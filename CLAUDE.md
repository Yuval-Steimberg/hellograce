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
        │
        ▼
AIService.handleMessage()
        │
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
GeminiProvider (gemini-2.5-flash) → Validator
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
- **Engagement dampener** (`userEngagedToday`, `userSilentDays` helpers): caps a silent user at 2 messages/day (morning + 1 nudge), drops to 1/day (morning only) after >1 day of no reply. Engaged users still get the full 3-message schedule.
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

## Tools (8 registered per-request, admin-toggleable)

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
```

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

## Accuracy / eval harness

Lives in `services/api/eval/`. Runs every case through real Gemini + mocked tools, grades against expected intent / tool calls / required + forbidden phrases / length bounds, writes JSON to `eval/results/<timestamp>.json`.

- `eval/cases.ts` — the dataset. Add a case when you fix a real failure so it doesn't regress.
- `eval/grade.ts` — deterministic checks (no LLM judge yet — coming in Step 2).
- `eval/runner.ts` — concurrent runner + report formatter.
- Crisis/emergency wording is NOT in the eval set — `SafetyGuard` short-circuits the pipeline before the orchestrator runs, and is unit-tested in `services/api/src/safety/guard.test.ts`.

Roadmap (in progress, in this order):
1. ✅ Eval harness + 50-case dataset (`services/api/eval/`).
2. ✅ LLM-critic on risky intents (`knowledge_lookup`, `safety_*`, validator-flagged, or low-confidence). Regenerate once on critic fail, safe fallback if second attempt also fails. Implementation: `packages/ai-core/src/critic.ts` + orchestrator wiring. Output exposes `critic`, `regenerated`, `usedSafeFallback` for admin observability.
3. ✅ Fact-grounding: deterministic precheck (`packages/ai-core/src/grounding.ts`) detects quantitative medical claims (doses, durations, frequencies, percentages) and interaction-safety assertions in the response and verifies them against retrieved KB chunks. Unsupported claims fail-close to regen — saves a Gemini call vs. invoking the LLM-critic. Surfaced via `CriticReport.unsupportedClaims` + `source: 'precheck' | 'llm'`.
4. ⏳ Wire eval scores into `prompts` table; gate `activate` on ≥ baseline.
5. ⏳ Gemini prompt caching for static system prompt + tool defs; skip planner for pure-chat intents.

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
| 7 | AI quality pass from WhatsApp QA: persona, hallucination guards, quiet hours, settings redirect, food-dislike paraphrase, brief-reply rule, GLP-1 week number, 50+ emotional patterns | ✅ landed on `claude/icloud-access-clarification-5hsRr-v2`, ready to deploy 2026-05-13 |

---

## Where to start in a new session

1. Read this file + `docs/STATUS.md` + `docs/OPERATIONS.md`.
2. `git log --oneline -10` to see recent commits.
3. `git checkout claude/icloud-access-clarification-5hsRr-v2` (active feature branch as of 2026-05-13). Latest commit: `c23584b` — GLP-1 start date collected in onboarding.
4. Production is live at `https://grace-api.fly.dev` (API) and `https://grace-admin-silk.vercel.app` (web). Tail logs with `fly logs --app grace-api`.
5. Top open items in `docs/STATUS.md § Post-cutover`: Fly payment method (machines auto-stop), WhatsApp Business sender approval (drops "Twilio Sandbox:" prefix), Vercel env vars for Stripe, disable v1 edge fn.

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

### Phase 7 — known follow-ups not yet shipped

- **STOP/UNSUBSCRIBE** natural-language handling in `services/api/src/routes/webhook.ts` (Twilio handles literal STOP at carrier level; "stop texting me" / "pause" still needs in-process opt-out → settings redirect)
- **`is_paused` flag** on `users` table to support pause-mode in the re-engagement ladder
- **Base tier 10-msg/day cap** with upgrade nudge in webhook gate (not yet enforced)
- **Twilio A2P campaign resubmission** — rejected twice (sample #2 said "Nudge" not "Grace"; use-case was Customer Care vs Mixed). Action: add real unchecked SMS consent checkbox to graceglp.com signup
- **Grace Pro Stripe price ($24/mo)** — not yet created in `acct_1TWfwc`; `PRO_PRICE_ID` in `supabase/functions/upgrade-to-pro/index.ts` still points to old account
- **Welcome email** — template ready (`docs/WELCOME_EMAIL.md`), not wired into `/users/onboard`
- **DB password** — `Giburking18!` was exposed in prior terminal output; should be rotated at Supabase Dashboard → Settings → Database

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

**Images** — two-step: classify first (one Gemini call), then route:
- `food` → inline base64 + detailed USDA nutrition prompt → `log_food` tool fires automatically
- `body` → inline base64 + GLP-1-aware progress analysis prompt → Grace replies warmly, no tool call
- `other` → Grace handles gracefully

**Audio** (WhatsApp voice notes, `audio/ogg`) — Gemini inline base64 doesn't reliably support ogg.
Uses the File API instead: write buffer to OS temp file → `GoogleAIFileManager.uploadFile()` → reference by `fileUri` → delete after. Twilio media URLs require Basic auth (`SID:token`) — passed via `AIServiceDeps.twilioSid/twilioToken` → `analyzeMedia opts.twilio`.

**Injection point** in `ai.service.ts`: augmented text is built before the orchestrator runs.
Food images get an explicit `[Use log_food tool...]` instruction. Body images get `[Do NOT call tools, reply warmly]`. This prevents the orchestrator from guessing the intent wrong.

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
