import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3001),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  PUBLIC_BASE_URL: z.string().url(),
  /** Public-facing web app URL for upgrade + settings links in outbound messages. */
  PUBLIC_WEB_URL: z.string().url().default('https://grace-admin-silk.vercel.app'),

  DATABASE_URL: z.string().min(1),
  DATABASE_SSL: z
    .string()
    .optional()
    .transform((v) => v === 'true' || v === '1'),

  TWILIO_ACCOUNT_SID: z.string().min(1),
  TWILIO_AUTH_TOKEN: z.string().min(1),
  TWILIO_FROM_NUMBER: z.string().optional(),
  TWILIO_WHATSAPP_FROM: z.string().optional(),

  // ── iMessage relay (2026-06-17, multi-channel) ──────────────────────────
  // Apple has no official iMessage API; a relay provider (LoopMessage by
  // default) hosts a dedicated iMessage sender + an inbound webhook. iMessage
  // is OFF until IMESSAGE_AUTH_KEY + IMESSAGE_SECRET_KEY + IMESSAGE_SENDER_NAME
  // are all set; WhatsApp/SMS keep working regardless. Per-user routing is via
  // the users.channel column (default 'whatsapp').
  /** Which relay implements the iMessage contract. LoopMessage (default) uses
   *  Authorization/Loop-Secret-Key headers + a sender name; 'sendblue' uses
   *  sb-api-key-id/sb-api-secret-key + a provisioned line (no sender name). */
  IMESSAGE_PROVIDER: z.enum(['loopmessage', 'sendblue']).default('loopmessage'),
  /** Provider send endpoint. Defaults to the chosen provider's send URL. */
  IMESSAGE_API_URL: z.string().url().optional(),
  /** Auth key. LoopMessage: Authorization header. Sendblue: sb-api-key-id. */
  IMESSAGE_AUTH_KEY: z.string().optional(),
  /** Secret key. LoopMessage: Loop-Secret-Key header. Sendblue: sb-api-secret-key. */
  IMESSAGE_SECRET_KEY: z.string().optional(),
  /** The dedicated iMessage sender name/handle (LoopMessage only; unused by Sendblue). */
  IMESSAGE_SENDER_NAME: z.string().optional(),
  /** Sendblue line to send FROM (E.164, e.g. +13054098546). Required when the
   *  Sendblue account has more than one line — without it Sendblue 400s with
   *  "missing required parameter from_number". LoopMessage ignores this. */
  IMESSAGE_FROM_NUMBER: z.string().optional(),
  /** Shared secret / HMAC key used to verify the inbound iMessage webhook.
   *  When unset, the /webhook/imessage route only accepts requests outside
   *  production (verification is enforced when NODE_ENV=production). */
  IMESSAGE_WEBHOOK_SECRET: z.string().optional(),

  LLM_PROVIDER: z.enum(['gemini']).default('gemini'),
  GEMINI_API_KEY: z.string().min(1),
  // 2026-06-19: base model REVERTED to the known-good gemini-2.5-flash.
  // gemini-3-flash-preview was shipping EMPTY replies in production — a preview
  // model that (per the thinking-budget note in gemini.ts) burns its whole
  // output budget on reasoning and returns no text. An empty 200 does NOT
  // trigger the model-not-found fallback, so every turn silently degraded to
  // the canned "I'm with you. What's on your mind?" fallback. 2.5-flash is the
  // model this codebase was built and tuned on. To trial Gemini 3 again once
  // it's confirmed to return non-empty text on the active key, set the
  // GEMINI_MODEL env/Fly secret — the empty-response fallback added in gemini.ts
  // now also covers the case where the chosen primary returns empty text.
  GEMINI_MODEL: z.string().default('gemini-2.5-flash'),
  /** Used when the primary model returns 404/503/429, OR returns empty text,
   *  even after retries. Kept on the known-good 2.5-flash so any primary
   *  outage / unavailable id / empty-completion always has a working fallback. */
  GEMINI_FALLBACK_MODEL: z.string().default('gemini-2.5-flash'),

  RAG_ENABLED: z
    .string()
    .optional()
    .transform((v) => v !== 'false'),
  TOOLS_ENABLED: z
    .string()
    .optional()
    .transform((v) => v !== 'false'),

  /** Conversational SMS/iMessage onboarding — now the DEFAULT (2026-07-02, "no
   *  more web quizzes"). A new number is onboarded entirely over chat (a short,
   *  warm, LLM-phrased sequence: name, medication, schedule, wake/sleep, diet,
   *  consent — timezone auto from the phone), and completion sets trial_start so
   *  they're registered without ever leaving Messages. The web /onboarding form
   *  stays only as a desktop fallback. Opt out per-environment with
   *  `fly secrets set SMS_ONBOARDING_ENABLED=false`. */
  SMS_ONBOARDING_ENABLED: z
    .string()
    .optional()
    .transform((v) => v !== 'false' && v !== '0'),

  /** Progressive profiling: after the short onboarding core, Grace gathers the
   *  rest of the profile (sex, weight, height, age, activity, diet) "along the
   *  way" — one gentle question woven into normal chat, relevance-first. Default
   *  ON; instant revert with `fly secrets set PROGRESSIVE_PROFILE_ENABLED=false`. */
  PROGRESSIVE_PROFILE_ENABLED: z
    .string()
    .optional()
    .transform((v) => v !== 'false' && v !== '0'),

  ADMIN_TOKEN: z.string().min(16).optional(),
  /** Phone number (E.164) to receive RLHF optimizer run reports via WhatsApp. */
  ADMIN_PHONE: z.string().optional(),

  REDIS_URL: z.string().url().optional().default('redis://localhost:6379'),

  /** 32-byte hex key for AES-256-GCM field-level encryption of PII (phone, name, medication).
   *  Generate with: openssl rand -hex 32. When unset, encryption is disabled. */
  FIELD_ENCRYPTION_KEY: z.string().length(64).optional(),

  /** Stripe secret key. When unset, admin Stripe-billing read/cancel routes
   *  return 503; the rest of the API works normally. Production: set on Fly
   *  via `fly secrets set STRIPE_SECRET_KEY=sk_live_...`. */
  STRIPE_SECRET_KEY: z.string().optional(),

  /** Stripe webhook signing secret (whsec_...). When set, the v2 webhook at
   *  POST /webhook/stripe verifies signatures and records every event in
   *  stripe_events. When unset, the route is not registered (the v1 Supabase
   *  edge function keeps handling webhooks). */
  STRIPE_WEBHOOK_SECRET: z.string().optional(),

  /** Stripe price IDs for the Standard (base) and Pro plans. Used by the admin
   *  change-plan action. Default to the test-account price IDs the Supabase
   *  edge functions already use, so behavior is unchanged when unset. */
  STRIPE_BASE_PRICE_ID: z.string().default('price_1TWgb5LMk6wjvxD9Y9azDUfZ'),
  STRIPE_PRO_PRICE_ID: z.string().default('price_1TLla9E0DcWyPH4XZnep2X7G'),

  /** FAQ semantic cache — when true, fresh-conversation messages whose
   *  embedding matches a seeded FAQ entry above the threshold bypass the
   *  full LLM pipeline and return the canonical response (~50ms vs ~1500ms).
   *  Default OFF until verified in production. */
  FAQ_CACHE_ENABLED: z.coerce.boolean().default(false),
  FAQ_CACHE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.92),

  /** Crisis-resource localization gate (2026-06-06 coverage audit, Area 6).
   *  When FALSE (default), SAFETY_RESPONSE always ships the US-only 988/911
   *  text exactly as today. When TRUE, the per-country lookup in
   *  services/api/src/safety/crisis-resources.ts is used.
   *
   *  PRE-LAUNCH GATE: do NOT set TRUE until clinical + legal review of every
   *  entry in COUNTRY_MAP is signed off. See docs/PRE_LAUNCH_GATES.md. */
  CRISIS_RESOURCES_REVIEWED: z.coerce.boolean().default(false),

  /** Phase 5: USDA FoodData Central API key. When unset, log_food falls back
   *  to the legacy LLM-only macro estimate. Free signup at
   *  https://fdc.nal.usda.gov/api-key-signup.html (1000 requests/hour). */
  USDA_API_KEY: z.string().optional(),

  /** Phase 12: Cross-encoder reranker sidecar URL (e.g. http://reranker:8081).
   *  When unset, HybridRagService silently degrades to dense-only retrieval —
   *  identical behavior to the legacy RagService. */
  RERANKER_URL: z.string().url().optional(),

  /** Engagement cooldown (hours): after a user sends a message, suppress all
   *  non-critical proactive reminders for this window. Resets on every user
   *  reply. Default 2h — recommended minimum so Grace feels like a companion,
   *  not a notification system. Set to 0 to disable. */
  ENGAGEMENT_COOLDOWN_HOURS: z.coerce.number().min(0).max(48).default(2),

  /** Hours of silence before nudging a user who started conversational
   *  onboarding (SMS_ONBOARDING_ENABLED) but didn't finish. Default 4. The
   *  scheduler sends at most 2 nudges, ≥20h apart, in the user's daytime. */
  ONBOARDING_NUDGE_AFTER_HOURS: z.coerce.number().min(1).max(72).default(4),
  /** Even users who turned reminders OFF (paused) get ONE warm "I'm still here"
   *  hello after this many hours of silence. Default 24. */
  REENGAGE_QUIET_AFTER_HOURS: z.coerce.number().min(1).max(168).default(24),
  /** Minimum gap between quiet re-engagements to the same opted-out user, so
   *  they're never nagged. Default 72 (every 3 days at most). 0 disables it. */
  REENGAGE_QUIET_MIN_GAP_HOURS: z.coerce.number().min(0).max(720).default(72),

  /** How many recent conversation turns to feed the orchestrator/Gemini so a
   *  message is never interpreted in isolation (short replies, multi-turn
   *  continuity). Default 12 (was 6 — doubled now that the anchoring guards
   *  — relevance check, topic-closer history stripping, "answer THIS message"
   *  focus markers — make a larger window safe). Tunable up to 40 without a
   *  deploy: more context = better understanding at a small latency/token cost
   *  (accuracy is prioritized over latency). */
  CONVERSATION_HISTORY_TURNS: z.coerce.number().int().min(4).max(40).default(24),

  /** Master kill switch for the self-improvement / background optimizer crons:
   *  the RLHF prompt optimizer (weekly), behavioral anomaly detector (nightly),
   *  research scrape (weekly), and research auto-fix (weekly). When false, none
   *  of them are scheduled — the per-minute proactive message tick and the
   *  daily personalization engine are NOT affected (those are core product, not
   *  optimizers). Default true (preserves documented behavior); set to false to
   *  pause all optimizer activity without a code change. */
  OPTIMIZERS_ENABLED: z.coerce.boolean().default(true),

  /** TRUST GEMINI mode (2026-06-04 architecture refactor).
   *
   *  When TRUST_GEMINI=true, the response pipeline collapses 7 guard layers
   *  down to 3 essential ones: safety check (medical emergencies), format
   *  enforcer (cosmetic — em-dashes, markdown), and harmful-content checker
   *  (privacy leaks, forbidden food, banned dose claims). The brittle
   *  LLM-as-judge guards that produce most false positives are bypassed:
   *
   *    - behavioral_guard: catches "deflection" patterns but over-fires on
   *      legitimate "I need more info" responses → user sees canned fallback
   *    - relevance_check: semantic on-topic check that flags borderline
   *      cases → triggers regen that produces shorter / worse answers
   *    - quality_guard sentence caps: forces knowledge intent to <8 sentences,
   *      breaking multi-part medical answers
   *    - critic: Gemini-as-judge for non-safety intents → adds ~2s and rarely
   *      catches anything the deterministic checks miss
   *
   *  Default OFF — strict pipeline is the baseline. Flip to true to A/B
   *  test the lean pipeline in production.
   *
   *  When false, granular flags below can still disable individual layers. */
  TRUST_GEMINI: z.coerce.boolean().default(false),

  /** Individual guard toggles. Set to false to disable a specific layer
   *  without flipping the whole pipeline. Composes with TRUST_GEMINI —
   *  if TRUST_GEMINI=true, these are all forced to false regardless. */
  BEHAVIORAL_GUARD_ENABLED: z.coerce.boolean().default(true),
  RELEVANCE_CHECK_ENABLED: z.coerce.boolean().default(true),
  QUALITY_GUARD_STRICT: z.coerce.boolean().default(true),

  /** GEMINI-FIRST quality mode (2026-06-19 response-quality parity pass).
   *
   *  When true, every NORMAL user-facing response is generated by Gemini —
   *  the latency shortcuts that bypass the LLM and ship a deterministic
   *  template are disabled:
   *    - trivial fast-path (greetings / small talk / acks)
   *    - food-log fast template (the generic "Logged X, 22g. Total: …")
   *    - weight-log fast template
   *    - FAQ semantic cache (canned educational answers)
   *    - the deterministic recommendation-ack advance
   *
   *  Those paths still RUN their detection (intent, entity extraction) but the
   *  text the user sees comes from the orchestrator + Gemini, so it's
   *  contextual, personalized, and non-repetitive. Tools still execute
   *  (log_food / log_weight persist exactly as before — Gemini just phrases
   *  the confirmation).
   *
   *  Deliberately UNAFFECTED (per the quality spec's "safety checks may still
   *  assist" clause — these are correctness/safety guarantees, not quality
   *  shortcuts): crisis SafetyGuard (988/911), hypoglycemia acute handler,
   *  water tracker (separate table / data integrity), reminder-interface
   *  answers (prevents capability-denial), meal-preference no-log guard,
   *  Settings single-source-of-truth redirects. Degraded fallbacks
   *  (knowledge bank / resilient fallback) are also untouched — they ONLY
   *  fire when Gemini actually fails, which is exactly the spec's intent.
   *
   *  Trade-off accepted by the spec: +1-2s latency for a real, contextual
   *  answer. Default ON; flip to false (env, no deploy) to restore the
   *  latency-first shortcuts instantly. */
  GEMINI_FIRST: z.coerce.boolean().default(true),

  /** DIRECT REPLY MODE (2026-06-19 "work exactly like the competitor") — the
   *  full Nudge generation model. When true, the user-facing reply is produced
   *  by a SINGLE Gemini call on [system prompt + last N history turns + user
   *  message], temperature 0.8, ~500 tokens — NO orchestrator, NO planner, NO
   *  per-intent directive wrapping, NO guard/regen cascade. That cascade (terse
   *  "reply in ONE sentence" directives, tiny per-intent token budgets, relevance
   *  / behavioral / quality regens) is what made replies feel dry and robotic.
   *
   *  Still preserved (NOT part of the dry-cascade): the crisis SafetyGuard
   *  (988/911, runs before this), the personalized system prompt (today's
   *  protein/calorie totals, medication, week number — makes replies MORE
   *  personal, not less), deterministic food/weight logging (so totals stay
   *  accurate), and a single dose-safety BLOCK check on the final text (the one
   *  genuinely dangerous class for a GLP-1 product). Everything else ships as
   *  Gemini wrote it — exactly the competitor's "ship the model's words" model.
   *
   *  Default OFF (2026-06-20): the direct path lacked the orchestrator's guards
   *  (format-enforcer, quality/length caps, relevance check) and regressed in
   *  production — verbose nutrition essays, conversation-summary dumps, and
   *  occasional stalls. The orchestrator (yesterday's stable system) is the
   *  default again; it generates every reply via Gemini under TRUST_GEMINI +
   *  GEMINI_FIRST but keeps the guards that prevent those regressions. Flip to
   *  true (fly secrets set DIRECT_REPLY_MODE=true) only to A/B the lean path. */
  DIRECT_REPLY_MODE: z.coerce.boolean().default(false),
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}
