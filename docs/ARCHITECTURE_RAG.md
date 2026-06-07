# RAG / Retrieval Architecture

Last updated: 2026-06-07 (Phase C of latency optimization program)

## Decision

Grace runs RAG as an **exception, not a default**. Of the 16+ intents the
classifier produces, RAG fires for exactly **two**: `knowledge` and
`medication_question`. Every other intent skips retrieval entirely.

This document records why this is the right design, and what the brief's
"RAG necessity review" looks for.

---

## What runs vs what skips

### Intents that skip RAG (14)

Defined in `services/api/src/services/ai.service.ts` `RAG_SKIP_INTENTS` set:

`food_log, weight_log, mood_log, exercise_log, injection_log, greeting,
gibberish, scheduling, pause_request, food_question, general, emotional,
appointment_prep, social_situation`

Why each is skipped:

- **food_log / weight_log / mood_log / exercise_log / injection_log**:
  confirmation messages. The user told us what they did; KB retrieval
  adds nothing.
- **greeting**: a "Hi" doesn't need clinical context.
- **gibberish**: no semantic intent to retrieve against.
- **scheduling / pause_request**: profile/system actions, not knowledge.
- **food_question**: answered by the curated meal-idea bank +
  `get_food_summary` tool + dietary filter. KB chunks burn ~750ms with
  no measurable quality gain.
- **general**: catch-all for chat / follow-ups that piggyback on prior
  context. Production telemetry showed RAG burning 1.7s on a
  misclassified breakfast question that landed here.
- **emotional / appointment_prep / social_situation** (added in commit
  `424dc4d`, 2026-06-06): these direct paths build their replies from a
  focused 4-step framework prompt, NOT from KB content. RAG was pure
  dead weight (500-700ms per turn).

### Intents that run RAG (2)

- **knowledge**: clinical questions ("protein target?", "nausea
  management?", "muscle preservation"). KB retrieval is core to the
  response, but even here:
  - `pickKnowledgeTopicFallback()` catches 14 common topics (water,
    alcohol, sleep, coffee, exercise, hair loss, etc.) deterministically,
    skipping RAG entirely
  - When `FAQ_CACHE_ENABLED=true` (Phase A1), an additional 40-60% of
    knowledge queries hit the FAQ semantic cache and skip RAG
- **medication_question**: storage, timing, dose escalation, travel,
  switching, missed doses. Specific medication facts from the KB are
  occasionally useful here.

## How RAG runs when it does fire

`services/api/src/rag/` modules:

| File | Responsibility |
|---|---|
| `rag.service.ts` | Core dense retrieval — embed query, pgvector cosine + RLHF feedback bias |
| `hybrid-rag.ts` | Dense + sparse fusion — pgvector + Postgres FTS, dedup by doc id |
| `sparse-search.service.ts` | Postgres `websearch_to_tsquery` for keyword catches |
| `reranker.service.ts` | Optional Python cross-encoder sidecar (4s timeout, gracefully disabled if unreachable) |
| `gemini-embedder.ts` | Embedding service, 30-min SHA256 cache, `gemini-embedding-001` (768-dim) |

### Knowledge base contents

Stored in the Postgres `embeddings` table (schema in
`supabase/migrations/20260507000001_grace_v2_core.sql`):

```sql
CREATE TABLE public.embeddings (
  id UUID PRIMARY KEY,
  user_id TEXT,              -- NULL = global knowledge
  source TEXT CHECK (source IN ('history', 'knowledge', 'web')),
  content TEXT NOT NULL,
  embedding vector(768),
  metadata JSONB,
  feedback_score REAL DEFAULT 0,
  created_at TIMESTAMPTZ
);
```

Seeded by `scripts/seed-knowledge.ts` with 8 base topics: protein,
hydration, nausea, constipation, side_effects, injection, plateau,
alcohol. Each chunk is 1-2 sentences with topic metadata.

### Latency cost when RAG fires

| Component | Cost |
|---|---|
| Embed query | ~150ms cached / ~350ms cold |
| pgvector IVFFlat cosine | 50-200ms |
| (optional) sparse FTS | +30-80ms parallel |
| (optional) reranker sidecar | +200-400ms |
| Total stage `rag_planner_memory` | ~247ms avg (after 2026-06-06 skip expansion) |

Without the skip list, RAG would run on every turn — production
telemetry pre-commit `424dc4d` showed `rag_planner_memory` at ~600-800ms
avg. After the skip expansion: ~247ms.

## Brief alignment

The user's brief specified:

### "DO NOT RUN RAG FOR"
- food logging ✅ — `food_log` in skip set
- calorie tracking ✅ — `food_log` covers (calorie tracking happens via tool, no RAG)
- protein tracking ✅ — same as calorie
- weight logging ✅ — `weight_log` in skip set
- profile updates ✅ — handled by settings-flow, never reaches AI pipeline
- onboarding updates ✅ — handled by REST endpoint, no AI involvement
- memory updates ✅ — no RAG involved
- injection day changes ✅ — handled by detectInjectionDayChange short-circuit
- acknowledgements ✅ — fast-path 23 categories
- emotional support ✅ — `emotional` in skip set
- progress discussions ✅ — `progress_today` goes through query-fast
- simple follow-ups ✅ — `followup_walkthrough` is deterministic math, no RAG
- clarification requests ✅ — `general` in skip set
- "why" questions ✅ — `followup_walkthrough` handles these
- "how" questions ✅ — context-dependent; "how does GLP-1 work" hits `knowledge`,
  follow-up "how" hits `followup_walkthrough`

### "RAG SHOULD ONLY BE USED FOR"
- internal document retrieval ✅ — `knowledge` intent
- source-specific answers ✅ — KB with topic metadata
- policy retrieval ✅ — clinical guidelines in `knowledge`
- advanced clinical references ✅ — `knowledge` + `medication_question`
- specialized medical grounding ✅ — `medication_question`

The brief's target state is shipped.

## Decision: no structural change

We do not rebuild retrieval. The current implementation already:

1. Skips RAG for 14 of 16 intents
2. Uses dense + sparse hybrid with optional reranker
3. Has metadata filtering (`source` enum, optional `metadata` JSONB)
4. Caches embeddings for 30 minutes (`gemini-embedder.ts`)
5. Falls back gracefully when reranker is unreachable
6. Biases by RLHF feedback score

When Phase A1 (`FAQ_CACHE_ENABLED=true`) ships, the `knowledge` intent
will additionally have a semantic-cache short-circuit at 0.92 cosine
threshold, eliminating ~3 seconds per cached knowledge question.

## When to revisit

Revisit RAG architecture only if:

- KB grows past ~50,000 chunks (consider partitioning + index tuning)
- Retrieval recall drops below 70% on the eval set (hybrid weights need
  retuning, or move to a different embedding model)
- Reranker sidecar becomes the bottleneck (replace with an in-process
  cross-encoder or drop it entirely)
- A new intent emerges that genuinely needs KB content (add to the
  RUN-not-SKIP list, not the other way around)

Don't disable RAG entirely. The two intents that use it (`knowledge`,
`medication_question`) genuinely benefit from grounded clinical content,
and the brief explicitly allows it for those cases.
