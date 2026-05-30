# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

_Also loaded automatically at session start. Update at the end of every session so the next session resumes without re-deriving context._

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
- `detectFrequencyChange()` — patterns for "text me less/more", "once a day", "twice a day", "every other day". Updates `users.checkin_count_per_day` directly (bounded [1, 4]) and confirms warmly. Short-circuits before AI handler.

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
