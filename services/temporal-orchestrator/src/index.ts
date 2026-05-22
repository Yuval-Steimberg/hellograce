/**
 * Grace Temporal Orchestrator — Feature 4
 *
 * Completely decoupled from the main API. Reads directly from Postgres,
 * generates messages with Gemini, sends via Twilio — no changes to any
 * existing service required.
 *
 * Medication lifecycle triggers (weekly injection users only):
 *   Day 2  (47–50h after injection_done_at) — Peak serum concentration.
 *           Probe for nausea, vomiting, fatigue. Highest side-effect risk.
 *   Day 6  (143–146h after injection_done_at) — End of cycle.
 *           Probe for energy, hunger creep, mood before next injection.
 *
 * Deduplication: Redis SET NX key per user+injection+trigger. Each trigger
 * fires at most once per injection cycle even across multiple machines.
 *
 * Access gate: mirrors the API's gate — only paid/pro/trial users receive
 * proactive messages.
 */
import cron from 'node-cron';
import pg from 'pg';
import Redis from 'ioredis';
import Twilio from 'twilio';
import { GoogleGenerativeAI } from '@google/generative-ai';
import pino from 'pino';
import { buildDay2Prompt, buildDay6Prompt } from './prompts.js';

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });

// ── Config ─────────────────────────────────────────────────────────────────

const cfg = {
  databaseUrl: process.env.DATABASE_URL ?? '',
  databaseSsl: process.env.DATABASE_SSL === 'true',
  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
  twilioSid: process.env.TWILIO_ACCOUNT_SID ?? '',
  twilioToken: process.env.TWILIO_AUTH_TOKEN ?? '',
  twilioFrom: process.env.TWILIO_WHATSAPP_FROM ?? process.env.TWILIO_FROM_NUMBER ?? '',
  geminiApiKey: process.env.GEMINI_API_KEY ?? '',
  geminiModel: process.env.GEMINI_MODEL ?? 'gemini-2.5-flash',
  // Window tolerance: ±1.5h around the target to handle machine restarts
  day2HoursMin: Number(process.env.DAY2_HOURS_MIN ?? 47),
  day2HoursMax: Number(process.env.DAY2_HOURS_MAX ?? 50),
  day6HoursMin: Number(process.env.DAY6_HOURS_MIN ?? 143),
  day6HoursMax: Number(process.env.DAY6_HOURS_MAX ?? 146),
};

// ── Clients ────────────────────────────────────────────────────────────────

const pool = new pg.Pool({
  connectionString: cfg.databaseUrl,
  ssl: cfg.databaseSsl ? { rejectUnauthorized: false } : false,
  max: 5,
});

const redis = new Redis(cfg.redisUrl, { lazyConnect: true, enableReadyCheck: false });
await redis.connect().catch((err) => logger.warn({ err }, 'redis.connect_failed'));

const twilioClient = Twilio(cfg.twilioSid, cfg.twilioToken);
const genAI = new GoogleGenerativeAI(cfg.geminiApiKey);

// ── Types ──────────────────────────────────────────────────────────────────

interface EligibleUser {
  phone: string;
  first_name: string | null;
  medication_type: string | null;
  injection_done_at: Date;
  hours_since_injection: number;
  timezone: string;
  // Used to build personalized context
  goals: string[];
  injection_count: number;
  glp1_start_date: Date | null;
}

// ── Main loop ──────────────────────────────────────────────────────────────

cron.schedule('* * * * *', async () => {
  try {
    await runLifecycleTriggers();
  } catch (err) {
    logger.error({ err }, 'orchestrator.tick.error');
  }
});

logger.info({ day2: `${cfg.day2HoursMin}-${cfg.day2HoursMax}h`, day6: `${cfg.day6HoursMin}-${cfg.day6HoursMax}h` }, 'temporal-orchestrator.started');

async function runLifecycleTriggers(): Promise<void> {
  const rows = await fetchEligibleUsers();
  if (rows.length === 0) return;

  logger.debug({ count: rows.length }, 'orchestrator.tick.users');

  await Promise.allSettled(rows.map((user) => processUser(user)));
}

async function processUser(user: EligibleUser): Promise<void> {
  const h = user.hours_since_injection;

  if (h >= cfg.day2HoursMin && h <= cfg.day2HoursMax) {
    await maybeSendTrigger(user, 'day2');
  } else if (h >= cfg.day6HoursMin && h <= cfg.day6HoursMax) {
    await maybeSendTrigger(user, 'day6');
  }
}

async function maybeSendTrigger(
  user: EligibleUser,
  trigger: 'day2' | 'day6',
): Promise<void> {
  // Dedup key: unique per phone + injection timestamp + trigger type
  const injTs = Math.floor(user.injection_done_at.getTime() / 1000);
  const lockKey = `temporal:${trigger}:${user.phone}:${injTs}`;

  // SET NX EX 7d — if another machine already sent this, skip
  const acquired = await redis.set(lockKey, '1', 'NX', 'EX', 604800).catch(() => null);
  if (acquired !== 'OK') {
    logger.debug({ phone: user.phone, trigger }, 'orchestrator.trigger.already_sent');
    return;
  }

  try {
    const message = await generateMessage(user, trigger);
    await sendMessage(user.phone, message);
    logger.info({ phone: user.phone, trigger, hours: user.hours_since_injection }, 'orchestrator.trigger.sent');
  } catch (err) {
    // Release lock on failure so we can retry on next tick
    await redis.del(lockKey).catch(() => null);
    logger.error({ err, phone: user.phone, trigger }, 'orchestrator.trigger.failed');
  }
}

async function generateMessage(user: EligibleUser, trigger: 'day2' | 'day6'): Promise<string> {
  const prompt = trigger === 'day2'
    ? buildDay2Prompt(user)
    : buildDay6Prompt(user);

  const model = genAI.getGenerativeModel({
    model: cfg.geminiModel,
    systemInstruction: SYSTEM_INSTRUCTION,
    generationConfig: { temperature: 0.7, maxOutputTokens: 120 },
  });

  const result = await model.generateContent(prompt);
  const text = result.response.text().trim();

  // Fallback to canned message if generation fails or produces empty output
  return text || (trigger === 'day2' ? FALLBACK_DAY2(user) : FALLBACK_DAY6(user));
}

async function sendMessage(phone: string, text: string): Promise<void> {
  if (!cfg.twilioFrom) throw new Error('TWILIO_FROM not configured');
  await twilioClient.messages.create({ from: cfg.twilioFrom, to: phone, body: text });
}

// ── DB query ───────────────────────────────────────────────────────────────

async function fetchEligibleUsers(): Promise<EligibleUser[]> {
  const { rows } = await pool.query<EligibleUser & { hours_since_injection: number }>(`
    SELECT
      u.phone,
      u.first_name,
      u.medication_type,
      u.injection_done_at,
      EXTRACT(EPOCH FROM (NOW() - u.injection_done_at)) / 3600 AS hours_since_injection,
      u.timezone,
      COALESCE(u.goals, '{}') AS goals,
      COALESCE(u.injection_count, 0) AS injection_count,
      u.glp1_start_date
    FROM users u
    WHERE
      u.injection_done_at IS NOT NULL
      -- Access gate: paid, pro, or within trial window
      AND (
        u.is_paid = true
        OR u.is_pro = true
        OR (u.trial_start IS NOT NULL AND u.trial_start > NOW() - INTERVAL '3 days')
      )
      -- Only weekly injection users (daily injectors don't have the same Day 2/6 lifecycle)
      AND (u.medication_type = 'weekly_injection' OR u.medication_type IS NULL)
      -- Pre-filter: only rows within the relevant time windows (avoids full table scan)
      AND EXTRACT(EPOCH FROM (NOW() - u.injection_done_at)) / 3600
          BETWEEN $1 AND $2
      -- Respect quiet hours (21:00–07:00) in user's local timezone
      AND EXTRACT(HOUR FROM NOW() AT TIME ZONE COALESCE(u.timezone, 'America/New_York'))
          BETWEEN 7 AND 20
  `, [cfg.day2HoursMin, cfg.day6HoursMax]);

  return rows;
}

// ── Prompt builders ────────────────────────────────────────────────────────
// (moved to prompts.ts for easier editing without touching orchestration logic)

const SYSTEM_INSTRUCTION = `You are Grace, a warm AI companion for people on GLP-1 medications.
Write ONE short, caring check-in message (1–2 sentences max). No question mark at the end unless
asking a direct question. No label prefix. No name unless natural. No em dashes. Conversational.`;

const FALLBACK_DAY2 = (u: EligibleUser) =>
  `Just checking in — Day 2 after your injection can bring some nausea or fatigue for some people. How are you feeling?`;

const FALLBACK_DAY6 = (u: EligibleUser) =>
  `Heading into the last stretch before your next injection — notice any changes in hunger or energy lately?`;
