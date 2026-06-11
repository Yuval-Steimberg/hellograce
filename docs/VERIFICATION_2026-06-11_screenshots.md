# WhatsApp screenshot failures — root cause + global fixes (2026-06-11, session 2)

Six live WhatsApp screenshots showed Grace repeatedly replying with generic
deflections ("I'm here, what's on your mind?", "Hey, what would you like to
talk about?") to clear-intent messages, plus two intent/data errors. Goal:
reproduce, root-cause, fix GLOBALLY (by intent class, not per-message), validate.

## Reproduction

`services/api/verification/repro-screenshots.ts` drives the real pipeline
(real Postgres + Redis) and runs the exact screenshot messages in two modes:
**Gemini healthy** and **Gemini DOWN** (the stub throws on
generation/planner/food-question/emergency — `StubLLM.throwOnClasses`). The
DOWN mode reproduced every screenshot verbatim, confirming the trigger is
**intermittent Gemini failures with no useful degradation**.

## Root causes

1. **No useful degradation when the LLM fails (dominant).** When Gemini
   errored, the orchestrator threw → the emergency Gemini call threw too →
   `handleMessage` rethrew → the webhook `catch` shipped a random generic
   deflection. The provider already retries (3× backoff) + has a fallback
   model, so this is the *terminal* state after retries exhaust (503 / safety
   block / model deprecation).
2. **Classifier/intent gaps (deterministic — failed even with Gemini up):**
   - `detectVagueFood` treated "How about pizza for dinner?" (considering) as
     eaten food → "What did you have at Pizza?"
   - "How much protein I had" matched no query-fast pattern → generic clinical
     range instead of today's logged total.
   - "What is my target?" (no "protein" word) → no deterministic answer.
   - "What I should eat for dinner" (inverted word order) → not food_question.
   - Typos broke intent: "Ima nervous", "stomach herts".
   - Bare food lists ("tuna / rice / avocado") → 'general'.

## Fixes (all global — by intent class, applied system-wide)

| Fix | File | Effect |
|---|---|---|
| **Resilient terminal fallback** — `handleMessage` never throws; on total LLM failure it returns an INTENT-AWARE deterministic reply (food→diet-aware suggestions, symptom→guidance, emotional→reflection, knowledge→curated topic, target→DB) and **never** a generic deflection | `ai.service.ts` `buildResilientFallback` | every intent, every user, every LLM-outage |
| **Personal-stats fast answer** (compound-tolerant) — "what's my target? how much I had?" answered from DB before any LLM | `ai.service.ts` `tryPersonalStats` | immune to Gemini state |
| **query-fast**: bare "what is my target/goal" → protein target; "protein I had/ate/got" → today's total | `query-fast.ts` | deterministic, zero-LLM |
| **vague-food consideration guard** — "how about / should I / thinking about / can I have X" is never a vague *log* | `safety/vague-food.ts` | whole "considering vs ate" class |
| **classifier**: inverted "what I should eat"; "how about X for meal"; bare multi-food lists; typo layer (ima→i'm, herts→hurts, protin→protein, tufu→tofu, felling→feeling, …) matching-only | `classify.ts` | all users, never alters text sent to Gemini |
| **symptom fallback** typo-tolerant ("herts") | `ai.service.ts` | symptom recognition under outage |

## Validation

- `repro-screenshots.ts`: every screenshot message now yields a useful reply in
  BOTH Gemini-healthy and Gemini-DOWN modes; no generic deflection anywhere.
- New verification phase **P10** (8 checks, Gemini-DOWN) asserts no
  generic-deflection string ships and each scenario returns the right shape.
- Full battery: **62/62 pass** (was 54/54; +P10).
- Unit regression tests added: `query-fast.test.ts` (+4), `vague-food.test.ts`
  (+8 considerations), `classify.test.ts` (+8 typos/word-order/food-lists).
- Suites: **647 api + 521 ai-core green**; typecheck clean.

## Re-run

```bash
# local Postgres 16+pgvector :5433 (db grace, all migrations) + Redis :6390
pnpm --filter @grace/api exec tsx verification/repro-screenshots.ts   # before/after view
pnpm --filter @grace/api exec tsx verification/run-verification.ts p10 # regression phase
```
