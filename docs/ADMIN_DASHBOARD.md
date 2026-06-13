# Admin Dashboard — operational control, Stripe two-way sync, audit logging

This is the operator guide for the Grace admin dashboard. It covers what the
dashboard can do, what was added in the 2026-06-13 ops pass, the migration +
env vars required, and a **live-verification checklist** for the things that
can only be confirmed against the real Stripe / Twilio / production stack
(they cannot be exercised in CI — the sandbox has no Stripe keys, no live
WhatsApp sender, and never deploys).

---

## What the dashboard already does (pre-existing)

`/admin` (auth: Bearer `ADMIN_TOKEN`, stored in localStorage). Pages: Metrics,
Conversations (+ live SSE), Users (full CRUD via the user drawer — 30+ editable
fields), Business, Scheduler, AI Quality, Auto-Eval, Regression, Replay & Diff,
Coverage, Research, Content Rules, Subscription Messages, System Health. The
user drawer also shows a **live Stripe billing snapshot** (status, plan, next
billing, card on file) and can cancel-at-period-end. Food logs are viewable +
deletable per user. `POST /admin/replay` is "test a response without sending."

## What the 2026-06-13 ops pass added

### 1. Stripe two-way sync
- **Mirror columns on `users`**: `stripe_customer_id`, `stripe_subscription_id`,
  `subscription_status`, `subscription_plan`, `stripe_synced_at`,
  `stripe_sync_error`. The live snapshot is still read on-demand; these let the
  dashboard detect drift, link straight to Stripe, and surface sync state.
- **`POST /admin/users/:phone/stripe/sync`** — "Sync from Stripe": pulls live
  state and mirrors status/plan/`is_paid`/`is_pro` into the row. No-customer →
  leaves `is_paid` untouched (don't flip a trial/comp user). Customer with no
  active sub → `is_paid=false`. Errors are written to `stripe_sync_error` and
  shown inline, never thrown.
- **`POST /admin/users/:phone/stripe/reactivate`** — undo a scheduled
  cancellation (`cancel_at_period_end=false`). Returns 404 if the sub is fully
  canceled (must re-checkout).
- **`POST /admin/users/:phone/stripe/change-plan`** `{plan:'base'|'pro'}` —
  swaps the subscription item price, pro-rated.
- **v2 webhook `POST /webhook/stripe`** — registered only when
  `STRIPE_WEBHOOK_SECRET` is set. Verifies the signature against the raw body
  (own encapsulated Fastify scope with a raw-buffer parser), updates the user,
  and records **every** delivery in `stripe_events` (idempotent on
  `stripe_event_id`). Handles `customer.subscription.created/updated/deleted`,
  `invoice.payment_failed`, `invoice.payment_succeeded`.
- **`GET /admin/stripe/events`** + **`POST /admin/stripe/events/:id/retry`** —
  webhook-event log + retry a failed event from its stored payload.
- Dashboard: the user drawer gets **Sync from Stripe / Reactivate / Switch
  plan** buttons + last-sync/error line; the **Audit & Ops → Stripe Events**
  tab lists deliveries with retry.

### 2. Manual ops & internal notes
- **`POST /admin/users/:phone/send-message`** `{text, channel?}` — sends a real
  WhatsApp/SMS message and persists it into the conversation thread
  (role `assistant`, intent `admin_manual`) so it shows in the viewer + the
  user's context. (Test-without-sending remains `POST /admin/replay`.)
- **`POST /admin/users/:phone/pause` / `/resume`** — dedicated, audited pause.
  (The existing Paused toggle also works and is now audited via the user-update
  diff.)
- **Internal notes**: `GET/POST /admin/users/:phone/notes`,
  `DELETE /admin/notes/:id`. Distinct from `grace_notes` (which is an AI
  personalization memo). Shown in the user drawer.
- **Flag bad responses / mark for review**: `POST /admin/messages/:id/flag`
  (`message_id`='conversation' to flag a whole convo), `GET /admin/flagged`,
  `PUT /admin/flagged/:id/resolve`. Shown in Audit & Ops → Flagged.

### 3. Deep audit logging
- `audit_logs` gains `actor`, `target_user`, `before`, `after`, `reason`.
- The acting admin is read from the **`X-Admin-Actor`** header (the dashboard
  sends `localStorage.grace_admin_actor` if set; defaults to `admin`). This is
  attribution without full RBAC (RBAC was explicitly out of scope this pass).
- **`PUT /admin/users/:phone`** now records a before→after diff of exactly the
  fields changed (PII decrypted for readability) + reason (`X-Admin-Reason`).
- Stripe actions, manual sends, pause/resume, notes, and flags all audit.
- **`GET /admin/audit-logs`** (filter by action / target_user / date) + the
  **Audit & Ops → Audit Log** page.

All audit/notes/flags/event writes are **best-effort** — a missing table or
column (un-migrated DB) is swallowed so the underlying action never fails.

---

## Required before this works in production

### Migration
Apply `supabase/migrations/20260613000001_admin_dashboard_ops.sql` in the
Supabase SQL editor (idempotent — safe to re-run). It adds the user mirror
columns, extends `audit_logs`, and creates `stripe_events`, `admin_notes`,
`flagged_responses`. Verify:
```sql
SELECT column_name FROM information_schema.columns
 WHERE table_name='users' AND column_name LIKE 'stripe%';        -- 4 rows
SELECT to_regclass('public.stripe_events'),
       to_regclass('public.admin_notes'),
       to_regclass('public.flagged_responses');                  -- all non-null
```

### Env / Fly secrets
| Var | Purpose |
|---|---|
| `STRIPE_SECRET_KEY` | already required for the existing snapshot/cancel |
| `STRIPE_WEBHOOK_SECRET` | **new** — set to register the v2 webhook + verify sigs |
| `STRIPE_BASE_PRICE_ID` | change-plan target for Standard (defaults to test price) |
| `STRIPE_PRO_PRICE_ID` | change-plan target + Pro detection (defaults to test price) |

```bash
fly secrets set --app grace-api \
  STRIPE_WEBHOOK_SECRET=whsec_... \
  STRIPE_BASE_PRICE_ID=price_live_base \
  STRIPE_PRO_PRICE_ID=price_live_pro
```

### Stripe webhook endpoint
In the Stripe dashboard → Developers → Webhooks, add an endpoint pointing at
`https://grace-api.fly.dev/webhook/stripe`, subscribed to
`customer.subscription.*` and `invoice.payment_*`. Use its signing secret as
`STRIPE_WEBHOOK_SECRET`.

> The v1 Supabase `stripe-webhook` edge function still exists. The v2 handler
> is **additive and idempotent** (unique on `stripe_event_id`, `is_paid` writes
> are convergent), so pointing Stripe at v2 is safe. Recommended: point Stripe
> at **one** endpoint (v2) and retire the v1 edge fn once v2 is verified.

### Backfill the mirror columns (one-time)
After the migration, run **Sync from Stripe** on a few users, or call
`POST /admin/stripe/backfill-customers` (creates missing customers) then sync.
New webhook deliveries keep the columns fresh thereafter.

---

## Live-verification checklist (run with real keys — cannot be done in CI)

CI coverage: `services/api/src/services/stripe.service.test.ts` (15 tests,
mocked Stripe — sync/reactivate/change-plan/webhook logic) and
`services/api/src/routes/admin-ops.test.ts` (10 tests — send-message, notes,
flags, audit-logs, pause/resume wiring). The following exercise the real stack:

**Stripe two-way sync — drive each transition in Stripe (test mode), confirm
the dashboard + DB converge:**
- [ ] New subscription → user shows `active`, `is_paid=true`, `stripe_synced_at` set.
- [ ] Trial started / trial ended → `trialing` → `active`/`canceled` reflected.
- [ ] Plan upgrade (Switch to Pro) → Stripe item price = Pro, `is_pro=true`.
- [ ] Plan downgrade (Switch to Standard) → `is_pro=false`, still `is_paid`.
- [ ] Cancel (period end) → snapshot shows "Cancels on", `cancel_at_period_end`.
- [ ] Reactivate → `cancel_at_period_end=false`, status `active`.
- [ ] Failed payment → `subscription_status='past_due'`; a `stripe_events` row
      `invoice.payment_failed` = processed.
- [ ] Payment method failure → still surfaced via webhook + sync.
- [ ] Subscription deleted → `is_paid=false`, `is_pro=false`, status `canceled`.
- [ ] Webhook retry → break processing (e.g. bad data), confirm the event lands
      `failed` in Audit & Ops → Stripe Events, then **Retry** flips it to
      processed. Confirm Stripe redelivery is also idempotent (no dup row).
- [ ] **No-drift check**: a user `is_paid=true` internally but canceled in
      Stripe → **Sync from Stripe** corrects `is_paid` to false.

**Manual ops:**
- [ ] Send a WhatsApp message from the user drawer → message arrives on the
      phone AND appears in the conversation viewer.
- [ ] Pause a user → no proactive scheduler messages fire for them; Resume restores.
- [ ] Add/delete an internal note; flag a response and resolve it.

**Audit:**
- [ ] Set `localStorage.grace_admin_actor` (or have the login set it), make an
      edit, confirm Audit & Ops → Audit Log shows the actor + before→after diff.
- [ ] Confirm a profile edit immediately changes Grace's behavior (the
      user-cache invalidation path — e.g. set `dietary_pattern=vegetarian`,
      then ask for food ideas).
