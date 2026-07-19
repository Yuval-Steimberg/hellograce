# Grace Unified

Grace Unified combines Nudge's simple response-generation model with Grace's production platform.

## What is combined

- Nudge: one grounded user-facing model call, short conversational replies, full recent history, deterministic carrier compliance, idempotency, and bounded timeouts.
- Grace: user memory, food and weight logging, multimodal input, SMS/WhatsApp/iMessage routing, reminders, onboarding, dashboards, billing, safety, analytics, and regression coverage.

## Request path

1. Verify and deduplicate the inbound message.
2. Run deterministic crisis and clinical safety checks.
3. Load profile, today's totals, known facts, narrative memory, recent history, and conversation identity in parallel.
4. Serve exact low-latency paths for greetings and authoritative facts such as reminders, dates, injection schedules, water, weight, and food totals.
5. Execute structured logging once when the message mutates user data.
6. Generate normal conversation with one grounded reply call.
7. Apply deterministic format, diet/allergy, numeric-grounding, completeness, and truncation floors.
8. Persist the turn and learn long-term memory asynchronously.

This avoids Grace's former planner/judge/regeneration cascade on ordinary turns while retaining code-enforced accuracy for values the model must never invent.

## Runtime defaults

`UNIFIED_REPLY_PATH=true` is now the default. No secret is required for a new deployment.

Rollback without a code deploy:

```bash
UNIFIED_REPLY_PATH=false
```

The reply model is independently selectable with `LLM_REPLY_PROVIDER=gemini|claude`; extraction, vision, tools, and safety remain on their existing paths.

## Performance contract

- Trivial conversational turns: no model call.
- Structured logs and exact account facts: deterministic whenever possible.
- Ordinary conversation: one user-facing model call.
- Rare retries: capability denial or demonstrably incomplete multi-part answers only.
- Grounded reply timeout: bounded by the unified path timeout, then a deterministic fallback.

Track p50/p95 total latency and the `unified_load`, `food_step`, `memory_recall`, and `grounded_gen` stages in the existing admin latency dashboard. Accuracy should be measured with the existing regression and auto-evaluation suites, split by intent and mutation type.

## Local testing

Run the complete repeatable readiness gate:

```bash
pnpm test:ready
```

This installs locked dependencies, starts isolated local PostgreSQL/pgvector and Redis services, builds the monorepo, runs all automated tests, and runs a unified-system database/configuration smoke test. Stop the services with `pnpm test:services:stop`.

After adding a real `GEMINI_API_KEY` to `services/api/.env`, start the locally configured API with:

```bash
pnpm dev:local
```

The older `verification/run-verification.ts` battery asserts the legacy orchestrator's planner and LLM-judge call counts. It is retained for legacy-path comparisons, but it is not the release gate for `UNIFIED_REPLY_PATH`: the unified path intentionally removes those calls.
