import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { ValidationError } from '../errors.js';
import type { UserService } from '../user/user.service.js';
import type { TwilioSender } from '../twilio/sender.js';
import type { MessageGenerator } from '../scheduler/message-generator.js';

const OnboardSchema = z.object({
  firstName: z.string().trim().min(1).max(120),
  phone: z.string().trim().min(8).max(30),
  medication: z.string().trim().min(1).max(120),
  medicationFrequency: z.string().trim().optional().default('weekly'),
  injectionDay: z.string().trim().max(20).optional().nullable(),
  wakeTime: z.string().regex(/^\d{2}:\d{2}$/).default('07:00'),
  sleepTime: z.string().regex(/^\d{2}:\d{2}$/).default('22:00'),
  foodDislikes: z.string().max(1000).optional().nullable(),
  currentWeight: z.number().finite().positive().optional().nullable(),
  goalWeight: z.number().finite().positive().optional().nullable(),
  goals: z.array(z.string().trim().min(1).max(120)).max(10).default([]),
  timezone: z.string().trim().max(100).optional().default('America/New_York'),
  checkinCountPerDay: z.number().int().min(1).max(5).optional().default(1),
  checkinDaysInterval: z.number().int().min(1).max(14).optional().default(1),
  rlhfEnabled: z.boolean().optional().default(false),
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

  // ─── Onboarding ─────────────────────────────────────────────────────────────

  app.post('/users/onboard', async (req) => {
    const parsed = OnboardSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError(parsed.error.message);
    const b = parsed.data;

    const phone = normalizePhone(b.phone);
    const foodDislikesArr = b.foodDislikes
      ? b.foodDislikes.split(',').map((s) => s.trim()).filter(Boolean)
      : [];

    // Upsert user then apply full profile.
    await users.ensureUser(phone);
    await users.update(phone, {
      first_name: b.firstName,
      medication: b.medication,
      medication_frequency: b.medicationFrequency,
      injection_day: b.injectionDay ?? undefined,
      wake_time: b.wakeTime,
      sleep_time: b.sleepTime,
      food_dislikes: foodDislikesArr,
      current_weight: b.currentWeight ?? undefined,
      goal_weight: b.goalWeight ?? undefined,
      goals: b.goals,
      timezone: b.timezone,
      checkin_count_per_day: b.checkinCountPerDay,
      checkin_days_interval: b.checkinDaysInterval,
      rlhf_enabled: b.rlhfEnabled,
      active: true,
      trial_start: new Date(),
    });

    // Fetch completed profile for message generation.
    const user = await users.getByPhone(phone);
    if (!user) throw new Error('user_not_found_after_upsert');

    // Send welcome message.
    try {
      const welcome = await generator.generate('welcome', user);
      await sender.send({ to: phone, body: welcome, channel: 'whatsapp' });
      await users.recordCheckIn({ userId: user.id, phone, type: 'welcome', messageSent: welcome });
    } catch (err) {
      req.log.warn({ err, phone }, 'onboard.welcome_send.failed');
    }

    req.log.info({ phone, medication: b.medication }, 'user.onboarded');
    return { ok: true, userId: user.id, phone: user.phone };
  });

  // ─── Self-serve GDPR data deletion ──────────────────────────────────────────

  app.delete('/users/:phone/data', async (req) => {
    const { phone } = req.params as { phone: string };
    await pool.query('DELETE FROM check_ins WHERE phone = $1', [phone]).catch(() => null);
    await pool.query('DELETE FROM messages WHERE user_id = $1', [phone]).catch(() => null);
    await pool.query('DELETE FROM conversations WHERE user_id = $1', [phone]).catch(() => null);
    await pool.query('DELETE FROM embeddings WHERE user_id = $1', [phone]).catch(() => null);
    await pool.query('DELETE FROM food_logs WHERE user_id = $1', [phone]).catch(() => null);
    await pool.query('DELETE FROM weight_logs WHERE user_id = $1', [phone]).catch(() => null);
    await pool.query('DELETE FROM feedback WHERE user_id = $1', [phone]).catch(() => null);
    await pool.query('DELETE FROM users WHERE phone = $1', [phone]).catch(() => null);
    req.log.info({ phone }, 'user.data_deleted');
    return { ok: true };
  });
}

