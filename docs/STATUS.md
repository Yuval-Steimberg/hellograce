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
| 4 | `apps/web` → admin dashboard | ⏳ pending |
| 5 | Cut Twilio webhook from legacy edge fn → `services/api` | ⏳ pending |

---

## Open TODOs (priority order)

### Phase 4 — admin dashboard (rebuild `apps/web`)

- [ ] Replace marketing landing with auth-gated admin shell. Keep `/onboarding`
      and `/settings` for end-users; gate `/admin/*` routes by role.
- [ ] **Conversation viewer** — paginated list of recent conversations
      (`GET /admin/conversations`), drill into messages, show intent + confidence
      + tool calls per assistant turn. Wire to `GET /chat/stream/:conversationId` SSE.
- [ ] **RLHF dashboard** — feedback trends, top low-rated responses, ability to
      thumbs-up/down a stored assistant turn (writes to `feedback`).
- [ ] **Prompt manager** — `prompts` table with `version`, `content`, `active`.
      Service reads the active prompt at startup, reloads on SIGHUP.
- [ ] **Tool toggle** — `tool_settings` table `{tool_name, enabled, priority}`.
      `ToolRegistry.list()` filters by enabled flag.
- [ ] **A/B experiments** — `experiments` table; orchestrator picks variant based
      on consistent userId hash.
- [ ] **Metrics** — render `/admin/metrics` as charts (recharts is already a dep).
      Include cache hit-rate chart from new `cache` field on metrics response.

### Phase 5 — cutover

- [ ] Stand up `services/api` on a public URL (Fly.io / Railway / Render).
- [ ] Repoint Twilio webhook in console; keep edge fn as fallback for 24h.
- [ ] Mirror traffic for 1h: log both responses, diff, alert on divergence.
- [ ] Remove `supabase/functions/handle-inbound-sms` once parity confirmed.
- [ ] Decommission Lovable AI gateway calls in remaining edge fns or migrate them.

### Cross-cutting / nice-to-have

- [ ] Add `pg-boss` or simple cron worker for the v1 cron jobs that today live in
      Supabase Edge Function scheduled invocations (morning/midday/evening sends).
- [ ] OpenTelemetry: traces for orchestrator → planner → tool → LLM. Export to
      Honeycomb or Tempo.
- [ ] Sentry for error reporting (server + web).
- [ ] Storybook for shared UI in `apps/web` once dashboard work starts.
- [ ] Add `@grace/api` integration test that boots Fastify in-process, hits
      `/chat/send` with a stubbed `LLMProvider`, asserts DB writes.
- [ ] Snapshot test the system prompt to detect accidental drift.
- [ ] Re-enable `exactOptionalPropertyTypes` in `tsconfig.base.json` (deferred for POC).

---

## Done (history, newest first)

### 2026-05-07 — Phase 3: Redis cache + BullMQ workers + SSE streaming

- `services/api/src/cache/redis.ts` — ioredis singleton with graceful close.
- `services/api/src/cache/cache.ts` — typed `Cache` wrapper: `get/set/del` with
  namespaced keys, in-process hit/miss counters, `stats()` method.
- `GeminiProvider` — caches LLM completions keyed by SHA-256(messages + params),
  30-min TTL. Optional; falls back to direct calls when no Redis.
- `GeminiEmbedder` — caches embedding vectors keyed by SHA-256(text), 5-min TTL.
- `GET /admin/metrics` now returns `cache: { hits, misses, hitRate }`.
- `services/api/src/workers/queues.ts` — BullMQ `Queue<TurnPersistJob>` with
  retry (3 attempts, exponential backoff), auto-prune completed/failed jobs.
- `services/api/src/workers/turn-persist.worker.ts` — BullMQ `Worker` that
  writes `appendTurn` (user + assistant) + `tool_logs` inserts. Concurrency 5.
- `services/api/src/workers/index.ts` — `startWorkers` / `stopWorkers`.
- `AIService` — enqueues `TurnPersistJob` to BullMQ; falls back to fire-and-forget
  if no queue configured (keeps the test harness simple).
- `server.ts` — wires Redis, Cache, Queue, workers into startup/shutdown lifecycle.
- `GET /chat/stream/:conversationId` — SSE endpoint; polls DB at 500 ms,
  pushes `message` events as new rows land.
- `ToolRegistry` — per-tool timeout config map (log_food: 10s, log_weight/mood: 3s,
  knowledge_search: 5s) replaces the hardcoded 5s global.
- Redis added to `docker-compose.yml` (redis:7-alpine) with healthcheck.
- `REDIS_URL` added to env schema (optional, default `redis://localhost:6379`).
- `services/api/.env.example` updated.
- 13 Vitest tests still green; typecheck clean across all packages.

### 2026-05-07 — Refactor commit `cb17797`

Phase 1 + Phase 2 shipped in one pass.

- Restructured to pnpm monorepo: `apps/web`, `services/api`, `packages/shared`,
  `packages/ai-core`.
- Fastify orchestration service with strict TS, pino, helmet, rate-limit, zod
  config, graceful shutdown.
- Twilio webhook with HMAC-SHA1 signature verification + WhatsApp/SMS + media
  normalization (image/audio).
- Gemini 2.5 Flash provider via `@google/generative-ai` (Lovable removed).
- Memory service (Postgres) + RAG service (pgvector, feedback-weighted retrieval).
- `AIOrchestrator` (planner → tool executor → validator) with confidence scoring.
- Safety guard (deterministic emergency / crisis / medical-advice pre-check).
- Multimodal: Gemini vision for meal photos, audio transcription.
- Tools: `log_food`, `log_weight`, `log_mood`, `knowledge_search`.
- Admin API: `/admin/metrics`, `/admin/conversations`, `POST /admin/feedback`.
- `/chat/send` demo endpoint (no Twilio).
- v2 SQL migration: `conversations`, `messages`, `embeddings`, `tool_logs`,
  `feedback`, `user_profiles`, `food_logs` + ivfflat index.
- Multi-stage Dockerfile + `docker-compose.yml` (postgres+pgvector + api).
- Seed knowledge script + investor demo bash script.
- 13 Vitest tests passing.

---

## Decisions log

- **2026-05-07** — BullMQ over pg-boss for background workers. Rationale: Redis is
  already a dep for caching; BullMQ gives reliable retries, job visibility, and
  worker concurrency control with zero extra infrastructure beyond Redis.
- **2026-05-07** — SSE over WebSockets for the dashboard stream. Rationale: one-way
  server→client push is all we need; SSE works through proxies and needs no extra
  library in the browser.
- **2026-05-07** — Use direct `@google/generative-ai` SDK instead of OpenRouter or
  Vercel AI SDK. Rationale: lowest dependency surface; the `LLMProvider`
  interface lets us swap later without touching orchestrator.
- **2026-05-07** — pgvector dim = 768 (text-embedding-004). If we later move to
  Voyage or OpenAI embeddings, we'll add a new column and dual-write during
  cutover; we don't rebuild the table.
- **2026-05-07** — RLHF re-ranking via additive `feedback_score` on cosine
  similarity. Coefficient 0.05 in `RagService.retrieve` is a starting guess.
  Tune in Phase 4 with real data.
- **2026-05-07** — Disabled `exactOptionalPropertyTypes` in `tsconfig.base.json`
  for POC velocity. Re-enable in Phase 4 or sooner.
