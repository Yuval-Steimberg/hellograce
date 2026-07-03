import { describe, it, expect } from 'vitest';
import {
  mightStateProfileChange,
  parseProfileUpdates,
  buildProfileExtractPrompt,
  normalizeMedication,
  normalizeFrequency,
  normalizeDay,
  normalizeTime,
  normalizeDose,
  normalizeGoalWeight,
  isValidTimezone,
  type ProfileSnapshot,
} from './profile-extract.js';

const BLANK: ProfileSnapshot = {
  medication: null,
  medication_frequency: null,
  injection_day: null,
  medication_time: null,
  dose_mg: null,
  goal_weight: null,
  timezone: null,
  wake_time: null,
  sleep_time: null,
  food_dislikes: [],
};

const json = (o: Record<string, unknown>) => JSON.stringify(o);

describe('mightStateProfileChange (pre-filter)', () => {
  it('fires on durable self-statements', () => {
    expect(mightStateProfileChange('I switched from Ozempic to Mounjaro')).toBe(true);
    expect(mightStateProfileChange('my dose is 5mg now')).toBe(true);
    expect(mightStateProfileChange('I inject on Fridays now')).toBe(true);
    expect(mightStateProfileChange('my goal weight is 160')).toBe(true);
    expect(mightStateProfileChange("I really don't like mushrooms")).toBe(true);
  });

  it('fires on present/habitual injection-day statements (memory capture)', () => {
    expect(mightStateProfileChange('my shot day is Saturday')).toBe(true);
    expect(mightStateProfileChange('my injection is on Fridays')).toBe(true);
    expect(mightStateProfileChange('I get my shot on Sundays')).toBe(true);
    expect(mightStateProfileChange('I take my shot on Saturdays')).toBe(true);
  });

  it('does NOT fire on ordinary food/question/emotion turns', () => {
    expect(mightStateProfileChange('I had 3 eggs for breakfast')).toBe(false);
    expect(mightStateProfileChange('what should I eat for lunch?')).toBe(false);
    expect(mightStateProfileChange('feeling really nauseous today')).toBe(false);
    expect(mightStateProfileChange('thanks, that helps!')).toBe(false);
    // Not a durable statement — a timing QUESTION, or an unrelated "shot".
    expect(mightStateProfileChange('when is my next shot?')).toBe(false);
    expect(mightStateProfileChange('I had a shot of espresso on Saturday')).toBe(false);
  });

  it('ignores empty / oversized input', () => {
    expect(mightStateProfileChange('')).toBe(false);
    expect(mightStateProfileChange('switched mounjaro '.repeat(200))).toBe(false);
  });
});

describe('normalizers', () => {
  it('normalizeMedication canonicalizes known meds and rejects junk', () => {
    expect(normalizeMedication('mounjaro')).toBe('Mounjaro');
    expect(normalizeMedication('I take WEGOVY')).toBe('Wegovy');
    expect(normalizeMedication('compounded semaglutide')).toBe('Compounded Semaglutide');
    expect(normalizeMedication('5mg')).toBeNull(); // a dose, not a med
    expect(normalizeMedication('x'.repeat(200))).toBeNull();
    expect(normalizeMedication(42)).toBeNull();
  });

  it('normalizeFrequency maps phrasings', () => {
    expect(normalizeFrequency('once a week')).toBe('weekly');
    expect(normalizeFrequency('every other week')).toBe('biweekly');
    expect(normalizeFrequency('every day')).toBe('daily');
    expect(normalizeFrequency('sometimes')).toBeNull();
  });

  it('normalizeDay returns full capitalized weekday (scheduler format)', () => {
    expect(normalizeDay('fri')).toBe('Friday');
    expect(normalizeDay('Fridays')).toBe('Friday');
    expect(normalizeDay('SUNDAY')).toBe('Sunday');
    expect(normalizeDay('someday')).toBeNull();
  });

  it('normalizeTime parses to HH:MM 24h', () => {
    expect(normalizeTime('6am')).toBe('06:00');
    expect(normalizeTime('6:30 pm')).toBe('18:30');
    expect(normalizeTime('18:30')).toBe('18:30');
    expect(normalizeTime('12am')).toBe('00:00');
    expect(normalizeTime('12pm')).toBe('12:00');
    expect(normalizeTime('25:00')).toBeNull();
    expect(normalizeTime('banana')).toBeNull();
  });

  it('normalizeDose clamps to a sane GLP-1 range', () => {
    expect(normalizeDose(2.4)).toBe(2.4);
    expect(normalizeDose('5')).toBe(5);
    expect(normalizeDose(0)).toBeNull();
    expect(normalizeDose(9999)).toBeNull();
  });

  it('normalizeGoalWeight clamps to plausible lbs', () => {
    expect(normalizeGoalWeight(160)).toBe(160);
    expect(normalizeGoalWeight(5)).toBeNull();
    expect(normalizeGoalWeight(2000)).toBeNull();
  });

  it('isValidTimezone accepts IANA only', () => {
    expect(isValidTimezone('America/Los_Angeles')).toBe(true);
    expect(isValidTimezone('Mars/Phobos')).toBe(false);
    expect(isValidTimezone('EST')).toBe(false); // no slash → reject
  });
});

describe('parseProfileUpdates — positive cases', () => {
  it('learns a medication switch', () => {
    const out = parseProfileUpdates(json({ medication: 'Mounjaro' }), { ...BLANK, medication: 'Ozempic' });
    expect(out).toEqual({ medication: 'Mounjaro' });
  });

  it('learns a dose change', () => {
    const out = parseProfileUpdates(json({ dose_mg: 5 }), { ...BLANK, dose_mg: 2.5 });
    expect(out).toEqual({ dose_mg: 5 });
  });

  it('learns an injection day in scheduler format', () => {
    const out = parseProfileUpdates(json({ injection_day: 'fri' }), BLANK);
    expect(out).toEqual({ injection_day: 'Friday' });
  });

  it('learns a goal weight', () => {
    const out = parseProfileUpdates(json({ goal_weight: 160 }), { ...BLANK, goal_weight: 180 });
    expect(out).toEqual({ goal_weight: 160 });
  });

  it('learns wake time normalized to HH:MM', () => {
    const out = parseProfileUpdates(json({ wake_time: '6am' }), { ...BLANK, wake_time: '08:00' });
    expect(out).toEqual({ wake_time: '06:00' });
  });

  it('merges new food dislikes with existing (full list, deduped)', () => {
    const out = parseProfileUpdates(json({ food_dislikes: ['Mushrooms', 'eggs'] }), { ...BLANK, food_dislikes: ['eggs'] });
    expect(out.food_dislikes).toEqual(['eggs', 'mushrooms']);
  });
});

describe('parseProfileUpdates — no-op / invalid are dropped', () => {
  it('drops a value equal to current (case-insensitive)', () => {
    const out = parseProfileUpdates(json({ medication: 'ozempic' }), { ...BLANK, medication: 'Ozempic' });
    expect(out).toEqual({});
  });

  it('drops an out-of-range dose', () => {
    const out = parseProfileUpdates(json({ dose_mg: 9999 }), BLANK);
    expect(out).toEqual({});
  });

  it('drops an out-of-range goal weight', () => {
    const out = parseProfileUpdates(json({ goal_weight: 5 }), BLANK);
    expect(out).toEqual({});
  });

  it('drops an invalid timezone', () => {
    const out = parseProfileUpdates(json({ timezone: 'Narnia/West' }), BLANK);
    expect(out).toEqual({});
  });

  it('drops an unparseable day', () => {
    const out = parseProfileUpdates(json({ injection_day: 'whenever' }), BLANK);
    expect(out).toEqual({});
  });

  it('drops food dislikes that are all already known', () => {
    const out = parseProfileUpdates(json({ food_dislikes: ['eggs'] }), { ...BLANK, food_dislikes: ['eggs'] });
    expect(out.food_dislikes).toBeUndefined();
  });

  it('returns {} on malformed JSON', () => {
    expect(parseProfileUpdates('not json', BLANK)).toEqual({});
    expect(parseProfileUpdates('null', BLANK)).toEqual({});
  });

  it('ignores fields the model nulls out', () => {
    const out = parseProfileUpdates(
      json({ medication: null, dose_mg: null, goal_weight: 160, food_dislikes: null }),
      { ...BLANK, goal_weight: 200 },
    );
    expect(out).toEqual({ goal_weight: 160 });
  });
});

describe('buildProfileExtractPrompt', () => {
  it('embeds the current snapshot and the hard guardrails', () => {
    const p = buildProfileExtractPrompt({ ...BLANK, medication: 'Ozempic', goal_weight: 180 });
    expect(p).toContain('medication=Ozempic');
    expect(p).toContain('goal_weight=180');
    expect(p).toContain('NEVER from a QUESTION');
    expect(p).toContain('NEVER about another person');
  });
});
