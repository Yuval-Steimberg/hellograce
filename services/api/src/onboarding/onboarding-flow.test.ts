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
  detectEmotionalDisclosure,
} from './onboarding-flow.js';

describe('buildSignupCompleteReply — warm, zero-pressure, no payment link', () => {
  it('never includes a payment link or trial ask, even if a url is passed', () => {
    const r = buildSignupCompleteReply('Sam', 'https://x/upgrade?phone=1');
    expect(r).toMatch(/Sam/);
    expect(r).not.toMatch(/http/i);        // no link at all
    expect(r).not.toMatch(/trial|upgrade|subscribe|pay/i); // no payment pressure
    expect(r.toLowerCase()).toMatch(/dashboard/); // still points to the app
  });
  it('invites the user to start texting Grace', () => {
    const r = buildSignupCompleteReply('Sam');
    expect(r).toMatch(/all set/i);
    expect(r).not.toMatch(/trial|upgrade|http/i);
  });
  it('invites the FIRST food log (activation), not just "text me anytime"', () => {
    const r = buildSignupCompleteReply('Sam');
    expect(r.toLowerCase()).toMatch(/ate|eat|meal|protein/); // a concrete first action
    expect(r.length).toBeLessThan(420); // stays under the outbound cap
  });
});

describe('detectEmotionalDisclosure', () => {
  it('flags painful lack-of-progress and distress', () => {
    expect(detectEmotionalDisclosure('Zepbound 7.5mg 9 months, lost zero and actually gained')).toBe(true);
    expect(detectEmotionalDisclosure("I'm so frustrated, this isn't working")).toBe(true);
    expect(detectEmotionalDisclosure('honestly I feel like a failure')).toBe(true);
    expect(detectEmotionalDisclosure("I've been stuck at a plateau for months")).toBe(true);
  });
  it('does NOT fire on neutral slot answers or good news', () => {
    expect(detectEmotionalDisclosure('Mounjaro')).toBe(false);
    expect(detectEmotionalDisclosure('Tuesday')).toBe(false);
    expect(detectEmotionalDisclosure('I lost 20 lbs and feel great')).toBe(false);
    expect(detectEmotionalDisclosure('Sarah')).toBe(false);
  });
});

describe('runOnboardingTurn — acknowledges an emotional disclosure before moving on', () => {
  it('prepends a warm ack, still stores the answer and asks the next slot', async () => {
    const { users, calls } = makeWriter();
    const u = user({ onboarding_state: 'in_progress', onboarding_last_slot: 'medication' });
    const res = await runOnboardingTurn({
      user: u,
      text: 'Zepbound but honestly 9 months and I lost zero and actually gained',
      mode: 'signup',
      users,
      logger,
    });
    // Acknowledged (fallback ack, no LLM) AND advanced (medication stored).
    expect(res.reply.toLowerCase()).toMatch(/thank you|not on your own|matters/);
    expect(calls.some((c) => 'medication' in c)).toBe(true);
    expect(calls).toContainEqual({ onboarding_last_slot: 'injection_day' });
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
    expect(opener.length).toBeLessThanOrEqual(160); // short — long intros cause ask_name drop-off
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

describe('runOnboardingTurn — personalizes nutrition targets when weight is learned', () => {
  it('writes a personalized protein target after the current-weight gapfill', async () => {
    const { users, calls } = makeWriter();
    await runOnboardingTurn({
      user: user({
        trial_start: new Date(),
        onboarding_state: 'in_progress',
        onboarding_last_slot: 'current_weight',
        goal_weight: 160,
        current_weight: null,
        primary_goal: 'fat_loss',
        protein_goal_grams: null,
        calorie_goal_kcal: null,
      }),
      text: '200 lbs',
      mode: 'gapfill',
      users,
      logger,
    });
    const targetWrite = calls.find((c) => 'protein_goal_grams' in c);
    expect(targetWrite).toBeTruthy();
    expect(targetWrite!.protein_goal_grams as number).toBeGreaterThan(150);
  });

  it('does not overwrite a protein target the user already has', async () => {
    const { users, calls } = makeWriter();
    await runOnboardingTurn({
      user: user({
        trial_start: new Date(),
        onboarding_state: 'in_progress',
        onboarding_last_slot: 'current_weight',
        current_weight: null,
        primary_goal: 'fat_loss',
        protein_goal_grams: 115,
      }),
      text: '200 lbs',
      mode: 'gapfill',
      users,
      logger,
    });
    expect(calls.find((c) => 'protein_goal_grams' in c)).toBeUndefined();
  });
});

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
    expect(nextSignupSlot(w, 'timezone')).toBe('wake_sleep');
    expect(nextSignupSlot(w, 'wake_sleep')).toBe('dietary');
    expect(nextSignupSlot(w, 'dietary')).toBe('consent');
    expect(nextSignupSlot(w, 'consent')).toBeNull();
  });

  it('the core collects the must-haves incl. wake/sleep + diet; defers the rest', () => {
    const seq = signupSequence({ medication_frequency: 'weekly' });
    expect(seq).toEqual(['first_name', 'medication', 'medication_frequency', 'injection_day', 'timezone', 'wake_sleep', 'dietary', 'consent']);
    // reminders need wake/sleep; food needs diet — both collected upfront now
    expect(seq).toContain('wake_sleep');
    expect(seq).toContain('dietary');
    // still deferred to progressive gathering
    for (const s of ['goals', 'goal_weight', 'dislikes', 'current_weight', 'height', 'age']) {
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
    expect(parseSlotAnswer('medication', 'mounjaro')).toEqual({ ok: true, fields: { medication: 'Mounjaro', medication_frequency: 'weekly' } });
    expect(parseSlotAnswer('medication_frequency', 'just once a week')).toEqual({ ok: true, fields: { medication_frequency: 'weekly' } });
    expect(parseSlotAnswer('injection_day', 'fridays')).toEqual({ ok: true, fields: { injection_day: 'Friday' } });
    expect(parseSlotAnswer('medication_time', '8am')).toEqual({ ok: true, fields: { medication_time: '08:00' } });
  });
  it('infers dosing cadence from the drug name (2026-07-02)', () => {
    // Daily meds → set medication_frequency=daily so the flow asks for the TIME.
    expect(parseSlotAnswer('medication', 'Rybelsus').fields).toMatchObject({ medication: 'Rybelsus', medication_frequency: 'daily' });
    expect(parseSlotAnswer('medication', 'I take Saxenda').fields).toMatchObject({ medication_frequency: 'daily' });
    // Weekly injectables → medication_frequency=weekly so the flow asks the DAY.
    expect(parseSlotAnswer('medication', 'Ozempic').fields).toMatchObject({ medication: 'Ozempic', medication_frequency: 'weekly' });
    expect(parseSlotAnswer('medication', 'mounjaro').fields).toMatchObject({ medication_frequency: 'weekly' });
    // Daily drug → schedule slot becomes medication_time (not injection_day).
    expect(signupSequence({ medication_frequency: 'daily' })).toContain('medication_time');
  });
  it('finds the weekday inside a phrase, incl. abbreviations (2026-07-02)', () => {
    expect(parseSlotAnswer('injection_day', 'on wed').fields?.injection_day).toBe('Wednesday');
    expect(parseSlotAnswer('injection_day', 'usually a Monday').fields?.injection_day).toBe('Monday');
    expect(parseSlotAnswer('injection_day', 'I take it thurs').fields?.injection_day).toBe('Thursday');
  });
  it('stores a CLEAN diet value from conversational phrasing (2026-07-02)', () => {
    expect(parseSlotAnswer('dietary', "I'm pescatarian").fields).toMatchObject({ dietary_pattern: 'pescatarian', dietary_restriction: 'pescatarian' });
    expect(parseSlotAnswer('dietary', 'I follow a keto diet').fields?.dietary_restriction).toBe('keto diet');
    expect(parseSlotAnswer('dietary', "I'm vegan").fields).toMatchObject({ dietary_pattern: 'vegan', dietary_restriction: 'vegan' });
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
    // bare "no" → skipped (whole-message decline; the gate then fills a "none" sentinel)
    expect(parseSlotAnswer('dietary', 'no')).toEqual({ ok: true, skipped: true });
    // "I eat everything" / "no restrictions" / "anything" → explicit 'none' = FILLED,
    // so the dietary slot is never re-asked (prod: these left it empty → endless asks)
    expect(parseSlotAnswer('dietary', 'I eat everything').fields).toEqual({ dietary_restriction: 'none' });
    expect(parseSlotAnswer('dietary', 'no restrictions').fields).toEqual({ dietary_restriction: 'none' });
    expect(parseSlotAnswer('dietary', 'anything').fields).toEqual({ dietary_restriction: 'none' });
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
    // Medication parse now also infers the cadence from the drug (Mounjaro → weekly).
    expect(calls).toContainEqual({ medication: 'Mounjaro', medication_frequency: 'weekly' });
    // weekly → the schedule slot is injection_day.
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
    expect(calls).toContainEqual({ onboarding_last_slot: 'wake_sleep' });   // advanced past timezone → wake/sleep
    expect(res.reply.toLowerCase()).toMatch(/wake|bed/);                    // asks wake/bed time
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
  it('a QUESTION is NOT captured as a dislike (prod replay bug)', () => {
    // user asks something else instead of answering → must NOT be stored as food
    expect(parseDislikes('When is my next reminder?')).toBeNull();
    expect(parseDislikes('what should I eat today?')).toBeNull();
    expect(parseDislikes('how much protein do I need')).toBeNull();
  });
});

describe('parseDiet guards (greedy-capture fix)', () => {
  it('captures real diets + avoidance, but NOT arbitrary text / questions', () => {
    expect(parseSlotAnswer('dietary', 'vegan').fields?.dietary_pattern).toBe('vegan');
    expect(parseSlotAnswer('dietary', 'no shellfish').fields?.dietary_restriction).toMatch(/shellfish/i);
    expect(parseSlotAnswer('dietary', 'allergic to peanuts').fields?.dietary_restriction).toMatch(/peanut/i);
    // a different question must NOT be stored as the diet
    expect(parseSlotAnswer('dietary', 'When is my next reminder?')).toEqual({ ok: false });
    expect(parseSlotAnswer('dietary', 'Hi grace')).toEqual({ ok: false });
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
    expect(r).toEqual({ ok: true, fields: { medication: 'Ozempic', medication_frequency: 'weekly' } });
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
    expect(calls).toContainEqual({ medication: 'Mounjaro', medication_frequency: 'weekly' });
  });
});

describe('CRITICAL onboarding fixes — skip understanding, side-questions, welcome', () => {
  // Test 1-3: optional field skip is understood (no repeat loop).
  for (const ans of ['No goal weight', 'No goal', 'skip', 'none', 'no', "I don't have one", "I don't know yet", 'not sure']) {
    it(`"${ans}" skips an optional field (no loop)`, () => {
      const r = parseSlotAnswer('goal_weight', ans);
      expect(r).toEqual({ ok: true, skipped: true });
    });
  }
  it('a real value with "no" inside is NOT mistaken for a skip', () => {
    // (goal_weight only takes a number, but dietary shows the substring guard)
    expect(parseSlotAnswer('dietary', 'vegan, no nuts').skipped).toBeUndefined();
    expect(parseSlotAnswer('dietary', 'vegan, no nuts').fields?.dietary_restriction).toMatch(/vegan/i);
  });

  // Test 4 + #7: a side-question during onboarding gets a short Grace answer,
  // then re-poses the SAME question — never treated as the answer.
  it('answers "what can you do?" in Grace voice and re-asks the current slot', async () => {
    const { users, calls } = makeWriter();
    const u = user({ onboarding_state: 'in_progress', onboarding_last_slot: 'medication' });
    const res = await runOnboardingTurn({ user: u, text: 'what can you do?', mode: 'signup', users, logger });
    expect(res.completed).toBe(false);
    expect(res.reply).toMatch(/Grace/);
    expect(res.reply.toLowerCase()).toMatch(/which glp-1|medication|taking/); // re-asked the med question
    expect(res.reply.toLowerCase()).not.toMatch(/quantum|code|poems?/);
    // did NOT store the side-question as the medication value, did NOT advance
    expect(calls.some((c) => 'medication' in c)).toBe(false);
    expect(calls.some((c) => 'onboarding_last_slot' in c)).toBe(false);
  });

  it('"why do you need this?" → brief reason + re-ask, no advance', async () => {
    const { users, calls } = makeWriter();
    const u = user({ onboarding_state: 'in_progress', onboarding_last_slot: 'injection_day' });
    const res = await runOnboardingTurn({ user: u, text: 'why do you need this', mode: 'signup', users, logger });
    expect(res.reply.toLowerCase()).toMatch(/personalize|helps/);
    expect(res.reply.toLowerCase()).toMatch(/day|shot/); // re-asked injection day
    expect(calls.some((c) => 'onboarding_last_slot' in c)).toBe(false);
  });

  // Test 5 + #8: the final welcome invites the user with a concrete starter —
  // but does NOT re-introduce "I'm Grace" (she already said that in the opener;
  // repeating it at completion felt redundant in production).
  it('the signup-complete message is a strong, inviting welcome (no repeated self-intro)', () => {
    const r = buildSignupCompleteReply('Yuval', 'https://x/upgrade?phone=1');
    expect(r.toLowerCase()).toMatch(/all set/);
    expect(r.toLowerCase()).toMatch(/ate|eat|meal|protein/); // a concrete first-action starter (log a meal)
    expect(r.toLowerCase()).toMatch(/dashboard/); // explains the dashboard option
    expect(r).not.toMatch(/http/i); // no payment link at completion — trial isn't a sales ask
    expect(r).not.toMatch(/I'?m Grace/i); // no redundant re-introduction
  });
});
