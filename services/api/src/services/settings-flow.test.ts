import { describe, it, expect } from 'vitest';
import { tryHandleSettings, tryHandleSettingsFollowUp, isBareSettingsFieldReply, __testing } from './settings-flow.js';
import type { GraceUser } from '../user/user.service.js';

const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

const deps = { logger: noopLogger };
const REDIRECT = __testing.PROFILE_REDIRECT;

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

// ─── Helper tests ────────────────────────────────────────────────────────────

describe('settings-flow helpers', () => {
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

// ─── READ flow — always allowed (Grace may read + use settings) ───────────────

describe('settings-flow READ', () => {
  it('"What is my timezone?" returns current value + settings link', async () => {
    const user = makeUser({ timezone: 'Asia/Jerusalem' });
    const reply = await tryHandleSettings('What is my timezone?', user, deps);
    expect(reply).toContain('Your timezone is Asia/Jerusalem (Jerusalem)');
    expect(reply).toContain('https://graceglp.com/settings');
  });

  it('"What is my injection day?" returns the stored day', async () => {
    const user = makeUser({ injection_day: 'Monday' });
    const reply = await tryHandleSettings('What is my injection day?', user, deps);
    expect(reply).toContain('Your injection day is Monday');
  });

  it('"How tall am I?" returns the stored height in both cm + ft/in', async () => {
    const user = makeUser({ height_cm: 175 });
    const reply = await tryHandleSettings('How tall am I?', user, deps);
    expect(reply).toMatch(/Your height is 175 cm \(5'9"\)/);
  });

  it('unset field returns the "you haven\'t set X yet" line', async () => {
    const user = makeUser({ goal_weight: null });
    const reply = await tryHandleSettings("What's my goal weight?", user, deps);
    expect(reply).toContain("haven't set your goal weight yet");
    expect(reply).toContain('graceglp.com/settings');
  });

  it('reads starting weight: unset → null-aware reply', async () => {
    const user = makeUser({ starting_weight: null });
    const reply = await tryHandleSettings('what is my starting weight?', user, deps);
    expect(reply).toContain("haven't set your starting weight yet");
  });
});

// ─── UPDATE → redirect (NEVER applied from chat) ──────────────────────────────

describe('settings-flow UPDATE redirects to Settings (no chat writes)', () => {
  const updatePhrases = [
    'change my goal weight to 170',
    'change my timezone to Jerusalem',
    'I switched to Wegovy',
    'my dose is 0.5 mg now',
    'I weigh 175 lbs now',
    'set my starting weight to 220 lbs',
    'I started at 230',
    'my height is 175 cm',
    'my sex is female',
    'call me Sarah',
    'my age is 40',
    'change my primary goal to maintenance',
  ];

  for (const phrase of updatePhrases) {
    it(`"${phrase}" → redirect, no write`, async () => {
      const reply = await tryHandleSettings(phrase, makeUser(), deps);
      expect(reply).toBe(REDIRECT);
      expect(reply).toContain('https://graceglp.com/settings');
      expect(reply).toContain('Settings page');
    });
  }

  it('even an unparseable value redirects (no "I didn\'t catch that")', async () => {
    const reply = await tryHandleSettings('change my timezone to Mars', makeUser(), deps);
    expect(reply).toBe(REDIRECT);
  });
});

// ─── Dietary preference changes → redirect ────────────────────────────────────

describe('settings-flow dietary changes redirect to Settings', () => {
  const dietaryPhrases = [
    "I'm vegetarian now",
    "I'm a vegan now",
    'I went vegetarian',
    'change my diet to vegan',
    'update my food preferences',
    'please remember that I don\'t eat meat',
    'I no longer keep kosher',
    "I don't eat eggs anymore",
    "I'm allergic to fish",
    'I hate mushrooms',
  ];

  for (const phrase of dietaryPhrases) {
    it(`"${phrase}" → redirect, no write`, async () => {
      const reply = await tryHandleSettings(phrase, makeUser(), deps);
      expect(reply).toBe(REDIRECT);
    });
  }
});

// ─── Settings MODIFICATION intent → redirect, not read (2026-06-13) ───────────

describe('settings modification requests redirect to Settings (never read the value)', () => {
  const modifyRequests = [
    'Change my protein goal',          // the production failure
    'change my protein goal to 120',
    'update my calorie goal',
    'I want to change my settings',
    'edit my goal weight',
    'lower my protein target',
    'adjust my reminders',
    'update my diet',
    'change my name',
    'set my wake time',
  ];
  for (const phrase of modifyRequests) {
    it(`"${phrase}" → Settings redirect`, async () => {
      const reply = await tryHandleSettings(phrase, makeUser(), deps);
      expect(reply).toBeTruthy();
      expect(reply!.toLowerCase()).toContain('settings page');
      // Must NOT echo a current value (the bug: "Your daily protein target is …").
      expect(reply).not.toMatch(/114g|target is/i);
    });
  }

  it('an INFO request still reads the value (not redirected)', async () => {
    const reply = await tryHandleSettings('what is my timezone?', makeUser({ timezone: 'America/New_York' }), deps);
    expect(reply).toMatch(/timezone/i);
  });

  it('nutrition questions are NOT caught (bare "protein", no "goal/target")', async () => {
    expect(await tryHandleSettings('how do I increase my protein intake?', makeUser(), deps)).toBeNull();
    expect(await tryHandleSettings('should I eat more protein?', makeUser(), deps)).toBeNull();
  });
});

// ─── Cross-turn: bare field reply after a settings clarification (2026-06-13) ──

describe('tryHandleSettingsFollowUp — inherits modify intent across turns', () => {
  const clar = 'It depends on what setting you’d like to change.';
  it('"protein goal" after "which setting?" → redirect', () => {
    expect(tryHandleSettingsFollowUp('protein goal', clar)).toMatch(/settings page/i);
    expect(tryHandleSettingsFollowUp('my protein goal', clar)).toMatch(/settings page/i);
    expect(tryHandleSettingsFollowUp('my goal weight', 'Which setting would you like to change?')).toMatch(/settings page/i);
  });

  it('does NOT fire without a prior settings clarification', () => {
    expect(tryHandleSettingsFollowUp('protein goal', 'How are you feeling today?')).toBeNull();
    expect(tryHandleSettingsFollowUp('protein goal', undefined)).toBeNull();
  });

  it('does NOT fire on a read question or a non-field reply', () => {
    expect(tryHandleSettingsFollowUp("what's my protein goal", clar)).toBeNull();
    expect(tryHandleSettingsFollowUp('chicken and rice', clar)).toBeNull();
  });

  it('isBareSettingsFieldReply gate', () => {
    expect(isBareSettingsFieldReply('protein goal')).toBe(true);
    expect(isBareSettingsFieldReply('my goal weight')).toBe(true);
    expect(isBareSettingsFieldReply('what is my protein goal')).toBe(false); // read
    expect(isBareSettingsFieldReply('change my protein goal')).toBe(false);  // has verb → main detector
    expect(isBareSettingsFieldReply('I had eggs')).toBe(false);
  });
});

// ─── Does NOT trigger on normal chat ──────────────────────────────────────────

describe('settings-flow does NOT trigger on normal chat', () => {
  const passThrough = [
    'I had eggs for breakfast',
    "I'm feeling tired today",
    'yes',
    "I'm vegan, what should I eat for dinner?",
    "I've been feeling really down lately and the scale isn't moving even though I'm sticking to my plan",
  ];

  for (const phrase of passThrough) {
    it(`"${phrase}" → null (falls through to AI)`, async () => {
      const reply = await tryHandleSettings(phrase, makeUser(), deps);
      expect(reply).toBeNull();
    });
  }
});
