import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Logger } from 'pino';
import { Scheduler } from './scheduler.js';
import type { GraceUser, UserService } from '../user/user.service.js';
import type { TwilioSender } from '../twilio/sender.js';
import type { MessageGenerator } from './message-generator.js';

/**
 * End-to-end scheduler timing test. Simulates a full 24h cycle for several
 * users and asserts every proactive reminder fires in the correct window:
 *
 *   ── Reminder schedule (per user-local time) ──────────────────────────────
 *   Morning           daily         wake_time + 0–54 min (90-min catch-up window)
 *   Midday            Mon/Wed/Fri   11:00 + 0–164 min (15-min delivery window)
 *   Evening           Tue/Thu/Sun   sleep_time − 90 min (engaged users only)
 *   Injection morning weekly        wake_time + 0–44 min on injection_day
 *   Injection f/up    weekly        3h after morning sent
 *   Day-after         weekly        morning after injection
 *   Quiet hours       always        21:00 → 07:00 local: nothing fires
 *   Trial Day 2       once          first morning window 24–48h after trial_start
 *   Side-effect f/up  once          4h after side_effect keyword detected
 */

const logger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  fatal: () => undefined,
  trace: () => undefined,
  child: () => logger,
  level: 'info',
} as unknown as Logger;

function makeUser(overrides: Partial<GraceUser> = {}): GraceUser {
  return {
    id: 'uuid-1',
    phone: '+15551234567',
    first_name: 'Test',
    medication: 'Ozempic',
    medication_frequency: 'weekly',
    injection_day: null,
    injection_count: 0,
    goals: ['Losing weight'],
    food_dislikes: [],
    timezone: 'America/New_York',
    wake_time: '08:00',
    sleep_time: '22:00',
    current_weight: 180,
    goal_weight: 160,
    height_cm: null,
    age: null,
    sex: null,
    primary_goal: null,
    protein_goal_grams: 80,
    dietary_pattern: null,
    protein_focus_boost: false,
    hydration_struggle: false,
    low_mood_mode: false,
    midday_skip: false,
    injection_flow_stage: null,
    injection_flow_started_at: null,
    injection_done_at: null,
    injection_side_effect_free: false,
    injection_evening_followup_due: false,
    side_effect_flow: null,
    side_effect_flow_started_at: null,
    side_effect_followup_sent: false,
    last_morning_sent_at: null,
    last_midday_sent_at: null,
    last_evening_sent_at: null,
    last_reply_at: null,
    messages_sent_today: 0,
    messages_sent_today_date: null,
    checkin_frequency: 'daily',
    checkin_count_per_day: 2,
    checkin_days_interval: 1,
    glp1_start_date: null,
    grace_notes: null,
    active: true,
    paused: false,
    blocked: false,
    is_paid: true,
    is_pro: false,
    trial_start: null,
    rlhf_enabled: false,
    created_at: new Date('2026-01-01'),
    updated_at: new Date('2026-01-01'),
    ...overrides,
  };
}

interface Harness {
  scheduler: Scheduler;
  sends: Array<{ to: string; body: string; channel: string }>;
  generateCalls: Array<{ type: string; user: GraceUser; opts?: Record<string, unknown> }>;
  user: GraceUser;
  setUser: (next: Partial<GraceUser>) => void;
  redisLocks: Map<string, string>;
}

/**
 * Build a scheduler with full in-memory mocks. The user object is mutable
 * across ticks so writes via UserService.update reflect on next tick.
 */
function buildHarness(
  initial: GraceUser,
  opts: {
    redisFails?: boolean;
    /** Mocked recent check-ins (anti-repetition context). */
    recentCheckIns?: Array<{ type: string; message_sent: string }>;
    /** Mocked per-day food history rows (morning context). */
    proteinHistory?: Array<{ day: string; protein_g: number; calories: number; item_count: number }>;
    /** Mocked today's food summary (evening context). */
    todaySummary?: { protein_g: number; calories: number; items: string[] };
  } = {},
): Harness {
  let user: GraceUser = { ...initial };
  const sends: Harness['sends'] = [];
  const generateCalls: Harness['generateCalls'] = [];
  const redisLocks = new Map<string, string>();

  const users = {
    listActiveUsers: async () => [user],
    update: async (_phone: string, fields: Partial<GraceUser>) => {
      user = { ...user, ...fields };
    },
    recordCheckIn: async () => 'check-in-id',
    setInjectionStage: async (_phone: string, stage: string | null, extra: Record<string, unknown> = {}) => {
      user = { ...user, injection_flow_stage: stage, ...(extra as Partial<GraceUser>) };
    },
    getRecentCheckIns: async () => opts.recentCheckIns ?? [],
    getDailyProteinHistory: async () => opts.proteinHistory ?? [],
    getTodaysFoodSummary: async () => opts.todaySummary
      ?? { protein_g: 0, calories: 0, items: [], items_detailed: [] },
  } as unknown as UserService;

  const sender = {
    send: async (msg: { to: string; body: string; channel: string }) => {
      sends.push(msg);
    },
  } as unknown as TwilioSender;

  const generator = {
    generate: async (type: string, u: GraceUser, genOpts?: Record<string, unknown>) => {
      generateCalls.push({ type, user: u, ...(genOpts !== undefined ? { opts: genOpts } : {}) });
      return `MOCK_${type}_MESSAGE`;
    },
  } as unknown as MessageGenerator;

  const redis = {
    set: async (key: string, value: string, ..._args: unknown[]) => {
      if (opts.redisFails) throw new Error('Redis unavailable');
      // EX TTL / NX flag aren't tracked here — for the tests below this is fine
      // because the cadence keys never collide with the sched: lock keys.
      const isLock = key.startsWith('sched:');
      if (isLock && redisLocks.has(key)) return null;
      redisLocks.set(key, value);
      return 'OK';
    },
    get: async (key: string) => {
      if (opts.redisFails) throw new Error('Redis unavailable');
      return redisLocks.get(key) ?? null;
    },
    incr: async (key: string) => {
      if (opts.redisFails) throw new Error('Redis unavailable');
      const cur = parseInt(redisLocks.get(key) ?? '0', 10);
      const next = cur + 1;
      redisLocks.set(key, String(next));
      return next;
    },
    expire: async (_key: string, _seconds: number) => {
      if (opts.redisFails) throw new Error('Redis unavailable');
      return 1;
    },
    del: async (key: string) => {
      redisLocks.delete(key);
      return 1;
    },
  } as unknown as import('ioredis').Redis;

  const scheduler = new Scheduler({ users, sender, generator, logger, redis });

  return {
    scheduler,
    sends,
    generateCalls,
    get user() { return user; },
    setUser: (next) => { user = { ...user, ...next }; },
    redisLocks,
  } as unknown as Harness;
}

/** Move the system clock to a specific UTC instant. */
function setUtc(yyyy: number, mm: number, dd: number, hh: number, min = 0): void {
  vi.setSystemTime(new Date(Date.UTC(yyyy, mm - 1, dd, hh, min, 0)));
}

/** Run one scheduler tick (the every-minute cron handler). */
async function tick(scheduler: Scheduler): Promise<void> {
  // @ts-expect-error — accessing private for test
  await scheduler.tick();
}

/**
 * Walk the clock from startUtc to endUtc in 1-minute steps, calling tick()
 * at every step. Lets us catch jittered reminder windows regardless of the
 * per-user offset value. Pass an `onMinute` hook to mutate user state mid-walk.
 */
async function walkMinutes(
  scheduler: Scheduler,
  startUtc: Date,
  endUtc: Date,
  onMinute?: (now: Date) => void,
): Promise<void> {
  const cur = new Date(startUtc.getTime());
  while (cur.getTime() <= endUtc.getTime()) {
    vi.setSystemTime(cur);
    onMinute?.(cur);
    await tick(scheduler);
    cur.setUTCMinutes(cur.getUTCMinutes() + 1);
  }
}

beforeEach(() => {
  vi.useFakeTimers();
});

describe('Scheduler — morning reminder', () => {
  it('fires exactly once during the morning window, then never again that day', async () => {
    // User in NY (UTC-4 in May). wake_time 08:00 local. Walk 08:00→10:30 local
    // (12:00→14:30 UTC) to guarantee we hit whatever jitter offset this user
    // gets. Window can extend to wake+54+90 = 10:24 in the worst case.
    const u = makeUser({ wake_time: '08:00', sleep_time: '22:00', timezone: 'America/New_York' });
    const h = buildHarness(u);

    await walkMinutes(
      h.scheduler,
      new Date(Date.UTC(2026, 4, 19, 12, 0)),  // 08:00 NY
      new Date(Date.UTC(2026, 4, 19, 14, 30)), // 10:30 NY
    );

    expect(h.generateCalls.filter((c) => c.type === 'morning').length).toBe(1);
    expect(h.sends.length).toBe(1);
    expect(h.user.last_morning_sent_at).not.toBeNull();

    // Walk the rest of the day — must not fire again.
    await walkMinutes(
      h.scheduler,
      new Date(Date.UTC(2026, 4, 19, 14, 31)),
      new Date(Date.UTC(2026, 4, 20, 0, 0)),
    );
    expect(h.generateCalls.filter((c) => c.type === 'morning').length).toBe(1);
  });

  it('does NOT fire during quiet hours (before 07:00 local)', async () => {
    const u = makeUser({ wake_time: '08:00', timezone: 'America/New_York' });
    const h = buildHarness(u);

    // 06:30 local = 10:30 UTC
    setUtc(2026, 5, 19, 10, 30);
    await tick(h.scheduler);
    expect(h.sends.length).toBe(0);
  });

  it('does NOT fire before wake_time even within waking hours', async () => {
    const u = makeUser({ wake_time: '09:00', timezone: 'America/New_York' });
    const h = buildHarness(u);

    // 08:30 local = 12:30 UTC (after quiet hours, before wake)
    setUtc(2026, 5, 19, 12, 30);
    await tick(h.scheduler);
    expect(h.generateCalls.filter((c) => c.type === 'morning').length).toBe(0);
  });

  it('catches up if the machine wakes inside the 90-min morning window', async () => {
    const u = makeUser({ wake_time: '08:00', timezone: 'America/New_York' });
    const h = buildHarness(u);

    // 09:00 local = 13:00 UTC — 60 min after wake_time, deep inside window
    // regardless of jitter. Single tick at this time MUST fire.
    setUtc(2026, 5, 19, 13, 0);
    await tick(h.scheduler);
    expect(h.generateCalls.filter((c) => c.type === 'morning').length).toBe(1);
  });

  it('uses 08:00 default when wake_time is null', async () => {
    const u = makeUser({ wake_time: null as unknown as string, timezone: 'America/New_York' });
    const h = buildHarness(u);

    // Walk through the full morning window (08:00 → 10:30 local).
    await walkMinutes(
      h.scheduler,
      new Date(Date.UTC(2026, 4, 19, 12, 0)),
      new Date(Date.UTC(2026, 4, 19, 14, 30)),
    );
    expect(h.generateCalls.filter((c) => c.type === 'morning').length).toBe(1);
  });

  it('respects user timezone (Asia/Jerusalem = UTC+3 in May)', async () => {
    const u = makeUser({ wake_time: '08:00', timezone: 'Asia/Jerusalem' });
    const h = buildHarness(u);

    // Walk the morning window in Jerusalem time (UTC+3 in May)
    // 08:00 Jerusalem = 05:00 UTC; window can extend to 10:24 Jerusalem = 07:24 UTC.
    await walkMinutes(
      h.scheduler,
      new Date(Date.UTC(2026, 4, 19, 5, 0)),
      new Date(Date.UTC(2026, 4, 19, 7, 30)),
    );
    expect(h.generateCalls.filter((c) => c.type === 'morning').length).toBe(1);

    // Verify quiet hours: 06:00 Jerusalem = 03:00 UTC should NOT fire.
    const h2 = buildHarness(makeUser({ wake_time: '08:00', timezone: 'Asia/Jerusalem' }));
    setUtc(2026, 5, 19, 3, 0);
    await tick(h2.scheduler);
    expect(h2.sends.length).toBe(0);
  });
});

describe('Scheduler — midday reminder', () => {
  it('fires on Mon/Wed/Fri within 11:00–14:00 local', async () => {
    // Monday May 18, 2026 — midday day. NY timezone.
    // Midday gate: user must have replied > 3h ago AND (engaged today OR
    // silent < 1 day). We use the "silent < 1 day" path by setting
    // last_reply_at to yesterday evening — a quiet but not-gone user.
    const u = makeUser({
      wake_time: '08:00',
      timezone: 'America/New_York',
      last_morning_sent_at: new Date('2026-05-18T12:00:00Z'),
      last_reply_at: new Date('2026-05-17T22:00:00Z'), // 18:00 NY yesterday — 17h silent
    });
    const h = buildHarness(u);

    await walkMinutes(
      h.scheduler,
      new Date(Date.UTC(2026, 4, 18, 15, 0)),
      new Date(Date.UTC(2026, 4, 18, 18, 0)),
    );
    expect(h.generateCalls.filter((c) => c.type === 'midday').length).toBe(1);
  });

  it('does NOT fire on Tuesday (Tue is evening day, not midday)', async () => {
    const u = makeUser({
      wake_time: '08:00',
      timezone: 'America/New_York',
      last_morning_sent_at: new Date('2026-05-19T12:00:00Z'),
      last_reply_at: new Date('2026-05-19T13:00:00Z'),
    });
    const h = buildHarness(u);

    // 13:00 local Tuesday = 17:00 UTC
    setUtc(2026, 5, 19, 17, 0);
    await tick(h.scheduler);
    expect(h.generateCalls.filter((c) => c.type === 'midday').length).toBe(0);
  });

  it('skips midday for users who replied within last 3h', async () => {
    const u = makeUser({
      wake_time: '08:00',
      timezone: 'America/New_York',
      last_morning_sent_at: new Date('2026-05-18T12:00:00Z'),
      last_reply_at: new Date('2026-05-18T15:30:00Z'), // replied 2h ago — too recent
    });
    const h = buildHarness(u);

    setUtc(2026, 5, 18, 17, 30); // 13:30 local Monday
    await tick(h.scheduler);
    expect(h.generateCalls.filter((c) => c.type === 'midday').length).toBe(0);
  });

  it('skips midday for fully silent users (>1 day no reply)', async () => {
    const u = makeUser({
      wake_time: '08:00',
      timezone: 'America/New_York',
      last_morning_sent_at: new Date('2026-05-18T12:00:00Z'),
      last_reply_at: new Date('2026-05-15T12:00:00Z'), // 3 days ago — silent
    });
    const h = buildHarness(u);

    setUtc(2026, 5, 18, 17, 30); // 13:30 local Monday
    await tick(h.scheduler);
    expect(h.generateCalls.filter((c) => c.type === 'midday').length).toBe(0);
  });

  it('respects midday_skip behavioural flag', async () => {
    const u = makeUser({
      wake_time: '08:00',
      timezone: 'America/New_York',
      last_morning_sent_at: new Date('2026-05-18T12:00:00Z'),
      last_reply_at: new Date('2026-05-18T13:00:00Z'),
      midday_skip: true,
    });
    const h = buildHarness(u);

    setUtc(2026, 5, 18, 17, 30);
    await tick(h.scheduler);
    expect(h.generateCalls.filter((c) => c.type === 'midday').length).toBe(0);
  });
});

describe('Scheduler — evening reminder', () => {
  it('fires on Tue/Thu/Sun at sleep_time − 90 min (engaged users)', async () => {
    // Tuesday May 19, sleep_time 22:00, so evening base = 20:30 local.
    // Walk 20:30 → 21:00 local Tue = 00:30 → 01:00 UTC May 20.
    const u = makeUser({
      wake_time: '08:00',
      sleep_time: '22:00',
      timezone: 'America/New_York',
      last_morning_sent_at: new Date('2026-05-19T12:00:00Z'),
      last_reply_at: new Date('2026-05-19T13:00:00Z'), // engaged today
    });
    const h = buildHarness(u);

    await walkMinutes(
      h.scheduler,
      new Date(Date.UTC(2026, 4, 20, 0, 30)),
      new Date(Date.UTC(2026, 4, 20, 0, 59)),
    );
    expect(h.generateCalls.filter((c) => c.type === 'evening').length).toBe(1);
  });

  it('does NOT fire on Monday (not an evening day)', async () => {
    const u = makeUser({
      wake_time: '08:00',
      sleep_time: '22:00',
      timezone: 'America/New_York',
      last_morning_sent_at: new Date('2026-05-18T12:00:00Z'),
      last_reply_at: new Date('2026-05-18T13:00:00Z'),
    });
    const h = buildHarness(u);

    setUtc(2026, 5, 19, 0, 30); // 20:30 local Monday
    await tick(h.scheduler);
    expect(h.generateCalls.filter((c) => c.type === 'evening').length).toBe(0);
  });

  it('skips evening for users who have not replied today (engagement gate)', async () => {
    const u = makeUser({
      wake_time: '08:00',
      sleep_time: '22:00',
      timezone: 'America/New_York',
      last_morning_sent_at: new Date('2026-05-19T12:00:00Z'),
      last_reply_at: new Date('2026-05-18T20:00:00Z'), // replied yesterday, not today
    });
    const h = buildHarness(u);

    setUtc(2026, 5, 20, 0, 30); // 20:30 local Tue
    await tick(h.scheduler);
    expect(h.generateCalls.filter((c) => c.type === 'evening').length).toBe(0);
  });

  it('never fires during quiet hours (≥ 21:00 local)', async () => {
    const u = makeUser({
      wake_time: '08:00',
      sleep_time: '22:00',
      timezone: 'America/New_York',
      last_morning_sent_at: new Date('2026-05-19T12:00:00Z'),
      last_reply_at: new Date('2026-05-19T13:00:00Z'),
    });
    const h = buildHarness(u);

    setUtc(2026, 5, 20, 1, 30); // 21:30 local Tue — quiet hours
    await tick(h.scheduler);
    expect(h.sends.length).toBe(0);
  });
});

describe('Scheduler — injection day flow', () => {
  it('fires injection_morning instead of regular morning on injection_day', async () => {
    // Tuesday is injection_day for this user.
    const u = makeUser({
      wake_time: '08:00',
      timezone: 'America/New_York',
      injection_day: 'Tuesday',
    });
    const h = buildHarness(u);

    setUtc(2026, 5, 19, 13, 0); // 09:00 local Tue
    await tick(h.scheduler);

    const calls = h.generateCalls.map((c) => c.type);
    expect(calls).toContain('injection_morning');
    expect(calls).not.toContain('morning');
    expect(h.user.injection_flow_stage).toBe('morning_sent');
  });

  it('does NOT fire injection_followup just because 3h elapsed — requires user to reply "Done"', async () => {
    // Pre-2026-05-29 bug: followup fired 3h after the morning reminder even
    // when the user hadn't injected yet. Evening injectors got a "Post-shot
    // check-in" at 10:29am while they were still planning to inject after
    // dinner. The followup is now gated on stage='done_confirmed'.
    const u = makeUser({
      wake_time: '08:00',
      timezone: 'America/New_York',
      injection_day: 'Tuesday',
      injection_flow_stage: 'morning_sent',
      injection_flow_started_at: new Date('2026-05-19T13:00:00Z'), // 09:00 NY
    });
    const h = buildHarness(u);

    // 3h later — would have fired before the fix.
    setUtc(2026, 5, 19, 16, 0);
    await tick(h.scheduler);
    // Even 6h later, still no followup without "Done" reply.
    setUtc(2026, 5, 19, 19, 0);
    await tick(h.scheduler);

    expect(h.generateCalls.filter((c) => c.type === 'injection_followup').length).toBe(0);
    expect(h.user.injection_flow_stage).toBe('morning_sent');
  });

  it('fires injection_followup 3h after user replied "Done" (evening injection)', async () => {
    // User injects at 7pm and replies "Done". Followup should fire 3h later
    // (10pm), but quiet hours start at 21:00 → deferred to next morning.
    const u = makeUser({
      wake_time: '08:00',
      timezone: 'America/New_York',
      injection_day: 'Tuesday',
      injection_flow_stage: 'done_confirmed',
      injection_flow_started_at: new Date('2026-05-19T13:00:00Z'), // 09:00 NY (morning ack)
      injection_done_at: new Date('2026-05-19T23:00:00Z'),         // 19:00 NY (user replied Done)
    });
    const h = buildHarness(u);

    // 22:00 NY = quiet hours, must NOT fire even though 3h has elapsed.
    setUtc(2026, 5, 20, 2, 0);
    await tick(h.scheduler);
    expect(h.generateCalls.filter((c) => c.type === 'injection_followup').length).toBe(0);

    // Next morning 08:30 NY = 12:30 UTC, out of quiet hours, elapsed > 3h.
    setUtc(2026, 5, 20, 12, 30);
    await tick(h.scheduler);
    expect(h.generateCalls.filter((c) => c.type === 'injection_followup').length).toBe(1);
    expect(h.user.injection_flow_stage).toBe('followup_sent');
  });

  it('safety-resets a stuck morning_sent stage after 24h so next week fires', async () => {
    // User never replied "Done" last week → stage stuck at morning_sent.
    // Without the reset, this would block next Tuesday's injection_morning
    // forever because the !stage guard would never be true.
    const u = makeUser({
      wake_time: '08:00',
      timezone: 'America/New_York',
      injection_day: 'Tuesday',
      injection_flow_stage: 'morning_sent',
      injection_flow_started_at: new Date('2026-05-12T13:00:00Z'), // last Tuesday
    });
    const h = buildHarness(u);

    // This Tuesday 09:00 NY = 13:00 UTC. First tick resets the stale stage.
    setUtc(2026, 5, 19, 13, 0);
    await tick(h.scheduler);
    expect(h.user.injection_flow_stage).toBeNull();

    // Second tick fires injection_morning with clean state.
    setUtc(2026, 5, 19, 13, 1);
    await tick(h.scheduler);
    expect(h.generateCalls.filter((c) => c.type === 'injection_morning').length).toBe(1);
    expect(h.user.injection_flow_stage).toBe('morning_sent');
  });

  it('fires injection_dayafter the morning following injection day', async () => {
    const u = makeUser({
      wake_time: '08:00',
      timezone: 'America/New_York',
      injection_day: 'Tuesday',
      injection_flow_stage: 'followup_sent',
      injection_flow_started_at: new Date('2026-05-19T13:00:00Z'),
    });
    const h = buildHarness(u);

    // Wednesday 08:30 local NY = 12:30 UTC
    setUtc(2026, 5, 20, 12, 30);
    await tick(h.scheduler);
    expect(h.generateCalls.filter((c) => c.type === 'injection_dayafter').length).toBe(1);
    expect(h.user.injection_flow_stage).toBeNull();
  });

  it('skips regular morning/midday/evening on injection day entirely', async () => {
    const u = makeUser({
      wake_time: '08:00',
      timezone: 'America/New_York',
      injection_day: 'Monday', // midday day collides with injection day
    });
    const h = buildHarness(u);

    // 09:00 local Mon → injection_morning fires
    setUtc(2026, 5, 18, 13, 0);
    await tick(h.scheduler);
    // 13:00 local Mon → would normally be midday window, but injection skips it
    setUtc(2026, 5, 18, 17, 0);
    await tick(h.scheduler);

    const calls = h.generateCalls.map((c) => c.type);
    expect(calls).toContain('injection_morning');
    expect(calls).not.toContain('midday');
    expect(calls).not.toContain('morning');
  });
});

describe('Scheduler — trial Day 2 reminder', () => {
  it('fires trial_expiry_reminder when 24–48h into trial (unpaid user)', async () => {
    // Trial started yesterday at 12:00 UTC — now 25h in.
    const u = makeUser({
      wake_time: '08:00',
      timezone: 'America/New_York',
      is_paid: false,
      is_pro: false,
      trial_start: new Date('2026-05-18T12:00:00Z'),
    });
    const h = buildHarness(u);

    setUtc(2026, 5, 19, 13, 0); // 09:00 local Tue, 25h after trial_start
    await tick(h.scheduler);

    const calls = h.generateCalls.map((c) => c.type);
    expect(calls).toContain('trial_expiry_reminder');
    expect(calls).not.toContain('morning');
  });

  it('does NOT fire trial reminder for paid users', async () => {
    const u = makeUser({
      wake_time: '08:00',
      timezone: 'America/New_York',
      is_paid: true,
      trial_start: new Date('2026-05-18T12:00:00Z'),
    });
    const h = buildHarness(u);

    setUtc(2026, 5, 19, 13, 0);
    await tick(h.scheduler);
    expect(h.generateCalls.filter((c) => c.type === 'trial_expiry_reminder').length).toBe(0);
    expect(h.generateCalls.filter((c) => c.type === 'morning').length).toBe(1);
  });
});

describe('Scheduler — side-effect follow-up', () => {
  it('fires side_effect_nausea 4h after keyword detected', async () => {
    const u = makeUser({
      wake_time: '08:00',
      timezone: 'America/New_York',
      side_effect_flow: 'nausea',
      side_effect_flow_started_at: new Date('2026-05-19T13:00:00Z'),
      side_effect_followup_sent: false,
    });
    const h = buildHarness(u);

    // 4h later = 17:00 UTC = 13:00 local NY
    setUtc(2026, 5, 19, 17, 0);
    await tick(h.scheduler);
    expect(h.generateCalls.filter((c) => c.type === 'side_effect_nausea').length).toBe(1);
  });

  it('does NOT fire side effect follow-up twice', async () => {
    const u = makeUser({
      wake_time: '08:00',
      timezone: 'America/New_York',
      side_effect_flow: 'fatigue',
      side_effect_flow_started_at: new Date('2026-05-19T13:00:00Z'),
      side_effect_followup_sent: true,
    });
    const h = buildHarness(u);

    setUtc(2026, 5, 19, 17, 0);
    await tick(h.scheduler);
    expect(h.generateCalls.filter((c) => c.type.startsWith('side_effect')).length).toBe(0);
  });
});

describe('Scheduler — Redis lock resilience', () => {
  it('fails open: still sends when Redis is unavailable', async () => {
    const u = makeUser({ wake_time: '08:00', timezone: 'America/New_York' });
    const h = buildHarness(u, { redisFails: true });

    setUtc(2026, 5, 19, 12, 30); // 08:30 local Tue
    await tick(h.scheduler);
    expect(h.generateCalls.filter((c) => c.type === 'morning').length).toBe(1);
    expect(h.sends.length).toBe(1);
  });

  it('Redis lock prevents duplicate when multiple ticks race in same minute', async () => {
    const u = makeUser({ wake_time: '08:00', timezone: 'America/New_York' });
    const h = buildHarness(u);

    setUtc(2026, 5, 19, 12, 30);
    // Fire ticks "simultaneously" — the second one finds the DB flag already set
    // by the first, and skips before reaching the Redis lock. Either way: 1 send.
    await Promise.all([tick(h.scheduler), tick(h.scheduler), tick(h.scheduler)]);
    expect(h.sends.length).toBe(1);
  });
});

describe('Scheduler — cadence guardrails (max 2 proactive/day)', () => {
  it('caps proactive reminders at 2 per user per day even when more windows fire', async () => {
    // Monday — both midday and morning windows are eligible; the bonus
    // spontaneous nudge can also try to fire. With cadence guard at 2/day,
    // total sends must still be exactly 2.
    const u = makeUser({
      wake_time: '08:00',
      sleep_time: '22:00',
      timezone: 'America/New_York',
      last_reply_at: new Date('2026-05-17T22:00:00Z'), // yesterday 18:00 NY
    });
    const h = buildHarness(u);

    await walkMinutes(
      h.scheduler,
      new Date(Date.UTC(2026, 4, 18, 4, 0)),
      new Date(Date.UTC(2026, 4, 19, 4, 0)),
    );

    // Cap is 2 total proactive messages per day across all non-exempt types.
    expect(h.sends.length).toBeLessThanOrEqual(2);
  });

  it('rejects the 3rd send within the same day after 2 have already fired', async () => {
    const u = makeUser({ wake_time: '08:00', timezone: 'America/New_York' });
    const h = buildHarness(u);
    const todayStr = '2026-05-18';

    // Pre-seed Redis: pretend 2 reminders already went out today, last one
    // 4 hours ago (so the 3h-gap rule alone wouldn't block — only the cap does).
    h.redisLocks.set(`cadence:${u.phone}:${todayStr}`, '2');
    h.redisLocks.set(`cadence:last:${u.phone}`, String(Date.UTC(2026, 4, 18, 9, 0)));

    // 13:00 local Mon — midday window for an engaged user.
    h.setUser({
      last_morning_sent_at: new Date('2026-05-18T12:00:00Z'),
      last_reply_at: new Date('2026-05-17T22:00:00Z'),
    });
    setUtc(2026, 5, 18, 17, 0);
    await tick(h.scheduler);

    expect(h.sends.length).toBe(0);
  });

  it('exempts injection_morning from the 2/day cap (time-critical flow)', async () => {
    const u = makeUser({
      wake_time: '08:00',
      timezone: 'America/New_York',
      injection_day: 'Monday',
    });
    const h = buildHarness(u);
    const todayStr = '2026-05-18';

    // Pre-seed at cap.
    h.redisLocks.set(`cadence:${u.phone}:${todayStr}`, '2');

    setUtc(2026, 5, 18, 13, 0); // 09:00 local Mon → injection_morning window
    await tick(h.scheduler);

    const calls = h.generateCalls.map((c) => c.type);
    expect(calls).toContain('injection_morning');
    expect(h.sends.length).toBe(1);
  });

  it('exempts trial_expiry_reminder from the 2/day cap', async () => {
    const u = makeUser({
      wake_time: '08:00',
      timezone: 'America/New_York',
      is_paid: false,
      is_pro: false,
      trial_start: new Date('2026-05-18T12:00:00Z'),
    });
    const h = buildHarness(u);
    const todayStr = '2026-05-19';

    h.redisLocks.set(`cadence:${u.phone}:${todayStr}`, '2');

    setUtc(2026, 5, 19, 13, 0); // 09:00 local Tue, 25h after trial_start
    await tick(h.scheduler);

    expect(h.generateCalls.map((c) => c.type)).toContain('trial_expiry_reminder');
    expect(h.sends.length).toBe(1);
  });
});

describe('Scheduler — full day simulation', () => {
  it('Tuesday: at most 2 reminders for engaged user (cap enforced)', async () => {
    const u = makeUser({
      wake_time: '08:00',
      sleep_time: '22:00',
      timezone: 'America/New_York',
    });
    const h = buildHarness(u);

    // Local Tue spans UTC 04:00 May 19 → UTC 04:00 May 20 (NY is UTC-4 in May).
    await walkMinutes(
      h.scheduler,
      new Date(Date.UTC(2026, 4, 19, 4, 0)),
      new Date(Date.UTC(2026, 4, 20, 4, 0)),
      (now) => {
        if (now.getUTCHours() === 14 && now.getUTCMinutes() === 0) {
          h.setUser({ last_reply_at: now });
        }
      },
    );

    const types = h.generateCalls.map((c) => c.type);
    // 2/day cap: morning always fires first; second slot is whichever of
    // {bonus, evening} the jitter+window combo reaches next. Midday is a
    // Mon/Wed/Fri reminder so it should never appear on Tuesday.
    expect(h.sends.length).toBeLessThanOrEqual(2);
    expect(types).toContain('morning');
    expect(types).not.toContain('midday');
  });

  it('Monday: morning + midday for silent-but-recent user', async () => {
    // Midday only fires via "silent < 1 day" path here because morning fires
    // <3h before midday window opens — too short for the engaged-today path.
    const u = makeUser({
      wake_time: '08:00',
      sleep_time: '22:00',
      timezone: 'America/New_York',
      last_reply_at: new Date('2026-05-17T22:00:00Z'), // yesterday 18:00 NY
    });
    const h = buildHarness(u);

    await walkMinutes(
      h.scheduler,
      new Date(Date.UTC(2026, 4, 18, 4, 0)),
      new Date(Date.UTC(2026, 4, 19, 4, 0)),
    );

    const types = h.generateCalls.map((c) => c.type);
    expect(types).toContain('morning');
    expect(types).toContain('midday');
    expect(types).not.toContain('evening'); // Monday is not an evening day
    expect(types.filter((t) => t === 'morning').length).toBe(1);
    expect(types.filter((t) => t === 'midday').length).toBe(1);
  });

  it('Saturday: morning only — no midday, no evening', async () => {
    const u = makeUser({
      wake_time: '08:00',
      sleep_time: '22:00',
      timezone: 'America/New_York',
    });
    const h = buildHarness(u);

    await walkMinutes(
      h.scheduler,
      new Date(Date.UTC(2026, 4, 23, 4, 0)),
      new Date(Date.UTC(2026, 4, 24, 4, 0)),
      (now) => {
        if (now.getUTCHours() === 14 && now.getUTCMinutes() === 0) {
          h.setUser({ last_reply_at: now });
        }
      },
    );

    const types = h.generateCalls.map((c) => c.type);
    expect(types[0]).toBe('morning');
    expect(types.every((t) => t === 'morning' || t === 'bonus')).toBe(true);
    expect(types.filter((t) => t === 'midday')).toHaveLength(0);
    expect(types.filter((t) => t === 'evening')).toHaveLength(0);
  });
});

describe('Scheduler — check-in cadence Settings (checkin_count_per_day / checkin_days_interval)', () => {
  // Call the private sendAndRecord directly so the cap is isolated from the
  // window/jitter/min-gap logic that walkMinutes exercises elsewhere.
  async function sendDirect(h: Harness, type: string): Promise<void> {
    // @ts-expect-error — accessing private for test
    await h.scheduler.sendAndRecord(h.user, type);
  }
  /** Rewind the min-3h-gap timestamp so only the daily cap is under test. */
  function rewindMinGap(h: Harness): void {
    h.redisLocks.set(`cadence:last:${h.user.phone}`, String(Date.now() - 4 * 3_600_000));
  }

  it('a user who chose 1 check-in per day gets exactly 1 non-critical send', async () => {
    setUtc(2026, 5, 20, 16, 0); // Wednesday noon NY
    const h = buildHarness(makeUser({ checkin_count_per_day: 1 }));

    await sendDirect(h, 'morning');
    expect(h.sends).toHaveLength(1);

    rewindMinGap(h);
    await sendDirect(h, 'midday');
    expect(h.sends).toHaveLength(1); // capped at the user's setting, not the old hard-coded 2
  });

  it('default (2/day) still allows a second send and blocks the third', async () => {
    setUtc(2026, 5, 20, 16, 0);
    const h = buildHarness(makeUser({ checkin_count_per_day: 2 }));

    await sendDirect(h, 'morning');
    rewindMinGap(h);
    await sendDirect(h, 'midday');
    expect(h.sends).toHaveLength(2);

    rewindMinGap(h);
    await sendDirect(h, 'evening');
    expect(h.sends).toHaveLength(2);
  });

  it('clamps an out-of-range setting (5/day) to the structural max of 3', async () => {
    setUtc(2026, 5, 20, 16, 0);
    const h = buildHarness(makeUser({ checkin_count_per_day: 5 }));

    for (const type of ['morning', 'midday', 'evening', 'bonus']) {
      rewindMinGap(h);
      await sendDirect(h, type);
    }
    expect(h.sends).toHaveLength(3);
  });

  it('critical health flows are exempt from the user cap', async () => {
    setUtc(2026, 5, 20, 16, 0);
    const h = buildHarness(makeUser({ checkin_count_per_day: 1 }));

    await sendDirect(h, 'morning');
    rewindMinGap(h);
    await sendDirect(h, 'injection_followup'); // critical — must not be blocked
    expect(h.sends).toHaveLength(2);
  });

  it('checkin_days_interval=2 sends on exactly one of two consecutive days', async () => {
    const h = buildHarness(makeUser({ checkin_days_interval: 2 }));

    setUtc(2026, 5, 20, 16, 0); // Wednesday noon NY
    await sendDirect(h, 'morning');
    setUtc(2026, 5, 21, 16, 0); // Thursday noon NY
    await sendDirect(h, 'morning');

    expect(h.sends).toHaveLength(1);
  });

  it('checkin_days_interval off-days still allow critical flows', async () => {
    const h = buildHarness(makeUser({ checkin_days_interval: 2 }));

    // Find the off day of the pair and assert a critical type still fires.
    setUtc(2026, 5, 20, 16, 0);
    await sendDirect(h, 'morning');
    const offDayUtc: [number, number] = h.sends.length === 0 ? [5, 20] : [5, 21];
    setUtc(2026, offDayUtc[0], offDayUtc[1], 16, 0);
    const before = h.sends.length;
    await sendDirect(h, 'trial_expiry_reminder');
    expect(h.sends.length).toBe(before + 1);
  });
});

describe('Scheduler — reminder context enrichment (2026-06-11 reminders fix)', () => {
  async function sendDirect(h: Harness, type: string): Promise<void> {
    // @ts-expect-error — accessing private for test
    await h.scheduler.sendAndRecord(h.user, type);
  }

  it('morning reminder receives YESTERDAY\'s real food data', async () => {
    setUtc(2026, 5, 19, 16, 0); // local NY date = 2026-05-19
    const h = buildHarness(makeUser({ protein_goal_grams: 90 }), {
      proteinHistory: [
        { day: '2026-05-19', protein_g: 12, calories: 200, item_count: 1 },
        { day: '2026-05-18', protein_g: 42, calories: 900, item_count: 3 },
      ],
    });
    await sendDirect(h, 'morning');
    const call = h.generateCalls.find((c) => c.type === 'morning');
    expect(call?.opts?.['yesterdayFood']).toEqual({
      protein_g: 42, calories: 900, itemCount: 3, proteinGoal: 90,
    });
    // Morning must NOT receive today's data — that's evening logic.
    expect(call?.opts?.['todayFood']).toBeUndefined();
  });

  it('evening reminder receives TODAY\'s real food data (not yesterday\'s)', async () => {
    setUtc(2026, 5, 19, 16, 0);
    const h = buildHarness(
      makeUser({ protein_goal_grams: 100, last_reply_at: new Date(Date.now() - 5 * 3_600_000), last_morning_sent_at: new Date(Date.now() - 6 * 3_600_000) }),
      { todaySummary: { protein_g: 82, calories: 1400, items: ['eggs', 'chicken', 'yogurt'] } },
    );
    await sendDirect(h, 'evening');
    const call = h.generateCalls.find((c) => c.type === 'evening');
    expect(call?.opts?.['todayFood']).toEqual({
      protein_g: 82, calories: 1400, itemCount: 3, proteinGoal: 100,
    });
    expect(call?.opts?.['yesterdayFood']).toBeUndefined();
  });

  it('generative reminders receive the last sent texts for anti-repetition', async () => {
    setUtc(2026, 5, 19, 16, 0);
    const h = buildHarness(makeUser(), {
      recentCheckIns: [
        { type: 'morning', message_sent: 'Protein first today 🌿' },
        { type: 'evening', message_sent: 'Rest well tonight 🌙' },
      ],
    });
    await sendDirect(h, 'morning');
    const call = h.generateCalls.find((c) => c.type === 'morning');
    expect(call?.opts?.['recentMessages']).toEqual(['Protein first today 🌿', 'Rest well tonight 🌙']);
  });

  it('context fetch failures never block the reminder (best-effort)', async () => {
    setUtc(2026, 5, 19, 16, 0);
    const h = buildHarness(makeUser());
    // Sabotage all context reads.
    // @ts-expect-error — reaching into the mock
    h.scheduler.deps.users.getRecentCheckIns = async () => { throw new Error('db down'); };
    // @ts-expect-error — reaching into the mock
    h.scheduler.deps.users.getDailyProteinHistory = async () => { throw new Error('db down'); };
    await sendDirect(h, 'morning');
    expect(h.sends.length).toBe(1); // still sent
  });

  it('critical injection_morning skips context enrichment entirely', async () => {
    setUtc(2026, 5, 19, 16, 0);
    const h = buildHarness(makeUser(), {
      recentCheckIns: [{ type: 'morning', message_sent: 'Old text' }],
    });
    await sendDirect(h, 'injection_morning');
    const call = h.generateCalls.find((c) => c.type === 'injection_morning');
    expect(call?.opts?.['recentMessages']).toBeUndefined();
  });
});

describe('Scheduler — timing varies day to day (jitter)', () => {
  it('same user + same day → same offset (stable across restarts/retries)', async () => {
    const { jitterMinutes } = await import('./scheduler.js');
    expect(jitterMinutes('+15551234567-2026-05-19-morning', 55))
      .toBe(jitterMinutes('+15551234567-2026-05-19-morning', 55));
  });

  it('offsets differ across days — reminders never land at identical times every day', async () => {
    const { jitterMinutes } = await import('./scheduler.js');
    const offsets = ['2026-05-18', '2026-05-19', '2026-05-20', '2026-05-21', '2026-05-22', '2026-05-23', '2026-05-24']
      .map((d) => jitterMinutes(`+15551234567-${d}-morning`, 55));
    // Across a week the offset must actually vary (not a constant schedule).
    expect(new Set(offsets).size).toBeGreaterThan(1);
    for (const o of offsets) {
      expect(o).toBeGreaterThanOrEqual(0);
      expect(o).toBeLessThan(55);
    }
  });
});

describe('Scheduler — OPTIMIZERS_ENABLED kill switch (2026-06-14)', () => {
  const baseDeps = () => {
    const logger = { info: () => {}, warn: () => {}, error: () => {} } as never;
    const noopRedis = {} as never;
    const promptOptimizer = { run: async () => {}, runIfMissedToday: async () => {} } as never;
    return {
      users: {} as never,
      sender: {} as never,
      generator: {} as never,
      logger,
      redis: noopRedis,
      promptOptimizer,
      researchScrape: async () => {},
      researchAutoFix: async () => {},
    };
  };

  it('schedules only the core tick + personalization crons when disabled', () => {
    const scheduler = new Scheduler({ ...baseDeps(), optimizersEnabled: false });
    scheduler.start();
    // Only the per-minute tick and the daily personalization engine — none of
    // the optimizer/research crons.
    // @ts-expect-error — reaching into private tasks for the assertion
    expect(scheduler.tasks.length).toBe(2);
    scheduler.stop();
  });

  it('schedules the optimizer crons when enabled (default)', () => {
    const scheduler = new Scheduler({ ...baseDeps(), optimizersEnabled: true });
    scheduler.start();
    // tick + personalization + promptOptimizer + researchScrape + researchAutoFix
    // @ts-expect-error — reaching into private tasks for the assertion
    expect(scheduler.tasks.length).toBeGreaterThan(2);
    scheduler.stop();
  });
});

describe('Scheduler — proactive reminders route on the user channel (iMessage-first)', () => {
  async function sendDirect(h: Harness, type: string): Promise<void> {
    // @ts-expect-error — accessing private for test
    await h.scheduler.sendAndRecord(h.user, type);
  }

  it('an iMessage user gets the reminder on the imessage channel', async () => {
    setUtc(2026, 5, 20, 16, 0); // Wednesday noon NY
    const h = buildHarness(makeUser({ channel: 'imessage' }));
    await sendDirect(h, 'morning');
    expect(h.sends).toHaveLength(1);
    expect(h.sends[0]!.channel).toBe('imessage');
  });

  it('a null channel defaults to imessage (system-wide iMessage-first)', async () => {
    setUtc(2026, 5, 20, 16, 0);
    const h = buildHarness(makeUser({ channel: null }));
    await sendDirect(h, 'morning');
    expect(h.sends[0]!.channel).toBe('imessage');
  });

  it('a WhatsApp user (re-aligned non-Apple) still gets the reminder on whatsapp', async () => {
    setUtc(2026, 5, 20, 16, 0);
    const h = buildHarness(makeUser({ channel: 'whatsapp' }));
    await sendDirect(h, 'morning');
    expect(h.sends[0]!.channel).toBe('whatsapp');
  });
});
