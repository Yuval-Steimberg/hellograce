# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

_Also loaded automatically at session start. Update at the end of every session so the next session resumes without re-deriving context._

---

## What this project is

**Grace** — a production-grade WhatsApp/SMS AI companion for people on GLP-1
medications (Ozempic, Wegovy, Mounjaro, Zepbound, compounded semaglutide/tirzepatide).

Users sign up via a web onboarding flow, then receive personalized daily check-ins,
meal/hydration guidance, injection-day flows, and on-demand chat — all via WhatsApp/SMS.
No app required.

The v2 Node.js orchestration service is **feature-complete and production-ready**.
The only remaining step is pointing the Twilio webhook URL from the legacy Supabase
edge function to `services/api` (Phase 5 cutover — one URL change).

---

## Repo layout

```
.
├── apps/
│   └── web/                # @grace/web — Vite + React + shadcn/ui
│                           # Onboarding flow + admin dashboard at /admin
├── services/
│   └── api/                # @grace/api — Fastify orchestration service (v2)
│                           # All AI, scheduling, webhooks, admin API
├── packages/
│   ├── shared/             # @grace/shared — canonical TS types
│   └── ai-core/            # @grace/ai-core — pure orchestrator, planner, validator
├── supabase/
│   ├── functions/          # Legacy v1 edge functions (Deno) — still live in prod
│   └── migrations/         # SQL migrations
├── docs/
│   ├── STATUS.md           # Phase tracker + open todos
│   ├── OPERATIONS.md       # Production setup guide + subscriptions + admin
│   ├── USER_GUIDE.md       # End-user guide (share with users)
│   └── WELCOME_EMAIL.md    # Welcome email template with personalization notes
├── docker-compose.yml      # One-command local: Postgres+pgvector + Redis + api
└── CLAUDE.md               # This file
```

---

## Architecture (v2 — fully built)

```
WhatsApp/SMS (Twilio)
        │
        ▼
POST /webhook/twilio
        │
        ├── isAccessAllowed() — 3-day trial / is_paid / is_pro gate
        ├── UserService.ensureUser() — upsert, update last_reply_at
        ├── injection "done" detection → advances state machine
        ├── RLHF feedback intercept (👍/👎/FEEDBACK:) for opted-in users
        │
        ▼
AIService.handleMessage()
        │
   ┌────┴───────────────────────────────────────┐
   ▼                   ▼                        ▼
SafetyGuard      MemoryService            RagService
(crisis check)   (Postgres history)       (pgvector + RLHF weights)
        │
        ▼
AIOrchestrator (packages/ai-core)
   ┌────┴──────┐
   ▼           ▼
Planner    ToolRegistry (8 tools, DB-gated)
   │
GeminiProvider (gemini-2.5-flash) → Validator
   │
BullMQ turn-persist worker → Postgres
   │
TwilioSender → WhatsApp/SMS
```

**Scheduler** (node-cron, in same process as API):
- Every minute → proactive messages per user (timezone-aware)
  - Morning at wake_time (daily)
  - Midday Mon/Wed/Fri 11am–2pm local
  - Evening Tue/Thu/Sun 90min before sleep_time
  - Injection day flow (4 stages: morning_sent → done_confirmed → followup_sent → day-after)
  - Side-effect follow-up 4h after keyword detected
- Daily 3am UTC → personalization engine (low_mood_mode, midday_skip)

---

## Subscription model

| Tier | DB flag | Stripe price ID | Access |
|---|---|---|---|
| Free trial | `trial_start` set | — | 3 days from signup |
| Standard | `is_paid = true` | `price_1TLha4E0DcWyPH4X2QxV9hh3` | Full AI + proactive |
| Pro | `is_pro = true` | `price_1TLla9E0DcWyPH4XZnep2X7G` | Full + priority |

Stripe flow (v1 Supabase edge functions, still active):
1. `create-checkout` → Stripe subscription with 3-day trial
2. `confirm-checkout` → marks `is_paid = true` in shared DB
3. `stripe-webhook` → syncs subscription events → `is_paid`/`is_pro`

v2 API reads `is_paid`/`is_pro` from the same Postgres DB — no duplication needed.
Subscription gate in `webhook.ts` fires paywall message if trial expired and not paid.

---

## Complete API surface

### Public
- `POST /webhook/twilio` — Twilio inbound (WhatsApp + SMS)
- `POST /chat/send` — demo/testing chat endpoint
- `GET /chat/stream/:conversationId` — SSE live message stream
- `GET /chat/history/:userId` — last 100 messages for a user
- `POST /users/onboard` — create user profile + set trial_start + send welcome WhatsApp
- `DELETE /users/:phone/data` — GDPR self-serve data deletion
- `GET /health` — liveness check

### Admin (Bearer `ADMIN_TOKEN` required)
- `GET /admin/metrics` — messages/tools/feedback/cache stats + `user_stats` breakdown (auto-refresh 30s)
- `GET /admin/conversations` + `/:userId/messages` — conversation viewer
- `GET /admin/users?limit&offset` — paginated user list; includes `rlhf_enabled`
- `GET /admin/users/:phone` — full user detail: profile + check-in history + weight logs + message count
- `PUT /admin/users/:phone` — update any profile/account field (Zod-validated)
- `DELETE /admin/users/:phone` — hard delete user + all data
- `POST /admin/users/:phone/reset-memory` — wipe messages/conversations/embeddings
- `PUT /admin/users/:phone/rlhf` — toggle `rlhf_enabled` for a user `{ enabled: boolean }`
- `GET|POST /admin/feedback` — RLHF signal viewer + submit
- `GET|POST /admin/prompts` — system prompt versions
- `PUT /admin/prompts/:id/activate` — hot-swap active prompt (atomic)
- `GET /admin/tool-settings` + `PUT /admin/tool-settings/:name` — tool toggles

---

## Tools (8 registered per-request, admin-toggleable)

| Tool | What it does |
|---|---|
| `log_food` | LLM-estimates protein/kcal for any food text, writes to `food_logs` |
| `log_weight` | Records lbs to `weight_logs` |
| `log_mood` | Records mood score 1–10 |
| `knowledge_search` | pgvector RAG over GLP-1 knowledge base |
| `get_user_profile` | Returns user's goals, medication, weight, behavioral flags |
| `get_weight_trend` | Last 10 weight entries + up/down/stable trend |
| `get_food_summary` | Today's protein + calories + protein_goal_met (≥80g target) |
| `log_side_effect` | Sets side_effect_flow → schedules 4h follow-up message |

---

## Database migrations (apply in order)

```bash
psql "$DATABASE_URL" -f supabase/migrations/20260507000001_grace_v2_core.sql
psql "$DATABASE_URL" -f supabase/migrations/20260507000002_grace_v2_phase4.sql
psql "$DATABASE_URL" -f supabase/migrations/20260507000003_grace_v2_users.sql
psql "$DATABASE_URL" -f supabase/migrations/20260508000001_rlhf_user_flags.sql
```

Core tables: `users`, `conversations`, `messages`, `embeddings`, `tool_logs`,
`feedback`, `food_logs`, `weight_logs`, `check_ins`, `injections`, `prompts`, `tool_settings`.

Key columns added by 20260508000001: `users.rlhf_enabled BOOLEAN DEFAULT FALSE`

---

## Credentials (local dev)

All secrets live in `services/api/.env` (gitignored — never commit it).
The following are already filled in for this project:

| Variable | Status |
|---|---|
| `GEMINI_API_KEY` | ✅ set in `.env` |
| `REDIS_URL` | ✅ set in `.env` (Upstash TLS) |
| `DATABASE_URL` | ⏳ fill in from Supabase (see `docs/DEPLOY.md § 1.1`) |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` | ⏳ fill in from Twilio console |
| `TWILIO_WHATSAPP_FROM` | ⏳ fill in once Twilio number confirmed |
| `ADMIN_TOKEN` | ⏳ generate with `openssl rand -hex 32` |

Full deployment instructions: `docs/DEPLOY.md`

---

## Commands

```bash
pnpm install

# Run everything via Docker (Postgres + Redis + API on :3001)
export GEMINI_API_KEY=your-key
docker compose up -d
pnpm --filter @grace/api exec tsx scripts/seed-knowledge.ts

# Local API dev (no Docker)
cp services/api/.env.example services/api/.env && vim services/api/.env
pnpm --filter @grace/api dev

# Tests / typecheck / build
pnpm test          # 47 tests, all green
pnpm -r typecheck  # clean across all 4 packages
pnpm -r build

# Single test file / single test by name (vitest)
pnpm --filter @grace/api test -- guard.test
pnpm --filter @grace/ai-core test -- -t "planner"

# Eval harness — measures accuracy/safety across ~50 GLP-1 cases
# Requires GEMINI_API_KEY. No DB needed (tools are mocked).
pnpm --filter @grace/api eval
# Filter / tune concurrency:
EVAL_FILTER=food EVAL_CONCURRENCY=5 pnpm --filter @grace/api eval

# Hot-reload system prompt without restart
docker kill --signal HUP grace-api-1  # or: kill -HUP <api-pid>

# Demo (no Twilio needed)
curl -X POST http://localhost:3001/chat/send \
  -H "Content-Type: application/json" \
  -d '{"userId":"+15551234567","text":"I just had chicken and rice"}'
```

> If `pnpm` is missing on a fresh machine: `corepack enable pnpm && corepack prepare pnpm@9.12.0 --activate`.

---

## Working agreements

- **Active branch**: `main`. Prior feature branches have all been merged — cut new branches off `main` and PR back when ready.
- **Don't break Twilio contract.** `POST /webhook/twilio` accepts Twilio form payload, replies empty TwiML. Outbound goes via `TwilioSender` async.
- **Keep `@grace/ai-core` pure.** No `pg`, no `pino`, no env reads. Inject all deps.
- **Tests first for orchestration changes.** 47 tests, keep them green.
- **No Lovable.** No `lovable-tagger`, no `ai.gateway.lovable.dev`.
- **Commit messages: imperative, focused on why.**

---

## Accuracy / eval harness

Lives in `services/api/eval/`. Runs every case through real Gemini + mocked tools, grades against expected intent / tool calls / required + forbidden phrases / length bounds, writes JSON to `eval/results/<timestamp>.json`.

- `eval/cases.ts` — the dataset. Add a case when you fix a real failure so it doesn't regress.
- `eval/grade.ts` — deterministic checks (no LLM judge yet — coming in Step 2).
- `eval/runner.ts` — concurrent runner + report formatter.
- Crisis/emergency wording is NOT in the eval set — `SafetyGuard` short-circuits the pipeline before the orchestrator runs, and is unit-tested in `services/api/src/safety/guard.test.ts`.

Roadmap (in progress, in this order):
1. ✅ Eval harness + 50-case dataset (`services/api/eval/`).
2. ✅ LLM-critic on risky intents (`knowledge_lookup`, `safety_*`, validator-flagged, or low-confidence). Regenerate once on critic fail, safe fallback if second attempt also fails. Implementation: `packages/ai-core/src/critic.ts` + orchestrator wiring. Output exposes `critic`, `regenerated`, `usedSafeFallback` for admin observability.
3. ✅ Fact-grounding: deterministic precheck (`packages/ai-core/src/grounding.ts`) detects quantitative medical claims (doses, durations, frequencies, percentages) and interaction-safety assertions in the response and verifies them against retrieved KB chunks. Unsupported claims fail-close to regen — saves a Gemini call vs. invoking the LLM-critic. Surfaced via `CriticReport.unsupportedClaims` + `source: 'precheck' | 'llm'`.
4. ⏳ Wire eval scores into `prompts` table; gate `activate` on ≥ baseline.
5. ⏳ Gemini prompt caching for static system prompt + tool defs; skip planner for pure-chat intents.

---

## Phase completion status

| Phase | Scope | Status |
|---|---|---|
| 1 | Monorepo, Fastify, Twilio webhook, Gemini orchestrator, memory + RAG, tests | ✅ |
| 2 | Real tools, safety, RLHF feedback, admin API, multimodal | ✅ |
| 3 | Redis cache, BullMQ workers, SSE streaming, per-tool timeouts | ✅ |
| 4 | Admin dashboard (web app) | ✅ |
| 4b | Full chatbot: users, scheduler, proactive messages, all tools, onboarding API | ✅ |
| 4c | Subscription gate, GDPR delete, chat history, admin user CRUD | ✅ |
| 4d | User-side RLHF: per-user ratings + feedback comments, admin toggle | ✅ |
| 4e | Admin dashboard overhaul: user drawer, create modal, richer metrics | ✅ |
| 5 | Cut Twilio webhook from v1 → v2 | ⏳ one URL change in Twilio console |

---

## Where to start in a new session

1. Read this file + `docs/STATUS.md` + `docs/OPERATIONS.md`.
2. `git log --oneline -10` to see recent commits.
3. `git checkout claude/icloud-access-clarification-5hsRr`.
4. Apply any unapplied migrations (see list above) against your Supabase DB.
5. For Phase 5: one URL change. See `docs/OPERATIONS.md § Twilio cutover`.

---

## Admin dashboard — component map

| File | What it does |
|---|---|
| `apps/web/src/components/admin/AdminLayout.tsx` | Sidebar nav + auth guard |
| `apps/web/src/components/admin/AdminAuth.tsx` | Token context (localStorage) |
| `apps/web/src/components/admin/UserDrawer.tsx` | Right slide-over: profile edit, account toggles, weight chart, check-ins |
| `apps/web/src/components/admin/CreateUserModal.tsx` | Dialog to onboard a new user without curl |
| `apps/web/src/pages/admin/MetricsPage.tsx` | Activity KPIs + user stats row + charts |
| `apps/web/src/pages/admin/ConversationsPage.tsx` | Two-panel thread viewer + SSE live stream |
| `apps/web/src/pages/admin/UsersPage.tsx` | Paginated table; click row → UserDrawer; Add User → CreateUserModal |
| `apps/web/src/pages/admin/FeedbackPage.tsx` | RLHF feedback list + quick rate buttons |
| `apps/web/src/pages/admin/PromptsPage.tsx` | Prompt versioning + one-click activate |
| `apps/web/src/pages/admin/ToolsPage.tsx` | Per-tool enable/disable + priority |

---

## Known gaps / deferred

- **Phase 5 cutover**: change Twilio webhook URL (see `docs/OPERATIONS.md`).
- **v2 Stripe webhook**: Stripe events currently update `is_paid` via v1 Supabase function hitting the shared DB. v2 reads from same DB so it works. Only build a native v2 handler if moving off Supabase DB entirely.
- **Admin auth upgrade**: localStorage Bearer token is fine for internal use. Upgrade to Supabase Auth roles before broad team access.
- **OpenTelemetry + Sentry**: not yet instrumented.
- **Integration tests**: boot Fastify in-process with stubbed LLMProvider.
- **`exactOptionalPropertyTypes`**: disabled in tsconfig — re-enable when ready.
- **A/B testing harness**: deferred.
- **BullMQ dashboard**: Bull Board not wired yet.
- **Welcome email sending**: template written (`docs/WELCOME_EMAIL.md`) but not wired into `POST /users/onboard` yet — needs an email provider (Postmark/Resend/SendGrid).
