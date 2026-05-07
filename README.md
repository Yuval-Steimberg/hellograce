# Grace

A production-grade WhatsApp AI assistant for people on GLP-1 medications.

This repository is a pnpm monorepo:

```
.
├── apps/
│   └── web/                # Vite + React app (becomes the admin dashboard in Phase 4)
├── services/
│   └── api/                # Node.js / Fastify orchestration service
├── packages/
│   ├── shared/             # Canonical TypeScript types
│   └── ai-core/            # AI orchestrator, planner, validator, tool registry
├── supabase/
│   ├── functions/          # Legacy Grace v1 edge functions (kept for cutover)
│   └── migrations/         # SQL migrations (v1 + v2)
└── docker-compose.yml      # One-command POC stack (Postgres+pgvector + api)
```

## Quick start (POC for investors)

```bash
# 1. Install
pnpm install

# 2. Configure
cp services/api/.env.example services/api/.env
# Fill in: GEMINI_API_KEY, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, DATABASE_URL

# 3. Run with Docker (recommended for demo)
docker compose up -d

# 4. Or run locally
pnpm --filter @grace/api dev

# 5. Demo without Twilio (investor-friendly)
curl -X POST http://localhost:3001/chat/send \
  -H 'content-type: application/json' \
  -d '{"userId":"demo-1","text":"Hey grace, I just had eggs and yogurt for breakfast"}'
```

## Architecture

```
WhatsApp / SMS (Twilio)            Investor Demo (curl)
         │                                │
         ▼                                ▼
POST /webhook/twilio              POST /chat/send
                       \         /
                        ▼       ▼
                      AIService
                         │
   ┌─────────────────────┼─────────────────────────────┐
   ▼                     ▼                             ▼
SafetyGuard       MemoryService                  RagService
(emergency/      (Postgres: messages,        (pgvector: embeddings,
 crisis pre-     conversations)              feedback-weighted)
 check)
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
              Validator
            (confidence scoring,
             safety guardrails)
                  │
                  ▼
             TwilioSender
```

## Phase status

| Phase | Scope | Status |
|---|---|---|
| 1 | Monorepo, Fastify, Twilio webhook, Gemini orchestrator, memory + RAG, tests | ✅ |
| 2 | Real tools, safety layer, RLHF feedback ingestion, admin API | ✅ |
| 3 | Multimodal (image/audio via Gemini), Redis cache, BullMQ workers | partial (image+audio ✅) |
| 4 | `apps/web` → admin dashboard (conversation viewer, prompt mgmt, RLHF) | pending |
| 5 | Cut Twilio webhook over to `services/api`, decommission v1 edge functions | pending |

## Lovable removal

- Removed `lovable-tagger` Vite plugin from `apps/web`.
- Replaced `ai.gateway.lovable.dev` calls with direct Gemini API access via `@google/generative-ai`.
- Legacy edge functions in `supabase/functions/` remain for the cutover; remove in Phase 5.

## RLHF (no fine-tuning)

We do **not** retrain the base model. Instead:

- Explicit signals: `POST /admin/feedback` with `rating ∈ {-1, 0, +1}` or comment.
- Implicit signals: re-query (user repeats / rephrases), drop-off (no reply within 24h), correction (user pushes back).
- Signals roll up into `embeddings.feedback_score`. The retrieval query adds this score to cosine similarity, biasing future answers toward responses that worked.
- Phase 4 admin dashboard exposes the trends, ranking, and A/B knobs.

## Endpoints

**Public:**
- `POST /webhook/twilio` — Twilio inbound (signature-verified in production)
- `POST /chat/send` — JSON `{userId, text}` for demo/testing
- `GET /health`, `GET /ready`

**Admin (Bearer token):**
- `GET /admin/metrics` — counts, latency, tool success rate
- `GET /admin/conversations` — recent conversations
- `GET /admin/conversations/:userId/messages` — full chat history
- `POST /admin/feedback` — RLHF signal ingestion
- `POST /admin/prompts` — version + activate prompts
- `POST /admin/tools/toggle` — enable/disable tools at runtime

## Testing

```bash
pnpm test                  # all packages
pnpm --filter @grace/api test
pnpm --filter @grace/ai-core test
```

## Database

Apply the v2 migration:

```bash
psql "$DATABASE_URL" -f supabase/migrations/20260507000001_grace_v2_core.sql
```
