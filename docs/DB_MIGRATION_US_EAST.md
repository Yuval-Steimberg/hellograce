# DB migration — Tokyo (ap-northeast-1) → US-East (us-east-1)

**Why:** the Fly app (`grace-api`, region `iad` / Virginia), Gemini, and Twilio are
all US-based, but the live Supabase DB is in `aws-1-ap-northeast-1` (Tokyo). Every
query is a ~300 ms trans-Pacific round trip, and a food/chat turn makes several —
that's the dominant latency (`unified_load` 760 ms–1.3 s). The original design (see
`docs/DEPLOY.md`) put the DB in `us-east-1`; the Tokyo project is the anomaly.
Co-locating the DB with the app removes that tax.

**Approach:** create a fresh Supabase project in `us-east-1`, `pg_dump` the Tokyo DB
→ restore into it, swap the `DATABASE_URL` Fly secret, redeploy. The DB is small, so
the cutover is minutes. Do it in a low-traffic window for the users' timezone.

**Run everything below on your Mac** (this cloud session can't reach prod, Fly, or
Supabase). You need: `psql` + `pg_dump` (v15+ — `brew install libpq` then
`brew link --force libpq`), the `fly` CLI, and both projects' DB passwords.

---

## 0. Prep the new US-East project (NO downtime — do this first, anytime)

1. Supabase dashboard → **New project** → Region **East US (North Virginia) /
   us-east-1**. Set a strong DB password (this becomes part of the new
   `DATABASE_URL` — see the security note at the end).
2. In the new project: **Database → Extensions** → enable **`vector`** and
   **`pgcrypto`**. (These back embeddings + `gen_random_uuid`. `pg_cron`/`pg_net`
   are legacy-v1-only and NOT needed by the v2 API.)
3. Grab both connection strings from **Project Settings → Database**:
   - **Direct** (port 5432, host `db.<ref>.supabase.co`) — used for dump/restore.
   - **Transaction pooler** (port 6543, host `aws-0-us-east-1.pooler.supabase.com`)
     — this becomes the app's new `DATABASE_URL`.

Set these shell vars (fill in refs/passwords):

```bash
# OLD (Tokyo) — DIRECT connection for dumping
OLD_DIRECT="postgresql://postgres:[OLD_PW]@db.[OLD_REF].supabase.co:5432/postgres"
# NEW (US-East) — DIRECT connection for restoring
NEW_DIRECT="postgresql://postgres:[NEW_PW]@db.[NEW_REF].supabase.co:5432/postgres"
# NEW (US-East) — TRANSACTION POOLER for the app's DATABASE_URL
NEW_POOLER="postgresql://postgres.[NEW_REF]:[NEW_PW]@aws-0-us-east-1.pooler.supabase.com:6543/postgres"
```

> Use the **direct** (5432) endpoints for `pg_dump`/`psql restore` — the transaction
> pooler (6543) doesn't support the session features a dump/restore needs. The app
> keeps using the **pooler** at runtime.

---

## 1. (No-downtime dry run) — dump + restore once to validate

This catches any restore error before the real cutover; a second dump at cutover
time replaces the data, so a stale dry-run is fine.

```bash
# Dump the public schema (schema + data) from Tokyo.
pg_dump "$OLD_DIRECT" \
  --schema=public --no-owner --no-privileges \
  --quote-all-identifiers --clean --if-exists \
  -f grace_dump.sql

# Restore into the new US-East project.
psql "$NEW_DIRECT" -v ON_ERROR_STOP=1 -f grace_dump.sql
```

Verify row counts match (spot-check the big tables):

```bash
for t in users food_logs messages weight_logs check_ins embeddings; do
  echo -n "$t  old="; psql "$OLD_DIRECT" -tAc "select count(*) from public.$t";
  echo -n "     new="; psql "$NEW_DIRECT" -tAc "select count(*) from public.$t";
done
```

If anything errors on restore (usually a missing extension), enable it on the new
project and re-run step 1. When counts match, you're ready for the real cutover.

---

## 2. Cutover (the only downtime — a few minutes)

Pick a quiet window. Inbound messages during this window will be retried by
Twilio / dropped by the iMessage relay — keep it short.

```bash
# a) Stop the app so no new writes hit the OLD DB mid-migration.
fly scale count 0 --app grace-api

# b) Fresh dump + restore (replaces the dry-run data with the latest).
pg_dump "$OLD_DIRECT" --schema=public --no-owner --no-privileges \
  --quote-all-identifiers --clean --if-exists -f grace_cutover.sql
psql "$NEW_DIRECT" -v ON_ERROR_STOP=1 -f grace_cutover.sql

# c) Point the app at the new US-East DB.
fly secrets set --app grace-api \
  DATABASE_URL="$NEW_POOLER"

# d) Bring the app back (secrets set already triggers a restart; scale to be safe).
fly scale count 1 --app grace-api
fly deploy --app grace-api --config services/api/fly.toml --no-cache \
  --build-arg GIT_COMMIT=$(git rev-parse --short HEAD)
```

---

## 3. Verify

```bash
curl -s https://grace-api.fly.dev/health          # status ok, version = current HEAD
# Send Grace a real test message, then confirm it read/wrote the NEW DB:
curl -s "https://grace-api.fly.dev/admin/users/%2B<your-e164>/food-logs" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq '.items | length'
```

Watch the latency drop on the admin **Latency dashboard** — `unified_load` should
fall from ~760 ms–1.3 s to tens of ms, and P50 chat/food turns should shed ~1–2 s.

---

## 4. Aftercare

- **Keep the Tokyo project running for a few days** as a rollback (to revert: set
  `DATABASE_URL` back to the old pooler + redeploy). Once the US-East DB is proven,
  **pause/delete** the Tokyo project.
- **Redis (Upstash):** confirm its region too — if it's not US-East, move it the same
  way (Upstash lets you pick a region on a new DB; it's a cache, so you can just
  repoint `REDIS_URL` with no data migration — pending-food/coalesce keys rebuild).
- **Legacy v1 edge functions** (`handle-inbound-sms`, `stripe-webhook`) still point at
  the Tokyo project's Supabase URL. They're slated for retirement; if you keep any,
  repoint them at the new project.

## 🔐 Security note (do this as part of the cutover)

The new `DATABASE_URL` will contain a fresh password — good, because the **old DB
password (`Giburking18!`) was exposed in chat and must be retired anyway.** Setting a
brand-new password on the US-East project rotates it for free. Also rotate the
**`ADMIN_TOKEN`** (it's been pasted in these curls) via `fly secrets set` while you're
in the secrets panel.
