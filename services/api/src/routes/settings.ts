import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import { randomInt, randomBytes } from 'crypto';
import { z } from 'zod';
import type { MessageSender } from '../twilio/sender.js';
import type { UserService, GraceUser } from '../user/user.service.js';
import { ValidationError, UnauthorizedError } from '../errors.js';
import { isEncryptedBlob } from '../crypto/field-encrypt.js';
import { isPlausibleStartDate } from '../services/medication-start-date.js';
import { createCheckoutSession, isStripeEnabled } from '../services/stripe.service.js';

/**
 * Self-serve user settings API (phone + verification code).
 *
 * Flow (all under the deployment's web domain — the Settings page calls these):
 *   1. POST /settings/request-code  { phone }        → sends a 6-digit code
 *   2. POST /settings/verify-code   { phone, code }  → { token, profile }
 *   3. GET  /settings/me            (Bearer token)   → { profile }
 *   4. PUT  /settings/me            (Bearer token)   → { ok, profile }
 *
 * Codes + sessions live in Redis (10-min code TTL, 30-min session TTL). The
 * session token is an opaque random string mapped to the verified phone — no
 * JWT/secret needed. Only profile/preference fields are editable here; account
 * flags (is_paid, is_pro, blocked, trial_start, paused) are admin-only.
 */

export interface SettingsRouteDeps {
  redis?: Redis;
  sender: MessageSender;
  users: UserService;
  /** WhatsApp configured? Code is sent via WhatsApp when true, else SMS. */
  whatsappEnabled: boolean;
  /** Stripe base (standard) price id for the customer-facing upgrade checkout. */
  stripePriceId?: string;
  /** Deployment web URL — used for Stripe success/cancel return URLs. */
  webUrl?: string;
  /** Development only: return the one-time code instead of calling a sender. */
  localTestMode?: boolean;
}

const CODE_TTL_SEC = 600;       // 10 minutes
const SESSION_TTL_SEC = 1800;   // 30 minutes
const MAX_VERIFY_ATTEMPTS = 5;

// Mirror routes/users.ts normalizePhone so a code requested for "+972 54…"
// matches the stored E.164 phone.
function normalizePhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (!digits) return phone.trim();
  const withPlus = `+${digits}`;
  return withPlus.replace(/^(\+1|\+7|\+[2-9]\d{1,2})0+/, '$1');
}

// User-editable fields ONLY (no account/billing/admin flags).
const SettingsUpdateSchema = z.object({
  first_name: z.string().trim().min(1).max(120).optional(),
  medication: z.string().trim().min(1).max(120).optional(),
  medication_frequency: z.string().trim().max(20).optional(),
  dose_mg: z.number().positive().max(100).nullable().optional(),
  injection_day: z.string().max(20).nullable().optional(),
  timezone: z.string().max(100).optional(),
  wake_time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
  sleep_time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
  current_weight: z.number().positive().max(2000).nullable().optional(),
  goal_weight: z.number().positive().max(2000).nullable().optional(),
  starting_weight: z.number().positive().max(2000).nullable().optional(),
  height_cm: z.number().int().min(80).max(250).nullable().optional(),
  age: z.number().int().min(13).max(120).nullable().optional(),
  sex: z.enum(['male', 'female', 'other']).nullable().optional(),
  primary_goal: z.string().max(120).nullable().optional(),
  activity_level: z.string().max(40).nullable().optional(),
  protein_goal_grams: z.number().int().min(1).max(500).nullable().optional(),
  calorie_goal_kcal: z.number().int().min(800).max(5000).nullable().optional(),
  dietary_pattern: z.enum(['vegan', 'vegetarian', 'pescatarian']).nullable().optional(),
  dietary_restriction: z.string().max(120).nullable().optional(),
  food_dislikes: z.array(z.string().trim()).max(50).optional(),
  goals: z.array(z.string().trim().max(120)).max(20).optional(),
  checkin_count_per_day: z.number().int().min(1).max(3).optional(),
  checkin_days_interval: z.number().int().min(1).max(14).optional(),
  sms_consent: z.boolean().optional(),
  // Validate format AND plausibility so a stray value (e.g. "1999-01-05" or a
  // future date) can never be saved — Grace answers date questions from this
  // field, so garbage here would surface as a wrong (but "real-looking") answer.
  glp1_start_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter a valid GLP-1 start date')
    .refine((v) => isPlausibleStartDate(v), 'GLP-1 start date must be between 2015 and today')
    .nullable()
    .optional(),
  // Fields also collected at onboarding — editable here so Settings shows every
  // piece of data the user entered.
  medication_time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullable().optional(),
  biggest_challenge: z.string().trim().max(120).nullable().optional(),
  why_started: z.string().trim().max(120).nullable().optional(),
  support_style: z.enum(['gentle', 'straight_facts', 'tough_love', 'mix']).nullable().optional(),
  exercise_habits: z.string().trim().max(200).nullable().optional(),
});

/**
 * Belt-and-suspenders: the read path (UserService.decryptUser) already nullifies
 * an unrecoverable ciphertext blob, but guard here too so the Settings page can
 * NEVER receive `enc:<iv>:<data>:<tag>` — it would render as garbage and a
 * round-trip save would fail the 120-char limit.
 */
const plainOrNull = (v: string | null): string | null => (isEncryptedBlob(v) ? null : v);

/**
 * Pick the delivery channel for an outbound (verification code / settings
 * notice). Honor the user's stored channel so iMessage users get it over
 * iMessage; the ChannelRouter falls back to WhatsApp if the relay send fails.
 * A user with no channel set falls back to WhatsApp (when configured) or SMS —
 * the prior behavior for legacy WhatsApp-only users.
 */
function resolveChannel(
  user: GraceUser,
  deps: Pick<SettingsRouteDeps, 'whatsappEnabled'>,
): 'whatsapp' | 'sms' | 'imessage' {
  if (user.channel) return user.channel;
  return deps.whatsappEnabled ? 'whatsapp' : 'sms';
}

/** The profile shape returned to the Settings page — editable fields only. */
function toProfile(u: GraceUser): Record<string, unknown> {
  return {
    // Shared DB id (same row v1/Supabase uses) — needed by the Upgrade page for
    // the Stripe checkout after code verification. Not secret to the verified user.
    id: (u as GraceUser & { id?: string }).id ?? null,
    phone: u.phone,
    first_name: plainOrNull(u.first_name),
    medication: plainOrNull(u.medication),
    medication_frequency: u.medication_frequency,
    dose_mg: u.dose_mg,
    injection_day: u.injection_day,
    timezone: u.timezone,
    wake_time: u.wake_time,
    sleep_time: u.sleep_time,
    current_weight: u.current_weight,
    goal_weight: u.goal_weight,
    starting_weight: u.starting_weight,
    height_cm: u.height_cm,
    age: u.age,
    sex: u.sex,
    primary_goal: u.primary_goal,
    activity_level: u.activity_level,
    protein_goal_grams: u.protein_goal_grams,
    calorie_goal_kcal: u.calorie_goal_kcal,
    dietary_pattern: u.dietary_pattern,
    dietary_restriction: u.dietary_restriction,
    food_dislikes: u.food_dislikes ?? [],
    goals: u.goals ?? [],
    checkin_count_per_day: u.checkin_count_per_day,
    checkin_days_interval: u.checkin_days_interval,
    sms_consent: u.sms_consent,
    glp1_start_date: u.glp1_start_date,
    medication_time: u.medication_time,
    biggest_challenge: u.biggest_challenge,
    why_started: u.why_started,
    support_style: u.support_style,
    exercise_habits: u.exercise_habits,
    // read-only context (shown, not edited)
    is_paid: u.is_paid,
    is_pro: u.is_pro,
    trial_start: u.trial_start,
  };
}

export function registerSettingsRoutes(app: FastifyInstance, deps: SettingsRouteDeps): void {
  const codeKey = (phone: string) => `settings:code:${phone}`;
  const attemptsKey = (phone: string) => `settings:attempts:${phone}`;
  const sessionKey = (token: string) => `settings:session:${token}`;

  /** Resolve the verified phone from the Bearer session token, or throw 401. */
  async function requireVerifiedPhone(req: { headers: Record<string, unknown> }): Promise<string> {
    if (!deps.redis) throw new UnauthorizedError('Sessions unavailable');
    const auth = req.headers.authorization;
    const header = Array.isArray(auth) ? auth[0] : (typeof auth === 'string' ? auth : '');
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!token) throw new UnauthorizedError('Missing session token');
    const phone = await deps.redis.get(sessionKey(token));
    if (!phone) throw new UnauthorizedError('Session expired — verify again');
    // Sliding expiry: refresh the TTL on activity.
    await deps.redis.expire(sessionKey(token), SESSION_TTL_SEC).catch(() => undefined);
    return phone;
  }

  // 1. Request a verification code.
  app.post('/settings/request-code', { config: { rateLimit: { max: 5, timeWindow: '10 minutes' } } }, async (req, reply) => {
    if (!deps.redis) { reply.code(503); return { error: 'Verification unavailable' }; }
    const parsed = z.object({ phone: z.string().min(5).max(30) }).safeParse(req.body);
    if (!parsed.success) throw new ValidationError('A valid phone number is required');
    const phone = normalizePhone(parsed.data.phone);

    const user = await deps.users.getByPhone(phone).catch(() => null);
    // Don't reveal whether a number is registered (enumeration guard) — always
    // return ok, but only actually send when the user exists.
    if (user) {
      const code = String(randomInt(100000, 1000000));
      await deps.redis.set(codeKey(phone), code, 'EX', CODE_TTL_SEC);
      await deps.redis.set(attemptsKey(phone), '0', 'EX', CODE_TTL_SEC);
      // Deliver the code on the channel the user actually lives on. iMessage is
      // the primary channel now, so an iMessage user gets the code over iMessage
      // (via Sendblue); the ChannelRouter falls back to WhatsApp if the relay
      // send fails. WhatsApp/SMS users are unchanged. A user with no channel set
      // defaults to iMessage when configured, else WhatsApp/SMS.
      if (deps.localTestMode) {
        req.log.info({ phone }, 'settings.code_local_test');
        return { ok: true, sent: true, devCode: code };
      } else {
        const channel = resolveChannel(user, deps);
        try {
          await deps.sender.send({
            to: phone,
            channel,
            body: `Your Grace verification code is ${code}. It expires in 10 minutes. If you didn't request this, ignore this message.`,
            raw: true,
          });
        } catch (err) {
          req.log.warn({ err: (err as Error).message, phone }, 'settings.code_send_failed');
          reply.code(502);
          return { error: 'Could not send the code right now. Please try again.' };
        }
      }
    } else {
      req.log.info({ phone }, 'settings.request_code.unregistered');
    }
    return { ok: true, sent: true };
  });

  // 2. Verify the code → issue a session token + return the profile.
  app.post('/settings/verify-code', { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } }, async (req, reply) => {
    if (!deps.redis) { reply.code(503); return { error: 'Verification unavailable' }; }
    const parsed = z.object({ phone: z.string().min(5).max(30), code: z.string().trim().regex(/^\d{6}$/) }).safeParse(req.body);
    if (!parsed.success) throw new ValidationError('Phone and a 6-digit code are required');
    const phone = normalizePhone(parsed.data.phone);

    const attempts = Number((await deps.redis.get(attemptsKey(phone))) ?? '0');
    if (attempts >= MAX_VERIFY_ATTEMPTS) {
      await deps.redis.del(codeKey(phone));
      reply.code(429);
      return { error: 'Too many attempts. Request a new code.' };
    }
    const stored = await deps.redis.get(codeKey(phone));
    if (!stored || stored !== parsed.data.code) {
      await deps.redis.incr(attemptsKey(phone));
      await deps.redis.expire(attemptsKey(phone), CODE_TTL_SEC).catch(() => undefined);
      reply.code(401);
      return { error: 'That code is incorrect or expired.' };
    }
    // Success — consume the code, issue a session.
    await deps.redis.del(codeKey(phone));
    await deps.redis.del(attemptsKey(phone));
    const user = await deps.users.getByPhone(phone).catch(() => null);
    if (!user) { reply.code(404); return { error: 'No account found for this number.' }; }
    const token = randomBytes(24).toString('hex');
    await deps.redis.set(sessionKey(token), phone, 'EX', SESSION_TTL_SEC);
    return { ok: true, token, profile: toProfile(user) };
  });

  // 2b. Start a hosted Stripe Checkout (v2-native upgrade) — Bearer session token.
  // Replaces the legacy Supabase create-checkout edge fn. Returns a Stripe URL to
  // redirect to; on completion the v2 Stripe webhook flips is_paid.
  app.post('/settings/checkout', async (req, reply) => {
    const phone = await requireVerifiedPhone(req);
    const user = await deps.users.getByPhone(phone).catch(() => null);
    if (!user) { reply.code(404); return { error: 'No account found for this number.' }; }
    if (user.is_paid || user.is_pro) return { alreadyPaid: true, url: null };
    if (!isStripeEnabled() || !deps.stripePriceId) {
      reply.code(503);
      return { error: 'Checkout is not available right now.' };
    }
    const id = (user as GraceUser & { id?: string }).id;
    if (!id) { reply.code(500); return { error: 'Account is missing an id.' }; }
    const base = (deps.webUrl ?? '').replace(/\/$/, '');
    const firstName = !isEncryptedBlob(user.first_name) ? (user.first_name ?? undefined) : undefined;
    try {
      const session = await createCheckoutSession({
        graceUserId: id,
        phone,
        ...(firstName ? { firstName } : {}),
        priceId: deps.stripePriceId,
        successUrl: `${base}/upgrade?checkout=success`,
        cancelUrl: `${base}/upgrade?checkout=cancel`,
      });
      if (!session?.url) { reply.code(502); return { error: 'Could not start checkout.' }; }
      return { url: session.url };
    } catch (err) {
      req.log.warn({ err: (err as Error).message, phone }, 'settings.checkout_failed');
      reply.code(502);
      return { error: 'Could not start checkout. Please try again.' };
    }
  });

  // 3. Get the current profile.
  app.get('/settings/me', async (req) => {
    const phone = await requireVerifiedPhone(req);
    const user = await deps.users.getByPhone(phone);
    if (!user) throw new UnauthorizedError('Account not found');
    return { profile: toProfile(user) };
  });

  // 4. Update editable fields.
  app.put('/settings/me', async (req) => {
    const phone = await requireVerifiedPhone(req);
    // A stale client (loaded before the ciphertext fix) can echo an `enc:` blob
    // back for first_name/medication. Drop those so the save can't hard-fail on
    // the 120-char limit — they're treated as "no change", not an error.
    const body = { ...((req.body as Record<string, unknown> | null) ?? {}) };
    for (const k of ['first_name', 'medication'] as const) {
      if (typeof body[k] === 'string' && isEncryptedBlob(body[k] as string)) {
        delete body[k];
        req.log.info({ phone, field: k }, 'settings.dropped_ciphertext_on_save');
      }
    }
    const parsed = SettingsUpdateSchema.safeParse(body);
    if (!parsed.success) {
      // Surface a human message (field names), not the raw Zod JSON blob.
      const fields = [...new Set(parsed.error.issues.map((i) => i.path.join('.')).filter(Boolean))];
      throw new ValidationError(
        fields.length
          ? `Some changes couldn't be saved — please check: ${fields.join(', ')}.`
          : 'Some of those changes were invalid. Please review and try again.',
      );
    }
    const fields = parsed.data as Record<string, unknown>;
    // Explicit opt-in/out owns the scheduler pause flag too. A verified user
    // opting back in must become eligible again; opting out stops sends now.
    if (typeof fields.sms_consent === 'boolean') {
      fields.paused = !fields.sms_consent;
    }
    const keys = Object.keys(fields);
    if (keys.length === 0) {
      const u = await deps.users.getByPhone(phone);
      return { ok: true, profile: u ? toProfile(u) : null };
    }
    // UserService.update encrypts first_name/medication and invalidates the
    // user cache so the change takes effect on the next message immediately.
    try {
      await deps.users.update(phone, fields as Parameters<typeof deps.users.update>[1]);
    } catch (err) {
      // A newer column missing a migration must not fail the whole save —
      // apply field-by-field, skipping any that error.
      req.log.warn({ err: (err as Error).message, phone }, 'settings.bulk_update_failed_falling_back');
      let applied = 0;
      for (const k of keys) {
        try {
          await deps.users.update(phone, { [k]: fields[k] } as Parameters<typeof deps.users.update>[1]);
          applied++;
        } catch {
          req.log.warn({ phone, field: k }, 'settings.field_skipped (likely missing migration)');
        }
      }
      if (applied === 0) throw new ValidationError('Could not save those changes.');
    }
    const u = await deps.users.getByPhone(phone);
    return { ok: true, profile: u ? toProfile(u) : null };
  });
}
