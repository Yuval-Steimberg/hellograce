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
  GEMINI_FALLBACK_MODEL: z.string().default('gemini-2.0-flash'),

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

  /** FAQ semantic cache — when true, fresh-conversation messages whose
   *  embedding matches a seeded FAQ entry above the threshold bypass the
   *  full LLM pipeline and return the canonical response (~50ms vs ~1500ms).
   *  Default OFF until verified in production. */
  FAQ_CACHE_ENABLED: z.coerce.boolean().default(false),
  FAQ_CACHE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.92),

  /** Phase 5: USDA FoodData Central API key. When unset, log_food falls back
   *  to the legacy LLM-only macro estimate. Free signup at
   *  https://fdc.nal.usda.gov/api-key-signup.html (1000 requests/hour). */
  USDA_API_KEY: z.string().optional(),

  /** Phase 12: Cross-encoder reranker sidecar URL (e.g. http://reranker:8081).
   *  When unset, HybridRagService silently degrades to dense-only retrieval —
   *  identical behavior to the legacy RagService. */
  RERANKER_URL: z.string().url().optional(),
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
