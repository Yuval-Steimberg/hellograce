# Grace — Claude Operating Notes

This file is loaded automatically by Claude Code at session start. Update it as the
project evolves so future sessions can resume without re-deriving context.

---

## What this project is

**Grace** — a production-grade WhatsApp/SMS AI companion for people on GLP-1
medications (Ozempic, Wegovy, Mounjaro, Zepbound, compounded semaglutide/tirzepatide).

Users sign up via a web onboarding flow, then receive personalized daily check-ins,
meal/hydration guidance, injection-day flows, and on-demand chat support. All
delivered via SMS/WhatsApp — no app required.

The repo is mid-refactor: the original "v1" Lovable-built stack (Vite app + Supabase
Edge Functions calling `ai.gateway.lovable.dev`) is being replaced with a "v2"
Node.js orchestration service built around Gemini 2.5 Flash, pgvector, and an
RLHF feedback loop — without breaking the existing Twilio webhook contract.

---

## Repo layout

```
.
├── apps/
│   └── web/                # @grace/web — Vite + React (Lovable-built site).
│                           # Lovable plugin removed. Becomes admin dashboard in Phase 4.
├── services/
│   └── api/                # @grace/api — NEW Fastify orchestration service.
├── packages/
│   ├── shared/             # @grace/shared — canonical TS types
│   └── ai-core/            # @grace/ai-core — pure orchestrator, planner, validator
├── supabase/
│   ├── functions/          # Legacy v1 edge functions (Deno). Kept for the cutover.
│   └── migrations/         # SQL — v1 (20260411..20260502) + v2 (20260507000001).
├── docker-compose.yml      # One-command POC: postgres+pgvector + api
└── docs/STATUS.md          # Rolling phase status + open todos (see below)
```

---

## Architecture (v2)

```
WhatsApp / SMS (Twilio)            Demo / curl
         │                              │
         ▼                              ▼
POST /webhook/twilio            POST /chat/send
                       \      /
                        ▼    ▼
                      AIService
                         │
   ┌─────────────────────┼──────────────────────────┐
   ▼                     ▼                          ▼
SafetyGuard       MemoryService                RagService
(emergency/      (Postgres: messages,      (pgvector: embeddings,
 crisis check)    conversations)            feedback-weighted)
                         │
                         ▼
                  AIOrchestrator
                  ┌──────┴──────┐
                  ▼             ▼
            PlannerAgent   ToolRegistry
                  │             │
                  ▼             ▼
           GeminiProvider   log_food / log_weight /
        (gemini-2.5-flash)  log_mood / knowledge_search
                  │
                  ▼
              Validator (confidence + safety)
                  │
                  ▼
             TwilioSender
```

Key design decisions:

- **Postgres + pgvector** is the single source of truth (users, history, embeddings,
  tool logs, feedback). No separate vector DB.
- **`@grace/ai-core` is pure** — no I/O, no env. The `LLMProvider` interface is
  injected from the service layer. Swap providers without touching orchestration.
- **No model retraining for RLHF.** Feedback signals (👍/👎, re-query, drop-off,
  correction) write to `feedback`, which bumps `embeddings.feedback_score`. The
  retrieval query adds that score to cosine similarity. Higher-rated past responses
  surface more often; lower-rated ones fade.
- **Twilio webhook stays compatible.** The new service exposes the same
  `POST /webhook/twilio` contract. Cutover is just changing the webhook URL in
  the Twilio console (Phase 5).

---

## Current status

| Phase | Scope | Status |
|---|---|---|
| 1 | Monorepo, Fastify, Twilio webhook, Gemini orchestrator, memory + RAG, tests | ✅ shipped |
| 2 | Real tools, safety layer, RLHF feedback ingestion, admin API, multimodal | ✅ shipped |
| 3 | Redis cache, BullMQ background workers, SSE streaming, per-tool timeouts | ✅ shipped |
| 4 | `apps/web` → admin dashboard (conversation viewer, prompt mgmt, RLHF UI, A/B) | ⏳ next |
| 5 | Cut Twilio webhook over from legacy edge function → `services/api` | ⏳ not started |

13 Vitest tests passing across orchestrator, planner, normalizer, signature, safety.

See `docs/STATUS.md` for the live todo list and open work items.

---

## Commands you'll use most

```bash
# Install
pnpm install

# Run everything via Docker (recommended for fresh sessions)
export GEMINI_API_KEY=...
docker compose up -d
pnpm --filter @grace/api exec tsx scripts/seed-knowledge.ts   # seed embeddings

# Local dev for the api
cp services/api/.env.example services/api/.env
pnpm --filter @grace/api dev

# Tests / typecheck / build
pnpm test
pnpm -r typecheck
pnpm -r build

# Demo (hits /chat/send with realistic messages)
./services/api/scripts/demo.sh

# Apply v2 migration to a real DB
psql "$DATABASE_URL" -f supabase/migrations/20260507000001_grace_v2_core.sql
```

---

## Working agreements (please follow)

- **Branch policy.** Active branch: `claude/icloud-access-clarification-5hsRr`.
  Develop, commit, and push there unless told otherwise.
- **Don't break the Twilio contract.** `POST /webhook/twilio` accepts Twilio's
  standard form payload and replies with empty TwiML. Outbound messages go via
  `TwilioSender`, async after the webhook returns.
- **Don't reintroduce Lovable.** No `lovable-tagger`, no `ai.gateway.lovable.dev`.
  All AI calls go through `LLMProvider` (currently `GeminiProvider`).
- **Keep `@grace/ai-core` pure.** No `pg`, no `pino`, no env reads. Inject deps.
- **Tests first for orchestration changes.** The orchestrator has full coverage —
  keep it green.
- **Commit messages: imperative, focused on the why.** Don't reference "Claude" or
  this session in code or commit subject lines.

---

## Where to start in a new session

1. Read this file + `docs/STATUS.md` (open todos).
2. `git status` and `git log --oneline -10` to see recent commits.
3. Pick the highest-priority open item from `docs/STATUS.md`.
4. If unclear, ask before implementing.

---

## Known gaps / things explicitly deferred

- **Redis required at runtime.** `REDIS_URL` defaults to `redis://localhost:6379`.
  Docker Compose starts Redis automatically. For local dev without Docker, run
  `redis-server` or set `REDIS_URL` to a managed Redis (Upstash, Railway, etc.).
- **BullMQ dashboard not wired.** Bull Board or similar can be added for job
  visibility in Phase 4 admin shell.
- **SSE uses DB polling (500 ms).** Good enough for dashboard; upgrade to Postgres
  LISTEN/NOTIFY for lower latency if needed.
- **No prompt versioning UI.** The system prompt lives in
  `packages/ai-core/src/prompts.ts`. Phase 4 adds a `prompts` table + admin UI.
- **No A/B testing harness.** Stub it in Phase 4.
- **Legacy edge functions still active.** Until Phase 5 cutover, real production
  traffic goes to `supabase/functions/handle-inbound-sms/index.ts`. Both code
  paths exist; don't delete v1 yet.
- **`apps/web` is still the customer-facing marketing site.** Don't rip it apart
  before Phase 4 plan is agreed.
