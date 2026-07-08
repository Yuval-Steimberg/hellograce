import { describe, it, expect } from 'vitest';
import {
  PROGRESSIVE_SLOTS,
  nextMissingProfileSlot,
  relevantProfileSlot,
  contextualGatherSlot,
  buildProfileGatherNote,
  parseProfileReply,
  isProfileSlotFilled,
  getPendingProfileAsk,
  setPendingProfileAsk,
  clearPendingProfileAsk,
  askedProfileRecently,
  setReplayQuery,
  getReplayQuery,
  clearReplayQuery,
  buildGatherClarify,
  isGatherDecline,
  markSlotAsked,
  wasSlotAskedRecently,
  type RedisLike,
} from './progressive-profile.js';

// A user shape with everything missing by default. medication/frequency unset →
// treated as a non-weekly-injectable, so injection_day reads as "filled" (never
// asked) unless a fixture opts a weekly med in.
const empty = {
  sex: null, current_weight: null, height_cm: null, age: null,
  activity_level: null, dietary_restriction: null, dietary_pattern: null, goal_weight: null,
  food_dislikes: [], goals: [], wake_time: null, injection_day: null,
} as Parameters<typeof nextMissingProfileSlot>[0];

// A weekly-injectable user (Ozempic) who has NOT set an injection day.
const weekly = { ...empty, medication: 'Ozempic', medication_frequency: 'weekly' };

describe('nextMissingProfileSlot — priority order', () => {
  it('walks dietary → dislikes → goals → goal_weight → … in priority order', () => {
    let u = { ...empty };
    expect(nextMissingProfileSlot(u)).toBe('dietary');
    u = { ...u, dietary_pattern: 'vegan' };
    expect(nextMissingProfileSlot(u)).toBe('dislikes');
    u = { ...u, food_dislikes: ['eggs'] };
    expect(nextMissingProfileSlot(u)).toBe('goals');
    u = { ...u, goals: ['lose weight'] };
    expect(nextMissingProfileSlot(u)).toBe('goal_weight');
    u = {
      ...u, goal_weight: 160, current_weight: 180, sex: 'male', height_cm: 180,
      age: 40, activity_level: 'light', wake_time: '07:00',
    };
    expect(nextMissingProfileSlot(u)).toBeNull();
  });

  it('dietary counts filled if either restriction OR pattern is set', () => {
    expect(isProfileSlotFilled({ ...empty, dietary_pattern: 'vegan' }, 'dietary')).toBe(true);
    expect(isProfileSlotFilled({ ...empty, dietary_restriction: 'kosher' }, 'dietary')).toBe(true);
    expect(isProfileSlotFilled(empty, 'dietary')).toBe(false);
  });
});

describe('relevantProfileSlot — ask the field that makes THIS answer accurate', () => {
  it('a PROTEIN target question needs only weight (not the full Mifflin chain)', () => {
    // Protein is g/kg — weight is the single input. Asking sex/height/age/activity
    // for "what's my protein goal" was the over-ask + repetition bug.
    expect(relevantProfileSlot(empty, 'how much protein should I eat?')).toBe('current_weight');
    expect(relevantProfileSlot(empty, 'what is my protein goal?')).toBe('current_weight');
    // weight known → no gather at all (tryPersonalStats derives + answers directly)
    expect(relevantProfileSlot({ ...empty, current_weight: 190 }, 'what is my protein goal?')).toBeNull();
  });
  it('a CALORIE/macro question still pulls the first missing Mifflin input', () => {
    expect(relevantProfileSlot(empty, 'how many calories do I need?')).toBe('sex');
    expect(relevantProfileSlot({ ...empty, sex: 'male' }, "what's my calorie target?")).toBe('current_weight');
  });
  it('a FACTUAL food-content estimate never gathers (production: salmon protein)', () => {
    // "how much protein IS that" is answered directly — it does NOT depend on
    // the user's activity level / Mifflin inputs, so no ask-out-of-nowhere.
    expect(relevantProfileSlot(empty, 'I had salmon with potatoes and salad. How much protein is that roughly, and what should I eat later?')).toBeNull();
    expect(relevantProfileSlot(empty, 'how much protein is in salmon?')).toBeNull();
    expect(relevantProfileSlot(empty, 'how many calories was that meal?')).toBeNull();
    // The bare word "protein" alone must not trigger a gather.
    expect(relevantProfileSlot(empty, 'I love a good protein shake')).toBeNull();
  });
  it('a food-idea question pulls dietary, then dislikes, then nothing', () => {
    expect(relevantProfileSlot(empty, 'what should I eat for dinner?')).toBe('dietary');
    // diet known but dislikes unknown → ask dislikes
    expect(relevantProfileSlot({ ...empty, dietary_pattern: 'vegan' }, 'any dinner ideas?')).toBe('dislikes');
    // both known → not relevant
    expect(relevantProfileSlot({ ...empty, dietary_pattern: 'vegan', food_dislikes: ['eggs'] }, 'any dinner ideas?')).toBeNull();
  });
  it('a reminder-timing question pulls wake_sleep when unknown', () => {
    expect(relevantProfileSlot(empty, 'when is my next reminder?')).toBe('wake_sleep');
    expect(relevantProfileSlot(empty, 'what time do you text me?')).toBe('wake_sleep');
    // once wake/sleep known → not relevant (the reminder handler answers it)
    expect(relevantProfileSlot({ ...empty, wake_time: '07:00' }, 'when is my next reminder?')).toBeNull();
  });
  it('an unrelated message triggers nothing', () => {
    expect(relevantProfileSlot(empty, 'good morning!')).toBeNull();
  });
  it('returns null once the relevant inputs are all known', () => {
    const full = { ...empty, sex: 'male', current_weight: 180, height_cm: 180, age: 40, activity_level: 'light' };
    expect(relevantProfileSlot(full, 'how much protein should I eat?')).toBeNull();
  });
});

describe('injection_day slot — only relevant for weekly injectables', () => {
  it('is "filled" (never asked) for a non-weekly / unknown-cadence user', () => {
    expect(isProfileSlotFilled(empty, 'injection_day')).toBe(true); // no med → skip
    expect(isProfileSlotFilled({ ...empty, medication: 'Rybelsus', medication_frequency: 'daily' }, 'injection_day')).toBe(true);
  });
  it('is missing for a weekly injectable with no day set, filled once set', () => {
    expect(isProfileSlotFilled(weekly, 'injection_day')).toBe(false);
    expect(isProfileSlotFilled({ ...weekly, injection_day: 'Friday' }, 'injection_day')).toBe(true);
  });
  it('infers weekly cadence from the drug name when frequency is unknown', () => {
    expect(isProfileSlotFilled({ ...empty, medication: 'Mounjaro' }, 'injection_day')).toBe(false);
  });
  it('a pill user is never surfaced injection_day by nextMissingProfileSlot', () => {
    const filled = {
      ...empty, medication: 'Rybelsus', medication_frequency: 'daily',
      dietary_pattern: 'vegan', food_dislikes: ['eggs'], goals: ['weight'],
      goal_weight: 160, current_weight: 180, sex: 'male', height_cm: 180,
      age: 40, activity_level: 'light', wake_time: '07:00',
    };
    expect(nextMissingProfileSlot(filled)).toBeNull();
  });
});

describe('contextualGatherSlot — pick the field relevant to the topic', () => {
  it('medication talk → injection_day (weekly injectable, unknown day)', () => {
    expect(contextualGatherSlot(weekly, 'my shot was rough this week')).toBe('injection_day');
    expect(contextualGatherSlot(weekly, 'when do I take my next dose')).toBe('injection_day');
    // pill user → never ask a shot day
    expect(contextualGatherSlot({ ...empty, medication: 'Rybelsus', medication_frequency: 'daily' }, 'took my dose today')).toBeNull();
    // day already known → nothing to gather from med talk
    expect(contextualGatherSlot({ ...weekly, injection_day: 'Friday' }, 'my shot went fine')).toBeNull();
  });
  it('exercise talk → activity when unknown', () => {
    expect(contextualGatherSlot(empty, 'I went for a run this morning')).toBe('activity');
    expect(contextualGatherSlot(empty, 'been hitting the gym lately')).toBe('activity');
    expect(contextualGatherSlot({ ...empty, activity_level: 'moderate' }, 'did a workout')).toBeNull();
  });
  it('progress talk → goal_weight then current_weight', () => {
    expect(contextualGatherSlot(empty, "how am I doing on my weight?")).toBe('goal_weight');
    expect(contextualGatherSlot({ ...empty, goal_weight: 160 }, 'am I making progress?')).toBe('current_weight');
  });
  it('food talk → dislikes then dietary', () => {
    expect(contextualGatherSlot(empty, "I'm thinking about what to cook tonight")).toBe('dislikes');
    expect(contextualGatherSlot({ ...empty, food_dislikes: ['eggs'] }, 'planning my meals')).toBe('dietary');
  });
  it('sleep talk → wake_sleep when unknown', () => {
    expect(contextualGatherSlot(empty, "I've been sleeping so badly")).toBe('wake_sleep');
    expect(contextualGatherSlot({ ...empty, wake_time: '07:00' }, 'barely slept')).toBeNull();
  });
  it('NEVER gathers on a symptom / heavy turn (out-of-nowhere guard)', () => {
    expect(contextualGatherSlot(weekly, "my shot made me so nauseous")).toBeNull();
    expect(contextualGatherSlot(empty, "I feel so anxious and overwhelmed today")).toBeNull();
    expect(contextualGatherSlot(empty, "I'm really struggling with this")).toBeNull();
  });
  it('returns null on an unrelated / empty message', () => {
    expect(contextualGatherSlot(empty, 'good morning!')).toBeNull();
    expect(contextualGatherSlot(empty, '')).toBeNull();
  });
});

describe('buildProfileGatherNote', () => {
  it('instructs ONE warm question at the end, with the reason, never stacked', () => {
    const note = buildProfileGatherNote('current_weight');
    expect(note).toMatch(/PROFILE GATHERING/);
    expect(note).toMatch(/ONE/);
    expect(note.toLowerCase()).toMatch(/weight/);
    expect(note).toMatch(/never stack/i);
  });
});

describe('parseProfileReply — defensive (short, direct answers only)', () => {
  it('parses a short direct answer', () => {
    expect(parseProfileReply('sex', 'male').fields).toEqual({ sex: 'male' });
    expect(parseProfileReply('current_weight', '180 kg').fields).toEqual({ current_weight: 397 }); // 180 kg → 397 lb
    expect(parseProfileReply('current_weight', '150kg').fields).toEqual({ current_weight: 331 }); // prod: was stored as 150
    expect(parseProfileReply('current_weight', '180').fields).toEqual({ current_weight: 180 }); // bare number stays lb (back-compat)
    expect(parseProfileReply('height', "6'2").fields).toEqual({ height_cm: 188 });
  });
  it('REJECTS a long sentence that merely contains a number (no misparse)', () => {
    // pending=current_weight, but the user moved on and logged food
    expect(parseProfileReply('current_weight', 'I just had 90g of grilled chicken and some rice').fields).toBeNull();
  });
  it('returns null when the short reply still is not a valid value', () => {
    expect(parseProfileReply('sex', 'idk').fields).toBeNull();
  });
  it('allows a slightly longer diet answer', () => {
    expect(parseProfileReply('dietary', 'vegetarian, no nuts please').fields?.dietary_restriction).toContain('vegetarian');
  });
});

// ── Redis-backed pending store (stubbed) ─────────────────────────────────────

function makeRedis(): RedisLike & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    get: async (k) => store.get(k) ?? null,
    set: async (k, v) => { store.set(k, v); return 'OK'; },
    del: async (k) => { store.delete(k); return 1; },
  };
}

describe('pending-ask Redis store', () => {
  it('set → get → clear round-trips, and throttles by last-ask time', async () => {
    const r = makeRedis();
    const phone = '+15551112222';
    const now = 1_000_000_000_000;
    await setPendingProfileAsk(r, phone, 'sex', now);
    expect(await getPendingProfileAsk(r, phone)).toBe('sex');
    expect(await askedProfileRecently(r, phone, 20, now + 60_000)).toBe(true);          // 1 min later
    expect(await askedProfileRecently(r, phone, 20, now + 21 * 3600 * 1000)).toBe(false); // 21h later
    await clearPendingProfileAsk(r, phone);
    expect(await getPendingProfileAsk(r, phone)).toBeNull();
  });

  it('no-ops safely when Redis is absent', async () => {
    await setPendingProfileAsk(undefined, '+1', 'sex', 0);
    expect(await getPendingProfileAsk(undefined, '+1')).toBeNull();
    expect(await askedProfileRecently(undefined, '+1', 20, 0)).toBe(false);
  });

  it('ignores a corrupt pending value', async () => {
    const r = makeRedis();
    r.store.set('profile:ask:+1', 'not_a_slot');
    expect(await getPendingProfileAsk(r, '+1')).toBeNull();
  });
});

describe('replay-query store + buildGatherClarify', () => {
  it('round-trips the stashed original question and clears it', async () => {
    const r = makeRedis();
    const phone = '+15551112222';
    await setReplayQuery(r, phone, 'what should I eat today?');
    expect(await getReplayQuery(r, phone)).toBe('what should I eat today?');
    await clearReplayQuery(r, phone);
    expect(await getReplayQuery(r, phone)).toBeNull();
  });
  it('no-ops safely when Redis is absent', async () => {
    await setReplayQuery(undefined, '+1', 'q');
    expect(await getReplayQuery(undefined, '+1')).toBeNull();
  });
  it('has a warm, SMS-short clarify question for every progressive slot', () => {
    for (const slot of PROGRESSIVE_SLOTS) {
      const q = buildGatherClarify(slot);
      expect(q.length).toBeGreaterThan(10);
      expect(q.length).toBeLessThan(220);
    }
  });
});

describe('per-slot asked marker + decline detection', () => {
  it('marks a slot asked, then reports it as recently asked (per slot)', async () => {
    const r = makeRedis();
    const phone = '+15551110000';
    expect(await wasSlotAskedRecently(r, phone, 'dietary')).toBe(false);
    await markSlotAsked(r, phone, 'dietary');
    expect(await wasSlotAskedRecently(r, phone, 'dietary')).toBe(true);
    expect(await wasSlotAskedRecently(r, phone, 'dislikes')).toBe(false); // independent per slot
  });
  it('no-ops safely without Redis', async () => {
    await markSlotAsked(undefined, '+1', 'dietary');
    expect(await wasSlotAskedRecently(undefined, '+1', 'dietary')).toBe(false);
  });
  it('detects decline / skip replies but not real answers', () => {
    for (const t of ['no', 'none', 'no preference', 'skip', 'idk', "i don't care", 'whatever', 'doesn’t matter'])
      expect(isGatherDecline(t)).toBe(true);
    for (const t of ['vegan', 'no nuts or shellfish', 'female', '180cm', 'chicken and rice'])
      expect(isGatherDecline(t)).toBe(false);
  });
  it('uses versioned keys so stale profile:ask state is ignored', () => {
    // a leftover legacy key must NOT be read by the new helpers
    const r = makeRedis();
    r.store.set('profile:ask:+1', 'dietary');
    // getPendingProfileAsk reads pgather:pending:* now, so the legacy key is invisible
    return getPendingProfileAsk(r, '+1').then((v) => expect(v).toBeNull());
  });
});

describe('PROGRESSIVE_SLOTS', () => {
  it('covers the food-rec + goals + accurate-target fields (priority order)', () => {
    expect([...PROGRESSIVE_SLOTS]).toEqual([
      'dietary', 'dislikes', 'goals', 'injection_day', 'goal_weight', 'current_weight',
      'sex', 'height', 'age', 'activity', 'wake_sleep',
    ]);
  });
});
