import { describe, it, expect, vi } from 'vitest';
import {
  signupSequence,
  nextSignupSlot,
  nextGapfillSlot,
  parseSlotAnswer,
  runOnboardingTurn,
  generateOpener,
  buildOnboardingNudge,
  buildSignupCompleteReply,
  extractAllFields,
  parseDislikes,
  understandSlotWithLlm,
} from './onboarding-flow.js';

describe('buildSignupCompleteReply — Tomo-style trial offer at completion', () => {
  it('with a checkout link: names the free trial + drops the link', () => {
    const r = buildSignupCompleteReply('Sam', 'https://x/upgrade?phone=1');
    expect(r).toMatch(/Sam/);
    expect(r.toLowerCase()).toMatch(/3-day free trial|free trial/);
    expect(r).toContain('https://x/upgrade?phone=1');
    expect(r.toLowerCase()).toMatch(/remind you before/); // reminder promise
  });
  it('without a link: plain confirmation, no payment ask', () => {
    const r = buildSignupCompleteReply('Sam');
    expect(r).toMatch(/all set/i);
    expect(r).not.toMatch(/trial|upgrade|http/i);
  });
});

const logger = { info: vi.fn(), warn: vi.fn() } as any;

describe('generateOpener — magnetic first message', () => {
  it('without an LLM, returns a warm intro that introduces Grace AND asks the name', async () => {
    const opener = await generateOpener(undefined, { logger });
    expect(opener).toMatch(/grace/i);
    expect(opener).toContain('?'); // it asks something (the name)
    expect(opener.toLowerCase()).toMatch(/name|call you/);
    expect(opener).not.toMatch(/\d[\d,]*\s*(people|users|members)/i); // no fabricated stats
  });

  it('uses the LLM opener when it ends with a question', async () => {
    const llm = { generate: vi.fn(async () => ({ text: "Hi, I'm Grace — your GLP-1 corner. What should I call you?" })) } as any;
    const opener = await generateOpener(llm, { logger });
    expect(opener).toMatch(/what should I call you/i);
  });

  it('falls back when the LLM reply is not a question', async () => {
    const llm = { generate: vi.fn(async () => ({ text: 'I am Grace and I help people.' })) } as any;
    const opener = await generateOpener(llm, { logger });
    expect(opener).toContain('?');
  });
});

describe('buildOnboardingNudge — abandoned-signup re-engagement', () => {
  it('re-asks the pending slot warmly, no guilt', async () => {
    const nudge = await buildOnboardingNudge(
      { first_name: 'Sam', onboarding_last_slot: 'medication' } as any,
      undefined,
      { logger },
    );
    expect(nudge).toBeTruthy();
    expect(nudge!).toMatch(/Sam/);
    expect(nudge!.toLowerCase()).toMatch(/no rush|whenever/);
    expect(nudge!.toLowerCase()).toMatch(/glp-1|medication|ozempic|wegovy/); // re-asks the med slot
  });

  it('returns null when there is no pending slot', async () => {
    const nudge = await buildOnboardingNudge({ first_name: 'Sam', onboarding_last_slot: null } as any, undefined, { logger });
    expect(nudge).toBeNull();
  });
});

function makeWriter() {
  const calls: Array<Partial<Record<string, unknown>>> = [];
  const users = { update: vi.fn(async (_phone: string, fields: any) => { calls.push(fields); }) };
  return { users, calls };
}

function user(partial: Record<string, unknown> = {}): any {
  return {
    phone: '+15551230000',
    first_name: null,
    medication: null,
    medication_frequency: 'weekly',
    injection_day: null,
    medication_time: null,
    goals: [],
    sms_consent: false,
    goal_weight: null,
    current_weight: null,
    trial_start: null,
    onboarding_state: null,
    onboarding_last_slot: null,
    ...partial,
  };
}

describe('slot sequencing', () => {
  it('weekly users get an injection_day slot; daily users get medication_time', () => {
    expect(signupSequence({ medication_frequency: 'weekly' })).toContain('injection_day');
    expect(signupSequence({ medication_frequency: 'daily' })).toContain('medication_time');
    expect(signupSequence({ medication_frequency: 'daily' })).not.toContain('injection_day');
  });

  it('nextSignupSlot walks the sequence and ends at null', () => {
    const w = { medication_frequency: 'weekly' as const };
    expect(nextSignupSlot(w, null)).toBe('first_name');
    expect(nextSignupSlot(w, 'first_name')).toBe('medication');
    expect(nextSignupSlot(w, 'medication')).toBe('medication_frequency');
    expect(nextSignupSlot(w, 'medication_frequency')).toBe('injection_day');
    expect(nextSignupSlot(w, 'injection_day')).toBe('timezone');
    expect(nextSignupSlot(w, 'timezone')).toBe('consent');
    expect(nextSignupSlot(w, 'consent')).toBeNull();
  });

  it('the core is FAST — only the essentials; everything else is along-the-way', () => {
    const seq = signupSequence({ medication_frequency: 'weekly' });
    expect(seq).toEqual(['first_name', 'medication', 'medication_frequency', 'injection_day', 'timezone', 'consent']);
    // moved out of the upfront flow → gathered progressively after onboarding
    for (const s of ['goals', 'goal_weight', 'dietary', 'dislikes', 'wake_sleep']) {
      expect(seq).not.toContain(s);
    }
  });

  it('the signup sequence collects timezone (so reminders use local time)', () => {
    expect(signupSequence({ medication_frequency: 'weekly' })).toContain('timezone');
  });

  it('an unknown/stale last slot restarts safely at the first slot', () => {
    expect(nextSignupSlot({ medication_frequency: 'weekly' }, 'bogus')).toBe('first_name');
  });

  it('nextGapfillSlot prioritizes goal then current weight, then done', () => {
    expect(nextGapfillSlot({ goal_weight: null, current_weight: null })).toBe('goal_weight');
    expect(nextGapfillSlot({ goal_weight: 160, current_weight: null })).toBe('current_weight');
    expect(nextGapfillSlot({ goal_weight: 160, current_weight: 185 })).toBeNull();
  });
});

describe('parseSlotAnswer', () => {
  it('parses a name out of conversational phrasing', () => {
    expect(parseSlotAnswer('first_name', "hey it's Sarah")).toEqual({ ok: true, fields: { first_name: 'Sarah' } });
  });
  it('parses medication / frequency / day / time', () => {
    expect(parseSlotAnswer('medication', 'mounjaro')).toEqual({ ok: true, fields: { medication: 'Mounjaro' } });
    expect(parseSlotAnswer('medication_frequency', 'just once a week')).toEqual({ ok: true, fields: { medication_frequency: 'weekly' } });
    expect(parseSlotAnswer('injection_day', 'fridays')).toEqual({ ok: true, fields: { injection_day: 'Friday' } });
    expect(parseSlotAnswer('medication_time', '8am')).toEqual({ ok: true, fields: { medication_time: '08:00' } });
  });
  it('parses a timezone from a city/region (→ IANA)', () => {
    expect(parseSlotAnswer('timezone', "I'm in Israel")).toEqual({ ok: true, fields: { timezone: 'Asia/Jerusalem' } });
    expect(parseSlotAnswer('timezone', 'New York')).toEqual({ ok: true, fields: { timezone: 'America/New_York' } });
    expect(parseSlotAnswer('timezone', 'gibberish').ok).toBe(false);
    // skippable — a hard answer never traps onboarding
    expect(parseSlotAnswer('timezone', 'skip')).toEqual({ ok: true, skipped: true });
  });
  it('parses goals into a list', () => {
    const r = parseSlotAnswer('goals', 'protein and staying hydrated');
    expect(r.ok).toBe(true);
    expect(r.fields?.goals).toEqual(['protein', 'staying hydrated']);
  });
  it('parses consent yes/no', () => {
    expect(parseSlotAnswer('consent', 'yes please')).toEqual({ ok: true, fields: { sms_consent: true } });
    expect(parseSlotAnswer('consent', 'no thanks')).toEqual({ ok: true, fields: { sms_consent: false } });
    expect(parseSlotAnswer('consent', 'what do you mean').ok).toBe(false);
  });
  it('parses weights and rejects implausible values', () => {
    expect(parseSlotAnswer('goal_weight', 'around 160 lbs')).toEqual({ ok: true, fields: { goal_weight: 160 } });
    expect(parseSlotAnswer('current_weight', '5').ok).toBe(false);
  });
  it('allows skipping optional slots but not required ones', () => {
    expect(parseSlotAnswer('goal_weight', 'skip')).toEqual({ ok: true, skipped: true });
    expect(parseSlotAnswer('medication', 'skip').ok).toBe(false);
  });
  it('returns not-ok on unparseable required input', () => {
    expect(parseSlotAnswer('medication', 'idk lol').ok).toBe(false);
  });

  it('parses wake_sleep into wake + sleep times (24h)', () => {
    expect(parseSlotAnswer('wake_sleep', '7 am go to bed 10 pm go to sleep'))
      .toEqual({ ok: true, fields: { wake_time: '07:00', sleep_time: '22:00' } });
    expect(parseSlotAnswer('wake_sleep', 'up at 6:30, bed by 23:00'))
      .toEqual({ ok: true, fields: { wake_time: '06:30', sleep_time: '23:00' } });
    expect(parseSlotAnswer('wake_sleep', 'whenever really').ok).toBe(false);
    // it's skippable, so a genuine "no idea" never traps onboarding
    expect(parseSlotAnswer('wake_sleep', 'no idea')).toEqual({ ok: true, skipped: true });
  });

  it('parses biological sex', () => {
    expect(parseSlotAnswer('sex', 'male')).toEqual({ ok: true, fields: { sex: 'male' } });
    expect(parseSlotAnswer('sex', 'female')).toEqual({ ok: true, fields: { sex: 'female' } });
    expect(parseSlotAnswer('sex', 'non-binary')).toEqual({ ok: true, fields: { sex: 'other' } });
    expect(parseSlotAnswer('sex', 'banana').ok).toBe(false);
  });

  it('parses height from cm and feet/inches', () => {
    expect(parseSlotAnswer('height', '190cm')).toEqual({ ok: true, fields: { height_cm: 190 } });
    expect(parseSlotAnswer('height', '190')).toEqual({ ok: true, fields: { height_cm: 190 } });
    expect(parseSlotAnswer('height', "6'2")).toEqual({ ok: true, fields: { height_cm: 188 } });
    expect(parseSlotAnswer('height', '5 foot 11')).toEqual({ ok: true, fields: { height_cm: 180 } });
    expect(parseSlotAnswer('height', 'tall').ok).toBe(false);
  });

  it('parses age from a number or a date of birth', () => {
    expect(parseSlotAnswer('age', '33')).toEqual({ ok: true, fields: { age: 33 } });
    const r = parseSlotAnswer('age', '24/02/1993');
    expect(r.ok).toBe(true);
    expect(typeof r.fields?.age).toBe('number');
    expect(r.fields!.age!).toBeGreaterThan(25);
    expect(parseSlotAnswer('age', 'old').ok).toBe(false);
  });

  it('parses activity level into a bucket', () => {
    expect(parseSlotAnswer('activity', 'mostly at a desk').fields?.activity_level).toBe('sedentary');
    expect(parseSlotAnswer('activity', 'low').fields?.activity_level).toBe('sedentary');
    expect(parseSlotAnswer('activity', "i'm pretty active, i run").fields?.activity_level).toBe('moderate');
  });

  it('parses diet → restriction (+ enum) and clears on "none"', () => {
    const vegan = parseSlotAnswer('dietary', 'vegan');
    expect(vegan.fields?.dietary_pattern).toBe('vegan');
    expect(vegan.fields?.dietary_restriction).toBe('vegan');
    expect(parseSlotAnswer('dietary', 'no')).toEqual({ ok: true, fields: { dietary_restriction: null } });
    expect(parseSlotAnswer('dietary', 'allergic to peanuts').fields?.dietary_restriction).toContain('peanut');
  });
});

describe('runOnboardingTurn (signup)', () => {
  it('first turn greets and asks the first slot, marking in_progress', async () => {
    const { users, calls } = makeWriter();
    const res = await runOnboardingTurn({ user: user(), text: 'hi', mode: 'signup', users, logger });
    expect(res.completed).toBe(false);
    expect(res.reply).toMatch(/\w/);
    expect(calls[0]).toMatchObject({ onboarding_state: 'in_progress', onboarding_last_slot: 'first_name' });
  });

  it('persists a valid answer and advances to the next slot', async () => {
    const { users, calls } = makeWriter();
    const u = user({ onboarding_state: 'in_progress', onboarding_last_slot: 'medication' });
    const res = await runOnboardingTurn({ user: u, text: 'Mounjaro', mode: 'signup', users, logger });
    expect(res.completed).toBe(false);
    expect(calls).toContainEqual({ medication: 'Mounjaro' });
    // medication_frequency is already 'weekly' on this user → skip-answered jumps
    // past it to the next unfilled slot (injection_day).
    expect(calls).toContainEqual({ onboarding_last_slot: 'injection_day' });
  });

  it('re-asks the same slot on an unclear answer without persisting it', async () => {
    const { users, calls } = makeWriter();
    const u = user({ onboarding_state: 'in_progress', onboarding_last_slot: 'medication' });
    const res = await runOnboardingTurn({ user: u, text: 'huh??', mode: 'signup', users, logger });
    expect(res.completed).toBe(false);
    expect(calls.some((c) => 'medication' in c)).toBe(false);
    expect(calls.some((c) => 'onboarding_last_slot' in c)).toBe(false);
  });

  it('auto-detects timezone from the phone and SKIPS asking (Israel number)', async () => {
    const { users, calls } = makeWriter();
    // Weekly user on an Israel number answers their injection day; the next slot
    // would be timezone, but +972 resolves to Asia/Jerusalem → skipped.
    const u = user({ phone: '+972547722420', onboarding_state: 'in_progress', onboarding_last_slot: 'injection_day' });
    const res = await runOnboardingTurn({ user: u, text: 'Sunday', mode: 'signup', users, logger });
    expect(res.completed).toBe(false);
    expect(calls).toContainEqual({ timezone: 'Asia/Jerusalem' }); // persisted automatically
    expect(res.reply.toLowerCase()).not.toMatch(/timezone|what timezone/); // not asked
    expect(calls).toContainEqual({ onboarding_last_slot: 'consent' });      // advanced past timezone → consent (fast core)
  });

  it('asks for timezone when the phone is ambiguous (unknown area code)', async () => {
    const { users } = makeWriter();
    const u = user({ phone: '+15555550000', onboarding_state: 'in_progress', onboarding_last_slot: 'injection_day' });
    const res = await runOnboardingTurn({ user: u, text: 'Sunday', mode: 'signup', users, logger });
    expect(res.reply.toLowerCase()).toMatch(/timezone|city or region|where are you/);
  });

  it('completes after the last slot and starts the trial', async () => {
    const { users, calls } = makeWriter();
    const now = new Date('2026-06-28T12:00:00Z');
    const u = user({ medication_frequency: 'daily', onboarding_state: 'in_progress', onboarding_last_slot: 'consent' });
    const res = await runOnboardingTurn({ user: u, text: 'yes', mode: 'signup', users, llm: undefined, logger, now });
    expect(res.completed).toBe(true);
    const finish = calls.find((c) => c.onboarding_state === 'complete');
    expect(finish).toMatchObject({ onboarding_state: 'complete', trial_start: now });
  });

  it('does not overwrite an existing trial_start on completion', async () => {
    const { users, calls } = makeWriter();
    const existing = new Date('2026-06-01T00:00:00Z');
    const u = user({ medication_frequency: 'daily', trial_start: existing, onboarding_state: 'in_progress', onboarding_last_slot: 'consent' });
    await runOnboardingTurn({ user: u, text: 'sure', mode: 'signup', users, logger });
    const finish = calls.find((c) => c.onboarding_state === 'complete');
    expect(finish).not.toHaveProperty('trial_start');
  });
});

describe('runOnboardingTurn (gapfill)', () => {
  it('first turn asks the first missing optional slot', async () => {
    const { users, calls } = makeWriter();
    const res = await runOnboardingTurn({ user: user(), text: 'hey', mode: 'gapfill', users, logger });
    expect(res.completed).toBe(false);
    expect(calls[0]).toMatchObject({ onboarding_state: 'in_progress', onboarding_last_slot: 'goal_weight' });
  });

  it('completes (no trial change) once gaps are filled', async () => {
    const { users, calls } = makeWriter();
    const u = user({ goal_weight: 160, onboarding_state: 'in_progress', onboarding_last_slot: 'current_weight' });
    const res = await runOnboardingTurn({ user: u, text: '185', mode: 'gapfill', users, logger });
    expect(res.completed).toBe(true);
    expect(calls).toContainEqual({ current_weight: 185 });
    const finish = calls.find((c) => c.onboarding_state === 'complete');
    expect(finish).not.toHaveProperty('trial_start');
  });

  it('stays silent and completes when there is nothing to gap-fill', async () => {
    const { users, calls } = makeWriter();
    const u = user({ goal_weight: 160, current_weight: 185 });
    const res = await runOnboardingTurn({ user: u, text: 'hi', mode: 'gapfill', users, logger });
    expect(res).toEqual({ reply: '', completed: true });
    expect(calls[0]).toMatchObject({ onboarding_state: 'complete' });
  });
});

describe('extractAllFields — multi-field, keyword-anchored, validated', () => {
  it('pulls medication + frequency + goal weight from one messy sentence', () => {
    const f = extractAllFields("I'm on ozempic once a week and I want to get to 120kg");
    expect(f.medication).toBe('Ozempic');
    expect(f.medication_frequency).toBe('weekly');
    expect(f.goal_weight).toBe(120);
  });
  it('does NOT treat a bare number as a goal weight', () => {
    expect(extractAllFields('120').goal_weight).toBeUndefined();
    expect(extractAllFields('I had 120g of chicken').goal_weight).toBeUndefined();
  });
  it('extracts a diet only with an explicit diet keyword', () => {
    expect(extractAllFields("I'm vegan").dietary_pattern).toBe('vegan');
    expect(extractAllFields('I want to eat better').dietary_restriction).toBeUndefined();
  });
  it('returns empty for a plain answer with no profile facts', () => {
    expect(extractAllFields('Sunday')).toEqual({});
  });
});

describe('parseDislikes', () => {
  it('parses a hate/avoid list into clean items', () => {
    expect(parseDislikes('I hate chicken and eggs')).toEqual(['chicken', 'eggs']);
    expect(parseDislikes('eggs, tuna')).toEqual(['eggs', 'tuna']);
    expect(parseDislikes("I don't like mushrooms or olives")).toEqual(['mushrooms', 'olives']);
  });
  it('"none" → empty list (nothing to avoid)', () => {
    expect(parseDislikes('none')).toEqual([]);
    expect(parseDislikes('I eat everything')).toEqual([]);
  });
});

describe('onboarding saves the answer (no Settings redirect during onboarding)', () => {
  it('saves goal weight from "My goal is 120 kg" and advances — the production bug', async () => {
    const { users, calls } = makeWriter();
    const u = user({ onboarding_state: 'in_progress', onboarding_last_slot: 'goal_weight' });
    const res = await runOnboardingTurn({ user: u, text: 'My goal is 120 kg', mode: 'signup', users, logger });
    expect(res.completed).toBe(false);
    expect(calls).toContainEqual({ goal_weight: 120 });
    expect(res.reply.toLowerCase()).not.toMatch(/settings|can only be updated/);
  });
  it('saves dietary preference from "I\'m vegan" and advances', async () => {
    const { users, calls } = makeWriter();
    const u = user({ onboarding_state: 'in_progress', onboarding_last_slot: 'dietary' });
    await runOnboardingTurn({ user: u, text: "I'm vegan", mode: 'signup', users, logger });
    expect(calls.some((c) => (c as Record<string, unknown>).dietary_pattern === 'vegan')).toBe(true);
  });
  it('saves disliked foods from "I hate chicken and eggs"', async () => {
    const { users, calls } = makeWriter();
    const u = user({ onboarding_state: 'in_progress', onboarding_last_slot: 'dislikes' });
    await runOnboardingTurn({ user: u, text: 'I hate chicken and eggs', mode: 'signup', users, logger });
    expect(calls.some((c) => Array.isArray((c as Record<string, unknown>).food_dislikes))).toBe(true);
  });
});

describe('understandSlotWithLlm — typo / slang / abbreviation tolerance', () => {
  const stub = (reply: string) => ({ generate: vi.fn(async () => ({ text: reply })) } as any);

  it('recovers a typo medication via the LLM, re-validated through the parser', async () => {
    const r = await understandSlotWithLlm('medication', 'im on ozemic', stub('Ozempic'), { logger });
    expect(r).toEqual({ ok: true, fields: { medication: 'Ozempic' } });
  });
  it('recovers an abbreviated frequency ("1x a wk" → weekly)', async () => {
    const r = await understandSlotWithLlm('medication_frequency', '1x a wk', stub('weekly'), { logger });
    expect(r).toEqual({ ok: true, fields: { medication_frequency: 'weekly' } });
  });
  it('rejects a hallucinated value the deterministic parser would not accept', async () => {
    // LLM returns junk for a medication → parseSlotAnswer('medication', 'banana') fails → null
    expect(await understandSlotWithLlm('medication', '???', stub('banana'), { logger })).toBeNull();
  });
  it('returns null on "NONE" (user does not know / unrelated) and with no LLM', async () => {
    expect(await understandSlotWithLlm('medication', 'no clue', stub('NONE'), { logger })).toBeNull();
    expect(await understandSlotWithLlm('medication', 'ozemic', undefined, { logger })).toBeNull();
  });

  it('runOnboardingTurn falls back to the LLM when the parser misses a typo answer', async () => {
    const { users, calls } = makeWriter();
    const llm = { generate: vi.fn(async () => ({ text: 'Mounjaro' })) } as any;
    const u = user({ onboarding_state: 'in_progress', onboarding_last_slot: 'medication' });
    // "munjaroo" isn't a known brand to the strict regex → LLM normalizes it.
    const res = await runOnboardingTurn({ user: u, text: 'munjaroo', mode: 'signup', users, llm, logger });
    expect(res.completed).toBe(false);
    expect(calls).toContainEqual({ medication: 'Mounjaro' });
  });
});
