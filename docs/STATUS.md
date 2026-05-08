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
| 5 | Cut Twilio webhook from v1 edge fn → v2 API | ⏳ **next — one URL change** |

---

## Open TODOs (priority order)

### Phase 5 — production cutover

- [ ] Stand up `services/api` on a public URL (Fly.io / Railway / Render). See `docs/OPERATIONS.md §4`.
- [ ] Deploy `apps/web` with `VITE_API_URL` set to the API URL. See `docs/OPERATIONS.md §5`.
- [ ] Run the 3 v2 migrations on your Supabase DB. See `docs/OPERATIONS.md §4b`.
- [ ] Smoke-test via `POST /chat/send` and `POST /users/onboard`.
- [ ] Change Twilio webhook URL in console. See `docs/OPERATIONS.md §6`.
- [ ] Monitor logs for 1h after cutover. Watch for `webhook.ai.failed`.
- [ ] Once stable, the v1 edge function `handle-inbound-sms` can be disabled (keep as fallback for 24h).

### Nice-to-have (post-launch)

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
- **2026-05-07** — pgvector dim = 768 (text-embedding-004).
- **2026-05-07** — Disabled `exactOptionalPropertyTypes` for POC velocity.
