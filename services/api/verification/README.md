# Execution-path verification harness

Production-shaped wiring of the REAL Grace pipeline (webhook → coalescing →
in-flight locks → fast-path/direct-path/orchestrator → guards → BullMQ
workers → Postgres persistence) with exactly three substitutions, all behind
the interfaces production already uses:

| Production            | Harness          | Why |
|-----------------------|------------------|-----|
| `GeminiProvider`      | `StubLLM`        | deterministic, latency-controllable, records every call (class, timestamps, prompt size) |
| `GeminiEmbedder`      | `StubEmbedder`   | deterministic 768-dim vectors so real pgvector retrieval still executes |
| `TwilioSender`        | `CaptureSender`  | records outbound (after the real `sanitizeOutbound`) instead of calling Twilio |

Postgres (all migrations applied) and Redis are REAL local services.

## Requirements

- Postgres 16 + pgvector listening per `HARNESS_DATABASE_URL`
  (default `postgresql://postgres@localhost:5433/grace`) with all
  `supabase/migrations/` applied (use extension name `vector`, not `pgvector`).
- Redis per `HARNESS_REDIS_URL` (default `redis://localhost:6390`).

## Run

```bash
# Full battery (P1..P7): routing, fast-path, tools/memory, guards,
# coalescing/bursts, long-thread scalability, latency model
pnpm --filter @grace/api exec tsx verification/run-verification.ts
# Single phases:
pnpm --filter @grace/api exec tsx verification/run-verification.ts p4 p5

# 24-user concurrent stress run with production-like LLM delays
pnpm --filter @grace/api exec tsx verification/stress.ts
```

The StubLLM classifies every call by system-prompt marker (planner, generation,
relevance_check, behavioral_guard, critic, food_itemize, fact_extractor, …) so
checks can assert WHICH calls ran, that guards ran in parallel (overlapping
timestamps), and that scripted-bad generations get caught by the guard layers
in real execution.
