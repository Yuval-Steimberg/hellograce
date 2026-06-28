import { describe, it, expect } from 'vitest';
import {
  PROGRESSIVE_SLOTS,
  nextMissingProfileSlot,
  relevantProfileSlot,
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
  type RedisLike,
} from './progressive-profile.js';

// A user shape with everything missing by default.
const empty = {
  sex: null, current_weight: null, height_cm: null, age: null,
  activity_level: null, dietary_restriction: null, dietary_pattern: null, goal_weight: null,
  food_dislikes: [], goals: [], wake_time: null,
} as Parameters<typeof nextMissingProfileSlot>[0];

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
  it('a protein/calorie question pulls the first missing Mifflin input', () => {
    expect(relevantProfileSlot(empty, 'how much protein should I eat?')).toBe('sex');
    expect(relevantProfileSlot({ ...empty, sex: 'male' }, 'how many calories do I need?')).toBe('current_weight');
  });
  it('a food-idea question pulls dietary, then dislikes, then nothing', () => {
    expect(relevantProfileSlot(empty, 'what should I eat for dinner?')).toBe('dietary');
    // diet known but dislikes unknown → ask dislikes
    expect(relevantProfileSlot({ ...empty, dietary_pattern: 'vegan' }, 'any dinner ideas?')).toBe('dislikes');
    // both known → not relevant
    expect(relevantProfileSlot({ ...empty, dietary_pattern: 'vegan', food_dislikes: ['eggs'] }, 'any dinner ideas?')).toBeNull();
  });
  it('an unrelated message triggers nothing', () => {
    expect(relevantProfileSlot(empty, 'good morning!')).toBeNull();
  });
  it('returns null once the relevant inputs are all known', () => {
    const full = { ...empty, sex: 'male', current_weight: 180, height_cm: 180, age: 40, activity_level: 'light' };
    expect(relevantProfileSlot(full, 'how much protein should I eat?')).toBeNull();
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
    expect(parseProfileReply('current_weight', '180 kg').fields).toEqual({ current_weight: 180 });
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

describe('PROGRESSIVE_SLOTS', () => {
  it('covers the food-rec + goals + accurate-target fields (priority order)', () => {
    expect([...PROGRESSIVE_SLOTS]).toEqual([
      'dietary', 'dislikes', 'goals', 'goal_weight', 'current_weight',
      'sex', 'height', 'age', 'activity', 'wake_sleep',
    ]);
  });
});
