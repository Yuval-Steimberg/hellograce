import { describe, it, expect, vi, beforeEach } from 'vitest';
import { tryHandleSettings, __testing } from './settings-flow.js';
import type { GraceUser, UserService } from '../user/user.service.js';

const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

function makeUser(overrides: Partial<GraceUser> = {}): GraceUser {
  return {
    id: 'u1',
    phone: '+15551234567',
    first_name: 'Sam',
    medication: 'Ozempic',
    medication_frequency: 'weekly',
    injection_day: 'Monday',
    medication_time: null,
    sms_consent: true,
    injection_count: 0,
    goals: [],
    food_dislikes: [],
    timezone: 'America/New_York',
    wake_time: '07:00',
    sleep_time: '23:00',
    current_weight: 180,
    starting_weight: null,
    goal_weight: 160,
    height_cm: 175,
    age: 35,
    sex: 'male',
    primary_goal: 'fat_loss',
    protein_goal_grams: 80,
    calorie_goal_kcal: 1800,
    activity_level: 'moderate',
    dietary_pattern: null,
    protein_focus_boost: false,
    hydration_struggle: false,
    low_mood_mode: false,
    midday_skip: false,
    injection_flow_stage: null,
    injection_flow_started_at: null,
    injection_done_at: null,
    injection_side_effect_free: true,
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
    checkin_count_per_day: 1,
    checkin_days_interval: 1,
    glp1_start_date: null,
    grace_notes: null,
    active: true,
    paused: false,
    blocked: false,
    is_paid: false,
    is_pro: false,
    trial_start: null,
    rlhf_enabled: false,
    created_at: new Date(),
    updated_at: new Date(),
    dose_mg: 0.5,
    dietary_restriction: null,
    biggest_challenge: null,
    why_started: null,
    support_style: null,
    exercise_habits: null,
    ...overrides,
  };
}

function makeRedis() {
  const store = new Map<string, { value: string; expiresAt: number }>();
  return {
    get: vi.fn(async (k: string) => {
      const entry = store.get(k);
      if (!entry) return null;
      if (entry.expiresAt > 0 && Date.now() > entry.expiresAt) {
        store.delete(k);
        return null;
      }
      return entry.value;
    }),
    set: vi.fn(async (k: string, v: string, _mode?: string, ttl?: number) => {
      const expiresAt = ttl ? Date.now() + ttl * 1000 : 0;
      store.set(k, { value: v, expiresAt });
      return 'OK';
    }),
    del: vi.fn(async (k: string) => {
      const had = store.has(k);
      store.delete(k);
      return had ? 1 : 0;
    }),
    __store: store,
  };
}

function makeUserService(initial: GraceUser): { svc: UserService; updates: Array<Partial<GraceUser>> } {
  const updates: Array<Partial<GraceUser>> = [];
  let current = initial;
  const svc = {
    update: vi.fn(async (_phone: string, fields: Partial<GraceUser>) => {
      updates.push(fields);
      current = { ...current, ...fields };
    }),
    getByPhone: vi.fn(async () => current),
    getById: vi.fn(async () => current),
  } as unknown as UserService;
  return { svc, updates };
}

// ─── Helper tests ────────────────────────────────────────────────────────────

describe('settings-flow helpers', () => {
  it('isConfirmation matches yes/yep/confirm/correct/that\'s right', () => {
    const yeses = ['yes', 'Yes', 'YES', 'yep', 'yeah', 'sure', 'ok', 'okay', 'confirm', 'correct', "that's right", 'do it', 'go ahead', 'please', 'alright'];
    for (const y of yeses) expect(__testing.isConfirmation(y)).toBe(true);
  });
  it('isCancellation matches no/cancel/never mind/wrong', () => {
    const nos = ['no', 'nope', 'cancel', 'wait', 'never mind', 'nevermind', "that's wrong", 'wrong', 'hold on'];
    for (const n of nos) expect(__testing.isCancellation(n)).toBe(true);
  });
  it('parseTimezone accepts friendly names + IANA', () => {
    expect(__testing.parseTimezone('Jerusalem')).toEqual({ value: 'Asia/Jerusalem', display: 'Asia/Jerusalem (Jerusalem)' });
    expect(__testing.parseTimezone('new york')).toEqual({ value: 'America/New_York', display: 'America/New_York (New York)' });
    expect(__testing.parseTimezone('Asia/Tokyo')).toEqual({ value: 'Asia/Tokyo', display: 'Asia/Tokyo' });
    expect(__testing.parseTimezone('mars')).toBeNull();
  });
  it('parseMedication maps common GLP-1 drugs', () => {
    expect(__testing.parseMedication('Wegovy')!.value).toBe('Wegovy');
    expect(__testing.parseMedication('mounjaro')!.value).toBe('Mounjaro');
    expect(__testing.parseMedication('aspirin')).toBeNull();
  });
  it('parseSex normalizes M/F/nonbinary', () => {
    expect(__testing.parseSex('M')!.value).toBe('male');
    expect(__testing.parseSex('woman')!.value).toBe('female');
    expect(__testing.parseSex('nonbinary')!.value).toBe('nonbinary');
    expect(__testing.parseSex('whatever')).toBeNull();
  });
  it('cmFromAnyHeight handles cm, feet+inches, plain numbers', () => {
    expect(__testing.cmFromAnyHeight('175 cm')).toBe(175);
    expect(__testing.cmFromAnyHeight('175')).toBe(175);
    expect(__testing.cmFromAnyHeight("5'10")).toBe(178);
    expect(__testing.cmFromAnyHeight('70')).toBe(178); // inches
    expect(__testing.cmFromAnyHeight('garbage')).toBeNull();
  });
  it('parseFoodToken rejects sentence-like strings', () => {
    expect(__testing.parseFoodToken('fish')).toBe('fish');
    expect(__testing.parseFoodToken('it')).toBeNull();
    expect(__testing.parseFoodToken('eggs because they hurt')).toBeNull();
  });
});

// ─── READ flow ────────────────────────────────────────────────────────────────

describe('settings-flow READ', () => {
  it('"What is my timezone?" returns current value + settings link', async () => {
    const user = makeUser({ timezone: 'Asia/Jerusalem' });
    const { svc } = makeUserService(user);
    const redis = makeRedis();
    const reply = await tryHandleSettings('What is my timezone?', user, { users: svc, redis: redis as any, logger: noopLogger });
    expect(reply).not.toBeNull();
    expect(reply).toContain('Your timezone is Asia/Jerusalem (Jerusalem)');
    expect(reply).toContain('https://grace-admin-git-claude-gemini-c34cfe-yuval-steimbergs-projects.vercel.app/settings');
  });

  it('"What is my injection day?" returns the stored day', async () => {
    const user = makeUser({ injection_day: 'Monday' });
    const { svc } = makeUserService(user);
    const redis = makeRedis();
    const reply = await tryHandleSettings('What is my injection day?', user, { users: svc, redis: redis as any, logger: noopLogger });
    expect(reply).toContain('Your injection day is Monday');
  });

  it('"How tall am I?" returns the stored height in both cm + ft/in', async () => {
    const user = makeUser({ height_cm: 175 });
    const { svc } = makeUserService(user);
    const redis = makeRedis();
    const reply = await tryHandleSettings('How tall am I?', user, { users: svc, redis: redis as any, logger: noopLogger });
    expect(reply).toMatch(/Your height is 175 cm \(5'9"\)/);
  });

  it('unset field returns the "you haven\'t set X yet" line', async () => {
    const user = makeUser({ goal_weight: null });
    const { svc } = makeUserService(user);
    const redis = makeRedis();
    const reply = await tryHandleSettings("What's my goal weight?", user, { users: svc, redis: redis as any, logger: noopLogger });
    expect(reply).toContain("haven't set your goal weight yet");
    expect(reply).toContain('grace-admin-git-claude-gemini-c34cfe-yuval-steimbergs-projects.vercel.app/settings');
  });

  it('unrelated message returns null (falls through to AI)', async () => {
    const user = makeUser();
    const { svc } = makeUserService(user);
    const redis = makeRedis();
    const reply = await tryHandleSettings('I had eggs for breakfast', user, { users: svc, redis: redis as any, logger: noopLogger });
    expect(reply).toBeNull();
  });
});

// ─── UPDATE → confirm → apply flow ────────────────────────────────────────────

describe('settings-flow UPDATE → confirm → apply', () => {
  let user: GraceUser;
  let svcObj: { svc: UserService; updates: Array<Partial<GraceUser>> };
  let redis: ReturnType<typeof makeRedis>;
  let deps: any;

  beforeEach(() => {
    user = makeUser();
    svcObj = makeUserService(user);
    redis = makeRedis();
    deps = { users: svcObj.svc, redis, logger: noopLogger };
  });

  it('stages a pending update and asks for confirmation', async () => {
    const reply = await tryHandleSettings('change my goal weight to 170', user, deps);
    expect(reply).toBe('Change your goal weight to 170 lbs? Reply yes to confirm.');
    // Pending update stored in Redis with TTL
    expect(redis.set).toHaveBeenCalledWith(
      __testing.PENDING_KEY_PREFIX + user.phone,
      expect.any(String),
      'EX',
      __testing.PENDING_TTL_SECONDS,
    );
    expect(svcObj.updates).toEqual([]);
  });

  it('"yes" after pending applies the update and confirms', async () => {
    await tryHandleSettings('change my goal weight to 170', user, deps);
    const reply = await tryHandleSettings('yes', user, deps);
    expect(reply).toBe('Done — your goal weight is now 170 lbs.');
    expect(svcObj.updates).toEqual([{ goal_weight: 170 }]);
    // Pending cleared
    expect(await redis.get(__testing.PENDING_KEY_PREFIX + user.phone)).toBeNull();
  });

  it('"no" after pending cancels and leaves data unchanged', async () => {
    await tryHandleSettings('change my goal weight to 170', user, deps);
    const reply = await tryHandleSettings('no', user, deps);
    expect(reply).toBe('Got it — leaving your goal weight as it was.');
    expect(svcObj.updates).toEqual([]);
    expect(await redis.get(__testing.PENDING_KEY_PREFIX + user.phone)).toBeNull();
  });

  it('a different message after pending drops the pending and treats as new turn', async () => {
    await tryHandleSettings('change my goal weight to 170', user, deps);
    // Unrelated message — pending is dropped, returns null (falls through).
    const reply = await tryHandleSettings('I had eggs', user, deps);
    expect(reply).toBeNull();
    expect(svcObj.updates).toEqual([]);
    expect(await redis.get(__testing.PENDING_KEY_PREFIX + user.phone)).toBeNull();
  });

  // ─── per-field update coverage ─────────────────────────────────────────────

  it('updates timezone', async () => {
    await tryHandleSettings('change my timezone to Jerusalem', user, deps);
    await tryHandleSettings('yes', user, deps);
    expect(svcObj.updates).toEqual([{ timezone: 'Asia/Jerusalem' }]);
  });

  it('updates medication ("I switched to Wegovy")', async () => {
    const reply1 = await tryHandleSettings('I switched to Wegovy', user, deps);
    expect(reply1).toBe('Change your medication to Wegovy? Reply yes to confirm.');
    await tryHandleSettings('yes', user, deps);
    expect(svcObj.updates).toEqual([{ medication: 'Wegovy' }]);
  });

  it('updates dose ("my dose is 0.5 now")', async () => {
    const reply1 = await tryHandleSettings('my dose is 0.5 mg now', user, deps);
    expect(reply1).toBe('Change your dose to 0.5 mg? Reply yes to confirm.');
    await tryHandleSettings('yes', user, deps);
    expect(svcObj.updates).toEqual([{ dose_mg: 0.5 }]);
  });

  it('updates current weight ("I weigh 175 lbs now")', async () => {
    const reply1 = await tryHandleSettings('I weigh 175 lbs now', user, deps);
    expect(reply1).toBe('Change your current weight to 175 lbs? Reply yes to confirm.');
    await tryHandleSettings('yes', user, deps);
    expect(svcObj.updates).toEqual([{ current_weight: 175 }]);
  });

  it('updates starting weight ("set my starting weight to 220 lbs")', async () => {
    // 2026-06-06 — added per coverage audit Area 8.
    const reply1 = await tryHandleSettings('set my starting weight to 220 lbs', user, deps);
    expect(reply1).toBe('Change your starting weight to 220 lbs? Reply yes to confirm.');
    await tryHandleSettings('yes', user, deps);
    expect(svcObj.updates).toEqual([{ starting_weight: 220 }]);
  });

  it('updates starting weight ("I started at 230")', async () => {
    const reply1 = await tryHandleSettings('I started at 230', user, deps);
    expect(reply1).toBe('Change your starting weight to 230 lbs? Reply yes to confirm.');
    await tryHandleSettings('yes', user, deps);
    expect(svcObj.updates).toEqual([{ starting_weight: 230 }]);
  });

  it('reads starting weight: "what is my starting weight?" unset → null-aware reply', async () => {
    const reply = await tryHandleSettings('what is my starting weight?', user, deps);
    expect(reply).toContain("haven't set your starting weight yet");
  });

  it('updates height ("my height is 175 cm")', async () => {
    const reply1 = await tryHandleSettings('my height is 175 cm', user, deps);
    expect(reply1).toBe(`Change your height to 175 cm (5'9")? Reply yes to confirm.`);
    await tryHandleSettings('yes', user, deps);
    expect(svcObj.updates).toEqual([{ height_cm: 175 }]);
  });

  it('updates sex ("my sex is female")', async () => {
    const reply1 = await tryHandleSettings('my sex is female', user, deps);
    expect(reply1).toBe('Change your sex to female? Reply yes to confirm.');
    await tryHandleSettings('yes', user, deps);
    expect(svcObj.updates).toEqual([{ sex: 'female' }]);
  });

  it('updates first name ("call me Sarah")', async () => {
    const reply1 = await tryHandleSettings('call me Sarah', user, deps);
    expect(reply1).toBe('Change your name to Sarah? Reply yes to confirm.');
    await tryHandleSettings('yes', user, deps);
    expect(svcObj.updates).toEqual([{ first_name: 'Sarah' }]);
  });

  it('updates age', async () => {
    const reply1 = await tryHandleSettings('my age is 40', user, deps);
    expect(reply1).toBe('Change your age to 40? Reply yes to confirm.');
    await tryHandleSettings('yes', user, deps);
    expect(svcObj.updates).toEqual([{ age: 40 }]);
  });

  it('updates primary goal', async () => {
    const reply1 = await tryHandleSettings('change my primary goal to maintenance', user, deps);
    expect(reply1).toBe('Change your primary goal to maintenance? Reply yes to confirm.');
    await tryHandleSettings('yes', user, deps);
    expect(svcObj.updates).toEqual([{ primary_goal: 'maintenance' }]);
  });

  // ─── Food dislikes ADD ─────────────────────────────────────────────────────

  it('"I don\'t eat eggs anymore" stages adding eggs to food_dislikes', async () => {
    const reply1 = await tryHandleSettings("I don't eat eggs anymore", user, deps);
    expect(reply1).toBe('Add eggs to your food dislikes? Reply yes to confirm.');
    await tryHandleSettings('yes', user, deps);
    // Appended, not replaced — applyPending reads fresh + appends
    expect(svcObj.updates).toEqual([{ food_dislikes: ['eggs'] }]);
  });

  it('"I\'m allergic to fish" stages adding fish', async () => {
    const reply1 = await tryHandleSettings("I'm allergic to fish", user, deps);
    expect(reply1).toBe('Add fish to your food dislikes? Reply yes to confirm.');
  });

  it('duplicate dislike short-circuits without asking', async () => {
    user.food_dislikes = ['fish'];
    svcObj = makeUserService(user);
    deps = { users: svcObj.svc, redis, logger: noopLogger };
    const reply = await tryHandleSettings("I'm allergic to fish", user, deps);
    expect(reply).toContain('Already noted that you avoid fish');
    expect(svcObj.updates).toEqual([]);
  });

  // ─── Invalid input ─────────────────────────────────────────────────────────

  it('unparseable value returns a helpful error', async () => {
    const reply = await tryHandleSettings('change my timezone to Mars', user, deps);
    expect(reply).toContain("I didn't catch the new timezone");
    expect(reply).toContain('grace-admin-git-claude-gemini-c34cfe-yuval-steimbergs-projects.vercel.app/settings');
  });

  // ─── Confirmation idempotence ──────────────────────────────────────────────

  it('"yes" without pending update returns null (falls through to AI)', async () => {
    const reply = await tryHandleSettings('yes', user, deps);
    expect(reply).toBeNull();
    expect(svcObj.updates).toEqual([]);
  });

  it('"yes" after pending has been deleted returns null', async () => {
    await tryHandleSettings('change my goal weight to 170', user, deps);
    await tryHandleSettings('yes', user, deps);
    // Second "yes" — no pending now
    const reply = await tryHandleSettings('yes', user, deps);
    expect(reply).toBeNull();
    expect(svcObj.updates).toEqual([{ goal_weight: 170 }]);
  });
});

// ─── Don't trigger on normal chat ─────────────────────────────────────────────

describe('settings-flow does NOT trigger on normal chat', () => {
  it('returns null for "I had eggs for breakfast"', async () => {
    const user = makeUser();
    const { svc } = makeUserService(user);
    const redis = makeRedis();
    const reply = await tryHandleSettings('I had eggs for breakfast', user, { users: svc, redis: redis as any, logger: noopLogger });
    expect(reply).toBeNull();
  });

  it('returns null for "Im feeling tired today"', async () => {
    const user = makeUser();
    const { svc } = makeUserService(user);
    const redis = makeRedis();
    const reply = await tryHandleSettings("I'm feeling tired today", user, { users: svc, redis: redis as any, logger: noopLogger });
    expect(reply).toBeNull();
  });

  it('returns null for a fresh "yes" with no pending', async () => {
    const user = makeUser();
    const { svc } = makeUserService(user);
    const redis = makeRedis();
    const reply = await tryHandleSettings('yes', user, { users: svc, redis: redis as any, logger: noopLogger });
    expect(reply).toBeNull();
  });

  it('returns null for a long emotional message', async () => {
    const user = makeUser();
    const { svc } = makeUserService(user);
    const redis = makeRedis();
    const reply = await tryHandleSettings(
      "I've been feeling really down lately and the scale isn't moving even though I'm sticking to my plan",
      user,
      { users: svc, redis: redis as any, logger: noopLogger },
    );
    expect(reply).toBeNull();
  });
});
