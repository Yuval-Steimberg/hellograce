# Local development

How to run Grace on your machine so you can preview changes to the web app
(onboarding, /settings, /upgrade, /admin) before pushing to git and letting
Vercel auto-deploy.

Two supported modes — pick the one that matches what you're testing.

---

## MODE 1 — Web only, hit production API (fastest)

**Use this when:** you're tweaking UI, copy, CSS, animations, button
behavior, or anything purely frontend. No backend changes.

**What runs locally:** Vite dev server on `http://localhost:8080`.
**What runs in the cloud:** Real Fly API at `https://grace-api.fly.dev` and
real Supabase DB. Every action you take (delete a user, change a
subscription, etc.) hits production.

### One-time setup

```bash
# 1. Install pnpm if you don't have it
corepack enable pnpm && corepack prepare pnpm@9.12.0 --activate

# 2. Install all workspace deps from the repo root
pnpm install

# 3. Create the web app's local env file
cp apps/web/.env.example apps/web/.env.local

# 4. Open apps/web/.env.local and confirm VITE_API_URL points at prod:
#    VITE_API_URL="https://grace-api.fly.dev"
```

### Every-time dev loop

```bash
pnpm --filter @grace/web dev
```

Open <http://localhost:8080>. Hot-reload is on — save any file under
`apps/web/src/` and the browser updates within ~200ms.

To stop: `Ctrl+C` in the terminal.

### Notes for MODE 1

- **CORS:** The production API allowlist now includes `http://localhost:8080`
  (added in `services/api/src/server.ts`). If you ever see a CORS error,
  redeploy the API.
- **Admin pages:** Visit <http://localhost:8080/admin> — paste your real
  `ADMIN_TOKEN` from `services/api/.env`. The token is stored in
  localStorage so you only paste it once.
- **Stripe checkout:** Works fully — opens the same Stripe Customer Portal
  you'd see on Vercel.
- **"Manage subscription" button:** Uses `window.location.href` (same-tab
  navigation) so it works on mobile Safari too. Stripe returns to
  `/settings` via `return_url`.

---

## MODE 2 — Full local stack via Docker

**Use this when:** you're changing the API, scheduler, prompts, tools, or
anything that touches data. Or you want to test destructive operations
(delete user, reset memory) without affecting production.

**What runs locally:** Postgres + Redis + Fastify API + reranker + Vite dev
server. Everything on your machine, fully isolated.

### One-time setup

```bash
# 1. Install pnpm + Docker Desktop if you don't have them
corepack enable pnpm && corepack prepare pnpm@9.12.0 --activate

# 2. Set GEMINI_API_KEY in your shell (required by the API container)
export GEMINI_API_KEY=AIza...   # add to ~/.zshrc to persist

# 3. Install workspace deps
pnpm install

# 4. Start the backend stack (API + Postgres + Redis + reranker)
docker compose up -d

# 5. Wait ~30 seconds for migrations to apply, then seed the knowledge base
pnpm --filter @grace/api exec tsx scripts/seed-knowledge.ts

# 6. Sanity-check the local API is up
curl http://localhost:3001/health
# → {"status":"ok",...}

# 7. Configure the web app to talk to the local API
cp apps/web/.env.example apps/web/.env.local
# Edit apps/web/.env.local:
#   VITE_API_URL="http://localhost:3001"     ← change from prod
```

### Every-time dev loop

```bash
# Terminal 1 — backend (only if not already running)
docker compose up -d

# Terminal 2 — web dev server
pnpm --filter @grace/web dev
```

Open <http://localhost:8080>.

### Useful commands

```bash
# Tail API logs
docker compose logs -f api

# Restart just the API after a backend code change (rebuild)
docker compose up -d --build api

# Drop everything and start clean (nukes the local DB)
docker compose down -v
docker compose up -d

# Connect to the local Postgres
psql postgres://grace:grace@localhost:5432/grace

# Run the eval / regression suites against local
pnpm --filter @grace/api test
pnpm --filter @grace/api eval
```

### Notes for MODE 2

- **No Twilio:** Inbound webhooks won't work locally unless you set up
  ngrok and configure Twilio to forward to your tunnel. For UI/API
  testing, use the in-app `/admin/replay` page or `POST /chat/send`.
- **Stripe:** The local API has no Stripe webhook secret. Subscription
  state won't flip via Stripe events — flip it manually via
  `PUT /admin/users/:phone` with `{ "is_paid": true }`.
- **First-run latency:** First Gemini call takes ~3s (no warm context
  cache yet). Subsequent calls are ~700ms.
- **Migrations:** New SQL files in `supabase/migrations/` auto-apply on
  `docker compose up` (mounted at `/docker-entrypoint-initdb.d`) — but
  ONLY on fresh DBs. To re-apply on an existing one: `docker compose
  down -v && docker compose up -d`.

---

## Pick-a-mode quick reference

| Question | MODE 1 | MODE 2 |
|---|---|---|
| Tweaking onboarding copy | ✅ | overkill |
| Changing a landing page color | ✅ | overkill |
| Testing the Stripe portal flow end-to-end | ✅ (uses real Stripe test mode) | needs extra Stripe setup |
| Adding a new tool to the orchestrator | ❌ | ✅ |
| Changing the system prompt | ❌ | ✅ |
| Testing scheduler proactive messages | ❌ | ✅ (with ngrok for Twilio) |
| Wiping a test user's memory | ❌ DON'T! (hits prod) | ✅ safe |
| Just want to see what your CSS change looks like | ✅ ← do this | no |

---

## Before you push

```bash
# Typecheck everything
pnpm -r typecheck

# Run the test suite
pnpm test

# Smoke-test the web build (catches Vite production issues like missing imports)
pnpm --filter @grace/web build
```

Then commit + push to the active feature branch. Vercel auto-deploys
`main` to <https://grace-admin-silk.vercel.app> within ~60s.
