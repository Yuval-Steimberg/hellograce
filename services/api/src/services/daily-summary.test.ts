import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import type { Pool } from 'pg';
import type { GraceUser, UserService } from '../user/user.service.js';
import type { MessageSender } from '../twilio/sender.js';
import { Scheduler } from '../scheduler/scheduler.js';
import {
  gatherDailySummaryData,
  hasLoggedData,
  renderDailySummary,
  dailySummaryTargetMinutes,
  isInDailySummaryWindow,
  DAILY_SUMMARY_WINDOW_MIN,
  type DailySummaryData,
} from './daily-summary.js';

// ── Fixtures ─────────────────────────────────────────────────────────────────

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

/** Banned wording per the spec's tone rules — must never appear. */
const BANNED_RE =
  /\byou failed\b|\badherence\b|\byou must\b|\byou should have\b|\bnon-?compliant\b|\bdiagnos/i;

function mkData(over: Partial<DailySummaryData> = {}): DailySummaryData {
  return {
    date: '2026-07-06',
    food: { proteinG: 0, calories: 0, mealCount: 0, items: [] },
    waterOz: null,
    habits: [],
    movement: false,
    strength: false,
    symptoms: [],
    weightLoggedToday: null,
    injection: { doneToday: false, isInjectionDayToday: false, tomorrowIsInjectionDay: false },
    ...over,
  };
}

function mkUser(over: Partial<GraceUser> = {}): GraceUser {
  return {
    phone: '+15551230000',
    timezone: 'UTC',
    wake_time: '07:00',
    sleep_time: '22:00',
    medication: 'Ozempic',
    injection_day: null,
    injection_done_at: null,
    protein_goal_grams: 120,
    daily_summary_enabled: true,
    onboarding_state: 'complete',
    channel: 'imessage',
    active: true,
    paused: false,
    blocked: false,
    ...over,
  } as unknown as GraceUser;
}

// ── Pure: window math ────────────────────────────────────────────────────────

describe('dailySummaryTargetMinutes', () => {
  it('is sleep_time − 30 min when that lands inside 19:00–21:00', () => {
    expect(dailySummaryTargetMinutes({ sleep_time: '21:00' })).toBe(20 * 60 + 30); // 20:30
    expect(dailySummaryTargetMinutes({ sleep_time: '20:15' })).toBe(19 * 60 + 45); // 19:45
  });
  it('clamps to 21:00 for late sleepers', () => {
    expect(dailySummaryTargetMinutes({ sleep_time: '22:00' })).toBe(21 * 60);
    expect(dailySummaryTargetMinutes({ sleep_time: '23:30' })).toBe(21 * 60);
  });
  it('clamps to 19:00 for early sleepers', () => {
    expect(dailySummaryTargetMinutes({ sleep_time: '18:00' })).toBe(19 * 60);
  });
  it('defaults to 21:00 when sleep_time is missing/unparseable', () => {
    expect(dailySummaryTargetMinutes({ sleep_time: null as unknown as string })).toBe(21 * 60);
    expect(dailySummaryTargetMinutes({ sleep_time: '' })).toBe(21 * 60);
    expect(dailySummaryTargetMinutes({ sleep_time: 'nope' })).toBe(21 * 60);
  });
});

describe('isInDailySummaryWindow', () => {
  it('is inclusive of the target and exclusive of target+window', () => {
    const t = 21 * 60;
    expect(isInDailySummaryWindow(t, t)).toBe(true);
    expect(isInDailySummaryWindow(t + DAILY_SUMMARY_WINDOW_MIN - 1, t)).toBe(true);
    expect(isInDailySummaryWindow(t + DAILY_SUMMARY_WINDOW_MIN, t)).toBe(false);
    expect(isInDailySummaryWindow(t - 1, t)).toBe(false);
  });
});

// ── Pure: hasLoggedData ──────────────────────────────────────────────────────

describe('hasLoggedData', () => {
  it('is false for an entirely empty day', () => {
    expect(hasLoggedData(mkData())).toBe(false);
  });
  it('is false when only injection CONTEXT exists (today/tomorrow is a shot day)', () => {
    expect(
      hasLoggedData(mkData({ injection: { doneToday: false, isInjectionDayToday: true, tomorrowIsInjectionDay: true } })),
    ).toBe(false);
  });
  it.each([
    ['protein', mkData({ food: { proteinG: 30, calories: 0, mealCount: 0, items: [] } })],
    ['meals', mkData({ food: { proteinG: 0, calories: 0, mealCount: 2, items: [] } })],
    ['water', mkData({ waterOz: 20 })],
    ['habits', mkData({ habits: ['fiber'] })],
    ['symptoms', mkData({ symptoms: ['nausea'] })],
    ['weight', mkData({ weightLoggedToday: 180 })],
    ['injection done', mkData({ injection: { doneToday: true, isInjectionDayToday: true, tomorrowIsInjectionDay: false } })],
  ])('is true when %s was logged', (_label, data) => {
    expect(hasLoggedData(data)).toBe(true);
  });
  it('treats water==0 (tracked but none) as no data', () => {
    expect(hasLoggedData(mkData({ waterOz: 0 }))).toBe(false);
  });
});

// ── Pure: render ─────────────────────────────────────────────────────────────

describe('renderDailySummary', () => {
  it('renders a full day with real numbers, warm + non-judgmental', () => {
    const data = mkData({
      food: { proteinG: 82, calories: 1400, mealCount: 3, items: ['eggs'] },
      waterOz: 40,
      movement: true,
      symptoms: ['nausea'],
      habits: ['movement', 'fluids'],
    });
    const msg = renderDailySummary(data, { protein_goal_grams: 120 } as GraceUser);
    expect(msg).toContain('Protein: 82g');
    expect(msg).toContain('Water: 5 cups');
    expect(msg).toContain('Movement: got some in');
    expect(msg).toContain('Meals: 3 logged');
    expect(msg).toContain('Symptoms: Nausea');
    expect(msg).toMatch(/My take:/);
    expect(msg).toMatch(/Tomorrow,/);
    // Under goal → a soft, non-shaming take
    expect(msg).toMatch(/protein came in a little under your goal/i);
    expect(msg).not.toMatch(BANNED_RE);
    // Anti-fabrication: the recap protein line reports the REAL total, and there
    // is no second, different protein figure (the 669g-hallucination class).
    expect(msg).toContain('Protein: 82g');
    expect(msg).not.toMatch(/Protein:\s*(?!82g)\d+g/);
  });

  it('acknowledges protein at/above goal without shaming', () => {
    const data = mkData({ food: { proteinG: 135, calories: 1600, mealCount: 4, items: [] }, waterOz: 72 });
    const msg = renderDailySummary(data, { protein_goal_grams: 120 } as GraceUser);
    expect(msg).toMatch(/protein was right on target/i);
    expect(msg).toMatch(/fluids looked solid/i);
    expect(msg).not.toMatch(BANNED_RE);
  });

  it('suggests water in the morning when fluids are low', () => {
    const data = mkData({ food: { proteinG: 90, calories: 1200, mealCount: 2, items: [] }, waterOz: 20 });
    const msg = renderDailySummary(data, { protein_goal_grams: 120 } as GraceUser);
    expect(msg).toMatch(/water close by in the morning/i);
  });

  it('flags tomorrow being injection day with a gentle prep suggestion', () => {
    const data = mkData({
      food: { proteinG: 60, calories: 900, mealCount: 2, items: [] },
      waterOz: 40,
      injection: { doneToday: false, isInjectionDayToday: false, tomorrowIsInjectionDay: true },
    });
    const msg = renderDailySummary(data, { protein_goal_grams: 120 } as GraceUser);
    expect(msg).toMatch(/shot coming up/i);
    expect(msg).not.toMatch(BANNED_RE);
  });

  it('handles a light day (only habits) without any invented food numbers', () => {
    const data = mkData({ habits: ['fiber', 'supplements'] });
    const msg = renderDailySummary(data, { protein_goal_grams: null } as GraceUser);
    expect(msg).not.toMatch(/Protein:/);
    expect(msg).toMatch(/Checked off:/);
    expect(msg).not.toMatch(BANNED_RE);
  });

  it('adds a gentle clinician nudge only when symptoms were logged', () => {
    const withSym = renderDailySummary(mkData({ symptoms: ['fatigue'], food: { proteinG: 40, calories: 500, mealCount: 1, items: [] } }), { protein_goal_grams: 120 } as GraceUser);
    const noSym = renderDailySummary(mkData({ food: { proteinG: 40, calories: 500, mealCount: 1, items: [] } }), { protein_goal_grams: 120 } as GraceUser);
    expect(withSym).toMatch(/clinician/i);
    expect(noSym).not.toMatch(/clinician/i);
  });
});

// ── gatherDailySummaryData: best-effort + today-filtering ────────────────────

describe('gatherDailySummaryData', () => {
  const NOW = new Date(Date.UTC(2026, 6, 6, 18, 0)); // 2026-07-06 18:00 UTC
  const todayTs = new Date(Date.UTC(2026, 6, 6, 12, 0));
  const twoDaysAgo = new Date(Date.UTC(2026, 6, 4, 12, 0));

  function usersMock(over: Partial<Record<string, unknown>> = {}): UserService {
    return {
      getTodaysFoodSummary: async () => ({ protein_g: 50, calories: 800, items: ['eggs'], items_detailed: [{ food: 'eggs', protein_g: 50, calories: 800, logged_at: '' }] }),
      getRecentSymptomEpisodes: async () => [],
      getWeightHistory: async () => [],
      ...over,
    } as unknown as UserService;
  }

  /** Fake pool: matches water_logs / habit_logs by SQL text. */
  function poolMock(cfg: { waterOz?: number | null; habits?: string[]; throwAll?: boolean } = {}): Pool {
    return {
      query: async (sql: string) => {
        if (cfg.throwAll) throw new Error('db down');
        if (/water_logs/.test(sql)) {
          if (cfg.waterOz == null) throw new Error('no water table');
          return { rows: [{ total_oz: cfg.waterOz }] };
        }
        if (/habit_logs/.test(sql)) return { rows: (cfg.habits ?? []).map((h) => ({ habit_key: h })) };
        return { rows: [] };
      },
    } as unknown as Pool;
  }

  it('aggregates food, water, and habits into the snapshot', async () => {
    const data = await gatherDailySummaryData(
      { users: usersMock(), pool: poolMock({ waterOz: 48, habits: ['movement', 'fiber'] }) },
      mkUser(),
      NOW,
    );
    expect(data.food.proteinG).toBe(50);
    expect(data.food.mealCount).toBe(1);
    expect(data.waterOz).toBe(48);
    expect(data.habits).toEqual(['movement', 'fiber']);
    expect(data.movement).toBe(true);
    expect(data.strength).toBe(false);
  });

  it('degrades to zeros/empties when every source errors (never throws)', async () => {
    const data = await gatherDailySummaryData(
      {
        users: usersMock({
          getTodaysFoodSummary: async () => { throw new Error('boom'); },
          getRecentSymptomEpisodes: async () => { throw new Error('boom'); },
          getWeightHistory: async () => { throw new Error('boom'); },
        }),
        pool: poolMock({ throwAll: true }),
      },
      mkUser(),
      NOW,
    );
    expect(hasLoggedData(data)).toBe(false);
    expect(data.waterOz).toBe(null);
    expect(data.habits).toEqual([]);
  });

  it('counts only symptoms + weight logged TODAY (local day)', async () => {
    const data = await gatherDailySummaryData(
      {
        users: usersMock({
          getRecentSymptomEpisodes: async () => [
            { symptom: 'nausea', created_at: todayTs, days_since_injection: null, dose_mg: null, remedy_helped: null },
            { symptom: 'fatigue', created_at: twoDaysAgo, days_since_injection: null, dose_mg: null, remedy_helped: null },
          ],
          getWeightHistory: async () => [{ weight: 178, created_at: twoDaysAgo }],
        }),
        pool: poolMock(),
      },
      mkUser(),
      NOW,
    );
    expect(data.symptoms).toEqual(['nausea']); // fatigue was 2 days ago
    expect(data.weightLoggedToday).toBe(null); // weigh-in was 2 days ago
  });

  it('detects a weight logged today and dedups repeat symptoms', async () => {
    const data = await gatherDailySummaryData(
      {
        users: usersMock({
          getRecentSymptomEpisodes: async () => [
            { symptom: 'nausea', created_at: todayTs, days_since_injection: null, dose_mg: null, remedy_helped: null },
            { symptom: 'nausea', created_at: NOW, days_since_injection: null, dose_mg: null, remedy_helped: null },
          ],
          getWeightHistory: async () => [{ weight: 176, created_at: NOW }],
        }),
        pool: poolMock(),
      },
      mkUser(),
      NOW,
    );
    expect(data.symptoms).toEqual(['nausea']);
    expect(data.weightLoggedToday).toBe(176);
  });

  it('marks injection.doneToday when injection_done_at falls on today', async () => {
    const data = await gatherDailySummaryData(
      { users: usersMock(), pool: poolMock() },
      mkUser({ injection_done_at: todayTs }),
      NOW,
    );
    expect(data.injection.doneToday).toBe(true);
  });

  it('flags tomorrow as injection day for a weekly injectable', async () => {
    // 2026-07-06 is a Monday (UTC). injection_day Tuesday → tomorrow.
    const data = await gatherDailySummaryData(
      { users: usersMock(), pool: poolMock() },
      mkUser({ medication: 'Ozempic', injection_day: 'Tuesday' }),
      NOW,
    );
    expect(data.injection.tomorrowIsInjectionDay).toBe(true);
  });
});

// ── Scheduler pass: window gate, dedup, opt-out, no-data, send-failure ────────

describe('Scheduler.sendDailySummaries', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  interface Built {
    scheduler: Scheduler;
    sends: Array<{ to: string; body: string; channel: string; raw?: boolean }>;
    checkIns: Array<{ type: string; messageSent: string }>;
    store: Map<string, string>;
  }

  function build(user: GraceUser, opts: { enabled?: boolean; foodProtein?: number; sendThrows?: boolean } = {}): Built {
    const sends: Built['sends'] = [];
    const checkIns: Built['checkIns'] = [];
    const store = new Map<string, string>();

    const users = {
      listActiveUsers: async () => [user],
      getTodaysFoodSummary: async () => ({
        protein_g: opts.foodProtein ?? 0,
        calories: opts.foodProtein ? 900 : 0,
        items: opts.foodProtein ? ['eggs'] : [],
        items_detailed: opts.foodProtein ? [{ food: 'eggs', protein_g: opts.foodProtein, calories: 900, logged_at: '' }] : [],
      }),
      getRecentSymptomEpisodes: async () => [],
      getWeightHistory: async () => [],
      recordCheckIn: async (c: { type: string; messageSent: string }) => {
        checkIns.push({ type: c.type, messageSent: c.messageSent });
        return 'id';
      },
    } as unknown as UserService;

    const sender = {
      send: async (msg: { to: string; body: string; channel: string; raw?: boolean }) => {
        if (opts.sendThrows) throw new Error('send failed');
        sends.push(msg);
        return { sid: 'x' };
      },
    } as unknown as MessageSender;

    const redis = {
      set: async (key: string, value: string, ...args: unknown[]) => {
        const nx = args.includes('NX');
        if (nx && store.has(key)) return null;
        store.set(key, value);
        return 'OK';
      },
      del: async (key: string) => { store.delete(key); return 1; },
    } as unknown as Redis;

    const pool = { query: async () => ({ rows: [] }) } as unknown as Pool;

    const scheduler = new Scheduler({
      users,
      sender,
      generator: {} as never,
      logger,
      redis,
      pool,
      dailySummaryEnabled: opts.enabled ?? true,
    });
    return { scheduler, sends, checkIns, store };
  }

  const call = (s: Scheduler) => (s as unknown as { sendDailySummaries: () => Promise<void> }).sendDailySummaries();

  /** 2026-07-06 21:05 UTC → local 21:05 for a UTC user (target 21:00, in window). */
  function inWindow(): void {
    vi.setSystemTime(new Date(Date.UTC(2026, 6, 6, 21, 5)));
  }
  function outOfWindow(): void {
    vi.setSystemTime(new Date(Date.UTC(2026, 6, 6, 15, 0))); // local 15:00
  }

  it('sends inside the window when there is logged data, with raw:true, and records a daily_summary check-in', async () => {
    inWindow();
    const h = build(mkUser(), { foodProtein: 82 });
    await call(h.scheduler);
    expect(h.sends).toHaveLength(1);
    expect(h.sends[0]!.raw).toBe(true);
    expect(h.sends[0]!.body).toContain('Protein: 82g');
    expect(h.checkIns).toEqual([{ type: 'daily_summary', messageSent: h.sends[0]!.body }]);
  });

  it('does not send outside the window', async () => {
    outOfWindow();
    const h = build(mkUser(), { foodProtein: 82 });
    await call(h.scheduler);
    expect(h.sends).toHaveLength(0);
  });

  it('sends nothing on a zero-log day (and claims no lock, so a later log can still send)', async () => {
    inWindow();
    const h = build(mkUser(), { foodProtein: 0 });
    await call(h.scheduler);
    expect(h.sends).toHaveLength(0);
    expect(h.store.size).toBe(0); // no daily_summary lock claimed
  });

  it('dedups: a second tick in the same window does not double-send', async () => {
    inWindow();
    const h = build(mkUser(), { foodProtein: 82 });
    await call(h.scheduler);
    await call(h.scheduler);
    expect(h.sends).toHaveLength(1);
  });

  it('skips a user who opted out (daily_summary_enabled = false)', async () => {
    inWindow();
    const h = build(mkUser({ daily_summary_enabled: false }), { foodProtein: 82 });
    await call(h.scheduler);
    expect(h.sends).toHaveLength(0);
  });

  it('skips a user still in onboarding', async () => {
    inWindow();
    const h = build(mkUser({ onboarding_state: 'in_progress' }), { foodProtein: 82 });
    await call(h.scheduler);
    expect(h.sends).toHaveLength(0);
  });

  it('is a no-op when the feature flag is off', async () => {
    inWindow();
    const h = build(mkUser(), { foodProtein: 82, enabled: false });
    await call(h.scheduler);
    expect(h.sends).toHaveLength(0);
    expect(h.checkIns).toHaveLength(0);
  });

  it('releases the lock when the send fails, so a later tick can retry', async () => {
    inWindow();
    const h = build(mkUser(), { foodProtein: 82, sendThrows: true });
    await call(h.scheduler);
    expect(h.sends).toHaveLength(0);
    // Lock was released → the daily_summary key is not lingering.
    expect([...h.store.keys()].some((k) => k.startsWith('daily_summary:'))).toBe(false);
  });
});
