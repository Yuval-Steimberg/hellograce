# Grace — Project Status & Open TODOs

This is the rolling source of truth for what's done and what's next.
Update at the end of every session. Newest entries on top of each section.

---

## Phase status snapshot

| Phase | Scope | Status |
|---|---|---|
| 1 | Monorepo, Fastify api, Twilio webhook, Gemini orchestrator, memory + RAG, tests | ✅ |
| 2 | Real tools, safety layer, RLHF feedback ingestion, admin API, multimodal | ✅ |
| 3 | Redis cache, BullMQ workers, SSE streaming, per-tool timeouts | ✅ |
| 4 | `apps/web` → admin dashboard | ✅ |
| 5 | Cut Twilio webhook from legacy edge fn → `services/api` | ⏳ pending |

---

## Open TODOs (priority order)

### Phase 5 — cutover

- [ ] Stand up `services/api` on a public URL (Fly.io / Railway / Render).
- [ ] Repoint Twilio webhook in console; keep edge fn as fallback for 24h.
- [ ] Mirror traffic for 1h: log both responses, diff, alert on divergence.
- [ ] Remove `supabase/functions/handle-inbound-sms` once parity confirmed.
- [ ] Decommission Lovable AI gateway calls in remaining edge fns or migrate them.

### Cross-cutting / nice-to-have

- [ ] OpenTelemetry: traces for orchestrator → planner → tool → LLM. Export to
      Honeycomb or Tempo.
- [ ] Sentry for error reporting (server + web).
- [ ] Add `@grace/api` integration test that boots Fastify in-process, hits
      `/chat/send` with a stubbed `LLMProvider`, asserts DB writes.
- [ ] Snapshot test the system prompt to detect accidental drift.
- [ ] Re-enable `exactOptionalPropertyTypes` in `tsconfig.base.json` (deferred for POC).
- [ ] Add `pg-boss` or simple cron worker for v1 morning/midday/evening sends
      (currently live in Supabase Edge Function scheduled invocations).
- [ ] ToolRegistry: filter by `tool_settings.enabled` at runtime (currently settings
      are only respected via the admin UI — ToolRegistry still registers all tools).

---

## Done (history, newest first)

### 2026-05-07 — Phase 4: Admin dashboard

**Backend additions:**
- `supabase/migrations/20260507000002_grace_v2_phase4.sql` — `prompts` and
  `tool_settings` tables with seed data (default prompt v1 + four tool rows).
- `GET /admin/prompts` — list all prompt versions, ordered by version DESC.
- `POST /admin/prompts` — create new version (auto-incremented, inactive by default).
- `PUT /admin/prompts/:id/activate` — atomic swap: deactivate all, activate target.
- `GET /admin/tool-settings` — list tool_name, enabled, priority, updated_at.
- `PUT /admin/tool-settings/:name` — upsert enabled + priority.
- `GET /admin/feedback` — list recent feedback entries for the RLHF dashboard.
- `AIService.updateSystemPrompt()` — hot-reload prompt without restart.
- `OrchestratorInput.systemPrompt` optional override in `@grace/shared`.
- `AIOrchestrator` uses `input.systemPrompt ?? GRACE_SYSTEM_PROMPT`.
- `server.ts` loads active prompt from DB on startup; SIGHUP triggers hot reload.
- CORS registered (`@fastify/cors`) so the dashboard can call the API.

**Frontend (`apps/web/src/`):**
- `lib/api.ts` — typed fetch wrapper with Bearer token auth, all typed API calls.
- `components/admin/AdminAuth.tsx` — React context: `login / logout`, verifies
  token against `/admin/metrics`, persists in localStorage.
- `components/admin/AdminLayout.tsx` — sidebar layout (Metrics, Conversations,
  RLHF Feedback, Prompt Manager, Tool Settings) with auth guard.
- `pages/admin/AdminLogin.tsx` — token input form with error state.
- `pages/admin/MetricsPage.tsx` — KPI cards + recharts BarChart (tool usage,
  p95 latency, feedback pie, cache stats). Auto-refreshes every 30s.
- `pages/admin/ConversationsPage.tsx` — conversation list + message thread +
  live SSE stream toggle via `GET /chat/stream/:conversationId`.
- `pages/admin/FeedbackPage.tsx` — signal breakdown chart + recent entries with
  inline 👍/👎 rating (writes to `POST /admin/feedback`).
- `pages/admin/PromptsPage.tsx` — version list, preview pane, "Set active" button.
- `pages/admin/ToolsPage.tsx` — per-tool card with Switch (enabled) + priority input.
- `App.tsx` — `/admin/*` routes added (lazy, nested under AdminLayout).
  `/admin/login` is public; all other `/admin/*` routes are auth-gated.
- `vite.config.ts` — fixed pre-existing `@tanstack/query-core` dedupe build error.
- `apps/web/.env.example` — added `VITE_API_URL`.
- Build clean: 40 chunks, 9.2s.

### 2026-05-07 — Phase 3: Redis cache + BullMQ workers + SSE streaming

- `services/api/src/cache/` — ioredis singleton + typed Cache wrapper (hit/miss counters).
- `GeminiProvider` — caches LLM completions by SHA-256(messages+params), 30-min TTL.
- `GeminiEmbedder` — caches embedding vectors by SHA-256(text), 5-min TTL.
- `GET /admin/metrics` returns `cache: { hits, misses, hitRate }`.
- BullMQ `turn-persist` queue + worker: moves `appendTurn` + `tool_logs` off hot path.
- `GET /chat/stream/:conversationId` SSE endpoint (DB poll, 500ms intervals).
- `ToolRegistry` per-tool timeout config map (log_food: 10s, weight/mood: 3s, knowledge: 5s).
- Redis 7-Alpine in `docker-compose.yml` with healthcheck.

### 2026-05-07 — Refactor commit `cb17797`

Phase 1 + Phase 2 shipped in one pass. Full monorepo, Fastify service, Gemini 2.5
Flash, pgvector RAG, RLHF, safety guard, multimodal, admin API, Docker, 13 tests.

---

## Decisions log

- **2026-05-07** — Prompt hot-reload via SIGHUP (not polling). Activating a prompt in
  the UI writes to DB; sending `kill -HUP <pid>` re-reads it without restart.
  In Docker: `docker kill --signal HUP grace-api-1`.
- **2026-05-07** — Tool settings stored in DB but ToolRegistry still registers all
  tools at startup. The DB settings gate per-user overrides; a global refactor to
  filter at registration time is deferred as a nice-to-have.
- **2026-05-07** — Admin auth: localStorage Bearer token, verified against
  `/admin/metrics` on load. No JWT/session — sufficient for internal investor demo.
  Upgrade to Supabase Auth roles before public release.
- **2026-05-07** — BullMQ over pg-boss: Redis already a dep for caching; BullMQ
  gives reliable retries, visibility, concurrency control.
- **2026-05-07** — SSE over WebSockets: one-way push is enough; SSE works through
  proxies with no extra library.
- **2026-05-07** — pgvector dim = 768 (text-embedding-004).
- **2026-05-07** — Disabled `exactOptionalPropertyTypes` for POC velocity.
