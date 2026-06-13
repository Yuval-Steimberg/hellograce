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

  LLM_PROVIDER: z.enum(['gemini']).default('gemini'),
  GEMINI_API_KEY: z.string().min(1),
  GEMINI_MODEL: z.string().default('gemini-2.5-flash'),
  /** Used when the primary model returns 503/429 even after retries. */
  // 2026-06-03: was 'gemini-2.0-flash' but Google deprecated that model
  // entirely (404 on every call). Reverted to the same primary so a transient
  // failure on primary still falls back to a known-working model. Override
  // via env if you want a different fallback.
  GEMINI_FALLBACK_MODEL: z.string().default('gemini-2.5-flash'),

  RAG_ENABLED: z
    .string()
    .optional()
    .transform((v) => v !== 'false'),
  TOOLS_ENABLED: z
    .string()
    .optional()
    .transform((v) => v !== 'false'),

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
