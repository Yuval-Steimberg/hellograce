import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { ValidationError, UnauthorizedError } from '../errors.js';
import type { UserService } from '../user/user.service.js';
import type { TwilioSender } from '../twilio/sender.js';
import type { MessageGenerator } from '../scheduler/message-generator.js';
import { calculateProteinTarget } from '../nutrition/protein-target.js';
import { calculateCalorieTarget } from '../nutrition/calorie-target.js';

// Minimal onboarding spec: only medication / injection day / sex / height /
// weight / goal weight / food dislikes are essential. Everything else is
// optional and gets learned progressively through conversation.
const OnboardSchema = z.object({
  firstName: z.string().trim().max(120).optional().default(''),
  phone: z.string().trim().min(8).max(20).regex(/^\+?[1-9]\d{6,14}$/, 'Invalid phone number'),
  medication: z.string().trim().min(1).max(120),
  medicationFrequency: z.string().trim().optional().default('weekly'),
  injectionDay: z.string().trim().max(20).optional().nullable(),
  medicationTime: z.string().trim().max(10).optional().nullable(),
  smsConsent: z.boolean().optional().default(false),
  sex: z.enum(['female', 'male', 'nonbinary', 'prefer_not_to_say']).optional().nullable(),
  wakeTime: z.string().regex(/^\d{2}:\d{2}$/).default('08:00'),
  sleepTime: z.string().regex(/^\d{2}:\d{2}$/).default('22:00'),
  foodDislikes: z.string().max(1000).optional().nullable(),
  currentWeight: z.number().finite().positive().optional().nullable(),
  goalWeight: z.number().finite().positive().optional().nullable(),
  /** Baseline weight at start of GLP-1 journey. Optional onboarding field
   *  added 2026-06-06. Grace will never fabricate a baseline when null. */
  startingWeight: z.number().finite().positive().optional().nullable(),
  heightCm: z.number().finite().positive().max(260).optional().nullable(),
  age: z.number().int().min(13).max(120).optional().nullable(),
  activityLevel: z.enum(['sedentary', 'lightly_active', 'moderate', 'very_active']).optional().nullable(),
  primaryGoal: z.enum(['fat_loss', 'muscle_gain', 'maintenance', 'recomposition']).optional().nullable(),
  goals: z.array(z.string().trim().min(1).max(120)).max(10).default([]),
  timezone: z.string().trim().max(100).refine((tz) => {
    try { Intl.DateTimeFormat(undefined, { timeZone: tz }); return true; } catch { return false; }
  }, 'Invalid timezone').optional().default('America/New_York'),
  checkinCountPerDay: z.number().int().min(1).max(5).optional().default(1),
  checkinDaysInterval: z.number().int().min(1).max(14).optional().default(1),
  glp1StartDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  doseMg: z.number().finite().positive().max(100).optional().nullable(),
  dietaryRestriction: z.string().max(50).optional().nullable(),
  biggestChallenge: z.string().max(50).optional().nullable(),
  whyStarted: z.string().max(50).optional().nullable(),
  supportStyle: z.enum(['gentle', 'straight_facts', 'tough_love', 'mix']).optional().nullable(),
  exerciseHabits: z.string().max(200).optional().nullable(),
});

export interface UserRouteDeps {
  pool: Pool;
  users: UserService;
  sender: TwilioSender;
  generator: MessageGenerator;
}

/** Normalize a phone number to E.164 format (+<digits>). */
function normalizePhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (!digits) return phone.trim();
  const withPlus = `+${digits}`;
  // Strip leading zero after country code (e.g. +972 052... → +97252...)
  return withPlus.replace(/^(\+1|\+7|\+[2-9]\d{1,2})0+/, '$1');
}

export function registerUserRoutes(app: FastifyInstance, deps: UserRouteDeps): void {
  const { pool, users, sender, generator } = deps;

  // ─── Phone existence check (pre-onboarding) ──────────────────────────────────
  app.get('/users/exists', { config: { rateLimit: { max: 20, timeWindow: '10 minutes' } } }, async (req) => {
    const { phone } = req.query as { phone?: string };
    if (!phone) return { exists: false };
    const normalized = normalizePhone(phone.trim());
    const result = await pool.query('SELECT id FROM users WHERE phone = $1 LIMIT 1', [normalized]);
    return { exists: result.rowCount != null && result.rowCount > 0 };
  });

  // ─── Onboarding ─────────────────────────────────────────────────────────────

  app.post('/users/onboard', { config: { rateLimit: { max: 5, timeWindow: '10 minutes' } } }, async (req) => {
    const parsed = OnboardSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError(parsed.error.message);
    const b = parsed.data;

    const phone = normalizePhone(b.phone);
    const foodDislikesArr = b.foodDislikes
      ? b.foodDislikes.split(',').map((s) => s.trim()).filter(Boolean)
      : [];

    // Personalized daily protein target (grams), based on body metrics + goal.
    // Falls back to a sensible 80g default when inputs are missing.
    const proteinGoalGrams = calculateProteinTarget({
      weightLbs: b.currentWeight ?? null,
      heightCm: b.heightCm ?? null,
      age: b.age ?? null,
      goal: b.primaryGoal ?? null,
    });

    // Personalized daily calorie target (Mifflin-St Jeor + activity + GLP-1
    // deficit). Returns null if any input is missing — column stays NULL
    // and Grace asks the user conversationally when calorie questions come up.
    const calorieGoalKcal = calculateCalorieTarget({
      weightLbs: b.currentWeight ?? null,
      heightCm: b.heightCm ?? null,
      age: b.age ?? null,
      sex: b.sex ?? null,
      activityLevel: b.activityLevel ?? null,
      goal: b.primaryGoal ?? null,
    });

    // Upsert user then apply full profile.
    await users.ensureUser(phone);

    // REGISTER FIRST, with base-schema columns only (active + trial_start always
    // exist). This guarantees the user is registered even if a later profile
    // write fails on a missing-migration column — otherwise a single failed
    // UPDATE rolls back trial_start and the webhook registration gate locks the
    // user out after they completed signup (production bug 2026-06-13).
    await users.update(phone, { active: true, trial_start: new Date() });

    // Full profile. Best-effort: a missing newer column here must NOT block
    // onboarding or un-register the user (trial_start is already set above).
    try {
      await users.update(phone, {
        ...(b.firstName ? { first_name: b.firstName } : {}),
        medication: b.medication,
        medication_frequency: b.medicationFrequency,
        injection_day: b.injectionDay ?? undefined,
        wake_time: b.wakeTime,
        sleep_time: b.sleepTime,
        food_dislikes: foodDislikesArr,
        current_weight: b.currentWeight ?? undefined,
        goal_weight: b.goalWeight ?? undefined,
        starting_weight: b.startingWeight ?? undefined,
        height_cm: b.heightCm ?? undefined,
        goals: b.goals,
        timezone: b.timezone,
        checkin_count_per_day: b.checkinCountPerDay,
        checkin_days_interval: b.checkinDaysInterval,
      });
    } catch (err) {
      req.log.warn(
        { err: err instanceof Error ? err.message : String(err), phone },
        'onboard.core_profile.partial (user is registered; some profile columns may be missing migrations)',
      );
    }

    // medication_time + sms_consent — migration 20260525000002. Degrades silently.
    try {
      await users.update(phone, {
        medication_time: b.medicationTime ?? undefined,
        sms_consent: b.smsConsent,
      } as Partial<Parameters<typeof users.update>[1]>);
    } catch {
      req.log.warn({ phone }, 'onboard.medication_time_consent.skipped (likely missing migration 20260525000002)');
    }

    // Sex — depends on migration 20260516000002. Degrades silently if absent.
    if (b.sex) {
      try {
        await users.update(phone, { sex: b.sex } as Partial<Parameters<typeof users.update>[1]>);
      } catch {
        req.log.warn({ phone }, 'onboard.sex.skipped (likely missing migration 20260516000002)');
      }
    }

    // Personalization fields — depend on the 20260513000002 migration.
    // If the migration hasn't been applied yet, silently degrade so signup
    // doesn't break. Once the migration runs, these get populated normally.
    if (b.age != null || b.primaryGoal != null || proteinGoalGrams) {
      try {
        await users.update(phone, {
          age: b.age ?? undefined,
          primary_goal: b.primaryGoal ?? undefined,
          protein_goal_grams: proteinGoalGrams,
        } as Partial<Parameters<typeof users.update>[1]>);
      } catch (err) {
        req.log.warn(
          { err, phone },
          'onboard.protein_personalization.skipped (likely missing migration 20260513000002)',
        );
      }
    }

    // Activity level — depends on migration 20260524000001. Degrades silently if absent.
    if (b.activityLevel) {
      try {
        await users.update(phone, { activity_level: b.activityLevel } as Partial<Parameters<typeof users.update>[1]>);
      } catch {
        req.log.warn({ phone }, 'onboard.activity_level.skipped (likely missing migration 20260524000001)');
      }
    }

    // Calorie goal — depends on migration 20260528000001. Only set when calculator
    // had enough inputs (sex/height/age/weight/activity all present).
    if (calorieGoalKcal != null) {
      try {
        await users.update(phone, { calorie_goal_kcal: calorieGoalKcal } as Partial<Parameters<typeof users.update>[1]>);
      } catch {
        req.log.warn({ phone }, 'onboard.calorie_goal.skipped (likely missing migration 20260528000001)');
      }
    }

    // GLP-1 start date — depends on 20260513000003 migration. Silently degrade if absent.
    if (b.glp1StartDate) {
      try {
        await users.update(phone, {
          glp1_start_date: new Date(b.glp1StartDate),
        } as Partial<Parameters<typeof users.update>[1]>);
      } catch {
        req.log.warn({ phone }, 'onboard.glp1_start_date.skipped (likely missing migration 20260513000003)');
      }
    }

    // Lifestyle & personalization fields — depend on 20260524000002 migration. Silently degrade.
    const lifestyleFields: Record<string, unknown> = {};
    if (b.doseMg != null) lifestyleFields.dose_mg = b.doseMg;
    if (b.dietaryRestriction) lifestyleFields.dietary_restriction = b.dietaryRestriction;
    if (b.biggestChallenge) lifestyleFields.biggest_challenge = b.biggestChallenge;
    if (b.whyStarted) lifestyleFields.why_started = b.whyStarted;
    if (b.supportStyle) lifestyleFields.support_style = b.supportStyle;
    if (b.exerciseHabits) lifestyleFields.exercise_habits = b.exerciseHabits;
    if (Object.keys(lifestyleFields).length > 0) {
      try {
        await users.update(phone, lifestyleFields as Partial<Parameters<typeof users.update>[1]>);
      } catch {
        req.log.warn({ phone }, 'onboard.lifestyle_fields.skipped (likely missing migration 20260524000002)');
      }
    }

    // Also populate the dietary_pattern ENUM when the signup diet is one of the
    // three the enum supports, so every code path that reads dietary_pattern
    // (admin display, chat detection persistence) sees it too — not just the
    // effectiveDietaryRestriction() helper that reads the free-text. Best-effort.
    if (b.dietaryRestriction) {
      const norm = b.dietaryRestriction.toLowerCase().replace(/[_-]+/g, ' ').trim();
      const pattern =
        /^(vegan|plant based)$/.test(norm) ? 'vegan' :
        /^(vegetarian|veggie)$/.test(norm) ? 'vegetarian' :
        /^(pesc[ae]tarian)$/.test(norm) ? 'pescatarian' : null;
      if (pattern) {
        try {
          await users.update(phone, { dietary_pattern: pattern } as Partial<Parameters<typeof users.update>[1]>);
        } catch {
          req.log.warn({ phone }, 'onboard.dietary_pattern.skipped (likely missing migration 20260516000004)');
        }
      }
    }

    // Fetch completed profile for message generation.
    const user = await users.getByPhone(phone);
    if (!user) throw new Error('user_not_found_after_upsert');

    // Send welcome message. Append a deterministic "how to use Grace" block so
    // the first message always explains what the user can do and the available
    // commands (SETTINGS / STOP), regardless of what the LLM/template body says.
    try {
      const welcome = await generator.generate('welcome', user);
      const howTo =
        "A few things you can do anytime: text me what you ate, your weight, or how you're feeling and I'll track it. " +
        "Send a meal photo or a voice note and I'll read it. " +
        'Text SETTINGS to update your check-in times, medication, or preferences, and STOP to pause messages.';
      const welcomeFull = `${welcome}\n\n${howTo}`;
      // raw: the generator already sanitized its body, and howTo is clean prose
      // I control — sending raw avoids the 420-char outbound cap truncating the
      // SETTINGS/STOP commands off the end of the welcome.
      await sender.send({ to: phone, body: welcomeFull, channel: 'whatsapp', raw: true });
      await users.recordCheckIn({ userId: user.id, phone, type: 'welcome', messageSent: welcomeFull });
    } catch (err) {
      req.log.warn({ err, phone }, 'onboard.welcome_send.failed');
    }

    // Create a Stripe customer at signup so every Grace user is visible in
    // the Stripe dashboard from day 1 (not just paid users). This lets admin
    // see / search every user in Stripe regardless of trial status, and
    // ensures the customer_id is already in place when they upgrade.
    // Fire-and-forget: failure must never break onboarding.
    void (async () => {
      try {
        const { ensureStripeCustomer } = await import('../services/stripe.service.js');
        await ensureStripeCustomer({
          graceUserId: user.id,
          phone,
          firstName: b.firstName,
          medication: b.medication,
        });
        req.log.info({ phone, graceUserId: user.id }, 'onboard.stripe_customer_ensured');
      } catch (err) {
        req.log.warn({ err: (err as Error).message, phone }, 'onboard.stripe_customer.failed');
      }
    })();

    req.log.info({ phone, medication: b.medication }, 'user.onboarded');
    return { ok: true, userId: user.id, phone: user.phone };
  });

  // ─── Self-serve GDPR data deletion ──────────────────────────────────────────

  app.delete('/users/:phone/data', { config: { rateLimit: { max: 3, timeWindow: '1 hour' } } }, async (req) => {
    const auth = req.headers.authorization;
    const expected = process.env.ADMIN_TOKEN;
    if (!expected || auth !== `Bearer ${expected}`) {
      throw new UnauthorizedError('Admin token required');
    }

    const { phone } = req.params as { phone: string };
    await pool.query('DELETE FROM user_memories WHERE user_id = $1', [phone]).catch(() => null);
    await pool.query('DELETE FROM user_profile_facts WHERE user_id = $1', [phone]).catch(() => null);
    await pool.query('DELETE FROM tool_logs WHERE user_id = $1', [phone]).catch(() => null);
    await pool.query('DELETE FROM injections WHERE user_id = $1', [phone]).catch(() => null);
    await pool.query('DELETE FROM check_ins WHERE phone = $1', [phone]).catch(() => null);
    await pool.query('DELETE FROM messages WHERE user_id = $1', [phone]).catch(() => null);
    await pool.query('DELETE FROM conversations WHERE user_id = $1', [phone]).catch(() => null);
    await pool.query('DELETE FROM embeddings WHERE user_id = $1', [phone]).catch(() => null);
    await pool.query('DELETE FROM food_logs WHERE user_id = $1', [phone]).catch(() => null);
    await pool.query('DELETE FROM weight_logs WHERE user_id = $1', [phone]).catch(() => null);
    await pool.query('DELETE FROM feedback WHERE user_id = $1', [phone]).catch(() => null);
    await pool.query('DELETE FROM users WHERE phone = $1', [phone]).catch(() => null);
    // Evict the in-memory cache so a subsequent message recreates the user
    // fresh (trial_start = NULL → must register again) instead of reading the
    // pre-delete cached row.
    users.invalidate(phone);
    req.log.info('user.data_deleted');
    return { ok: true };
  });
}

