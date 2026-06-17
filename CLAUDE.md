# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

_Also loaded automatically at session start. Update at the end of every session so the next session resumes without re-deriving context._

---

### Multi-channel: WhatsApp/SMS + iMessage (2026-06-17)

Grace now delivers on **both Twilio (WhatsApp/SMS) and iMessage** simultaneously.
Full setup: `docs/IMESSAGE.md`. The AI pipeline is transport-agnostic.
- **Outbound**: every caller sends through a `MessageSender` (interface in `twilio/sender.ts`).
  `ChannelRouter` (`src/channel-router.ts`) dispatches by `msg.channel`: `'imessage'` →
  `ImessageSender` (LoopMessage relay, `src/imessage/sender.ts`, reuses `sanitizeOutbound` +
  `rewriteCanonicalLinks`); `'whatsapp'|'sms'` → `TwilioSender`. iMessage requested but
  unconfigured → falls back to Twilio WhatsApp (never silent).
- **Inbound**: `webhook.ts` extracted the shared `processInboundMessage(deps, normalized, log)`;
  `POST /webhook/twilio` and new `POST /webhook/imessage` both call it. iMessage payloads map
  via `src/imessage/normalize.ts`; webhook verified via `src/imessage/signature.ts` (shared-secret
  header or HMAC, enforced only in production).
- **Per-user channel**: `users.channel` column (migration `20260617000001_user_channel.sql`,
  default `'whatsapp'`) drives PROACTIVE sends (scheduler reads `user.channel`). Inbound replies
  always go back on the arriving channel. An inbound iMessage auto-aligns `users.channel='imessage'`
  so scheduled check-ins follow. Editable via `PUT /admin/users/:phone {channel}` + admin manual send.
- **Env** (`config/env.ts`): `IMESSAGE_AUTH_KEY` / `IMESSAGE_SECRET_KEY` / `IMESSAGE_SENDER_NAME`
  (all three required to enable) + optional `IMESSAGE_API_URL`, `IMESSAGE_WEBHOOK_SECRET`.
  OFF until configured; WhatsApp/SMS unchanged when off. Log tag: `imessage.channel.enabled`.
- Tests: `imessage/normalize.test.ts` (8), `imessage/signature.test.ts` (4), `imessage/sender.test.ts`
  (6), `channel-router.test.ts` (3). 1094 api tests green, typecheck clean.
- **Caveat**: relay APIs are against Apple ToS (accounts can be throttled) — iMessage is an
  optional channel layered on WhatsApp/SMS, not a replacement.

---

## What this project is

**Grace** — a production-grade WhatsApp/SMS AI companion for people on GLP-1
medications (Ozempic, Wegovy, Mounjaro, Zepbound, compounded semaglutide/tirzepatide).

Users sign up via a web onboarding flow, then receive personalized daily check-ins,
meal/hydration guidance, injection-day flows, and on-demand chat — all via WhatsApp/SMS.
No app required.

The v2 Node.js orchestration service is **live in production**:
- API: `https://grace-api.fly.dev` (Fly.io, region `iad`, 2 machines)
- Admin web + onboarding: deployed to Vercel as `grace-admin` (alias `https://grace-admin-silk.vercel.app`) with `VITE_API_URL=https://grace-api.fly.dev`
- Twilio WhatsApp sandbox webhook points at `https://grace-api.fly.dev/webhook/twilio`
- End-to-end verified 2026-05-12 with a real WhatsApp message.
- KB re-embedded against `gemini-embedding-001` (768-dim) — RAG returns real GLP-1 knowledge.
- Multimodal fully working: voice notes (transcribed via Gemini File API), food photos (per-item USDA breakdown + auto log_food), body/progress photos (compassionate GLP-1-aware analysis). All fixed 2026-05-13.

Open follow-ups: add a Fly payment method (trial machines auto-stop after 5 min idle),
get a WhatsApp Business sender approved by Meta to drop the "Twilio Sandbox:" prefix,
set the 5 Vercel env vars (`VITE_API_URL`, `VITE_WHATSAPP_NUMBER`, `VITE_WHATSAPP_JOIN_CODE`,
`VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`), disable the legacy v1
`handle-inbound-sms` edge function once 24h of stable v2 traffic is confirmed.

---

## Repo layout

```
.
├── apps/
│   └── web/                # @grace/web — Vite + React + shadcn/ui
│                           # Onboarding flow + admin dashboard at /admin
├── services/
│   └── api/                # @grace/api — Fastify orchestration service (v2)
│                           # All AI, scheduling, webhooks, admin API
├── packages/
│   ├── shared/             # @grace/shared — canonical TS types
│   └── ai-core/            # @grace/ai-core — pure orchestrator, planner, validator
├── supabase/
│   ├── functions/          # Legacy v1 edge functions (Deno) — still live in prod
│   └── migrations/         # SQL migrations
├── docs/
│   ├── STATUS.md           # Phase tracker + open todos
│   ├── OPERATIONS.md       # Production setup guide + subscriptions + admin
│   ├── CACHING.md          # Canonical caching + latency reference (every layer documented)
│   ├── USER_GUIDE.md       # End-user guide (share with users)
│   └── WELCOME_EMAIL.md    # Welcome email template with personalization notes
├── docker-compose.yml      # One-command local: Postgres+pgvector + Redis + api
└── CLAUDE.md               # This file
```

---

## Architecture (v2 — fully built)

```
WhatsApp/SMS (Twilio)
        │
        ▼
POST /webhook/twilio
        │
        ├── isAccessAllowed() — 3-day trial / is_paid / is_pro gate
        ├── UserService.ensureUser() — upsert, update last_reply_at
        ├── injection "done" detection → advances state machine
        ├── RLHF feedback intercept (👍/👎/FEEDBACK:) for opted-in users
        ├── shouldSkipCoalesce() — trivial messages bypass the 2s buffer
        │
        ▼
AIService.handleMessage()
        │
        ├── tryFastPath() — 14 categories of trivial messages (greetings,
        │                   brief feelings, thanks, goodnight, etc.) get
        │                   instant deterministic replies, ZERO LLM call.
        │                   Pure latency win: ~150ms instead of ~3s.
        ├── analyzeMedia() — if media present (runs before orchestrator)
        │     ├── fetchMedia() with Twilio Basic Auth (SID:token)
        │     ├── image → classifyImage() → 'food' | 'body' | 'other'
        │     │     ├── food  → per-item USDA breakdown (ITEMS/BREAKDOWN/TOTAL/NOTES)
        │     │     └── body  → GLP-1-aware progress analysis (muscle + encouragement)
        │     └── audio → Gemini File API upload → transcribe → delete
        │
   ┌────┴───────────────────────────────────────┐
   ▼                   ▼                        ▼
SafetyGuard      MemoryService            RagService
(crisis check)   (Postgres history)       (pgvector + RLHF weights)
        │
        ▼
AIOrchestrator (packages/ai-core)
   ┌────┴──────┐
   ▼           ▼
Planner    ToolRegistry (8 tools, DB-gated)
   │
GeminiProvider (gemini-2.5-flash) → Validator → RelevanceCheck (gemini-2.0-flash)
   │
BullMQ turn-persist worker → Postgres
   │
TwilioSender → WhatsApp/SMS
```

**Scheduler** (node-cron, in same process as API):
- Every minute → proactive messages per user (timezone-aware)
  - Morning at wake_time (daily — the "at least 1/day" anchor)
  - Midday Mon/Wed/Fri 11am–2pm local (only fires if engaged today or <1 day silent)
  - Evening Tue/Thu/Sun 90min before sleep_time (only fires if user replied today)
  - Injection day flow (4 stages: morning_sent → done_confirmed → followup_sent → day-after)
  - Side-effect follow-up 4h after keyword detected
  - Bonus spontaneous nudge: 1 extra daily message at a varied random time (adds variety to the schedule)
- **Engagement dampener** (`userEngagedToday`, `userSilentDays` helpers): caps a silent user at 2 messages/day (morning + 1 nudge), drops to 1/day (morning only) after >1 day of no reply. Engaged users still get the full 3-message schedule.
- **Engagement cooldown** (Phase 15, configurable via `ENGAGEMENT_COOLDOWN_HOURS`, default 2h): after a user sends a message, ALL non-critical proactive types are suppressed for the cooldown window. Resets on every user reply. Critical-exempt types (always allowed): `injection_morning`, `injection_followup`, `trial_expiry_reminder`. `injection_dayafter` is NOT exempt — it's a check-in, not urgent. Logs `scheduler.engagement_cooldown_active` with the elapsed hours.
- **Message coalescing**: 2s window to merge rapid multi-message sends into a single AI turn. Trivial messages (greetings, brief acks, thanks, goodnights, etc.) bypass coalesce via `shouldSkipCoalesce()` for instant response.
- Daily 3am UTC → personalization engine (low_mood_mode, midday_skip)

---

## Subscription model

| Tier | DB flag | Stripe price ID | Access |
|---|---|---|---|
| Free trial | `trial_start` set | — | 3 days from signup |
| Standard | `is_paid = true` | `price_1TLha4E0DcWyPH4X2QxV9hh3` | Full AI + proactive |
| Pro | `is_pro = true` | `price_1TLla9E0DcWyPH4XZnep2X7G` | Full + priority |

Stripe flow (v1 Supabase edge functions, still active):
1. `create-checkout` → Stripe subscription with 3-day trial
2. `confirm-checkout` → marks `is_paid = true` in shared DB
3. `stripe-webhook` → syncs subscription events → `is_paid`/`is_pro`

v2 API reads `is_paid`/`is_pro` from the same Postgres DB — no duplication needed.
Subscription gate in `webhook.ts` fires paywall message if trial expired and not paid.

---

## Complete API surface

### Public
- `POST /webhook/twilio` — Twilio inbound (WhatsApp + SMS)
- `POST /chat/send` — demo/testing chat endpoint
- `GET /chat/stream/:conversationId` — SSE live message stream
- `GET /chat/history/:userId` — last 100 messages for a user
- `POST /users/onboard` — create user profile + set trial_start + send welcome WhatsApp
- `DELETE /users/:phone/data` — GDPR self-serve data deletion
- `GET /health` — liveness check

### Admin (Bearer `ADMIN_TOKEN` required)
- `GET /admin/metrics` — messages/tools/feedback/cache stats + `user_stats` breakdown (auto-refresh 30s)
- `GET /admin/conversations` + `/:userId/messages` — conversation viewer
- `GET /admin/users?limit&offset` — paginated user list; includes `rlhf_enabled`
- `GET /admin/users/:phone` — full user detail: profile + check-in history + weight logs + message count
- `PUT /admin/users/:phone` — update any profile/account field (Zod-validated)
- `DELETE /admin/users/:phone` — hard delete user + all data
- `POST /admin/users/:phone/reset-memory` — wipe messages/conversations/embeddings
- `PUT /admin/users/:phone/rlhf` — toggle `rlhf_enabled` for a user `{ enabled: boolean }`
- `GET|POST /admin/feedback` — RLHF signal viewer + submit
- `GET|POST /admin/prompts` — system prompt versions
- `PUT /admin/prompts/:id/activate` — hot-swap active prompt (atomic)
- `GET /admin/tool-settings` + `PUT /admin/tool-settings/:name` — tool toggles

---

## Tools (9 registered per-request, admin-toggleable)

| Tool | What it does |
|---|---|
| `log_food` | LLM-estimates protein/kcal for food text (handles multi-item + pre-calculated totals from image analysis), writes to `food_logs` |
| `log_weight` | Records lbs to `weight_logs` |
| `log_mood` | Records mood score 1–10 |
| `knowledge_search` | pgvector RAG over GLP-1 knowledge base |
| `get_user_profile` | Returns user's goals, medication, weight, behavioral flags |
| `get_weight_trend` | Last 10 weight entries + up/down/stable trend |
| `get_food_summary` | Today's protein + calories + protein_goal_met (≥80g target) |
| `log_side_effect` | Sets side_effect_flow → schedules 4h follow-up message |
| `search_food_ideas` | Calls Gemini with Google Search grounding to find current, varied, diet-specific meal/snack ideas. Builds query with dietary restriction + food dislikes + "GLP-1 friendly". Grace calls this for all food recommendation requests. |

---

## Database migrations (apply in order)

```bash
psql "$DATABASE_URL" -f supabase/migrations/20260507000001_grace_v2_core.sql
psql "$DATABASE_URL" -f supabase/migrations/20260507000002_grace_v2_phase4.sql
psql "$DATABASE_URL" -f supabase/migrations/20260507000003_grace_v2_users.sql
psql "$DATABASE_URL" -f supabase/migrations/20260508000001_rlhf_user_flags.sql
psql "$DATABASE_URL" -f supabase/migrations/20260513000001_prompt_optimizer_columns.sql
psql "$DATABASE_URL" -f supabase/migrations/20260513000002_protein_personalization.sql
psql "$DATABASE_URL" -f supabase/migrations/20260513000003_glp1_start_date.sql
psql "$DATABASE_URL" -f supabase/migrations/20260516000005_content_rules.sql
psql "$DATABASE_URL" -f supabase/migrations/20260527000001_enable_rls_all_tables.sql
psql "$DATABASE_URL" -f supabase/migrations/20260528000001_calorie_goal.sql
psql "$DATABASE_URL" -f supabase/migrations/20260601000001_real_data_corpus.sql
psql "$DATABASE_URL" -f supabase/migrations/20260601000002_content_rules_auto_fix_type.sql
```

**`20260516000005_content_rules.sql`** — IMPORTANT: run in Supabase SQL Editor with "No limit" toggle OFF (not in Neon). Creates `content_rules` table + 48 seed rules. Verify with: `SELECT severity, COUNT(*) FROM content_rules GROUP BY severity;` → should show `block: 4, regen: 44`.

**`20260527000001_enable_rls_all_tables.sql`** — Enables Row Level Security on all 16 public tables. Default-deny policy blocks the Supabase `anon` key from reading/writing any table. Service-role and direct connections (used by the API) are unaffected.

Core tables: `users`, `conversations`, `messages`, `embeddings`, `tool_logs`,
`feedback`, `food_logs`, `weight_logs`, `check_ins`, `injections`, `prompts`, `tool_settings`.

Key columns:
- `20260508000001`: `users.rlhf_enabled BOOLEAN DEFAULT FALSE`
- `20260513000002`: `users.age INT`, `users.primary_goal TEXT`, `users.protein_goal_grams INT`
- `20260513000003`: `users.glp1_start_date DATE` — drives accurate week-number context

---

## Credentials (local dev)

All secrets live in `services/api/.env` (gitignored — never commit it).
The following are already filled in for this project:

| Variable | Status |
|---|---|
| `GEMINI_API_KEY` | ✅ set in `.env` and Fly secrets |
| `REDIS_URL` | ✅ Upstash TLS, in `.env` and Fly secrets |
| `DATABASE_URL` | ✅ Supabase Transaction Pooler (`aws-1-ap-northeast-1.pooler.supabase.com:6543`) |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` | ✅ in `.env` and Fly secrets (auth token rotated 2026-05-12) |
| `TWILIO_WHATSAPP_FROM` | ✅ sandbox `whatsapp:+14155238886` |
| `PUBLIC_BASE_URL` | ✅ `https://grace-api.fly.dev` in Fly secrets — used by Twilio signature verification |
| `ADMIN_TOKEN` | ✅ set in `.env` and Fly secrets |
| `ENGAGEMENT_COOLDOWN_HOURS` | ⚙️  Optional, default 2. Window in hours during which scheduled non-critical proactive messages are suppressed after the user replies. Set to 0 to disable. |
| `ADMIN_PHONE` | ✅ set in Fly secrets (`+972547722420`) — receives WhatsApp RLHF optimizer report after each nightly run |

Full deployment instructions: `docs/DEPLOY.md`

---

## Commands

```bash
pnpm install

# Run everything via Docker (Postgres + Redis + API on :3001)
export GEMINI_API_KEY=your-key
docker compose up -d
pnpm --filter @grace/api exec tsx scripts/seed-knowledge.ts

# Local API dev (no Docker)
cp services/api/.env.example services/api/.env && vim services/api/.env
pnpm --filter @grace/api dev

# Tests / typecheck / build
pnpm test          # 47 tests, all green
pnpm -r typecheck  # clean across all 4 packages
pnpm -r build

# Single test file / single test by name (vitest)
pnpm --filter @grace/api test -- guard.test
pnpm --filter @grace/ai-core test -- -t "planner"

# Eval harness — measures accuracy/safety across ~50 GLP-1 cases
# Requires GEMINI_API_KEY. No DB needed (tools are mocked).
pnpm --filter @grace/api eval
# Filter / tune concurrency:
EVAL_FILTER=food EVAL_CONCURRENCY=5 pnpm --filter @grace/api eval

# Auto-eval — multi-turn simulated conversations with LLM judge
# Generates realistic user interactions via 20 personas × 43 scenarios,
# runs them through the real orchestrator, evaluates with a detailed
# 15-dimension LLM rubric, detects patterns, and generates RLHF preference pairs.
# Requires GEMINI_API_KEY. No DB needed (tools are mocked).
pnpm --filter @grace/api auto-eval
# Filter by category / persona / limit scenario count:
AUTO_EVAL_CATEGORIES=food_logging,emotional_support pnpm --filter @grace/api auto-eval
AUTO_EVAL_PERSONAS=sarah_new,mike_terse pnpm --filter @grace/api auto-eval
AUTO_EVAL_SCENARIOS=10 AUTO_EVAL_CONCURRENCY=3 pnpm --filter @grace/api auto-eval
# Skip preference pair generation:
AUTO_EVAL_SKIP_PAIRS=1 pnpm --filter @grace/api auto-eval
# Use a different model for evaluation:
GEMINI_EVALUATOR_MODEL=gemini-2.5-pro pnpm --filter @grace/api auto-eval

# Hot-reload system prompt without restart
docker kill --signal HUP grace-api-1  # or: kill -HUP <api-pid>

# Demo (no Twilio needed)
curl -X POST http://localhost:3001/chat/send \
  -H "Content-Type: application/json" \
  -d '{"userId":"+15551234567","text":"I just had chicken and rice"}'
```

> If `pnpm` is missing on a fresh machine: `corepack enable pnpm && corepack prepare pnpm@9.12.0 --activate`.

---

## Working agreements

- **Active branch**: `main`. Prior feature branches have all been merged — cut new branches off `main` and PR back when ready.
- **Don't break Twilio contract.** `POST /webhook/twilio` accepts Twilio form payload, replies empty TwiML. Outbound goes via `TwilioSender` async.
- **Keep `@grace/ai-core` pure.** No `pg`, no `pino`, no env reads. Inject all deps.
- **Tests first for orchestration changes.** 47 tests, keep them green.
- **No Lovable.** No `lovable-tagger`, no `ai.gateway.lovable.dev`.
- **Commit messages: imperative, focused on why.**

---

## Canonical deploy workflow

**Always use this exact sequence to deploy to production. Do not improvise alternatives.**

The flow: work on a feature branch → open a PR → merge via GitHub (squash) → user runs the command below to pull latest main and deploy.

```bash
cd "$(git -C ~/Grace rev-parse --show-toplevel 2>/dev/null || find ~ -maxdepth 4 -type d -name Grace -exec test -d '{}/.git' \; -print 2>/dev/null | head -1)"
git fetch origin
git checkout main
git pull origin main
fly deploy --app grace-api --config services/api/fly.toml --no-cache
```

Why each piece exists:
- `cd "$(...)"` — the user's repo isn't at `~/Grace`; this finds the real Git toplevel wherever it lives. Failing silently in zsh was a recurring bug.
- `git fetch origin` — refreshes remote-tracking refs. Without this, `git merge` and `git pull` operate on stale local copies of remote branches and silently say "Already up to date".
- `git pull origin main` — fast-forwards local main to remote HEAD (which now includes the squash-merged PR).
- `--no-cache` — Depot's build cache aggressively reuses layers keyed on file content, but quirks have caused "all CACHED" deploys to ship stale code. `--no-cache` adds ~3 minutes but guarantees the new code compiles into the image. Use it on every production deploy.

**Verification after deploy:**
- `git pull origin main` should report `Updating XXXX..YYYY  Fast-forward` (NOT "Already up to date")
- The build should run `[build 5/5] RUN pnpm ... build` for ~11s (NOT `CACHED`)
- `curl https://grace-api.fly.dev/health` returns `{"status":"ok",...}`
- `fly logs --app grace-api | grep <log-tag-for-the-new-code>` shows the new path firing on real traffic

---

## Accuracy / eval harness

Lives in `services/api/eval/`. Runs every case through real Gemini + mocked tools, grades against expected intent / tool calls / required + forbidden phrases / length bounds, writes JSON to `eval/results/<timestamp>.json`.

- `eval/cases.ts` — the dataset. Add a case when you fix a real failure so it doesn't regress.
- `eval/grade.ts` — deterministic checks (no LLM judge yet — coming in Step 2).
- `eval/runner.ts` — concurrent runner + report formatter.
- Crisis/emergency wording is NOT in the eval set — `SafetyGuard` short-circuits the pipeline before the orchestrator runs, and is unit-tested in `services/api/src/safety/guard.test.ts`.

### Auto-evaluation system (advanced)

Lives in `services/api/auto-eval/`. A multi-turn simulated conversation engine with LLM-powered evaluation.

**Architecture:**
```
auto-eval/
├── types.ts                    # All type definitions
├── personas.ts                 # 20 user personas (varied styles, medications, goals)
├── scenarios.ts                # 43 scenario templates across 15 categories + dynamic generation
├── conversation-generator.ts   # LLM-powered realistic user message generation
├── simulator.ts                # Runs multi-turn conversations through the real orchestrator
├── evaluator.ts                # 15-dimension LLM judge (Gemini) with per-turn + conversation-level scoring
├── analyzer.ts                 # Pattern detection, regression tracking, improvement suggestions
├── preference-pairs.ts         # RLHF preference pair generation (chosen/rejected)
├── reporter.ts                 # Human-readable terminal reports + JSON
├── store.ts                    # JSON file storage for all artifacts
├── runner.ts                   # Main 5-phase pipeline orchestrator
└── index.ts                    # Public exports
```

**15 evaluation dimensions** (each scored 1-5):
relevance (HIGHEST PRIORITY), context_memory, tone_match, conciseness, naturalness, no_repetition, no_generic_fallback, conversational_continuity, no_unnecessary_questions, no_hallucination, guardrail_compliance, topic_tracking, empathy, actionability, persona_awareness.

**20 personas** spanning: terse/verbose/emoji/formal/anxious/casual communication styles, all medication types (weekly injection, daily pill), dietary restrictions (vegan, vegetarian, pescatarian), emotional states (frustrated, anxious, celebratory, lonely), edge-case behaviors (typos, mixed language, topic switching, boundary testing).

**15 scenario categories**: food_logging, emotional_support, topic_switching, medical_question, correction, frustration, multi_question, slang_typos, injection_day, side_effects, weight_tracking, edge_case, onboarding, long_term_memory, proactive_response.

**Pipeline phases:**
1. Simulate — generate realistic user messages per persona, run through real orchestrator with mocked tools
2. Evaluate — LLM judge scores each Grace response on 15 dimensions + conversation-level assessment
3. Analyze — detect recurring failure patterns, compare against previous runs for regressions
4. Preference pairs — generate RLHF-style chosen/rejected pairs for low-scoring turns (LLM generates improved alternatives)
5. Report — terminal output + JSON artifacts stored in `auto-eval/results/`

**Output artifacts** (all in `auto-eval/results/`):
- `conversations/` — full simulated conversation transcripts with orchestrator metadata
- `evaluations/` — per-conversation evaluation breakdowns
- `preference-pairs/` — RLHF training data (context + chosen + rejected + reasoning)
- `reports/` — aggregate run reports with category/dimension breakdowns, patterns, regressions

**Feedback loop** (`auto-eval/feedback-loop.ts`) — closes the auto-eval → live chatbot loop via three mechanisms:

1. **Preference pairs → prompt optimizer**: Auto-eval preference pairs are loaded at server startup and injected into the nightly `PromptOptimizer` as synthetic negative feedback. The optimizer sees both real RLHF 👎 ratings AND simulated low-quality responses, giving it thousands of additional learning signals. Flow: `auto-eval/results/preference-pairs/*.json` → `loadPreferencePairs()` → `pairsToSyntheticFeedback()` → `promptOptimizer.injectSyntheticFeedback()` → merged into `gatherSignals()` negative samples.

2. **Eval-gated prompt activation**: Before any prompt is activated (both admin `PUT /admin/prompts/:id/activate` and nightly auto-activation), a quick auto-eval run (8 scenarios) checks the overall score against `EVAL_GATE_BASELINE` (default 2.5). If the score drops below baseline, activation is blocked and the prompt is saved as a draft for manual review. Skip with `?skip_eval=1` on the admin endpoint. Set baseline via `EVAL_GATE_BASELINE` env var.

3. **Auto-generated content rules**: `POST /admin/content-rules/auto-generate` analyzes all stored auto-eval evaluations, detects recurring failure patterns (frequency ≥ 3, score impact ≥ 1.5), and uses Gemini to generate runtime content-checking rules. Rules are inserted as **inactive drafts** (`is_active = false`) — an admin must review and activate them. Only `regen`/`log` severity allowed (never `block`).

Roadmap (in progress, in this order):
1. ✅ Eval harness + 50-case dataset (`services/api/eval/`).
2. ✅ LLM-critic on risky intents (`safety_*`, validator-flagged `possible_medical_advice`, or low-confidence). `knowledge_lookup` removed from risky list (2026-05-15) — it was incorrectly failing food/nutrition responses. Regenerate once on critic fail, safe fallback if second attempt also fails. Implementation: `packages/ai-core/src/critic.ts` + orchestrator wiring.
3. ✅ Fact-grounding: deterministic precheck (`packages/ai-core/src/grounding.ts`) detects quantitative medical claims (doses, durations, frequencies, percentages) and interaction-safety assertions in the response and verifies them against retrieved KB chunks. Unsupported claims fail-close to regen — saves a Gemini call vs. invoking the LLM-critic. Surfaced via `CriticReport.unsupportedClaims` + `source: 'precheck' | 'llm'`.
4. ✅ Eval-gated prompt activation + auto-eval preference pairs → prompt optimizer + auto-generated content rules. Implementation: `auto-eval/feedback-loop.ts`, wired into `prompt-optimizer.ts` + `routes/admin.ts` + `server.ts`.
5. ✅ LLM relevance checker (`packages/ai-core/src/relevance-check.ts`): post-generation semantic verification using `gemini-2.0-flash`. Topic-closer history stripping + ratio-based drift detection. Emergency LLM fallback for pipeline crashes.
6. ⏳ Gemini prompt caching for static system prompt + tool defs; skip planner for pure-chat intents.

---

## Phase completion status

| Phase | Scope | Status |
|---|---|---|
| 1 | Monorepo, Fastify, Twilio webhook, Gemini orchestrator, memory + RAG, tests | ✅ |
| 2 | Real tools, safety, RLHF feedback, admin API, multimodal | ✅ |
| 3 | Redis cache, BullMQ workers, SSE streaming, per-tool timeouts | ✅ |
| 4 | Admin dashboard (web app) | ✅ |
| 4b | Full chatbot: users, scheduler, proactive messages, all tools, onboarding API | ✅ |
| 4c | Subscription gate, GDPR delete, chat history, admin user CRUD | ✅ |
| 4d | User-side RLHF: per-user ratings + feedback comments, admin toggle | ✅ |
| 4e | Admin dashboard overhaul: user drawer, create modal, richer metrics | ✅ |
| 5 | Cut Twilio webhook from v1 → v2 | ✅ live at `https://grace-api.fly.dev` |
| 6 | Multimodal: voice notes + food photos + body/progress photos | ✅ Gemini File API audio, image classification, per-item nutrition, body analysis |
| 6b | Admin dashboard premium redesign + animated landing page | ✅ deep slate + indigo admin shell, colorful animated blob background |
| 7 | AI quality pass from WhatsApp QA: persona, hallucination guards, quiet hours, settings redirect, food-dislike paraphrase, brief-reply rule, GLP-1 week number, 50+ emotional patterns | ✅ |
| 8 | Master prompt operationalization: full prompt rewrite from `gracemasterprompt.md`, unified safety message (988+911), reminder-style proactive messages, in-chat frequency change, natural-language opt-out, runtime context (Today is / Time of day / Total protein TODAY / Scheduled check-ins sent today / Medication type) | ✅ |
| 9 | Production quality pass: proactive message label/truncation fix, humanized timing jitter, trial Day 2 reminder, RLHF on proactive messages, admin WhatsApp optimizer report, food recommendation rules, every-response-unique rule, critic tuned for food facts, safe fallback improved, name stripping in code | ✅ 2026-05-15 |
| 10 | DB-driven content guardbands: `content_rules` table (48 rules: 4 block + 44 regen), `ContentRulesService` with 60s cache, applied to both reactive AI and proactive scheduler paths. Admin CRUD + test endpoint. Redis distributed lock on scheduler to prevent duplicate messages across Fly machines. | ✅ 2026-05-16 |
| 11 | AI quality pass: GREETING RULE (pure greeting → one sentence, topic reset), FOOD VARIETY rule + 40-food pool, `search_food_ideas` tool (Google Search grounding for food questions), two-pass scientific food image analysis (Pass 1: visual ID with USDA anchors; Pass 2: text-only macro calculation with 50-food USDA table). | ✅ 2026-05-19 |
| 12 | Auto-evaluation system: 20 personas × 43 scenarios × 15 categories, multi-turn conversation simulation through real orchestrator, 15-dimension LLM judge, pattern detection, regression tracking, RLHF preference pair generation. `pnpm --filter @grace/api auto-eval`. | ✅ 2026-05-24 |
| 13 | Security hardening + Conversation intelligence + Production quality: RLS on all tables, LLM relevance checker, topic-closer history stripping, medical tone graduated escalation, message coalescing 3.5s, bonus spontaneous reminders, emergency LLM fallback, optimizer switched to gemini-2.0-flash, Docker fix. | ✅ 2026-05-27 |
| 14 | QA tools + behavioral defense + calorie parity: regression suite (`/admin/regression`, 17 scenarios replaying every fixed bug), production-realistic replay tool (`/admin/replay` with in-memory orchestrator + mock tools), prompt-version diff, auto-eval presets/category filter, calorie tracking full parity with protein (Mifflin-St Jeor + activity + GLP-1 deficit, force tool calls, prompt rules, content rules), behavioral guard (LLM judge against 10 principles), generalized content checker (catch-all regexes), force log_food with classifier + safety net + continuation. | ✅ 2026-05-28 |
| 15 | Latency + comprehensive feedback pass: fast-path responder (14 categories of trivial messages get instant ~150ms replies skipping LLM entirely), parallel LLM guards (relevance + behavioral + critic via Promise.all), per-intent token budgets, coalesce 3.5s→2s + bypass for fast-path messages, RAG embed cache 5min→30min, critic on gemini-2.0-flash + disableThinking, image follow-up context (preserves analyzed image across turns), food-log preamble leak guard, privacy rule strict scoping (no more misfires on self-referencing health questions), banned-phrase expansion (18 new patterns), list-format hardening, appointment_prep intent + classifier, EMOTION BEFORE DATA rule, ANSWER ONLY THE CURRENT MESSAGE rule with 7 production-failure examples, clinical redirect template, plateau-feeling education rule, two-question detector, protein-from-current-weight guard, configurable engagement cooldown (suppresses non-critical proactive messages within ENGAGEMENT_COOLDOWN_HOURS of any user reply — default 2h, set via env). | ✅ 2026-05-30 |
| 16 | Deep-research coverage expansion: 22 new FAQ seeds across 10 new categories (travel, injection site rotation, dose timing, exercise during nausea, sleep, pregnancy redirect, diarrhea, heartburn, alcohol expanded, hangover recovery) + 5 new classifier intents (`exercise_log`, `injection_log`, `medication_question`, `social_situation`, `pause_request`) + 11 new verified-knowledge sections in `prompts.ts` (diarrhea / heartburn / injection site rotation / dose escalation / travel / alcohol / sleep / pregnancy redirect / exercise / medication questions / social situations) + pause/auto-resume via webhook short-circuit + SafetyGuard now runs BEFORE all webhook short-circuits + intent library (51 hand-curated entries across 10 domains in `services/api/coverage/intents.json`) + `taxonomy.md` / `safety-framework.json` / `journey-map.json` + Gemini-driven question generator (`scripts/generate-coverage-questions.ts`) + coverage test suite (`services/api/coverage/suite.ts`, `runner.ts`, `grader.ts`, `reporter.ts`) feeding through real orchestrator via `runSandboxReplay` + admin UI `/admin/coverage` with domain/safety filters and case-by-case view + admin endpoints `GET /admin/coverage/intents`, `POST /admin/coverage/run`, `GET /admin/coverage/runs[/:runId]`, `POST /admin/coverage/ingest` (classify CSV of prod messages → discover uncovered intents) + 50-case coverage smoke wired into the 4am UTC optimizer cron with pass-rate delta appended to admin WhatsApp report. | ✅ 2026-05-31 |
| 17 | Real-world conversation research: unauthenticated Reddit JSON scraper (`services/api/src/research/reddit-scraper.ts`) for 8 GLP-1 subreddits (Ozempic, Mounjaro, Zepbound, WegovyWeightLoss, Semaglutide, GLP1, loseit, WeightLossAdvice) with SHA-256 username hashing + NSFW/stickied/deleted/link-only filtering + 17 unit tests; new `real_data_corpus` Postgres table (migration `20260601000001_real_data_corpus.sql`) with content_hash dedup + indexed by intent/subreddit/status/scraped_at; `CorpusService` (`services/api/src/research/corpus.service.ts`) with four idempotent stages — `ingestPosts` (dedup) → `classifyAndCheckCoverage` (deterministic classifier + nearest-intent token-overlap matcher) → `replayAndGrade` (sandbox replay + deterministic grader) → `evaluateFailures` (15-dimension LLM evaluator ONLY on grade fails OR uncovered intents); admin endpoints `POST /admin/research/scrape`, `POST /admin/research/upload` (Facebook / forum CSV ingest), `GET /admin/research/corpus`, `GET /admin/research/corpus/:id`, `POST /admin/research/corpus/:id/promote` (returns suggested `intents.json` entry), `POST /admin/research/corpus/:id/reject`, `GET /admin/research/coverage-gaps`; weekly cron at Sunday 5am UTC pulls top-of-week from each subreddit + classifies + replays + LLM-evals failures + sends admin WhatsApp summary; admin UI `/admin/research` with Corpus tab (filterable by subreddit/intent/coverage/status) + Coverage Gaps tab (top uncovered posts prioritized by upvote, breakdown by intent + subreddit, weakest LLM-eval dimensions) + side-panel detail with Grace's replay + grade verdict + eval scores + Promote/Reject actions. | ✅ 2026-06-01 |

---

### Settings = single source of truth (2026-06-09)

Profile, dietary, and reminder fields are owned EXCLUSIVELY by the Settings page. Grace may **read** them in chat but must **never** create, save, overwrite, or confirm a change to them from a chat message — that prevents a conflicting second source of truth. Enforced deterministically (before the AI ever runs) so it can't drift:

- **`services/api/src/services/settings-flow.ts`** — `tryHandleSettings()` now only READS + REDIRECTS. The two-phase Redis confirm/apply flow and all chat writes were removed. READ requests answer + append the Settings URL (unchanged). UPDATE requests (timezone, medication, dose, weights, height, sex, name, age, primary goal), dietary-identity changes (`DIETARY_CHANGE_PATTERNS`: "I'm vegan now", "change my diet", "I no longer keep kosher", "remember I don't eat meat"), and food-dislike adds all return the verbatim `PROFILE_REDIRECT` message. Deps slimmed to `{ logger }` (no more `users`/`redis`). Dietary patterns are conservative — a passing mention like "I'm vegan, what should I eat?" still flows to food-ideas.
- **`services/api/src/routes/webhook.ts`** — `detectFrequencyChange()` (which wrote `checkin_count_per_day`) replaced by `isFrequencyChangeRequest()` → sends `REMINDER_REDIRECT_REPLY` to Settings. No cadence write from chat.
- **SOLE EXCEPTION:** injection-day change, still handled in-chat by `detectInjectionDayChange()` (writes `injection_day`).
- **`packages/ai-core/src/prompts.ts`** — SETTINGS MANAGEMENT + CHECK-IN FREQUENCY sections rewritten to "redirect, never confirm in chat / never claim to remember"; the only in-chat exception is injection day. Starting-weight redirect no longer offers "tell me 'set my starting weight to ___'".
- Tests: `settings-flow.test.ts` rewritten to assert redirect (no writes). Full suite green (615 api + 513 ai-core).
- **Follow-up:** the legacy v1 `supabase/functions/handle-inbound-sms` edge fn still has its own chat-write settings flow ("Reply yes to confirm"). It's not the live v2 path, but disable/align it before re-enabling v1 as a fallback.

---

### Reliability verification + fixes (2026-06-10)

Full-system verification report: `docs/RELIABILITY_VERIFICATION_2026-06-10.md` — evidence-based
PASS/FAIL for nutrition, memory, context, reminders, conversation protection, profile/settings,
recommendations, injection day, data consistency. Two production-critical failures found and
fixed the same session, plus five smaller items. Branch `claude/grace-reliability-verification-r77eph`.

**Fixed — webhook message loss (CRITICAL, regression since `a2ae4bc` 2026-06-04):**
- The per-user in-flight lock ran BEFORE coalescing, so any follow-up arriving while a
  turn was processing (including within the 2s coalesce window) failed `SET NX` and was
  silently dropped — coalescing was dead code in production.
- `webhook.ts` now: (1) coalesces FIRST (buffer append before any lock), (2) the in-flight
  lock WAITS with bounded retries (`acquireInflightSlot`, 15×1s, exported + tested) instead
  of dropping, (3) `coalesceMessages` explicitly releases its window lock after draining —
  previously it relied on the 5s TTL, so messages arriving 2–5s after the first were
  absorbed into an already-drained window and lost.

**Fixed — scheduler ignores cadence Settings (CRITICAL):**
- `checkin_count_per_day` / `checkin_days_interval` were collected at onboarding, editable
  in Settings, claimed by the AI context ("CHECKIN FREQUENCY: N") — and never read by the
  scheduler (hard-coded 2/day cap). `sendAndRecord` now honors `checkin_count_per_day`
  (clamped 1..3, default 2 — default behavior unchanged) and `checkin_days_interval`
  (every-N-days, phase = user-local day number mod interval). Critical health flows
  (`injection_morning`, `injection_followup`, `trial_expiry_reminder`) remain exempt.
  The AI context line now reports the same clamped value.

**Also fixed:** injection "done" reply now gets a deterministic injection-aware ack
(short-circuits before fast-path's generic "Got it 👍"; state machine unchanged);
`reset-memory` admin endpoint wraps core deletes in a transaction + invalidates the
memory.md cache; `user_memories` retrieval adds a recency penalty (0 under 30 days,
max +0.30 distance at ~390 days) so old memories can't permanently outrank new
corrections; RAG `feedback_score` contribution clamped to ±0.25; date-flaky
`curated-meal-ideas` test de-flaked (asserts spread across 10 users).

**Deliberately deferred:** dedicated `allergies` column (functionally enforced today via
`food_dislikes`; needs coordinated web-UI + v1 edge-fn changes — product decision);
disabling the dormant v1 `handle-inbound-sms` settings-write path (prod Supabase action,
already in open items). Tests: 627 api + 513 ai-core green.

---

### Execution-path verification + production fixes (2026-06-11)

Branch `claude/grace-production-readiness-x2k1oj`. Full report:
`docs/VERIFICATION_2026-06-11.md`. New tooling: `services/api/verification/`
— a production-shaped harness (real webhook→coalesce→locks→AI→workers→Postgres
pipeline on local Postgres+Redis; deterministic stub LLM/embedder/sender that
records every LLM call) with a 54-check battery (P1-P9, incl. deterministic
content accuracy + anti-hallucination/context phases) + 24-user stress run.
All green; 635 api + 513 ai-core tests green.

**Fixed (production):**
1. Fast-path silent drops — `'Hi 🤍'`, `'😄'`, `'😆'`, `'🤍'`, `'On it.'`
   failed the webhook `/[A-Za-z0-9]{3,}/` junk gate → user got NO reply.
   Pools reworded + brute-force regression test in `fast-path.test.ts`.
2. DB content rules (incl. all 4 block-severity dose rules) were NOT applied
   on `runDirectPath` / `handleFoodQuestionDirect` / emergency fallback / FAQ
   cache. Now threaded via `AIService.getDbRules()` (cached, ~0ms).
3. Code-level banned-phrase violations carry NO `severity`; direct-path gates
   only checked `'block'|'regen'` → every code-level banned phrase shipped on
   knowledge/emotional/food direct paths (reproduced live). Gates now treat
   missing severity as regen, matching orchestrator semantics.
4. `FOOD_LOG_SKIP_RE` missed "I **just** had/ate/drank …" → +2s coalesce tax
   on the most common food-log phrasing. Fixed; e2e 2011ms → 9ms in harness.
5. `user_memory_md` migration had an unimplementable TEXT→UUID FK (fails on
   every DB; table is keyed by phone). FK dropped. **Verify the table exists
   in prod Supabase** — if the migration never applied, Phase D pilot can't
   enroll anyone (fails soft).
6. Core migration `CREATE EXTENSION pgvector` → `vector` (the old name errors
   on every Postgres and halted `docker compose up` initdb).
7. `USDA_API_KEY` was a no-op — `UsdaFoodService` was never constructed.
   Now built in server.ts when the key is set.
8. "Calories/protein left today?" matched no query_fast pattern → routed to
   knowledge_direct, which can't see today's intake → generic/hallucinated
   answers. New PROTEIN_LEFT_RE / CALORIE_LEFT_RE route to the existing
   DB-backed protein_today/calorie_today renderers (+5 unit tests).
9. Durable facts (user_profile_facts) never reached the direct paths'
   prompts — runDirectPath now injects top-8 getKnownFacts (cached, fetched
   in parallel with the profile) as "Known about this user:".

**Documented, not fixed:** `ConversationSummaryService`, `TopicTrackerService`,
`ResponseFingerprintService`, `BanditService` are scaffolded + accepted as deps
but never instantiated anywhere — summaries/topic-tracking/repetition-
fingerprinting/bandit loop are dead code in prod. Wiring them changes live
behavior; needs live-Gemini evals first.

---

### Full-sentence multi-item comprehension (2026-06-11, continued)

Branch `claude/grace-production-readiness-x2k1oj`. Driven by a production report:
"For breakfast I ate 2 eggs. For lunch I had chicken breast with bowl of rice"
logged only ~12g protein (the eggs) — the chicken + rice were silently dropped.

**Root cause (a Gemini-outage failure):** `splitMultiMealText` correctly split the
message into two per-meal `log_food` calls, but the lunch call
("chicken breast with bowl of rice") hit the fast-lookup **multi-food bail**, then
both USDA decomposition and the LLM estimator needed Gemini (down on free-tier
quota) → `log_food` returned `ok:false` and the lunch was dropped. `log_food` had
**no deterministic last resort**, so on any LLM outage a recognizable compound meal
vanished.

**Fixes:**
1. **`services/api/src/tools/log-food.ts`** — `makeLogFoodTool` now falls back to
   `estimateMultiItemFood` (the no-LLM macro-table decomposer) before returning
   `ok:false`. A multi-item meal now totals correctly during a total Gemini outage.
   `estimateSource` gains `'deterministic'`; logs `tool.log_food.deterministic_fallback`.
2. **`estimateMultiItemFood` hardened** — splits on meal-label boundaries (not just
   strips them) so punctuation-free "2 eggs for lunch chicken and rice" still
   separates; and any leftover piece that still holds multiple foods is resolved by
   a new greedy `resolvePieceTokens` (longest-window-first scan) so nothing drops.
3. **`packages/ai-core/src/prompts.ts`** — MULTI-PART PARSING section gains a
   "MULTI-ITEM FOOD LOGS — enumerate EVERY food" rule + an INFORMATIVE CONFIRMATION
   requirement (name each food, separate by meal, give the total + brief uncertainty,
   never a bare "Got it 👍" for a multi-item meal) + a food-specific self-check.
4. **`services/api/src/services/ai.service.ts`** — the deterministic food fallback
   confirmation now enumerates every item + includes calories ("Got it — 2 eggs,
   chicken breast (4oz), and rice (1 cup). Roughly about 46g protein and 520 calories…").

**Validation:** new `estimateMultiItemFood` unit tests (incl. the exact production
case → 46g, not 12g); P10 verification phase strengthened to assert the multi-meal
reply names chicken AND rice and totals ≥40g under GEMINI_DOWN. Full battery
66 pass / 0 fail; 534 ai-core + 653 api tests green.

**Note (design):** no general LLM "did-you-cover-everything" completeness judge was
added — that's the brittle judge class `TRUST_GEMINI` deliberately disables. The
completeness guarantee is deterministic (the log itself now captures all items) plus
the prompt enumeration rule, consistent with the existing architecture.

---

### Aggregated food-log summaries (2026-06-11, continued)

Branch `claude/grace-production-readiness-x2k1oj`. Production report: "what did I
eat today?" returned a raw, repetitive DB dump — "chicken, rice, 2 eggs, 2 eggs,
chicken, rice, … and 12 more" — a database export, not a summary.

**Root cause:** `query-fast.ts` `food_summary_today` joined raw `food_logs.items`
(one row per log, with leaked internal labels) capped at 8 with "and N more". No
dedup, no aggregation. The same raw list also fed the LLM prompt context
(`ai.service.ts`), so tool-path answers could echo the duplicates too.

**Fix — new `services/api/src/services/food-summary.ts`:**
- `aggregateFoodItems(items)` — explodes multi-item meal labels ("3 eggs + salad
  + rice"), strips portion parentheticals ("chicken breast (4oz)"), parses a
  leading count as a multiplier ("2 eggs" ×3 logs → Eggs ×6) UNLESS it's a
  serving word ("1 can tuna" stays intact), and dedupes into `{name, qty}` ordered
  by qty.
- `formatAggregatedInline(items)` — compact "Eggs × 6, Chicken breast × 3" label
  for prompt context (overflow → "+N more items").
- `renderDailyFoodSummary(items, protein, cal)` — the user-facing answer as ONE
  conversational line: "Today you've had Eggs × 6, Chicken breast × 3, Rice × 2,
  plus 2 more foods. That's 171g protein and 2,040 calories." Single line on
  purpose — the WhatsApp outbound enforcer (`twilio/sender.ts` + `format-enforcer`)
  strips bullets / "Here's your day:" intros / "Label:" headers / multi-line lists,
  so a sectioned report gets gutted to an empty reply. Totals are passed in (summed
  upstream) — aggregation never recomputes them, so a summary can't change the day's
  numbers.

**Wiring:** `query-fast.ts food_summary_today` → `renderDailyFoodSummary`;
FOOD_SUMMARY_LIST_RE broadened to match "eat" (not just "ate") + "summarize my
meals/day/intake". Prompt-context "Foods logged today:" line + `get_food_summary`
tool (`items_aggregated` field) + replay sandbox all use the aggregated inline
form. `prompts.ts` gains a "FOOD LISTING vs PROTEIN BREAKDOWN" rule (LISTING =
aggregate; "how did I reach X grams" = per-item walk-through, unchanged).

**Validation:** `food-summary.test.ts` (aggregation + render), updated query-fast
tests, new P12 verification phase (9 checks) proving the aggregated one-line
summary survives the full webhook→enforcer→sender pipeline with duplicates +
a long tail. Battery 75 pass / 0 fail; 534 ai-core + 668 api green.

---

### Food day boundary = LOCAL MIDNIGHT (2026-06-11, continued)

Branch `claude/grace-production-readiness-x2k1oj`. Spec: the food day is the
user's local calendar day, 12:00 AM – 11:59 PM. The code used a **5am rollover**
(`- INTERVAL '5 hours'` in every "today" SQL query + a matching 5h pre-shift in
the Redis cache key), so a log between midnight and 4:59 AM silently counted
toward *yesterday* — contradicting `getTodaysFoodSummary`'s own doc comment,
which already claimed "resets at the user's local midnight".

**Change (mechanical, conventions must stay in lockstep):** dropped the 5-hour
shift everywhere → `(created_at AT TIME ZONE user_tz.tz)::date = (now() AT TIME
ZONE user_tz.tz)::date`:
- `user/user.service.ts` — `getTodaysFoodSummary` (L3 query) + `getDailyProteinHistory` (day keys + window)
- `tools/log-food.ts` — post-insert running total
- `tools/remove-food.ts` — all 3 queries (match, list, recount)
- `services/food-log-fast.ts` — fast-path daily total
- `routes/admin.ts` — `/admin/users/:phone/food-logs` day filter
- `cache/today-food-cache.ts` — `computeUserToday` no longer pre-shifts 5h (the
  L2 Redis key MUST use the same date convention as the SQL or the cache serves
  a different day window than the DB)

Everything else the daily-reset spec asks for was already true and is now
verified: per-user isolation (`WHERE user_id = $1` everywhere), history never
deleted (the "reset" is purely a query-window convention — totals are always
recomputed from rows, nothing is carried over), full timestamps stored per row,
history queryable per local day via `getDailyProteinHistory`.

**Validation:** `today-food-cache.test.ts` rollover tests replaced with
midnight-boundary tests (11:59 PM = today, 12:00 AM = new day, 1 AM = new day);
new **P13** verification phase (7 checks): inserts rows at yesterday-11:30 PM /
today-12:30 AM / now, proves today = 22g not 72g (the 12:30 AM row is the
discriminator — old code put it in yesterday), history keeps yesterday's 50g,
users isolated, WhatsApp "protein today" answers 22g. Battery 82 pass / 0 fail;
534 ai-core + 669 api green.

---

### Reminders: grounded context + anti-repetition + salutation fix (2026-06-11, continued)

Branch `claude/grace-production-readiness-x2k1oj`. Production report: reminder
shipped as **"For Yuval, Hope you're having a good day…"** — mail-merge tone,
generic, unconnected to the user's actual behavior.

**Root causes & fixes (scheduler + message-generator):**
1. **Salutation bug** — `buildPrompt` opened with "Generate a single short SMS
   for ${name}", baiting Gemini into echoing "For Yuval, …" as a salutation.
   Prompt no longer names the user ("Write the next short proactive SMS…
   NEVER address the user by name / never open 'For <name>' / 'Dear user' /
   'As your assistant'"), and `sanitizeProactiveOutput` now strips
   `ADDRESSED_OPENER_RE` (For/Dear/To + Capitalized-name — catches nicknames
   that don't match `users.first_name`) + `ROLE_OPENER_RE` ("Dear user", "As
   your assistant", "Grace here:"). Capital-letter requirement distinguishes
   "For Yuval," (strip) from "For breakfast," (keep).
2. **No real context** — morning/evening reminders were goal-template-only.
   `Scheduler.enrichGenerateOpts()` (best-effort, never blocks a send) now
   feeds the generator: **morning** → YESTERDAY's totals via
   `getDailyProteinHistory` ("yesterday you were short on protein → plan one
   solid protein meal early"; no-logs day gets shame-free framing); **evening**
   → TODAY's running totals via `getTodaysFoodSummary` ("you're at 82g — eggs
   or yogurt tonight closes the gap"; target-hit → acknowledge, no suggestion).
   Prompt carries a DATA ACCURACY rule: use ONLY provided REAL DATA lines,
   never invent logs/symptoms/numbers.
3. **Repetition** — all generative types now receive the last 5 sent reminder
   texts (`getRecentCheckIns().message_sent`) as a RECENTLY SENT banned list,
   plus a deterministic `isNearDuplicate` backstop (normalized exact or ≥85%
   token Jaccard) that ships the daily-rotating fallback instead of a near-dupe.

**Verified pre-existing and now tested:** 2/day default cap (user-settable
1..3) + 3h min gap + Redis day counter; per-user-per-day jitter (new test:
offsets vary across a week, stable within a day); 2h engagement cooldown;
quiet hours; injection flows fully separate (own state machine, exempt from
caps, skip regular check-ins on injection day, NOT context-enriched).

Tests: `message-generator.test.ts` (NEW — 12: salutation strips incl. the
exact production string, near-duplicate, prompt grounding, no-invention rule)
+ 5 scheduler context-enrichment tests + 2 jitter tests. 688 api + 534 ai-core
green; battery 82/82.

---

### Admin dashboard ops pass: Stripe two-way sync + manual ops + deep audit (2026-06-13)

Branch `claude/grace-admin-dashboard-4n3s37`. Full operator guide +
live-verification checklist: `docs/ADMIN_DASHBOARD.md`. The dashboard already
covered ~70% of the requested spec; this pass closed the genuine gaps
(RBAC roles were explicitly out of scope this session).

**Migration `20260613000001_admin_dashboard_ops.sql` (NEW — run in Supabase):**
adds `users.stripe_customer_id / stripe_subscription_id / subscription_status /
subscription_plan / stripe_synced_at / stripe_sync_error`; extends `audit_logs`
with `actor / target_user / before / after / reason`; creates `stripe_events`
(unique on `stripe_event_id` → idempotent + retryable), `admin_notes`,
`flagged_responses`. RLS-enabled (default-deny; API uses direct PG, bypasses).

**Stripe two-way sync (`services/api/src/services/stripe.service.ts`):**
`syncSubscriptionToDb` (mirror live status/plan/`is_paid`/`is_pro`; no-customer
→ leaves `is_paid` untouched; error → `stripe_sync_error`, never throws),
`reactivateSubscription`, `changePlan(base|pro)`, `handleStripeWebhookEvent`
(created/updated/deleted + invoice failed/succeeded; resolves user by
`stripe_customer_id` then customer.metadata.phone, backfilling the id),
`recordStripeEvent`, `constructWebhookEvent`. New v2 webhook
`POST /webhook/stripe` (`services/api/src/routes/stripe-webhook.ts`) —
registered ONLY when `STRIPE_WEBHOOK_SECRET` set; encapsulated Fastify scope
with a raw-buffer JSON parser for signature verification; records every event.
The v1 Supabase `stripe-webhook` edge fn is still live — v2 is additive +
idempotent; cut Stripe over to one endpoint and retire v1 once verified.

**New admin endpoints (`routes/admin.ts`):** `POST /admin/users/:phone/stripe/{sync,reactivate,change-plan}`,
`GET /admin/stripe/events`, `POST /admin/stripe/events/:id/retry`,
`POST /admin/users/:phone/send-message` (real WhatsApp send + persists turn as
`intent:'admin_manual'`), `POST /admin/users/:phone/{pause,resume}`,
`GET/POST /admin/users/:phone/notes` + `DELETE /admin/notes/:id`,
`POST /admin/messages/:id/flag` + `GET /admin/flagged` + `PUT /admin/flagged/:id/resolve`,
`GET /admin/audit-logs`. `AdminDeps` gained `sender`, `memory`,
`stripeBasePriceId`, `stripeProPriceId` (wired in `server.ts`).

**Deep audit:** `auditLogFull()` helper + `actorOf(req)` (reads `X-Admin-Actor`
header, defaults `admin` — attribution without RBAC). `PUT /admin/users/:phone`
now records a before→after diff (PII decrypted) + `X-Admin-Reason`. Stripe
actions / manual send / pause-resume / notes / flags all audit. All audit/
notes/flags/event writes are best-effort (swallow missing table/column).

**Env (`config/env.ts`):** `STRIPE_WEBHOOK_SECRET` (optional), `STRIPE_BASE_PRICE_ID`
+ `STRIPE_PRO_PRICE_ID` (default to the test-account prices).

**Frontend:** `lib/api.ts` sends `X-Admin-Actor` (from `localStorage.grace_admin_actor`)
+ new `stripe.*`, `sendMessage`, `pauseUser/resumeUser`, `notes.*`, `flags.*`,
`auditLogs` calls + `getActor/setActor`. New page `pages/admin/AuditLogPage.tsx`
(Audit & Ops: Audit Log / Flagged / Stripe Events tabs, route `/admin/audit`,
nav entry added). `UserDrawer.tsx` gained Sync-from-Stripe / Reactivate /
Switch-plan buttons + last-sync/error line, a manual-message box, and an
internal-notes section.

**Tests:** `stripe.service.test.ts` (15, mocked Stripe SDK) +
`admin-ops.test.ts` (10, Fastify inject) — **713 api tests green**, api +
web typecheck clean, web build clean. Live Stripe/WhatsApp/deploy verification
deferred to the checklist in `docs/ADMIN_DASHBOARD.md` (no Stripe keys / live
sender / deploy in CI).

**Registration gate fix (same branch, 2026-06-13):** a deleted user could keep
using Grace — `ensureUser` re-INSERTs their row on the next inbound message
with `trial_start = NULL`, and `isAccessAllowed` treated `trial_start = NULL`
as "allow" (unlimited, never-expiring access), so they reappeared as Active and
chatted normally. Fixed in `routes/webhook.ts`: `isAccessAllowed` now returns
`false` for a null trial; new `needsRegistration(user)` (`!is_paid && !is_pro &&
!trial_start`) fires a sign-up message (`buildSignupUrl` → `/onboarding`, new
`register` template key w/ fallback) BEFORE the trial-expired paywall, then
returns. Effect: only web-onboarded (`trial_start` set by `POST /users/onboard`)
or paid/pro users get AI access; any unregistered number — brand-new OR
deleted — gets the sign-up prompt on its first message. Admin delete +
GDPR self-delete now also call `UserService.invalidate(phone)` (new public
method) so the deleted user isn't served from the 60s in-memory cache. Tests:
+5 in `webhook.test.ts` (gate matrix). 718 api tests green.

---

### Food-log fast-path bypassed the vague-food clarification gate (2026-06-13)

Production screenshot: "I had pizza" → "Logged pizza (2 slices), roughly 22g
protein. Running total: 22g." — an assumed portion the user never gave.

Root cause: `tryFoodLogFastResponse` (`services/api/src/services/food-log-fast.ts`)
runs EARLY in `handleMessage` (ai.service ~534), before the well-tested
`detectVagueFood` gate (ai.service ~1966). The common-food macro table
(`lookupCommonFoodMacros`) has bare-category defaults — `'pizza' → 'pizza
(2 slices), 22g'` (log-food.ts:555) — so a bare vague food got fast-logged with
a fabricated portion, skipping the clarification ask entirely. The vague-food
system already existed and was correct; the fast path was the only bypass (other
paths — degraded/force-log, FAQ cache — sit after the 1966 gate).

Fix: `tryFoodLogFastResponse` now calls `detectVagueFood(trimmed)` and returns
null when vague, deferring to the full pipeline (which returns the "what exactly
did you have?" clarification). `detectVagueFood` returns vague=false the moment
a quantity/specific item is present, so "2 slices of pizza" / "a chicken
sandwich" still fast-log. Also added `'salad'` to `VAGUE_CATEGORIES`
(`safety/vague-food.ts`) — bare "salad" spans a 2g side to a 40g chicken-caesar;
"chicken salad" / "large salad" stay specific via the qualified/sized regexes.
Tests: +2 in `food-log-fast.test.ts`. 720 api tests green. NOTE: regression fix
to the EXISTING gate, not a new ask-always policy — the team deliberately avoids
over-asking, and multi-item meals still log deterministically (never-drop
hardening) rather than asking per-item.

---

### Vague-category expansion + prep-method clarification + multi-item formats (2026-06-13)

Follow-on to the fast-path fix above. All in `safety/vague-food.ts` (single
source of truth — `detectVagueFood` is called by both the food-log fast path
and the pipeline gate, so changes here cover both automatically).

- **Expanded `VAGUE_CATEGORIES`**: added `casserole, bowl, noodles, ramen,
  omelette, omelet, smoothie, milkshake, stew` (+ `salad` from the prior fix).
  Qualified forms stay specific: added `omelette|omelet|noodles|casserole|stew`
  to `QUALIFIED_CATEGORY_RE` ("cheese omelette", "chicken noodles", "beef stew")
  and to `SIZED_PORTION_RE`. Note: bare `bowl` is intentionally inconsistent —
  "rice bowl"/"poke bowl" → vague, but "a bowl"/"a bowl of X" reads as a
  quantity (bowl is a UNIT_WORD) → specific. `shake` was NOT added (would break
  "protein shake"); only `milkshake`.
- **Prep-method clarification** (`detectPrepNeeded`, folded into
  `detectVagueFood`): a bare prep-ambiguous protein/side (`chicken, fish,
  salmon, shrimp, prawns, tofu, pork, wings, eggplant, potato(es),
  cauliflower, tilapia, cod`) with NO prep word, NO sauce word, and NO quantity
  → asks "grilled, baked, or fried? any sauce or oil?" (calories swing ~2x).
  Tightly scoped to a SINGLE bare food: naming a cut ("chicken breast"), a dish,
  a quantity ("6 oz salmon"), prep ("grilled chicken", "mashed potatoes"), or
  listing multiple foods ("chicken and rice") all skip the ask and log normally.
  The prep question contains "calories" + "?" so the existing continuation gate
  (`lastWasFoodQuestion`) fires; `briefDetailMatchesFood` (ai.service ~2180)
  gained prep words (grilled/fried/baked/…/sauce/oil) so a one-word reply
  ("grilled") combines + logs. `PRIOR_ASK_RE` recognizes the prep ask for
  follow-up templating.
- **Multi-item formats**: `estimateMultiItemFood` already split on newlines,
  periods, commas, "and", and meal labels — verified with tests for the two
  requested formats: "for breakfast i ate eggs. for lunch chicken breast, rice
  and salad" → eggs+chicken breast+rice+salad = 49g; "rice\nchicken" → 2 items.
  No code change needed there; the splitter was already correct.

Tests: +34 (vague-food: expanded categories + prep matrix; log-food: the two
multi-item formats; food-log-fast from the prior fix). 754 api + 534 ai-core
green, typecheck clean. Still a regression/scoping change to the EXISTING
clarification gate — not an ask-always policy; multi-item + portioned + dish/cut
logs are untouched.

---

### Onboarded users locked out by the registration gate (2026-06-13)

Production: user completed web signup, got NO welcome, and still got the
"sign up here" prompt on every message. The registration gate (`needsRegistration`,
added earlier today) blocks any user with `!is_paid && !is_pro && !trial_start`.
The lockout means `trial_start` never landed for the webhook's phone.

Root cause (defensive fixes for both):
1. **Onboarding could roll back `trial_start`.** `POST /users/onboard` set the
   whole core profile — including newer columns like `starting_weight` — in ONE
   un-try/caught `users.update`. A single missing-migration column threw, rolling
   back the entire UPDATE (incl. `trial_start`), so the user was never registered.
   Fix: register FIRST with base-schema columns only (`await users.update(phone,
   { active: true, trial_start: new Date() })`) immediately after `ensureUser`,
   THEN best-effort the full profile inside try/catch. A missing column can no
   longer un-register anyone.
2. **The gate was too strict.** `needsRegistration` now also returns false when
   the user has onboarding profile data (`medication` set OR `goals` non-empty),
   so a user who onboarded but whose `trial_start` didn't land (legacy path /
   partial write) is treated as registered instead of locked out. A bare
   deleted/never-onboarded row (no medication, no goals) still gets the sign-up
   prompt. The paywall branch now only fires when `user.trial_start` is set (a
   trial actually started + expired) — a registered-but-null-trial user is no
   longer dumped into the paywall.

Immediate manual unblock (no deploy): admin dashboard → open the user → toggle
Paid, or "Reset trial" (sets trial_start) → access restored under current code.
Note: the missing welcome is partly Twilio-sandbox mechanics — outbound fails
until the user has sent `join <code>` and is inside the 24h session window.
Tests: +1 webhook gate case (onboarded-no-trial not locked out). 755 api green.

---

### Food-log continuation: clean reconstruction of clarification answers (2026-06-13)

Production: Grace asked "For the pizza, how many slices and what kind?", user
replied "2 slices", Grace responded "Two slices is a perfect amount…" — generic,
didn't log, broke the flow. The continuation gate (ai.service ~2171) DID fire
(`lastWasFoodQuestion` + brief reply), but it built the food arg as the messy
blob `"<entire 200-char question>: 2 slices"` and handed that to `log_food` —
which the LLM turned into chat instead of a log.

Fix: new `reconstructFoodFromClarification(lastGraceMsg, reply)` (exported from
`ai.service.ts`) pulls the food the clarification was about ("pizza" from "For
the pizza…", "chicken" from "How was the chicken prepared…") and joins it with
the answer into a CLEAN phrase — quantity answers get "of" ("2 slices" →
"2 slices of pizza"), prep/other answers prefix ("grilled" → "grilled chicken").
The continuation block then (1) tries `tryFoodLogFastResponse` on the clean
phrase and, when it resolves in the macro table, returns a DETERMINISTIC log
confirmation immediately (no LLM detour) with `intent:'food_log_continuation'` +
persisted turns; (2) otherwise sets the orchestrator force-log to the clean
phrase (not the blob). Brand replies ("what did you have at KFC?" → "3 tenders")
return null from the reconstructor and keep the existing path (the reply is
already specific). Tests: +4 reconstruct cases (`ai.service.test.ts`). 764 api
green.

---

### Health-concern guard: stop logging out-of-scope vitals questions (2026-06-13)

Production: "I'm having blood pressure problems what should I do" → Grace replied
"Logged." A health concern + guidance request got routed into a logging
workflow. Earlier "How about my blood pressure?" got a generic GLP-1 education
blurb instead of recognizing the user was asking about THEMSELVES.

Fix: new `services/api/src/safety/health-concern.ts` — `detectHealthConcern(text,
lastGraceMessage?)` flags PERSONAL concern / guidance phrasing ("my bp", "I'm
having…", "what should I do") about out-of-scope cardiovascular vitals (blood
pressure / heart rate / pulse / palpitations / cholesterol; blood sugar
deliberately excluded — GLP-1-relevant). Wired into `ai.service.handleMessageInner`
right after the vague-food guard and BEFORE the FAQ cache + force-log, returning
a supportive, clarifying, scope-aware referral and short-circuiting so it can
NEVER be logged or answered with generic education. Pure education ("does GLP-1
affect blood pressure?") does NOT fire — it flows to the educational pipeline.
Follow-up aware: once we've asked, a vital-less reply ("high readings") recovers
the vital from our prior question and gives a refer-focused answer instead of
re-asking. Crisis/emergency stays with the SafetyGuard (runs earlier). Tests:
`health-concern.test.ts` (8). 771 api green.

Note (deferred): the broader "mandatory relevance validation on every response"
(user ask) is partially served by the existing LLM relevance-check
(`packages/ai-core/src/relevance-check.ts`), which is gated by
`RELEVANCE_CHECK_ENABLED` / disabled under `TRUST_GEMINI`. This guard adds
deterministic coverage for the reported failure class without re-enabling the
LLM judge.

---

### Global response-validation gap + scope referrals (2026-06-13)

Reframing the BP failure as a CORE conversation-engine issue, not a topic patch.
The "response validation layer" the spec describes already exists and is ON by
default: `RELEVANCE_CHECK_ENABLED` / `BEHAVIORAL_GUARD_ENABLED` /
`QUALITY_GUARD_STRICT` all default TRUE, `TRUST_GEMINI` defaults FALSE
(`config/env.ts`). The relevance check (`relevance-check.ts`) regenerates any
response that doesn't address the user's latest message.

The gap was its skip rule. `orchestrator.ts` treated ANY response < 40 chars as
`isTrivial` and skipped the relevance/behavioral judges — so a bare "Logged." to
"what should I do about my blood pressure?" was never validated. Fix: a short
response is only trivial-skip when the user's message is NOT a question
(`validated.text.length < 40 && !looksLikeQuestion`). Now a suspiciously short
reply to a real question is validated + regenerated, globally, for every
non-food intent. Food/log intents remain in `RELEVANCE_SKIP_INTENTS` (the
2026-06-04 carve-out that fixed clearly-on-topic dinner responses being flagged
"not relevant" — deliberately kept).

Scope handling made global with professional referrals (`safety/scope-guard.ts`):
legal → "one for a lawyer", finance → "a financial advisor is the right person",
instead of a flat "not my area". Combined with the medical health-concern guard
(refers to doctor) and the existing politics/war/tech/meta categories, every
out-of-scope domain now acknowledges + refers appropriately. Tests: +2 scope
referral cases. 534 ai-core + 773 api green.

Deferred (not a clearly-observed failure, and risks misrouting legit flows):
an account/billing "contact support" referral category; removing the food
relevance carve-out. The conversation pipeline now is: classify intent →
deterministic routing (scope / health-concern / vague-food / continuation) →
generate → validate (content + grounding + relevance + behavioral + quality) →
regen on failure.

---

### Complete questions treated as incomplete + general fallback gap (2026-06-13)

Production: "is it possible that i feel that my muscles get smaller?" → Grace
replied "What's the rest of that?" — a complete question treated as truncated.

Root cause (NOT classification — `classifyMessage` correctly returns `knowledge`
for it): the topic-specific knowledge answers in `getToolAwareFallback`
(`orchestrator.ts`, muscle / water / alcohol / sleep / hair / plateau / protein)
were gated on `type === 'knowledge'`. When a health question lands in `general`
(classifier near-miss, or a generation failure that resolved to the general
fallback), ALL those helpful branches were skipped → straight to the
`TYPED_FALLBACKS.general` clarification pool, which included "What's the rest of
that?" (reads as "you didn't finish your sentence").

Fixes (`packages/ai-core/src/orchestrator.ts`):
1. The topic-answer block now runs for `type === 'knowledge' || 'general'`. Each
   branch only RETURNS on a topic-keyword match, so non-health general messages
   fall through untouched — but a health question that landed in general now
   gets the real answer (verified: water/alcohol/muscle under `general`).
2. Muscle fallback verb set broadened beyond affect/loss to include perception/
   shrinkage phrasing: `smaller|shrink\w*|weaker|wasting|atrophy|thinner|…` so
   "muscles get smaller" matches.
3. `TYPED_FALLBACKS.general` reworded to never imply truncation ("What's the
   rest of that?" removed) — these fire on genuinely unclassifiable messages,
   not incomplete ones.

Tests: +3 in `orchestrator.test.ts` (muscle question under both intents, health
topics under general, no-truncation phrasing). 537 ai-core + 773 api green.

---

### Comprehensive, typo-tolerant GLP-1 knowledge bank (2026-06-13)

New `packages/ai-core/src/glp1-knowledge.ts` — `answerGlp1Topic(msg)` +
`matchGlp1Topic` + `normalizeKnowledgeText`. A single ordered topic table
(~40 topics, specific→generic) covering: nausea / nausea duration / vomiting /
constipation / diarrhea / heartburn / bloating-gas / stomach pain / fatigue /
dizziness / headache / brain fog / hair loss / muscle / Ozempic-face-skin /
food-noise-appetite / appetite-return / missed dose / dose increase / injection
site / injection timing / storage-travel / mechanism / how-long-take /
weight-regain / expected-loss / alcohol / caffeine / blood sugar / gallbladder /
pregnancy (redirect) / birth control / fiber / electrolytes / water / sleep /
exercise / plateau / protein target.

Typo tolerance: `normalizeKnowledgeText` collapses 3+ repeated letters and
applies a GLP-1 misspelling map (nausia→nausea, diarhea→diarrhea, constipaton,
muscels→muscles, protien→protein, hartburn, bloted, etc.) before matching, and
topic regexes include common variants. Verified: "im so naus", "how do i deal
with constipaton", "is hair loose commn on glp" all resolve.

Wired as the PRIMARY deterministic answer source in BOTH fallback paths
(de-duplicating them): `orchestrator.getToolAwareFallback` (knowledge||general
block, before the legacy inline branches) and `ai.service.pickKnowledgeTopicFallback`
(before its legacy checks). This is the degraded-mode floor — the live primary
path is still Gemini + RAG; the bank guarantees accurate answers to common
questions when Gemini is down. Each topic regex requires a health keyword, so
non-health messages return null and fall through untouched.

Safety: missed-dose answer warns "don't double up" (never advises doubling);
pregnancy/birth-control defer to the clinician; severe/red-flag symptoms route
to the doctor. The orchestrator critic-failure test was tightened from a blunt
`not.toContain('double')` to forbid the DANGEROUS advice ("take an extra/double
the dose") while allowing the curated safe missed-dose guidance.

Tests: `glp1-knowledge.test.ts` (53 — coverage + typos + non-health null +
safety). 590 ai-core + 773 api green. Follow-up: the legacy inline topic
branches in both paths are now mostly shadowed by the bank — safe to delete in a
later cleanup once the bank is confirmed in prod.

---

### Every knowledge question routed to the reasoning path; no generic fallback for questions (2026-06-13)

Production: "Is it possible that I feel that my hair is shorter?" → "I'm with
you. What can I help with right now?" — a clear question got a generic fallback.

This is an ENGINE-LAYER fix (not a hair patch), applying to every knowledge
question:
1. **`classify.ts`** — final catch-all: a substantive question (>= 8 chars,
   ending in `?` OR starting with is/are/can/could/would/should/will/does/do/
   did/why/how/what/when/where/which/who) now classifies as `knowledge`, not
   `general`. By that point food/medication/scheduling/pause/symptom questions
   are already routed, so a remaining question is a genuine info request → it
   gets the knowledge path (strongest reasoning budget + always-on relevance
   check + the knowledge bank). Bare one-word follow-ups ("Why") stay `general`
   (length gate) for the reasoning/continuation handlers.
2. **`orchestrator.getToolAwareFallback`** — final safety net: if the message is
   a question (`?` or interrogative start) and nothing else matched, it returns
   an honest, on-topic answer ("changes on a GLP-1 trace back to the weight loss
   itself…, share what you're noticing, anything off → your doctor") instead of
   a generic "I'm with you / tell me more" clarification. So a question can never
   resolve to a generic engagement prompt, regardless of topic.
3. **Hair topic broadened** (`glp1-knowledge.ts`) beyond loss to appearance
   changes (shorter/thinner/different/texture/volume/dry/brittle), with an
   answer that addresses "feels shorter".

Net: ANY genuine question is routed to the knowledge/reasoning path and answered
(by Gemini when available; by the comprehensive bank or the honest
question-aware fallback when degraded) — never a generic clarification. Tests:
+ hair-appearance cases, + classify question-routing, + question-aware fallback
(and caught my own fallback using the banned "tell me a bit more" phrasing).
594 ai-core + 773 api green.

---

### Food recommendations ignored the signup diet (read wrong field) (2026-06-13)

Production: a vegan who set it at signup still got salmon/chicken dinner recs.

Root cause: onboarding stores the diet in `users.dietary_restriction` (free
text, `routes/users.ts:218`), but EVERY food-recommendation path read only
`user.dietary_pattern` (the vegan/vegetarian/pescatarian ENUM, which signup
never sets) → `buildRestrictionFromLabel(null)` → no filtering. The main
orchestrator prompt (`buildPersonalisedPrompt`) DID inject `dietary_restriction`
+ a top banner, so the Gemini path respected it; the FOOD-QUESTION DIRECT path
(the fast path for "dinner ideas") + the resilient fallback + the FAQ-cache
diet check all bypassed it by reading only `dietary_pattern`.

Fixes (`services/api/src/services/ai.service.ts`):
1. New `effectiveDietaryRestriction(user)` — derives the restriction from
   `dietary_pattern` ?? `dietary_restriction`. All food paths now use it
   (handleFoodQuestionDirect, buildResilientFallback, the direct-path USER
   PROFILE block, and the FAQ-cache safety check).
2. `buildRestrictionFromLabel` extended beyond vegan/vegetarian/pescatarian to
   kosher / halal / gluten-free (celiac/coeliac) / dairy-free (lactose), with
   forbidden lists for each, and separator/synonym normalization
   ("gluten-free"/"gluten_free"/"gluten free"/"plant-based").
3. `DietaryRestriction.label` union widened (`packages/shared/src/ai.ts`) +
   `DietaryRestrictionLite` in `orchestrator.ts` to match.

Allergies / avoided ingredients already flow through `food_dislikes` (prompt +
`buildForbiddenSet` post-gen filter) — unchanged. NOTE: deferred mapping signup
`dietary_restriction` → the `dietary_pattern` enum at onboard (the effective
helper reads the free-text directly, so not required). Tests:
`dietary-restriction.test.ts` (7). 594 ai-core + 780 api green.

---

### Dietary end-to-end: signup → enum → admin visibility/edit (2026-06-13)

Completes the dietary chain so it works perfectly end-to-end:
- **Signup form** already collects + sends `dietaryRestriction` (`Onboarding.tsx`
  → FoodStep). Confirmed.
- **Onboard now also populates the `dietary_pattern` ENUM** when the signup diet
  is vegan/vegetarian/pescatarian (best-effort), so every path that reads the
  enum (admin, chat-detection persistence) sees it — not just the
  `effectiveDietaryRestriction()` free-text reader (`routes/users.ts`).
- **Admin detail** (`GET /admin/users/:phone`) now returns `dietary_pattern` +
  `calorie_goal_kcal` (were missing from the SELECT; `dietary_restriction` was
  already there).
- **UserDrawer** gained a Diet dropdown (none/vegan/vegetarian/pescatarian →
  `dietary_pattern`), an "Other diet" free-text (`dietary_restriction`, for
  kosher/halal/gluten-free/etc.), and a Calorie-goal field — all editable and
  saved via the existing `PUT /admin/users/:phone` (empty select → null so the
  Zod enum doesn't reject ''). Frontend `UserDetail` type extended.

Net chain: survey → stored (free-text + enum) → respected in every food rec via
`effectiveDietaryRestriction` → visible + editable in the admin drawer. api
typecheck + 780 tests green; web typecheck + build clean.

---

### Settings modification intent: "change my X" redirects, never reads (2026-06-13)

Production: "Change my protein goal" → "Your daily protein target is 114g" — a
MODIFY request answered as an INFO request, then a clarify loop.

Root cause: `settings-flow.ts` had no field for `protein_goal_grams` /
`calorie_goal_kcal`, and existing fields' update patterns required an explicit
"to <value>". So "change my protein goal" matched nothing → fell to the AI,
which force-called get_user_profile and read the value.

Fix: a GENERAL settings-modification detector at the TOP of `tryHandleSettings`
(before the READ loop): `MODIFY_VERB_RE` (change/update/edit/modify/adjust/set/
lower/raise/increase/decrease/reduce/fix/correct/switch/reset/customize) +
`SETTINGS_FIELD_RE` (protein goal/target, calorie goal, goal/current/starting
weight, height, age, sex, name, timezone, wake/sleep time, medication, dose,
primary goal, my goals, my diet/dietary, food dislikes/preferences/restrictions,
reminders, check-ins, my profile/settings, preferences) → returns
`PROFILE_REDIRECT`. Distinguishes ACTION from INFO so a change request is never
answered with the current value. Field nouns are SETTING phrasings ("protein
goal", not bare "protein"), so nutrition questions ("how do I increase my
protein intake") are untouched. Injection-day excluded (its own in-chat
handler); check-in frequency handled earlier in the webhook (REMINDER_REDIRECT).
Resolves the action-vs-info, repeated-clarification-loop, and
non-deterministic-flow failures in one deterministic gate. Applies to ALL
settings/survey fields, not just protein. Tests: +12 in `settings-flow.test.ts`.
792 api tests green.

**Cross-turn follow-up (same day):** a bare settings-field reply ("protein
goal", "my goal weight") to a PRIOR settings clarification now inherits the
modify intent → redirect, instead of being read back. `settings-flow.ts` exports
`isBareSettingsFieldReply` (cheap regex: names a field, no modify verb, not a
read question) + `wasSettingsClarification(lastGraceMessage)` (Grace asked
"which setting?") + `tryHandleSettingsFollowUp(text, lastGraceMessage)`. Wired in
`webhook.ts` right after `tryHandleSettings`: the cheap gate fires first, and
only then does it fetch the prior Grace message (`deps.ai.getRecentTurnsForUser`)
— so the extra read only happens for the rare bare-field follow-up. Resolves the
context-inheritance + repeated-clarification-loop points (#3/#4). +4 tests; 796
api green.

---

### Terse "How 32" reasoning challenges explain the number, not switch topics (2026-06-13)

Production: user logged food, Grace said "32g protein", user asked "How 32"
(= how did you get 32g?) → Grace replied with a GLP-1 side-effects/hair/appetite
lecture. Two failures:
1. `detectReasoningRequest` (`orchestrator.ts`) missed terse challenges: its
   `REASONING_TRIGGERS_RE` "how" branch requires "how did you calculate/get…",
   and the shared trailing `\b` rejects alternatives ending in '?' or a unit. So
   "How 32" / "how 32g?" / bare "how"/"how?" weren't detected as reasoning →
   fell to the question-aware general fallback (the GLP-1 framing added earlier).
   Fix: explicit terse checks in `detectReasoningRequest` — `^how\s*\??$` (bare)
   and `^(?:how|why|where)\b[^?]*?\d` (number challenge) — still gated by
   `PRIOR_REASONING_ANCHOR_RE` (prior Grace msg must contain a number/target).
2. The reasoning fallback was weight/goal-specific. Now it's topic-aware: if the
   prior message was about protein (or has a `\d+g`) → explains the protein
   estimate ("that 32g is added up from the foods you logged… tell me serving
   sizes and I'll tighten it"); calories → calorie version; weight/goal → the
   weight math; else a generic "want me to walk you through it?". Transparent
   (it's an estimate) + offers to refine with portions, never switches topics.

The live path (Gemini up) already had history to explain; this fixes the
degraded/fallback path AND the routing (so a number-challenge is treated as
reasoning, never the generic fallback). +1 test (`orchestrator.test.ts`). 595
ai-core + 796 api green.

---

### Settings links use the deployment URL, not hardcoded graceglp.com (2026-06-13)

`settings-flow.ts` hardcoded `https://graceglp.com/settings` in every redirect/
read response; the webhook's `REMINDER_REDIRECT_REPLY` did the same. On the
sandbox/Vercel deployment those links don't resolve. Now they use the running
deployment's `PUBLIC_WEB_URL`:
- `settings-flow.ts`: `resolveSettingsUrl(webUrl)` → `<webUrl>/settings`;
  `profileRedirect(settingsUrl)` builds the redirect; `SettingsHandlerDeps`
  gains `webUrl`. `tryHandleSettings` computes the URL once and uses it for all
  redirects + read responses; `tryHandleSettingsFollowUp(text, last, webUrl)`.
  Falls back to the `graceglp.com` default when `webUrl` is absent (so the unit
  tests, which pass no webUrl, are unchanged).
- `webhook.ts`: passes `deps.env.PUBLIC_WEB_URL` into both settings calls;
  `REMINDER_REDIRECT_REPLY` const → `buildReminderRedirectReply(webUrl)`.

Note: the LLM system prompt (`prompts.ts`) and a few orchestrator fallback
strings still mention `graceglp.com/settings` — those are static prompt text the
model echoes, not the deterministic settings-flow redirects; left for a separate
pass. Tests: +2 in `settings-flow.test.ts` (webUrl honored / default fallback).
798 api green.

---

### Self-serve Settings page on the v2 API (phone + code verification) (2026-06-13)

Rebuilt the Settings page so it no longer depends on the Supabase edge functions
+ the unset `VITE_SUPABASE_*` Vercel env vars (which made the settings LINK error
when pressed). Now fully on the v2 API under the Vercel domain.

**Backend — `services/api/src/routes/settings.ts`** (registered in server.ts with
`{ redis, sender, users, whatsappEnabled: !!env.TWILIO_WHATSAPP_FROM }`):
- `POST /settings/request-code` { phone } → normalize, look up user; if
  registered, generate a 6-digit code (Redis `settings:code:{phone}`, 10-min
  TTL) and send via WhatsApp (or SMS). Enumeration-guarded (always returns
  `{ok,sent}`, only sends for a real account). Rate-limited 5/10min.
- `POST /settings/verify-code` { phone, code } → checks code + attempt counter
  (lockout after 5), issues an opaque Redis session token (`settings:session:
  {token}`, 30-min sliding TTL), returns `{ token, profile }`.
- `GET /settings/me` (Bearer token) → profile.
- `PUT /settings/me` (Bearer token) → updates the user-editable subset only
  (no is_paid/is_pro/blocked/trial_start/paused). `UserService.update` encrypts
  PII + invalidates the user cache so changes take effect on the next message.
  Bulk update falls back to field-by-field on a missing-migration column.
- Tests: `settings.test.ts` (8 — code send/enumeration, verify + lockout,
  session gate, update). 806 api green.

**Frontend** — `apps/web/src/lib/settingsApi.ts` (user-facing fetch client, NO
admin token, token in sessionStorage `grace_settings_token`) + rewritten
`pages/Settings.tsx`: 3 stages (phone → 6-digit code → full profile form),
resumes an existing session on load, edits every profile field (about you /
medication / body & goals / diet / check-ins) grouped, saves via PUT. Uses
`VITE_API_URL` (already set on Vercel). web typecheck + build clean.

Note: code delivery uses WhatsApp when `TWILIO_WHATSAPP_FROM` is set (sandbox
requires the user to have joined; real users need the approved WhatsApp sender
or SMS). A user must be registered (onboarded) to receive a code.

---

### Every outbound message rewrites graceglp.com → the deployment URL (2026-06-13)

The deterministic settings-flow redirects already use `PUBLIC_WEB_URL`, but
Gemini-generated responses still echo `graceglp.com/settings` from the system
prompt (`prompts.ts`) + a few orchestrator fallback strings, so some settings
replies showed the wrong (non-resolving) link. Rather than thread a URL through
the 2,500-line prompt, the guaranteed fix is at the OUTBOUND layer:
`twilio/sender.ts` `rewriteCanonicalLinks(text, webUrl)` rewrites any
`graceglp.com` host (protocol'd, www, or bare) to the deployment host while
preserving the path (`/settings`, `/upgrade?phone=…`). Applied to EVERY outbound
in `TwilioSender.send()` — raw + sanitized — so links from the LLM, the system
prompt, fallbacks, or the DB-active prompt all resolve. `TwilioSenderConfig`
gains `canonicalWebUrl` (wired from `env.PUBLIC_WEB_URL` in server.ts). No-op
when the deployment IS graceglp.com (set `PUBLIC_WEB_URL=https://graceglp.com`
once that domain is live and links follow automatically). Tests: +5 in
`sender.test.ts`. 811 api green.

---

### Outbound sanitizer was truncating trailing URLs → broken settings link (2026-06-13)

Production: the WhatsApp settings link arrived as `https://grace-admin-silk.vercel`
— missing `.app/settings` — so Safari said "server can't be found." (Also
diagnosed + fixed an unrelated Vercel issue: the project had Deployment
Protection / "Require Log In" ON, 403-ing the public; that's a dashboard toggle,
not code.)

Root cause: `sanitizeOutbound` (`twilio/sender.ts`) mid-sentence-truncation
repair. A message ending in a URL doesn't end in terminal punctuation, so it was
flagged `endsMidWord=true`, then trimmed to the last `.` — which is the dot in
`vercel.app` — chopping the link to `…vercel.`. Every settings/upgrade message
(which always ends with a URL) was mangled.

Fix: compute `endsWithUrl` (`https?://\S+$` OR a bare `host.tld[/path]$` for
com/app/io/org/net/co/dev/ai/me/health/care) and skip the truncation repair when
true — a message ending in a URL is complete. Genuine mid-word truncation (no
URL) still repairs. Tests: +4 in `sender.test.ts` (full link preserved, link +
trailing period, bare-domain link, real truncation still trimmed). 815 api green.

---

### Reasoning-about-a-number intercept ("How 88g") — deterministic, never rambles (2026-06-13)

Production: after "What I ate today?" → "Eggs ×2, pizza ×2, salmon, rice. That's
88g protein…", the user asked "How 88g" / "How 88 g of protein". Grace replied
with (a) the generic GLP-1 "changes on a GLP-1…" fallback and (b) a confused
Gemini ramble that re-asked what they ate (already told). The #53 reasoning fix
only covered the orchestrator FALLBACK path — the degraded resilient-fallback
(`buildResilientFallback`, common on free-tier quota) didn't pass
`isReasoningRequest`, and a bad-but-non-empty Gemini generation bypassed the
fallback entirely.

Fix: a deterministic reasoning intercept in `ai.service.handleMessageInner`
(right after the health-concern guard, BEFORE the FAQ cache / force-log /
orchestrator): when `detectReasoningRequest(input.text, lastGraceMessage)` is
true — gated on the prior Grace turn containing a number/target, so it only
fires when there's a number to explain — it returns the topic-aware
`getToolAwareFallback(..., { isReasoningRequest: true })` explanation
("that 88g is added up from the foods you logged… tell me serving sizes and
I'll tighten it") and short-circuits. Covers "How 88g", "How 88 g of protein",
"why 32", bare "how?", in both live and degraded modes — never a generic or
confused answer. Trade-off (accepted for reliability): a reasoning challenge no
longer reaches Gemini for a richer per-item breakdown; the deterministic
explanation is on-topic + offers to refine with portions. 815 api green.

---

### Meal lifecycle: interest ≠ consumption — preference language never logs (2026-06-15)

Branch `claude/meal-lifecycle-states-7ayf7w`. Production bug: after Grace
recommended a meal, "Halloumi and roasted vegetable plate sounds good" (INTEREST)
was logged as if eaten — inflating protein/calorie totals for a meal the user
never had. Root cause: no explicit meal lifecycle (suggested → consumed); the
old `meal_selection` guard fired too late (after the food-log fast path) and only
when a recommendation was found in history, so a missed recommendation let the
message reach Gemini, which called `log_food`.

**New deterministic lifecycle (single source of truth):**
- **`services/api/src/services/meal-lifecycle.ts`** — `detectMealConsumption(text)`
  → `'consumed' | 'preference' | 'neither'`. Consumption checked FIRST so
  "I ended up eating the dal that sounded good" → consumed. `CONSUMPTION_RE`
  (I ate/had, just finished, for <meal> I had, ended up having/making, "log/track/
  add it" imperative) with a negation void ("didn't eat", "haven't had yet").
  `PREFERENCE_RE` (sounds/looks good, I like that, maybe, I'll have/make/go with,
  I think I'll have, I might make it, planning to eat, considering it, that works,
  going with, the X one). Plus `mentionsFood()` (broad dish vocabulary) and
  `isBareConsumptionBackReference()` ("I ended up making it" / "had it").
- **`services/api/src/services/meal-recommendation-store.ts`** — Redis-backed
  active suggestion (`meal:rec:{phone}`, 5h TTL, status `suggested`). Set on
  selection, overwritten on new pick, cleared after logging. Redis-optional
  (no-ops + never throws when absent). Enables "I ended up making it" to log
  without repeating the dish.

**Wiring (`services/api/src/services/ai.service.ts`):**
- Early guard BEFORE every logging path (fast-log / weight / classify / force-log
  / orchestrator): `detectMealConsumption === 'preference'` (≤12 words, no `?`,
  AND real food context — names a food OR Grace's last turn was a food
  recommendation, so a bare "that sounds good" to a non-food offer isn't
  hijacked) → returns a non-logging, goal-aware `meal_suggested` reply via
  `buildMealSuggestionReply` ("…solid pick, ~Xg protein… Let me know once you've
  had it and I'll log it.") and stores the dish. `=== 'consumed'` + bare
  back-reference → `tryLogStoredMeal` logs the stored meal deterministically +
  clears it; otherwise clears the stale suggestion and falls through.
- The old `meal_selection` block (which required a detected recommendation) was
  removed/subsumed. Defense-in-depth: `shouldForceLogFood` gained
  `!isMealPreference`.
- **`packages/ai-core/src/prompts.ts`** — new "MEAL LIFECYCLE — INTEREST IS NOT
  CONSUMPTION" rule covers the LLM path for longer preference messages that
  bypass the 12-word cap (lists never-log preference phrases vs. only-log
  consumption phrases, with the exact production failure as a ✗/✓ pair).

Tests: `meal-lifecycle.test.ts` (54) + `meal-recommendation-store.test.ts` (5).
1009 api + 614 ai-core green; typecheck clean across all packages.

---

### Reminders: Grace is the interface, never denies capability (2026-06-15)

Branch `claude/meal-lifecycle-states-7ayf7w`. Production bug: user asked "When is
my next reminder?" (Grace implied reminders exist) then "Would you send a reminder
tomorrow morning?" → Grace replied **"I can't send reminders … I don't have the
ability to initiate messages at a future time."** Two contradictions: (1) it
exposed an LLM/architecture limitation, and (2) it denied the core product (Grace
DOES send scheduled reminders).

Root cause: reminder-status questions had NO deterministic handler — they fell
through to Gemini, which faced **contradictory prompt rules**: one section said
"echo the pre-computed Next scheduled reminder," another said "Grace has zero
visibility into the proactive scheduler … NEVER state a future reminder time …
banned absolutely." The model resolved the conflict by denying capability.

**Fix — deterministic reminder service + ownership model:**
- **`services/api/src/services/reminder-service.ts`** (NEW, pure/testable) — the
  source of truth for ANSWERING reminder questions. `computeReminderSchedule(user,
  now)` mirrors the scheduler math (morning = `wake_time`; evening = `sleep_time −
  EVENING_LEAD_MIN`; midday Mon/Wed/Fri; injection day REPLACES the regular
  schedule; quiet hours 21:00–07:00; `checkin_days_interval` walked forward to the
  next eligible day; `paused` = disabled). Times are computed DYNAMICALLY from
  wake/sleep settings via named offset constants (`MORNING_OFFSET_MIN`,
  `EVENING_LEAD_MIN`) — never hardcoded 12pm/6pm. `detectReminderIntent(text)` →
  `next | explain | change | null`. Reply builders explain the schedule + redirect
  to Settings; the change builder ("I can't customize reminder times through chat,
  but you can set them in Settings…") never exposes a limitation.
- **`services/api/src/services/ai.service.ts`** — early deterministic intercept in
  `handleMessage` (before the orchestrator): a reminder-intent message is answered
  from the user's real config (`getByPhone` → reminder-service), short-circuiting
  so it NEVER reaches Gemini. `change` → Settings redirect; `next`/`explain` →
  computed answer. Settings URL uses `graceglp.com/settings` (rewritten to the
  deployment host by `TwilioSender`). Verified the webhook's earlier short-circuits
  (`isFrequencyChangeRequest`, `isSettingsKeyword` anchored, settings-flow READ
  patterns anchored) do NOT pre-empt status/explain/change questions.
- **`packages/ai-core/src/prompts.ts`** — reconciled the contradiction: the
  "zero visibility / NEVER state a future reminder time / banned absolutely" rule
  became "use the pre-computed Next scheduled reminder field; never INVENT a
  different time." New **"REMINDERS — GRACE IS THE INTERFACE, NEVER EXPOSES
  LIMITATIONS"** section with the BANNED capability-denial phrases ("I can't send
  reminders", "I don't have the ability to…", "unable to initiate messages",
  "I don't have access…") and explain-then-redirect examples.
- **`packages/ai-core/src/content-checker.ts`** — backstop: 5 capability-denial
  regexes added to `BANNED_PHRASES` (regen severity) so the phrasing can never
  ship even if the LLM emits it.

**Ownership model (per spec):** Settings own configuration; the scheduler owns
delivery; Grace owns explanation only. Grace can tell when reminders fire, explain
behavior/limits, and redirect to Settings — she cannot create/edit/disable
reminders or promise a custom one-off in chat. The scheduler already implements
the delivery rules correctly (morning at wake, evening before sleep, ≤ cadence/day,
injection-day flow, quiet hours) — verified, no changes needed. Note:
`reminders_enabled`/`morning_reminder`/`evening_reminder` columns don't exist;
`paused` is the existing enable/disable toggle and the reminder service uses it.

Tests: `reminder-service.test.ts` (18 — intent detection, schedule math incl.
injection day / paused / every-other-day, and reply builders asserting no
capability denial). 1026 api + 614 ai-core green; typecheck clean.

---

### Per-user food logging day = wake_time (verified end-to-end) (2026-06-15)

Branch `claude/meal-lifecycle-states-7ayf7w`. Requirement: food/protein/calorie
totals must reset on each user's PERSONAL day (starts at their `wake_time`), not
the calendar day or a fixed reset. The window itself was already implemented in
`services/api/src/nutrition/logging-window.ts` (`USER_DAY_CTE` / `userDayExpr` /
`isCurrentUserDay` SQL helpers + `computeUserLoggingDay` JS twin; default
`07:00`; a row's logging day = its local timestamp shifted back by wake_time,
taken as a date). This session was a **full audit + verification** that it's
applied everywhere, plus one consistency fix.

**Verified on the wake window (no change needed):** `getTodaysFoodSummary` +
`getDailyProteinHistory` (user.service — the source for nearly everything),
the L2 Redis cache key (`today-food-cache` → `computeUserLoggingDay` with
wake_time), `log-food` running total, `remove-food` (all 3 queries),
`food-log-fast`, water log, admin `/admin/users/:phone/food-logs` (uses
`userDayExpr`/`isCurrentUserDay`), `get-food-summary` tool, `query-fast`
(protein/calorie today + remaining renderers), the ai.service context lines
("Total protein/calories TODAY", "Foods logged today"), and the scheduler
reminder/progress messages (`scheduler.ts` → `getDailyProteinHistory` for
morning, `getTodaysFoodSummary` for evening). All food/protein/calorie "today"
reads route through these — so a Settings wake-time change re-buckets totals
dynamically (no rows move), and a pre-wake 2 AM snack counts toward the prior
logging day across DB + cache identically.

**Out of scope (correctly NOT a per-day window):** the anomaly detector's
rolling multi-day `food_logs` counts (`now() - interval '3/10 days'`), the
`persistEstimatedFood` 2-minute dedupe (a relative window — timezone-independent
by construction), and the admin `messages/feedback/tool_logs` 30-day analytics
(`DATE_TRUNC('day', …)` — global charting, not a user's food day).

**Fixed (the one inconsistency):** `ai.service.countTodaysCheckIns` used a
calendar-day boundary (`(created_at AT TIME ZONE tz)::date = …`), so "check-ins
today" could disagree with "food today" at the pre-wake boundary. Now uses
`USER_DAY_CTE` + `isCurrentUserDay('created_at')` — same window as food. (In
practice they rarely differed because quiet hours block proactive sends before
07:00, but "today" is now a single consistent concept system-wide.)

Tests: `logging-window.test.ts` extended with the spec scenarios — 7 AM example
(8 AM = today, 2 AM = prior day, 23:30 = same day), custom/late wake, wake-time
change re-buckets the same timestamp, missing wake → 07:00 default, non-UTC tz.
1031 api + 614 ai-core green; typecheck clean.

---

### Conversational continuity for small talk + leading-punctuation fix (2026-06-16)

Branch `claude/meal-lifecycle-states-7ayf7w`. Production: Grace asked "anything
specific making you feel that way?", user replied "just having good day", Grace
replied ", what would you like to dig into?" — ignored the answer, switched
topics, sounded robotic, and had a leading-comma formatting bug. Fixed as GENERAL
mechanisms (per the report's "comprehensive, not specific to this one"), not a
one-off:

1. **Leading orphan-punctuation strip (ALL outbound)** —
   `twilio/sender.ts sanitizeOutbound` now strips leading whitespace +
   punctuation (`, ; : . ! ? ) ] } – —`) and re-capitalizes, as the final guard
   before every send. Upstream edits (first-name stripping → "<name>, what…",
   greeting-prefix removal, em-dash→comma) could leave a reply starting with
   orphaned punctuation; this fixes the entire class from any source. A leading
   emoji is preserved; an all-punctuation body is left unchanged (never emptied).
2. **Comprehensive small-talk fast-path** (`services/api/src/services/fast-path.ts`)
   — short rapport replies now get a warm continuation instead of degrading to a
   generic fallback or a forced health pivot. `GOOD_DAY_RE` ("good day", "had a
   good week", "just having a good day"), `POSITIVE_STATE_RE` ("all good",
   "doing fine", "can't complain", "not bad") → `brief_positive`; new
   `SMALL_TALK_RE` ("not much", "same old", "just chilling", "keeping busy") →
   new `small_talk` category with acks that leave a soft door and NEVER mention
   food/protein/symptoms. `GOOD_DAY_RE` is added as a `NEVER_FAST_PATH_RE`
   exception (it trips the "had" food guard but names a day/week, never a food;
   a real "had a good lunch/breakfast" doesn't match and stays blocked). Bare
   "same" stays excluded (ambiguous → full pipeline resolves it with history).
3. **Reworded the robotic `general` fallback** (`packages/ai-core/src/orchestrator.ts`)
   — removed "Happy to help — what would you like to dig into?" (topic-switching
   + its em-dash mangled into the leading comma). Replaced with warm, open
   continuations for the residual genuinely-unclassifiable cases.

Deliberately NOT done: the report's wholesale "dialogue state machine / give
Gemini more ownership / multi-stage reasoning" rewrite. The response-validation
layer it asks for already exists and is ON by default (relevance-check,
behavioral-guard, content-checker, quality-guard — they regenerate off-topic /
short responses), the pipeline already passes recent turns + reconstructs
follow-ups, and the team deliberately avoids brittle LLM judges
(`TRUST_GEMINI`). These three deterministic fixes resolve the reported failure
class (small talk, short answers, formatting) without that risk.

Tests: fast-path small-talk matrix (+ the exact production case, neutral acks
don't pivot, bare "same" excluded, food log not hijacked) + sender
leading-punctuation cases. 1060 api + 614 ai-core green; typecheck clean.

---

### Conversation context window is now tunable (default 12 turns) (2026-06-16)

Branch `claude/meal-lifecycle-states-7ayf7w`. Driven by a "never interpret a
message in isolation" request. The orchestrator history window had been cut
12→6 (Phase 13) to fight old-topic anchoring; the anchoring guards added since
(relevance check, topic-closer history stripping, "answer THIS message" focus
markers) now make a larger window safe. New `CONVERSATION_HISTORY_TURNS` env
(default **12**, clamp 4–40) threads through `AIServiceDeps.historyTurns` to the
single orchestrator `getRecentTurns` call (`ai.service.ts` ~2189). Doubles the
context Gemini sees (short-reply resolution, multi-turn continuity) at a small
latency/token cost; tunable up to 40 without a deploy (accuracy prioritized over
latency). 1060 api + 614 ai-core green.

**Audit (the rest of the "universal conversation understanding" framework is
already present):** validation layer = relevance/behavioral/content/quality
guards (on by default, regenerate off-topic/short responses); multi-intent =
"Grace MUST address EVERY meaningful part" prompt section + `splitMultiMealText`
+ symptom-before-food force-log suppression; short replies = `reconstructFollowUp`
+ continuation gates + (now) more history; emotional = EMOTION BEFORE DATA +
small-talk fast-path; memory = RAG + `user_memories` (recency-weighted) +
privacy scoping; unstructured input = typo-tolerant classifier + multi-item
estimator. **Genuinely deferred (needs live-Gemini evals before wiring):** the
persistent structured dialogue-state object (`active_topics`/`open_threads`/
`awaiting_response`) and conversation-summary injection — `TopicTrackerService`
+ `ConversationSummaryService` are scaffolded but NOT instantiated (dead code);
wiring them changes live behavior and must be eval-gated.

---

### Diagnostic confidence + contextual triage (symptoms are clues) (2026-06-16)

Branch `claude/meal-lifecycle-states-7ayf7w`. Production screenshot: user said
"I'm shaky, sweaty, and lightheaded" → Grace replied **"That sounds like your
blood sugar might be low. Please grab a quick source of sugar right now…"** — a
specific diagnosis AND a condition-specific treatment from symptoms alone.

Two rules added (prompt + deterministic backstop):
- **`packages/ai-core/src/prompts.ts`** — new **H8b DIAGNOSTIC CONFIDENCE**
  (symptoms are clues, not conclusions: never volunteer a named diagnosis or
  guess-based treatment; hedge with "one possibility is…" / "can sometimes occur
  when…", ask the 1–2 questions that narrow it, give SAFE general steps, name the
  signs that mean get help now; calibrate confidence to available info) with the
  exact screenshot as ✗/✓, and **H8c CONTEXTUAL TRIAGE** (read symptoms ACROSS
  recent turns, not in isolation; an evolving/worsening trajectory — especially
  neurological: confusion, sudden weakness, fainting — means rising risk → raise
  concern + escalate, don't repeat reassurance). The larger history window
  (`CONVERSATION_HISTORY_TURNS`) is what lets Gemini see the earlier symptoms.
- **`packages/ai-core/src/content-checker.ts`** — 5 regen-severity patterns that
  catch definitive symptom→diagnosis framing ("that/this sounds like (your) low
  blood sugar / hypoglycemia / dehydration / pancreatitis", "your blood sugar
  is/might be low", "you probably have …", "this is likely …") while the hedged
  forms ("can sometimes occur when blood sugar is low", "one possibility is…")
  are deliberately NOT matched. Defense in depth so the phrasing can't ship even
  when degraded.

Note: the SafetyGuard (chest pain / breathing / self-harm → 988/911) is
unchanged — this is about diagnostic LANGUAGE + cross-turn triage, not the
emergency classifier. Tests: `content-checker.test.ts` (+12 — flags the
definitive forms, allows the hedged forms). 1060 api + 626 ai-core green;
typecheck clean.

---

### Hypoglycemia warning: hedge the label, still give safe action (2026-06-16)

Branch `claude/meal-lifecycle-states-7ayf7w`. Second screenshot on the same
symptom cluster: "I'm shaky, sweaty and light headed" → Grace replied
"You might be experiencing symptoms of low blood sugar or dehydration." (hedged
but USELESS — no empathy, no action, no next step), then **stalled with NO reply**
on the follow-up "What should I do?". The prior fix (H8b) had over-corrected into
passivity. The user's desired behavior: empathy + the SAFE immediate action
(quick sugar now + call your doctor) while HEDGING the label ("this could be low
blood sugar"), and it must never stall.

**Deterministic handler — `services/api/src/safety/hypoglycemia-warning.ts`:**
`detectHypoglycemiaWarning(text, lastGrace?, lastUser?)` fires on (a) ≥2 distinct
adrenergic/neuroglycopenic warning symptoms (shaky / sweaty / lightheaded-dizzy /
weak / confused / palpitations / blurry vision) in the current message, or (b) a
bare "what should I do?" follow-up when the prior turn established low-blood-sugar
/ symptom context. Returns a warm, ACTIONABLE, hedged response ("Get some quick
sugar in you right now — juice or regular soda — and call your doctor right away.
This could be low blood sugar and needs a medical look. If you feel worse or more
confused, call 911."). Wired in `ai.service.handleMessage` right after the
SafetyGuard (before fast-path/orchestrator) so it's guaranteed regardless of
Gemini's state and can never "stick". Cheap regex gate; only reads history for
the follow-up. SafetyGuard (988/911) unchanged; `health-concern.ts` still
excludes blood sugar (this module owns it).

**Prompt H8b reworked** (`prompts.ts`): "hedge the LABEL, STILL give safe action"
— hedging the diagnosis does NOT mean withholding help; for an acute cluster,
lead with empathy + safe immediate action + hedged cause + call doctor, don't
bury help behind clarifying questions. Both screenshots embedded as ✗ (the
overconfident one AND the useless-passive one) with the desired ✓.

**Content-checker acute exemption** (`content-checker.ts`): the pre-existing
"call your doctor right away / immediately" escalation bans (added to stop alarm
language on NORMAL effects) were blocking the legitimate urgent response. The 4
escalation patterns are now `acuteExempt: true` and skipped when the response
contains acute markers (`ACUTE_ESCALATION_CONTEXT_RE`: 911 / low blood sugar /
quick sugar / fainting / dosing error / severe / can't keep liquids down) — so
urgent escalation ships for a real warning but is still softened for a normal
side effect. (The deterministic handler bypasses the content-checker anyway; this
fixes the LLM path for all other acute cases.)

Tests: `hypoglycemia-warning.test.ts` (12 — cluster, follow-up, no-fire cases,
asserts hedged-not-definitive) + content-checker acute-exemption cases. 1069 api
+ 629 ai-core green; typecheck clean.

---

## Where to start in a new session

1. Read this file + `docs/STATUS.md` + `docs/OPERATIONS.md` + `docs/CACHING.md` (caching/latency reference).
2. `git log --oneline -10` to see recent commits.
3. Active branch: `main`. Latest commit: `9b365c9` — Engagement cooldown: configurable, applies to all non-critical proactive types. All Phase 15 work has been merged to main.
4. **Daily QA workflow:** `/admin/regression` (1-2 min, runs 17 known bug scenarios) → `/admin/replay` (paste WhatsApp msgs, see what Grace would say, with tool calls + regen status) → `/admin/auto-eval` (presets: Quick smoke 5, Standard 15, focused categories, Full sweep).
5. **Migrations needed before deploying Phase 14 code:**
   - `20260528000001_calorie_goal.sql` — adds `calorie_goal_kcal INT` to users
   Apply in Supabase SQL Editor: `ALTER TABLE public.users ADD COLUMN IF NOT EXISTS calorie_goal_kcal INT;`
4. Production is live at `https://grace-api.fly.dev` (API) and `https://grace-admin-silk.vercel.app` (web). Tail logs with `fly logs --app grace-api`.
5. Top open items: Fly payment method (machines auto-stop), WhatsApp Business sender approval (drops "Twilio Sandbox:" prefix), Vercel env vars for Stripe, disable v1 edge fn, rotate DB password.

### Phase 7 — AI quality pass (commits `bb420da`, `b09fe0f`, `174112e`, `c23584b`)

Driven by the WhatsApp QA feedback PDF (`/root/.claude/uploads/.../Grace_WhatsApp_Summary.pdf`) — 1 month of real GLP-1 user testing surfaced these production bugs and fixes:

**System prompt (`packages/ai-core/src/prompts.ts`)** — rewritten with:
- NON-NEGOTIABLE TRUTHS: Grace is proactive (never deny scheduled messages), Grace remembers (answer from user context, never hallucinate, never deny knowing), never quote raw food-dislike text verbatim
- SETTINGS MANAGEMENT hard override: settings changes (wake time, injection day, food prefs, etc.) → `https://graceglp.com/settings`, NOT doctor
- BRIEF REPLY RULE: 1–4 word replies ("ok", "tired", "thanks") get one warm sentence back, no question, no paragraph
- KEY EMOTIONAL MOMENTS: medical abandonment (validate fully — Grace IS the companion their doctor didn't provide), fear of stopping (validate + educational), loss of food-noise identity (don't rush "great news"), Ozempic face / body image
- GLP-1 WEEK NUMBER guidance with milestone examples (Week 1/4/8/12/26/52)
- NON-JUDGMENTAL STANCE with explicit banned implicit-shaming patterns
- HEALTH EDUCATION vs MEDICAL ADVICE — relaxes blanket "see your doctor" redirect into "Research shows…" framing with explicit escalation triggers (driven by the 50+ women research pivot)
- RE-ENGAGEMENT LADDER (1/3/7/14 day silence escalation) + PAUSE MODE
- GLP-1 MEDICATION KNOWLEDGE: tirzepatide vs semaglutide mechanism, Rybelsus empty-stomach rule, muscle loss ~25–35% of weight lost, protein target 1.2–1.6g/kg, Ozempic face mechanism, hair loss telogen effluvium, plateau science

**Scheduler (`services/api/src/scheduler/scheduler.ts`)** — quiet hours (21:00–07:00 local) added as code-level hard guard, passes `GenerateOpts` (isWednesday, lowMoodMode) to `generator.generate()`.

**Message generator (`services/api/src/scheduler/message-generator.ts`)** — food dislike prefix-stripping regex (`/^(i\s+(don'?t|do\s+not|hate|can'?t\s+stand|dislike)\s+(like\s+)?|no\s+|avoid\s+)/i`) so Grace doesn't say "you're not a fan of i don't like rice." Welcome prompt capped at 1–2 sentences with explicit paraphrase instruction.

**AI service (`services/api/src/services/ai.service.ts`)** — `buildPersonalisedPrompt` now includes:
- Injection day computed as TODAY/TOMORROW/YESTERDAY/in N days
- Weight as `X lbs → goal Y lbs (Z lbs to go)`
- GLP-1 week number from `glp1_start_date` (e.g. `GLP-1 week: Week 8 (started Mar 18, 2026)`)
- Food dislikes with same prefix-stripping regex
- LOW MOOD MODE explicit action instruction
- isNew → "FIRST message. Welcome them warmly."

**Onboarding** — `glp1StartDate` added to `OnboardSchema` (`services/api/src/routes/users.ts`) + WeightStep (`apps/web/src/components/onboarding/WeightStep.tsx`) as optional date input. Wrapped in try/catch so signup doesn't break if migration `20260513000003` hasn't been applied yet.

**Stripe** — publishable key + price IDs now match `acct_1TWfwc` (commits `5b09c9e`, `57b569a`). Price: `price_1TWgb5LMk6wjvxD9Y9azDUfZ`.

### Phase 8 — Master prompt operationalization (this session, 2026-05-13)

Adopts `gracemasterprompt.md` as the canonical Grace behavioral spec.

**`packages/ai-core/src/prompts.ts`** — full rewrite. New sections: QUESTION RULE (default: NO question mark) · MESSAGE TYPES · PROACTIVE MESSAGES ARE REMINDERS (with reminder vs. question style examples) · CHECK-IN FREQUENCY IN-CHAT exception · MISSED OR FORGOTTEN DOSE (5-day general guideline) · OPT-OUT HANDLING (natural language → settings link) · MEDICATION TYPE rule (weekly_injection / daily_pill / daily_injection / unknown — strict separation) · HOW GRACE EXPLAINS CHECK-INS · SCHEDULE EXPLANATION RESPONSES · FOOD SUGGESTIONS (banned vague phrases) · HOW TO USE MEMORY · TIME OF DAY · IMPORTANT DATE RULE · 15+ inline EXAMPLES.

**`services/api/src/safety/guard.ts`** — unified `SAFETY_RESPONSE` for both emergency (chest pain, breathing) and crisis (self-harm, suicide), word-for-word per spec. Single message surfaces both 988 (crisis line) and 911 (physical emergency).

**`services/api/src/scheduler/message-generator.ts`** — RULES block rewritten: proactive messages are REMINDERS, default to a STATEMENT (no question mark), explicit ✓/✗ examples ("Protein first today" vs "How's your eating?"), banned internal labels ("morning check-in", "midday nudge").

**`services/api/src/services/ai.service.ts`** — runtime context enriched. New lines: `Today is: <weekday>` · `Time of day for this user right now: morning/afternoon/evening/night` · `Medication type: weekly_injection|daily_pill|daily_injection|unknown` · `CHECKIN FREQUENCY: N` · `Scheduled check-ins sent today: N` · `Total protein TODAY: Xg (Y kcal)` · `Foods logged today: …`. Two new parallel DB reads per turn: `getTodaysFoodSummary` + `countTodaysCheckIns` — both already indexed.

**`services/api/src/routes/webhook.ts`** — two new in-conversation intercepts:
- `detectNaturalOptOut()` — 6 regex patterns ("stop texting me", "I want to cancel", "don't want messages", etc). Reply word-for-word per spec; redirects to `https://graceglp.com/settings`. Short-circuits before AI handler.
- `detectFrequencyChange()` — patterns for "text me less/more", "once a day", "twice a day", "every other day". Originally updated `users.checkin_count_per_day` directly. **SUPERSEDED 2026-06-09 (Settings single-source-of-truth):** replaced by `isFrequencyChangeRequest()`, which now redirects the user to the Settings page instead of writing the field. See the dated section below.

### Phase 9 — Production quality pass (2026-05-15)

All changes landed on `main`, deployed to `https://grace-api.fly.dev`.

**`services/api/src/routes/webhook.ts`**
- Paywall URL fixed: `grace.com` → `graceglp.com`
- Paywall message removes user name (RLHF rule)
- `detectFrequencyChange()` patterns expanded to cover indirect phrasings: "stop texting so much", "you message too much", "tone it down", "back off a bit", "less reminders", "check in more", "bump up the messages", etc.

**`services/api/src/scheduler/scheduler.ts`**
- **Trial Day 2 reminder**: fires `trial_expiry_reminder` during morning window when `trial_start` is 24–48h old for unpaid users, using `last_morning_sent_at` as gate. Replaces regular morning message that day.
- **Humanized timing (jitter)**: `jitterMinutes(seed, max)` — deterministic hash-based per-user-per-day offset so messages never fire at the exact same minute. Morning: 0–55 min, midday: 0–165 min across 11:00–13:45, evening: 0–30 min, injection: 0–45 min. Survives restarts/retries (same seed = same window within a day).
- **RLHF on proactive messages**: `sendAndRecord()` now appends `👍 👎 / #` rating prompt for `rlhf_enabled` users, same as reactive messages.

**`services/api/src/scheduler/message-generator.ts`**
- `MsgType` union extended with `trial_expiry_reminder`
- All proactive fallbacks except `welcome` now name-free (RLHF ZERO TOLERANCE rule)
- `maxOutputTokens` bumped 120 → 280 (Gemini 2.5 Flash thinking tokens were eating the output)
- `sanitizeProactiveOutput(raw, firstName)`:
  - Strips forbidden label prefixes (`Midday reminder:`, `Morning check-in —`, etc.) that the LLM emits ~10% of the time despite prompt instructions
  - Strips user's first name from non-welcome messages at the code level
  - Rejects output that doesn't end with punctuation/emoji (detects mid-sentence truncation)
  - Falls back to warm canned message on any rejection
- RULES block in `buildPrompt` now lists every forbidden opener pattern with `✗` examples

**`packages/ai-core/src/orchestrator.ts`**
- `knowledge_lookup` removed from `RISKY_INTENT_PREFIXES` — it was too broad, causing food/nutrition questions to run through the critic which then failed on USDA protein-gram facts not verbatim in retrieved KB chunks. Only `safety_` intents now gate the critic.
- `SAFE_FALLBACK_TEXT` replaced: cold "could you share a bit more…" → neutral "I'm not sure I caught all of that — can you give me a bit more detail so I can actually help?"

**`packages/ai-core/src/critic.ts`**
- `CRITIC_SYSTEM` updated: general nutritional facts (protein grams, USDA food values, calories) explicitly score `grounding: 5`. Only drug doses/interaction claims still penalised.

**`packages/ai-core/src/prompts.ts`** — three new sections:
- **FOOD RECOMMENDATIONS — ANSWER DIRECTLY**: Grace gives 3–5 specific foods with brief reasoning, filtered by user dislikes, GLP-1-aware (small/dense), ends every food reply with "These are general suggestions — a registered dietitian can tailor this further." Includes ✓/✗ examples.
- **EVERY RESPONSE IS UNIQUE — HARD RULE**: If a different user with a different message would get the same reply → rewrite. Every response must reference something concrete from THIS message (a word they used, a number, today's protein total, their medication, weeks in). Includes ✓/✗ examples.
- **NO PHRASE REPETITION** strengthened with more rotation examples.

**`services/api/src/scheduler/prompt-optimizer.ts`**
- `OptimizerRunReport` interface + `onRunComplete` hook added
- `saveVersion()` now returns the version number
- After each nightly run (4am UTC), calls `onRunComplete` with stats (totalMessages, pos/neg counts, satisfaction %, fallback count), analysis, activated/draft status

**`services/api/src/server.ts`**
- `onRunComplete` wired to `buildOptimizerReport()` → `sender.send()` to `ADMIN_PHONE`
- Report format: version, 14-day stats, what changed, same-pattern prevention note, link to `graceglp.com/admin/prompts`

**`services/api/src/config/env.ts`**
- `ADMIN_PHONE` optional env var added (E.164, receives RLHF optimizer WhatsApp report)

**`services/api/src/scheduler/prompt-optimizer.ts`**
- `SAFE_FALLBACK_SNIPPET` updated to match new fallback text

### Phase 10 — DB-driven content guardbands + scheduler reliability (2026-05-16)

All changes on branch `claude/icloud-access-clarification-5hsRr`. Deploy: `fly deploy --app grace-api`.

**`supabase/migrations/20260516000005_content_rules.sql`** (NEW — run in Supabase SQL Editor)
- Creates `content_rules` table with: `rule_type`, `pattern`, `is_regex`, `flags`, `reason`, `severity` (block/regen/log), `applies_to` (ai/scheduler/all), `is_active`
- Trigger auto-updates `updated_at`
- Seeds 48 rules: 4 `block` + 44 `regen`
  - **block** (4): extra dose, double dose, exceeding prescribed amount, prescribing authority
  - **regen** (44): medication safety (6), medical authority (10), emotional safety (10), banned phrases (14), privacy leaks (4)
- All block rules and most regen rules have `applies_to = 'all'` (both paths)
- One rule (`seek immediate medical help`) is `applies_to = 'ai'` only — safety guard handles real emergencies

**`services/api/src/services/content-rules.service.ts`** (NEW)
- `ContentRulesService` singleton: 60-second in-memory TTL cache, zero latency on hot path
- `getActive(target: 'ai' | 'scheduler')` filters by `applies_to`
- `start()` loads immediately + refreshes on interval; `stop()` clears timer
- Keeps stale cache on transient DB error (never wipes on failure)

**`packages/shared/src/ai.ts`** (MODIFIED)
- Added `DbContentRule` interface (id, rule_type, pattern, is_regex, flags, reason, severity, applies_to)
- Added `dbRules?: DbContentRule[]` to `OrchestratorInput`

**`packages/ai-core/src/content-checker.ts`** (MODIFIED)
- Added `severity?: 'log' | 'regen' | 'block'` to `ContentViolation`
- Added `dbRules?: DbContentRule[]` to `ContentCheckOpts`
- Added `checkDbRules(text, rules)` — silently skips invalid regex patterns (never crash on bad admin input)
- Extended `checkContent()` to call `checkDbRules` when opts.dbRules provided
- Extended `buildContentRegenInstruction()` to format `db_rule_*` violations

**`packages/ai-core/src/index.ts`** (MODIFIED)
- Added `export * from './content-checker.js'` so `checkDbRules` is importable by scheduler

**`packages/ai-core/src/orchestrator.ts`** (MODIFIED)
- Block-severity gate: if any violation has `severity === 'block'` → immediate safe fallback, no regen attempt
- Split violations into `blockViolations` / `regenViolations` / `logViolations`
- `needsReview` uses `regenViolations.length > 0` only
- Retry also checks `retryBlockViolations` — block after regen still falls through to safe fallback

**`services/api/src/services/ai.service.ts`** (MODIFIED)
- Added `contentRulesService?: ContentRulesService` to `AIServiceDeps`
- In `handleMessage()`: loads `dbRules` from `contentRulesService.getActive('ai')`, passes to orchestrator

**`services/api/src/scheduler/message-generator.ts`** (MODIFIED)
- Added `rulesService?: ContentRulesService` field + `updateRulesService()` method
- In `generate()`: after `sanitizeProactiveOutput`, loads scheduler rules and runs `checkDbRules`
- Any block/regen violation → returns canned fallback (proactive messages can't regen with chat history)

**`services/api/src/scheduler/scheduler.ts`** (MODIFIED)
- Added `redis: Redis` to `SchedulerDeps`
- `sendAndRecord()` now acquires a Redis `SET NX EX 82800` lock (`sched:{phone}:{type}:{todayStr}`)
  before generating + sending. Only first Fly machine to win the lock sends; second skips silently.
  Lock released on failure so next tick can retry. Prevents duplicate messages from 2-machine deploy.

**`services/api/src/routes/admin.ts`** (MODIFIED)
- 5 new endpoints under `/admin/content-rules`:
  - `GET` — list/filter by type/severity/active with pagination
  - `POST` — create (validates regex before saving)
  - `PUT /:id` — partial update
  - `DELETE /:id` — soft-deactivate (sets `is_active = false`)
  - `POST /test` — test any text against all active rules, returns violations JSON

**`services/api/src/server.ts`** (MODIFIED)
- `ContentRulesService` instantiated, `start()` called, `stop()` in shutdown
- Injected into `AIService` (constructor) and `MessageGenerator` (`updateRulesService()`)
- `redis` passed to `Scheduler`

**Smoke test** (confirmed working in production):
```bash
curl -s -X POST https://grace-api.fly.dev/admin/content-rules/test \
  -H "Authorization: Bearer <ADMIN_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"text":"You could take an extra dose to make up for it"}' | jq .
# → {"violations":[{"id":1,"severity":"block","reason":"Advising an extra dose...","match":"take an extra dose"}],"clean":false}
```

### Phase 11 — AI quality pass: response accuracy + food variety + image analysis (2026-05-19)

All changes on branch `claude/icloud-access-clarification-5hsRr`.

**`packages/ai-core/src/prompts.ts`**
- **GREETING RULE** (new section): pure greetings ("hi", "hey", "hey grace", "hello") → ONE warm sentence only, topic reset. Greetings must NOT continue the previous topic. Includes exact production failure as ✗ example (user said "Hey Grace" → Grace responded with drink paragraph from old history).
- **FOOD VARIETY — HARD RULE** (new section): never suggest same food twice in one conversation. Wide food pool added: 30+ plant-based options (tempeh, chickpea curry, falafel, black bean tacos, quinoa bowl, kefir, hemp seeds, etc.) + 15+ meat options (only suggested when user has no stated restriction). Two example pairs showing different foods on first vs second ask.
- **SEARCH_FOOD_IDEAS TOOL guidance** (added to FOOD RECOMMENDATIONS section): instructs Grace to call `search_food_ideas` for all food recommendation requests. Specifies how to build the query (dietary restriction + food dislikes + "GLP-1 friendly" + meal type). Example queries included.
- **TOPIC PIVOT HARD RULE** (added in previous session, now documented): self-check before sending — "Is my reply answering the message the user JUST sent or still answering the previous one?"

**`services/api/src/tools/search-food-ideas.ts`** (NEW)
- `makeSearchFoodIdeasTool(deps)` — calls Gemini with `useGoogleSearch: true` (Google Search grounding)
- Builds a targeted query with dietary restriction, dislikes, meal type, "GLP-1 friendly"
- Returns structured JSON array: `[{ name, protein_g, why }]`
- Falls back gracefully (returns `{ ok: false }`) if search or parse fails
- Enabled by default; admin-toggleable via `tool_settings` (no DB migration needed — new tools are allowed when no row exists)

**`services/api/src/services/ai.service.ts`** (MODIFIED)
- Imports and registers `search_food_ideas` tool alongside the existing 8 tools
- Passes `llm` provider to the tool so it can make grounded Gemini calls

**`services/api/src/multimodal/analyze.ts`** (MODIFIED — food path only)
- **Two-pass food image analysis** (see Multimodal section above for full detail)
- `IMAGE_CLASSIFY_AND_IDENTIFY_PROMPT`: enhanced Pass 1 with visual anchors and cooking-method detection
- `USDA_PROTEIN_TABLE`: embedded 50-food reference (poultry, seafood, eggs/dairy, plant proteins, grains, vegetables)
- `buildFoodMacroCalculationPrompt(pass1)`: constructs Pass 2 text-only prompt with USDA table + step-by-step methodology
- Body/audio/other paths: zero changes

**`services/api/src/scheduler/prompt-optimizer.ts`** (MODIFIED)
- `generateAdditions()` now extracts previous BEHAVIORAL ADJUSTMENTS from the active prompt and passes them to Gemini as "ALREADY IN PLACE" context — prevents optimizer from re-deriving the same rules every nightly run
- LLM instructed: "Do NOT repeat rules already covered. Refine with concrete examples if they're not working."
- `TS2532` fix: `previousAdditions` extraction uses `?? ''` null guard

**`services/api/eval/cases.ts`** (MODIFIED)
- Added 11 eval cases targeting known 👎 failure patterns: topic pivot, food-logging over-asking, food deflection, brief emotional replies, side effect deflection

**Known production bugs fixed (2026-05-19):**
- `tryWebSearchFallback()` now rejects regen-severity violations (was only checking block) — prevents banned phrases from reaching users via the web search path
- Morning reminders weren't firing for Israel users: root cause was DB default timezone `'America/New_York'`. At 08:00 Israel = 01:00 EDT → quiet hours blocked. Fixed per-user via admin PUT to `Asia/Jerusalem`. **New users still default to `'America/New_York'` in the migration — update timezone immediately after manual user creation.**

### Phase 13 — Security hardening + Conversation intelligence + Production quality (2026-05-27)

All work on branch `claude/grace-auto-evaluation-HiMb8`, merged to main.

**`supabase/migrations/20260527000001_enable_rls_all_tables.sql`** (NEW)
- Enables Row Level Security on all 16 public tables (`users`, `conversations`, `messages`, `embeddings`, `tool_logs`, `feedback`, `food_logs`, `weight_logs`, `check_ins`, `injections`, `prompts`, `tool_settings`, `content_rules`, plus 3 others)
- Default-deny policy blocks Supabase `anon` key from all operations
- Service-role and direct Postgres connections (used by the API) are unaffected

**`packages/ai-core/src/relevance-check.ts`** (NEW)
- LLM relevance checker module: post-generation semantic check using `gemini-2.0-flash` (~150ms)
- Verifies response actually answers the user's latest message, not an older topic
- Returns `{ relevant: boolean, reason: string }` — triggers regen on `relevant: false`

**`packages/ai-core/src/orchestrator.ts`** (MODIFIED)
- Wired LLM relevance check after generation: if response fails semantic relevance → regen with explicit instruction to address the latest message
- Topic drift detection: ratio-based check (old-topic keywords > 2x current keywords → regen)
- Topic-closer history stripping: after "thanks"/"ok"/"got it", all history before the closer is stripped from orchestrator input so old topics don't anchor the response

**`packages/ai-core/src/prompts.ts`** (MODIFIED)
- Memory block reframed as "BACKGROUND — DO NOT mention unless relevant"
- Tool results similarly reframed as background-only context
- User data block changed to "background only"
- Dynamic response length: match response length to user's message energy
- Brief reply = topic closer: "Thanks" explicitly closes previous topic, no re-reference allowed

**`packages/ai-core/src/content-checker.ts`** (MODIFIED)
- Banned "oh dear"/"oh my"/"yikes" alarm language
- Banned premature medical escalation patterns ("I'm really concerned", "please see your doctor immediately" for non-emergency contexts)
- Added concern-without-panic rule enforcement

**`services/api/src/services/ai.service.ts`** (MODIFIED)
- History reduced from 12 → 6 turns to reduce old-topic anchoring
- Medical tone: 6-step mandatory response structure, 4-level graduated escalation logic (acknowledge → educate → suggest → escalate)
- Message coalesce window increased from 2s to 3.5s
- Emergency LLM fallback: if full pipeline crashes, minimal Gemini call still answers the user

**`services/api/src/services/user.service.ts`** (MODIFIED)
- `ensureUser()` no longer crashes when `phone_hash` column missing; `medication_time`/`sms_consent` moved to try/catch block

**`services/api/src/routes/webhook.ts`** (MODIFIED)
- RLHF feedback acknowledgment replaced: developer-like "Thanks for the feedback, I'll work on that!" → Grace-appropriate "Got it. I hear you."
- Stray colon cleanup: format enforcer strips mid-sentence colons from LLM output

**`services/api/src/scheduler/scheduler.ts`** (MODIFIED)
- Bonus spontaneous reminders: 1 extra daily message at a varied random time
- Scheduler tick includes the new spontaneous nudge type alongside morning/midday/evening

**`services/api/src/scheduler/prompt-optimizer.ts`** (MODIFIED)
- Switched from `gemini-2.5-flash` to `gemini-2.0-flash` for both primary and retry attempts — thinking tokens from 2.5-flash were eating the JSON output budget, causing parse failures

**`services/api/src/config/ssl.ts`** (MODIFIED)
- Reverted `rejectUnauthorized` back to `false` for Supabase transaction pooler compatibility

**`Dockerfile`** (MODIFIED)
- Added `pnpm-lock.yaml` to runtime COPY stage for frozen-lockfile install

**Key architecture notes:**
- Conversation context pipeline: 6 history turns → topic-closer detection strips old turns → LLM relevance check catches semantic drift → content checker catches banned phrases → format enforcer cleans formatting
- Optimizer now uses `gemini-2.0-flash` (not `gemini-2.5-flash`) to avoid thinking token budget issues
- Message coalesce window is 3.5s (was 2s)
- Topic closers ("thanks", "ok", "got it") reset conversation context — all history before the closer is stripped

### Phase 14 — QA tools + behavioral defense + calorie parity (2026-05-28)

**Calorie tracking — full parity with protein:**
- `supabase/migrations/20260528000001_calorie_goal.sql` — `calorie_goal_kcal INT` column on users
- `services/api/src/nutrition/calorie-target.ts` — Mifflin-St Jeor BMR + activity factor + GLP-1 deficit (fat_loss 500, recomp 350, maintenance 300, muscle_gain -200 surplus). Floor at BMR or 1200 kcal, cap at 4000 kcal.
- `services/api/src/routes/users.ts` — wires calculator into onboarding, degrades silently if any input missing
- `services/api/src/user/user.service.ts` — `calorie_goal_kcal` added to GraceUser interface
- `services/api/src/services/ai.service.ts` — context now shows "Total calories TODAY: X / Y target (Z remaining)" as first-class line + "Personal daily calorie target: X kcal" with range guidance
- `packages/ai-core/src/prompts.ts` — new "CALORIES LEFT FOR TODAY" required pattern mirror of protein rule
- `services/api/src/tools/get-food-summary.ts` — added `calorie_goal_kcal`, `calorie_goal_met`, `calories_remaining` fields (parity with protein)
- `packages/ai-core/src/content-checker.ts` — 7 calorie-shame banned patterns (under-ate, over-ate, "way over budget", starvation language, "you should be eating more/less")
- `packages/ai-core/src/classify.ts` — added patterns for "calories left/remaining", "did I overeat", "can I still eat", "am I over my goal"
- `services/api/src/services/ai.service.ts` — force-call get_food_summary when classifier detects calorie query

**Force-call hardening (food logs not detected):**
- `packages/ai-core/src/classify.ts` — broadened FOOD_LOG regex: present tense ("I'm eating"), comma-separated food lists, 50+ food words, "and"/"with" joiners, quantity units
- `services/api/src/services/ai.service.ts` — additional safety net: detects food verb + food word combination, force log_food even if classifier missed. Logs `ai.handle.forced_log_food` for debug.
- Force-call CONTINUATION turns: when last Grace message was a food question and user replies with brief detail ("one scoop", "with milk"), combine both messages and call log_food. Logs `ai.handle.forced_log_food_continuation`.

**New admin QA tools:**
- `services/api/auto-eval/regression-scenarios.ts` — 17 scenarios replaying every production bug fixed in sessions 13+14 (weight loss alarm, fatigue premature escalation, "Thanks" topic leakage, muscle loss concern, food log format/clarification, protein/calorie left today, developer feedback ack, connection excuse, memory relevance, long responses, excessive questions, protein shake log, brief continuation fallback)
- `services/api/auto-eval/regression-runner.ts` — runs each scenario through Grace, checks for banned phrases (literal) AND required behaviors (LLM judge)
- `POST /admin/regression/run` + `GET /admin/regression/scenarios` endpoints
- `apps/web/src/pages/admin/RegressionPage.tsx` — one-click "Run all 17 scenarios" UI with pass/fail per scenario, expandable details
- `services/api/src/replay/sandbox.ts` — production-realistic replay using REAL AIOrchestrator + in-memory mock tools (log_food, get_food_summary, get_user_profile). State persists across turns. Returns rich metadata: intent, tool calls, regenerated flag, critic issues.
- `POST /admin/replay` rewritten to use sandbox (was raw llm.generate)
- `POST /admin/replay/diff` — same messages against two prompt versions
- `apps/web/src/pages/admin/ReplayPage.tsx` — paste WhatsApp messages, see what Grace would actually say (with tool calls, regen status, banned-phrase highlighting)
- Auto-eval UI: 6 presets (Quick smoke 5, Standard 15, Food/protein focus, Emotional/medical focus, Edge cases, Full sweep), concurrency selector (1/2/4/8), category multi-select chips, live time estimate

**Triple-layer behavioral defense:**
- Layer 1: Prompt instructions (existing)
- Layer 2: Generalized regex patterns — single catch-all instead of 5 specific:
  - Sycophantic openers: `(great|awesome|wonderful|perfect|fantastic|amazing|excellent|brilliant|marvelous|splendid|terrific|superb|outstanding|incredible|stellar|nice job|good job|way to go|kudos)[!,]`
  - Refusals: `i (don'?t|do not) (know|have) (what you'?ve|what you have|your)`, `without knowing`, `it depends on`, etc.
  - Clarification questions: any "how much/what was/what size/which brand" on user's food
  - Generic fallbacks: any "I'm here to help" / "what's on your mind" / "feel free to ask"
- Layer 3 (NEW): `packages/ai-core/src/behavioral-guard.ts` — LLM judge against 10 high-level principles (uses available data, logs without clarification, answers the actual question, calm not alarmist, no sycophantic openers, no developer voice, no fabricated excuses, no irrelevant memory, concise to brief, no generic fallbacks with clear context). Runs after quality guard, before send. Returns `{violations: [{principle, reason}]}`. Triggers regen with specific principle quoted.

**Scheduler cadence guardrails:**
- `services/api/src/scheduler/scheduler.ts` — strict rules in `sendAndRecord`:
  - Maximum **2** proactive messages per user per day (Redis counter)
  - Minimum **3 hours** between any two proactive messages (Redis timestamp)
- Tracked in Redis: `cadence:{phone}:{date}` counter + `cadence:last:{phone}` timestamp, both with 24h TTL
- Exempt time-critical flows: `injection_morning`, `injection_followup`, `injection_dayafter`, `trial_expiry_reminder`

**Welcome message rewrite:**
- `services/api/src/scheduler/message-generator.ts` — 3 short paragraphs: greeting + medication, what Grace does (1-2 check-ins/day, text anytime for food/symptoms/weight/feelings, photos/voice work), expectations (no pressure to reply)

**Pipeline order now:**
1. Format enforcer (deterministic) — em dashes, markdown, bullets, colons, names, length caps
2. Content checker — banned phrases (generalized regex)
3. Grounding precheck — unsupported medical claims
4. Topic drift (keyword + Jaccard) — old-topic continuation
5. LLM relevance check — semantic off-topic
6. Quality guard — too long, too many numbers, multiple questions
7. **Behavioral guard (NEW)** — 10 high-level principles, LLM judge
8. Critic (risky intents only) — safety / medical accuracy
9. → regen if any fails → web search fallback → safe fallback

**Key files added this session:**
- `services/api/src/nutrition/calorie-target.ts`
- `services/api/src/replay/sandbox.ts`
- `services/api/auto-eval/regression-scenarios.ts`
- `services/api/auto-eval/regression-runner.ts`
- `packages/ai-core/src/behavioral-guard.ts`
- `apps/web/src/pages/admin/RegressionPage.tsx`
- `apps/web/src/pages/admin/ReplayPage.tsx`
- `supabase/migrations/20260528000001_calorie_goal.sql`

### Phase 15 — Latency pass + comprehensive feedback fixes (2026-05-30)

Driven by two production feedback reports (`gracefullfeedback.html` — 24 exchanges across 7 screenshots; `gracefeedbacksession3.txt` — 11 exchanges) plus targeted latency work.

**`services/api/src/services/fast-path.ts`** (NEW) — instant deterministic responder. 14 categories (greeting, brief_positive, brief_negative, brief_ack, thanks, goodnight, farewell, laughter, apology, reaction, appreciation, love_it, confirmation, denial). Each has a rotating reply pool seeded by `hash(userId + text)` so same user doesn't repeat the same line. Hard guards: length >40 chars / `?` / digits / media → falls through to LLM. `NEVER_FAST_PATH_RE` defensively blocks medical/food/crisis keywords. Wired into `AIService.handleMessage()` before `handleMessageInner()`. Logs `ai.fast_path.hit` with category + latencyMs. End-to-end: ~150ms.

**`services/api/src/routes/webhook.ts`** — `shouldSkipCoalesce()` mirrors fast-path patterns. Trivial messages bypass the 2-second coalesce buffer entirely. Coalesce window also dropped 3.5s → 2s for messages that still go through it.

**`packages/ai-core/src/orchestrator.ts`** — parallel LLM guards: relevance, behavioral, critic now run via `Promise.all` instead of sequentially. Skip rules for trivial intents and very short responses (<40 chars) avoid the LLM calls entirely. Critic gated by `shouldRunCriticEarly` — joins the parallel batch only when needed, otherwise runs lazily inside the regen branch. Per-intent token budgets: greeting/gibberish 256, food_log/weight_log/mood_log 512, emotional 1024, knowledge/complex 8192. New `appointment_prep` intent type with 8192 budget. Truncation recovery addendum on regen: when finishReason was 'length' or response ended mid-word, the retry prompt is appended with "TRUNCATION RECOVERY: rewrite in 2-3 short sentences, no lists, ensure complete sentence ending."

**`packages/ai-core/src/critic.ts` + `packages/ai-core/src/behavioral-guard.ts`** — both now run on `gemini-2.0-flash` + `disableThinking: true`. Saves 300-500ms per call vs default 2.5-flash with thinking enabled. Critic also bumped from 300 → 500 maxOutputTokens (smaller models truncated JSON at 300 → malformed_response).

**`services/api/src/rag/gemini-embedder.ts`** — embed cache TTL bumped 5min → 30min. Query embeddings are deterministic — same "what should I eat?" hits cache instead of re-embedding (~350ms saved per hit).

**`packages/ai-core/src/classify.ts`** — added `appointment_prep` MessageType + `APPOINTMENT_PREP` regex patterns. Detection runs BEFORE knowledge/general so "Help me write my questions for my endocrinologist appointment" routes correctly on the FIRST message, not the second (fixes Session 3 feedback Exchange 6 bug).

**`packages/ai-core/src/content-checker.ts`** — major expansion driven by the feedback reports:
- 18 new banned-phrase patterns (incredibly common, completely understandable, really important question, excellent that you're thinking, absolutely critical questions, you MUST discuss, holistic approach, layers of complexity, hope it hit the spot, classic breakfast, I'm here and ready to help, etc.)
- Context-aware checks accepting `userMessage`:
  - `checkPrivacyMisfire()` — Grace said "I only know about you and your journey" on a self-referencing health question (e.g. "I feel nauseous after my shot") → regen. Fixes Bug 1 from feedback.
  - `checkTwoQuestions()` — counts `?` in response, regen if >1.
  - `checkFoodLogPreambleLeak()` — if user's message is a food log AND response opens with "That's great you're feeling…" callback → regen. Fixes the "just had protein shake" → "That's great you're feeling strong" production bug from screenshot.
- List-introducing phrase blocks: `Here's a breakdown:`, `Here's why it's happening:`, `Why it's happening:` etc.
- Wrong-redirect block: `share this feeling with your doctor` when paired with "isn't working" language (the user's frustration about a plateau is NOT a clinical question).
- Image capability denial blocks: `I cannot see images` / `text-based AI` / `describe the picture to me` (Grace HAS image analysis — denying it contradicts the prior turn).
- Protein-from-goal-weight factual error block: `per kilogram of your goal body weight`.

**`packages/ai-core/src/format-enforcer.ts`** — label-colon threshold dropped 2 → 1 (a single `Bananas: easy to digest` leaks list-feel through). Added `list_intro_stripped` and `section_header_stripped` passes for `Here's a breakdown:` / `Why it's happening:` / `What to do:` patterns. Added `appointment_prep` MessageContext with 800-char cap.

**`packages/ai-core/src/quality-guard.ts`** — added `appointment_prep` to sentence and char limits (8 sentences / 800 chars).

**`packages/ai-core/src/prompts.ts`** — major rewrite at the top of the system prompt:
- **PRIVACY RULE — STRICTLY SCOPED**: fires ONLY on third-party queries, with the exact "I feel nauseous after my shot" production failure as a memorized example.
- **ANSWER ONLY THE CURRENT MESSAGE — RULE #1**: highest-priority rule with 7 exact production transcripts as ✗/✓ pairs (hair vs nausea, face vs hair, constipation vs face, bloating vs exhaustion, food noise vs plateau, failing-feeling vs stale food log, protein shake vs stale "feeling strong"). SELF-CHECK instruction before every response.
- **EMOTION BEFORE DATA — HARD RULE**: if user's message is emotional, respond to the emotion FIRST. Never open with food logging, protein numbers, or data.
- **H3 PROSE ONLY** strengthened: 6 production list-format failures shown with ✗/✓ pairs (BRAT staples, Why Muscle Loss Can Happen, breakdown of how they differ, etc.) + self-check.
- **H3a NO TWO QUESTIONS**: max one `?` per response, at the end.
- **H9 PROTEIN TARGET — NOT goal weight**: explicit ✗/✓ examples for the "per kilogram of your current body weight" phrasing.
- **H10 CLINICAL REDIRECT TEMPLATE**: gold-standard "That one I'd genuinely leave to your doctor. They can [reason]. Worth calling them this week." Banned warning-label phrasing list.
- **H11 "FEELING LIKE IT'S NOT WORKING" — EDUCATION**: never redirect plateau-feeling vents to doctor. The right response is validate + plateau science + grounded hope.
- **H12 banned phrases list expanded** to match content-checker.
- **IMAGE FOLLOW-UP — CRITICAL** (in non-negotiable truth #5): if Grace already analyzed an image earlier, follow-up questions like "what do you see?" MUST reference what was seen. Never deny image capability.
- **BANNED FOREVER list expanded** with all 18 new patterns.

**`services/api/src/services/ai.service.ts`** — image follow-up context injection. When user's message references "picture/image/photo/the meal" but no new image was sent, scan recent history for Grace's prior image analysis reply (matching "looks like / that meal" + grams or protein) and inject as `[IMAGE FOLLOW-UP — your previous analysis said: "…". Reference what you saw.]`. Prevents Grace from denying she analyzed the image.

**`services/api/src/scheduler/scheduler.ts`** — engagement cooldown. New `engagementCooldownHours` dep (configurable via `ENGAGEMENT_COOLDOWN_HOURS` env var, default 2). LAYER 1: cooldown applies to ALL non-critical types — if `user.last_reply_at` is within window, skip. Resets automatically when next user message updates `last_reply_at`. Critical-exempt list narrowed: `injection_morning`, `injection_followup`, `trial_expiry_reminder`. `injection_dayafter` now respects cooldown. Logs `scheduler.engagement_cooldown_active`.

**`services/api/src/config/env.ts`** — added `ENGAGEMENT_COOLDOWN_HOURS` z.coerce.number().min(0).max(48).default(2).

**`services/api/src/server.ts`** — passes `env.ENGAGEMENT_COOLDOWN_HOURS` into `new Scheduler(...)`.

**Key files added/touched this phase:**
- `services/api/src/services/fast-path.ts` (NEW)
- `services/api/src/routes/webhook.ts` (coalesce 3.5→2, shouldSkipCoalesce)
- `services/api/src/services/ai.service.ts` (fast-path wiring, image follow-up context)
- `services/api/src/scheduler/scheduler.ts` (engagement cooldown)
- `services/api/src/config/env.ts` (cooldown env var)
- `services/api/src/server.ts` (cooldown wiring)
- `services/api/src/rag/gemini-embedder.ts` (embed TTL 5→30 min)
- `packages/ai-core/src/orchestrator.ts` (parallel guards, per-intent budgets, truncation addendum)
- `packages/ai-core/src/critic.ts` (gemini-2.0-flash + disableThinking)
- `packages/ai-core/src/behavioral-guard.ts` (disableThinking)
- `packages/ai-core/src/classify.ts` (appointment_prep)
- `packages/ai-core/src/content-checker.ts` (18 new bans, 3 context-aware checks)
- `packages/ai-core/src/format-enforcer.ts` (label-colon 2→1, list-intro stripping)
- `packages/ai-core/src/quality-guard.ts` (appointment_prep limits)
- `packages/ai-core/src/prompts.ts` (PRIVACY scoped, ANSWER ONLY RULE #1, EMOTION BEFORE DATA, H3 hardened, H10–H12, IMAGE FOLLOW-UP, BANNED FOREVER expanded)
- `docs/CACHING.md` (NEW — caching + latency layers reference)

### Phase 7+8 — known follow-ups not yet shipped

- **`is_paused` flag** on `users` table to support pause-mode in the re-engagement ladder. Currently `paused: boolean` exists but isn't toggled by chat — needs a separate handler for "pause" / "I'm back" phrases.
- **Base tier 10-msg/day cap** with upgrade nudge in webhook gate (not yet enforced)
- **Twilio A2P campaign resubmission** — rejected twice (sample #2 said "Nudge" not "Grace"; use-case was Customer Care vs Mixed). Action: add real unchecked SMS consent checkbox to graceglp.com signup
- **Grace Pro Stripe price ($24/mo)** — not yet created in `acct_1TWfwc`; `PRO_PRICE_ID` in `supabase/functions/upgrade-to-pro/index.ts` still points to old account
- **Welcome email** — template ready (`docs/WELCOME_EMAIL.md`), not wired into `/users/onboard`
- **DB password** — `Giburking18!` was exposed in terminal output twice; MUST be rotated at https://supabase.com/dashboard/project/uifadtlktpddtfohwxfi/settings/database then update `fly secrets set --app grace-api DATABASE_URL="postgresql://postgres.uifadtlktpddtfohwxfi:NEW_PASSWORD@aws-1-ap-northeast-1.pooler.supabase.com:6543/postgres"`

---

## Web app — landing + onboarding component map

| File | What it does |
|---|---|
| `apps/web/src/components/Logo.tsx` | Reusable logo lockup — botanical sprig SVG mark (sage + terracotta) + serif wordmark. 3 sizes (small/default/large). |
| `apps/web/src/pages/Landing.tsx` | Sticky desktop nav + mobile header + section composition. |
| `apps/web/src/components/landing/HeroSection.tsx` | Editorial chat mockup left, copy + CTA right. |
| `apps/web/src/components/landing/ChatMockup.tsx` | WhatsApp-style phone-frame mockup showing real Grace exchange. |
| `apps/web/src/components/landing/MedicationsBar.tsx` | Pill row of all supported GLP-1 meds. |
| `apps/web/src/components/landing/QuoteSection.tsx`, `PhilosophySection.tsx`, `FeatureSpread.tsx`, `FAQSection.tsx`, `FooterCTA.tsx` | Below-fold content sections, all GLP-1-specific. |
| `apps/web/src/pages/Onboarding.tsx` | 11-step quiz wrapper. POSTs to `/users/onboard` when `VITE_API_URL` set, falls back to Supabase edge fn otherwise. Passes `rlhfEnabled` consent + `glp1StartDate` through. |
| `apps/web/src/components/onboarding/PhoneStep.tsx` | Final form: phone, SMS consent, optional RLHF consent checkbox. |
| `apps/web/src/components/onboarding/WeightStep.tsx` | Optional personalization fields: weight, height, age, primary goal, **GLP-1 start date** (drives Grace's week-number accuracy). |
| `apps/web/src/components/onboarding/PaymentStep.tsx` | Stripe checkout via Supabase edge fn. Needs `VITE_SUPABASE_*` env vars. |
| `apps/web/src/components/onboarding/ConfirmationStep.tsx` | Success screen with primary `wa.me` deeplink CTA. Pre-fills `join <code>` in sandbox mode (`VITE_WHATSAPP_JOIN_CODE`), clean link in production. |
| `apps/web/vercel.json` | SPA rewrite — every route serves `index.html`. |
| `apps/web/src/index.css` | Design tokens. Sage primary + terracotta accent + cool gray-white background, with a fixed dual-halo body gradient (terracotta top-right, slate bottom-left). `.admin-shell` scope overrides all tokens to deep slate + indigo for the admin dashboard. |
| `apps/web/src/components/landing/AnimatedBackground.tsx` | Five colorful animated blobs (coral, mint, lavender, gold, sky) on the landing page. Uses `isolate` stacking context in Landing.tsx wrapper to keep z-index contained. |

## Admin dashboard — component map

| File | What it does |
|---|---|
| `apps/web/src/components/admin/AdminLayout.tsx` | Sidebar nav + auth guard |
| `apps/web/src/components/admin/AdminAuth.tsx` | Token context (localStorage) |
| `apps/web/src/components/admin/UserDrawer.tsx` | Right slide-over: profile edit, account toggles, weight chart, check-ins |
| `apps/web/src/components/admin/CreateUserModal.tsx` | Dialog to onboard a new user without curl |
| `apps/web/src/pages/admin/MetricsPage.tsx` | Activity KPIs + user stats row + charts |
| `apps/web/src/pages/admin/ConversationsPage.tsx` | Two-panel thread viewer + SSE live stream |
| `apps/web/src/pages/admin/UsersPage.tsx` | Paginated table; click row → UserDrawer; Add User → CreateUserModal |
| `apps/web/src/pages/admin/FeedbackPage.tsx` | RLHF feedback list + quick rate buttons |
| `apps/web/src/pages/admin/PromptsPage.tsx` | Prompt versioning + one-click activate |
| `apps/web/src/pages/admin/ToolsPage.tsx` | Per-tool enable/disable + priority |

---

## Multimodal implementation notes

`services/api/src/multimodal/analyze.ts` is the single entry point for all media.

**Images — food (two-pass scientific algorithm, 2026-05-19):**
- Pass 1 (vision): classify image + detailed visual identification — lists every item with weight estimate using calibrated visual anchors (standard dinner plate = 25–27cm, palm-sized protein = ~85–100g cooked, egg = ~50g, etc.) and cooking method. NO macro calculation in this pass.
- Pass 2 (text-only, food only): takes Pass 1 output → scientific USDA calculation. Uses embedded reference table (50+ foods, g protein/100g from USDA FoodData Central). Explicit per-item formula: `weight_g / 100 × USDA_value`. Outputs `CALCULATION_NOTES` with USDA matches used. Falls back to Pass 1 result if Pass 2 fails.
- Output format: identical to before (`IMAGE_TYPE: food`, `ITEMS:`, `BREAKDOWN:`, `TOTAL:`, `CONFIDENCE:`, `NOTES:`) — no changes needed in `ai.service.ts` or `buildFoodLogArg()`.
- `body` → Pass 1 only (unchanged) → GLP-1-aware progress analysis, no tool call
- `other` → Pass 1 only (unchanged) → Grace handles gracefully

**Audio** (WhatsApp voice notes, `audio/ogg`) — Gemini inline base64 doesn't reliably support ogg.
Uses the File API instead: write buffer to OS temp file → `GoogleAIFileManager.uploadFile()` → reference by `fileUri` → delete after. Twilio media URLs require Basic auth (`SID:token`) — passed via `AIServiceDeps.twilioSid/twilioToken` → `analyzeMedia opts.twilio`.

**Injection point** in `ai.service.ts`: augmented text is built before the orchestrator runs.
- Food images: Pass 2 result contains `IMAGE_TYPE: food` + `TOTAL:` → `buildFoodLogArg()` extracts items+total → `log_food` auto-called. Grace replies with TOTAL protein in 1–2 sentences.
- Body images: Pass 1 result contains `IMAGE_TYPE: body` → Grace replies warmly, no tool call.
- This prevents the orchestrator from guessing intent wrong.

---

## Known gaps / deferred

- **Fly payment method**: add at https://fly.io/trial — trial machines auto-stop after 5 min idle, breaking scheduler proactive messages and adding ~10s cold-start to every incoming webhook.
- **WhatsApp Business sender**: still on Twilio sandbox (`whatsapp:+14155238886`), which forcibly prepends "Twilio Sandbox:" to every outbound message and requires each user to text `join <code>` first. Submit a real sender via Twilio Console → Messaging → Senders → New Sender → "My own phone number". 3–10 business day Meta approval. When done: update `VITE_WHATSAPP_NUMBER` on Vercel, remove `VITE_WHATSAPP_JOIN_CODE`, update `TWILIO_WHATSAPP_FROM` Fly secret.
- **Vercel env vars**: `VITE_SUPABASE_URL` + `VITE_SUPABASE_PUBLISHABLE_KEY` need to be set on the `grace-admin` Vercel project for the Stripe checkout step to work. `VITE_WHATSAPP_NUMBER` + `VITE_WHATSAPP_JOIN_CODE` light up the deeplink button on the Confirmation screen.
- **Legacy v1 edge fn**: `handle-inbound-sms` still deployed in Supabase as a fallback. Disable after 24h of stable v2 traffic.
- **v2 Stripe webhook**: Stripe events currently update `is_paid` via v1 Supabase function hitting the shared DB. v2 reads from same DB so it works. Only build a native v2 handler if moving off Supabase DB entirely.
- **Admin auth upgrade**: localStorage Bearer token is fine for internal use. Upgrade to Supabase Auth roles before broad team access.
- **OpenTelemetry + Sentry**: not yet instrumented.
- **Integration tests**: boot Fastify in-process with stubbed LLMProvider.
- **`exactOptionalPropertyTypes`**: disabled in tsconfig — re-enable when ready.
- **A/B testing harness**: deferred.
- **BullMQ dashboard**: Bull Board not wired yet.
- **Welcome email sending**: template written (`docs/WELCOME_EMAIL.md`) but not wired into `POST /users/onboard` yet — needs an email provider (Postmark/Resend/SendGrid).
