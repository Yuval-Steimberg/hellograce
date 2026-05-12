# Grace — Project Status & Open TODOs

Rolling source of truth. Newest entries on top.

---

## Phase status

| Phase | Scope | Status |
|---|---|---|
| 1 | Monorepo, Fastify, Twilio webhook, Gemini orchestrator, memory + RAG, 13 tests | ✅ |
| 2 | Real tools, safety layer, RLHF feedback, admin API, multimodal | ✅ |
| 3 | Redis cache, BullMQ workers, SSE streaming, per-tool timeouts | ✅ |
| 4 | Admin dashboard (web app) | ✅ |
| 4b | Full chatbot: users, scheduler, proactive messages, all 8 tools | ✅ |
| 4c | Onboarding API, subscription gate, GDPR delete, chat history, admin user CRUD | ✅ |
| 4d | User-side RLHF: per-user ratings + feedback comments, admin toggle | ✅ |
| 4e | Admin dashboard overhaul: user drawer, create modal, richer metrics | ✅ |
| 5 | Cut Twilio webhook from v1 edge fn → v2 API | ✅ live at `https://grace-api.fly.dev` |

---

## Open TODOs (priority order)

### Post-cutover

- [ ] Add a Fly.io payment method (https://fly.io/trial) — trial machines auto-stop after 5 min idle, breaking scheduler proactive messages and adding ~10s cold-start to every webhook.
- [ ] Re-embed the 428 KB rows (currently zero-vector placeholders so RAG returns nothing meaningful). Run a one-off script that reads each row and writes a real `gemini-embedding-001` vector via the API.
- [ ] Once stable, disable the v1 edge function `handle-inbound-sms` (keep as fallback for 24h).
- [ ] Monitor logs for 24h. Watch for `webhook.ai.failed`, `rag.embed.failed`, `scheduler.tick.error`.

### Nice-to-have (post-launch)

- [ ] Wire welcome email send into `POST /users/onboard` (template at `docs/WELCOME_EMAIL.md`, needs Postmark/Resend/SendGrid).
- [ ] OpenTelemetry traces (orchestrator → planner → tool → LLM → Honeycomb/Tempo).
- [ ] Sentry error reporting (API + web).
- [ ] Integration test: boot Fastify in-process, hit `/chat/send` with stubbed LLMProvider, assert DB writes.
- [ ] Native v2 Stripe webhook handler (`POST /stripe/webhook`) — only needed if moving off Supabase DB.
- [ ] Admin auth upgrade to Supabase Auth roles (currently localStorage Bearer token).
- [ ] Re-enable `exactOptionalPropertyTypes` in tsconfig.
- [ ] BullMQ dashboard (Bull Board).
- [ ] A/B testing harness for prompts.

---

## Done (newest first)

### 2026-05-12 — Phase 5: Production cutover

- API deployed to Fly.io at `https://grace-api.fly.dev` (2 machines, `iad` region, single-stage Docker, `pnpm exec tsx src/server.ts` at runtime).
- Admin web deployed to Vercel as `grace-admin` with `VITE_API_URL=https://grace-api.fly.dev`.
- 14 Fly secrets configured (DB, Redis, Twilio, Gemini, admin token, etc.).
- Supabase Transaction Pooler URL (`aws-1-ap-northeast-1.pooler.supabase.com:6543`) for IPv6-friendly DB access from Fly machines.
- Knowledge base imported: 428 rows in `embeddings` table (zero-vector placeholders — re-embed pending).
- Twilio WhatsApp sandbox webhook pointed at `https://grace-api.fly.dev/webhook/twilio`. Verified end-to-end: real inbound message → Grace reply on WhatsApp.
- Twilio auth token rotated and updated in both Fly secrets and `services/api/.env`.
- Embedding model migrated from deprecated `text-embedding-004` → `gemini-embedding-001` with `outputDimensionality=768` via raw REST (SDK 0.21.0 doesn't expose the param).

### 2026-05-08 — Phase 4e: Admin dashboard overhaul

- `GET /admin/users/:phone` — full user detail: profile + check-ins + weight logs + message count.
- `PUT /admin/users/:phone` — update any user field (Zod-validated, 17 allowed fields).
- `GET /admin/metrics` — now includes `user_stats` (total/paid/pro/trial/paused/new_this_week).
- `UserDrawer` — right slide-over with Profile tab (account toggles, editable fields, reset/delete) and History tab (weight sparkline + check-ins).
- `CreateUserModal` — full onboarding form in a dialog; no curl needed.
- `MetricsPage` — second KPI row: 6 user stat cards with colour coding.
- `UsersPage` — click any row → drawer; Add User button → modal.
- `docs/USER_GUIDE.md` — end-user guide for sharing with users.
- `docs/WELCOME_EMAIL.md` — welcome email template with A/B subject lines, plain text fallback, personalization fields.

### 2026-05-08 — Phase 4d: User-side RLHF

- `users.rlhf_enabled` column (migration 20260508000001) — opt specific users into feedback collection.
- `UserService.recordUserFeedback()` — finds last assistant message, writes to `feedback` table, adjusts `embeddings.feedback_score` for real-time RAG ranking impact.
- Webhook intercept: 👍/👎/`FEEDBACK: text` from opted-in users is captured as RLHF signal, acknowledged, and skips AI processing.
- AI responses to opted-in users include rating prompt appended to message body.
- `PUT /admin/users/:phone/rlhf` — toggle `rlhf_enabled` per user.
- `UsersPage`: RLHF on/off toggle button per row (amber when active).

### 2026-05-08 — Phase 4c: Production-ready

- `POST /users/onboard` — normalize phone, upsert full profile, set `trial_start`, send welcome WhatsApp.
- `DELETE /users/:phone/data` — GDPR self-serve data deletion.
- `GET /chat/history/:userId` — last 100 messages for a user.
- `DELETE /admin/users/:phone` — admin hard delete (user + all data).
- `POST /admin/users/:phone/reset-memory` — wipe messages/conversations/embeddings.
- Subscription gate in `webhook.ts`: 3-day trial → paywall nudge if `is_paid=false && is_pro=false`.
- `trial_start = now()` set on every `POST /users/onboard`.
- `Onboarding.tsx` dual-mode: posts to v2 API when `VITE_API_URL` set, Supabase edge fn otherwise.
- `UsersPage`: Reset memory + Delete (confirm flow) buttons.
- `CLAUDE.md` rewritten with full architecture, API surface, subscription model.
- `docs/OPERATIONS.md` created — complete ship guide.

### 2026-05-08 — Phase 4b: Full GLP-1 chatbot

- SQL migration: `users`, `check_ins`, `weight_logs`, `injections` tables.
- `UserService`: upsert/get users, injection state machine, check-in recording, food/weight history.
- `Scheduler` (node-cron): morning/midday/evening/injection-day/side-effect proactive flows.
- `MessageGenerator`: AI-powered with per-type fallbacks (10 message types).
- 4 new tools: `get_user_profile`, `get_weight_trend`, `get_food_summary`, `log_side_effect`.
- `AIService`: personalized per-user system prompt, welcome detection, side-effect keyword detection.
- Webhook: upsert user on every inbound message, "done" reply → `done_confirmed` state.
- Admin `GET /admin/users` + `UsersPage` with pagination and search.
- Fixed evening wind-down operator precedence bug.

### 2026-05-07 — Phase 4: Admin dashboard

- `prompts` + `tool_settings` tables (migration 20260507000002).
- Admin API: prompts CRUD + activate, tool settings toggle/priority, feedback list.
- Hot-reload prompt via SIGHUP.
- React admin dashboard: Metrics, Conversations, RLHF Feedback, Prompt Manager, Tool Settings, Users.
- `apps/web` build fixed (removed `@tanstack/query-core` from dedupe).

### 2026-05-07 — Phase 3: Redis + BullMQ + SSE

- ioredis singleton + Cache wrapper (hit/miss counters, namespaced keys).
- GeminiProvider LLM cache (SHA-256, 30-min TTL).
- GeminiEmbedder cache (SHA-256, 5-min TTL).
- BullMQ `turn-persist` queue + worker (concurrency 5, 3 retries).
- `GET /chat/stream/:conversationId` SSE (DB poll 500ms).
- Per-tool timeout config (log_food 10s, weight/mood 3s, knowledge 5s).
- Redis 7-Alpine in docker-compose.

### 2026-05-07 — Phases 1 & 2: Core system

Full monorepo, Fastify v5, Gemini 2.5 Flash, pgvector RAG, RLHF feedback loop,
safety guard (crisis/emergency), multimodal (image + voice), admin API, Docker Compose, 13 tests.

---

## Decisions log

- **2026-05-08** — Subscription gate: 3-day trial from `trial_start`. After expiry, paywall
  nudge replaces AI response. `is_paid`/`is_pro` bypass. Stripe sync via v1 Supabase functions
  (both update same DB — no duplication needed).
- **2026-05-08** — Onboarding dual-mode: `VITE_API_URL` env var selects v2 API vs Supabase fallback.
  Clean backwards-compatible migration path.
- **2026-05-07** — Prompt hot-reload via SIGHUP. Activating in admin UI writes to DB; `kill -HUP`
  re-reads without restart. In Docker: `docker kill --signal HUP grace-api-1`.
- **2026-05-07** — Admin auth: localStorage Bearer token verified against `/admin/metrics`.
  Sufficient for internal use. Upgrade to Supabase Auth before public team access.
- **2026-05-07** — BullMQ over pg-boss: Redis already a dep for caching.
- **2026-05-07** — SSE over WebSockets: one-way push is enough; works through proxies.
- **2026-05-12** — Embedding model: `gemini-embedding-001` with `outputDimensionality=768` via raw REST. SDK 0.21.0's `EmbedContentRequest` type doesn't include `outputDimensionality`, so the embedder calls `https://generativelanguage.googleapis.com/v1beta/models/<m>:embedContent` directly. Keeps existing `vector(768)` schema and the 428 imported KB rows.
- **2026-05-07** — pgvector dim = 768 (originally text-embedding-004, now gemini-embedding-001).
- **2026-05-07** — Disabled `exactOptionalPropertyTypes` for POC velocity.
