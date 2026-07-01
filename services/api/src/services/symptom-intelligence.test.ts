import { describe, it, expect } from 'vitest';
import {
  classifySymptom,
  extractRemedy,
  detectRemedyOutcome,
  localDayOfWeek,
  daysSinceInjection,
  analyzeSymptomPattern,
  buildSymptomRecallNote,
  buildInjectionDaySymptomNote,
  type SymptomEpisode,
} from './symptom-intelligence.js';

describe('classifySymptom', () => {
  it('maps common GLP-1 side effects to canonical symptoms', () => {
    expect(classifySymptom('I feel so nauseous today')).toBe('nausea');
    expect(classifySymptom('been throwing up all morning')).toBe('vomiting');
    expect(classifySymptom("I'm so constipated, haven't gone in days")).toBe('constipation');
    expect(classifySymptom('bad diarrhea after my shot')).toBe('diarrhea');
    expect(classifySymptom('terrible heartburn tonight')).toBe('heartburn');
    expect(classifySymptom('so bloated and gassy')).toBe('bloating');
    expect(classifySymptom('my head is pounding')).toBe('headache');
    expect(classifySymptom('feeling really dizzy and lightheaded')).toBe('dizziness');
    expect(classifySymptom('I am so tired, no energy at all')).toBe('fatigue');
  });

  it('prefers the specific symptom (vomiting over nausea)', () => {
    expect(classifySymptom('nauseous and throwing up')).toBe('vomiting');
  });

  it('returns null for non-symptom messages', () => {
    expect(classifySymptom('what should I eat for dinner?')).toBeNull();
    expect(classifySymptom('I had chicken and rice')).toBeNull();
    expect(classifySymptom('')).toBeNull();
  });
});

describe('extractRemedy / detectRemedyOutcome', () => {
  it('extracts a named remedy from a positive outcome', () => {
    expect(extractRemedy('the ginger tea really helped')).toBe('ginger');
    expect(extractRemedy('peppermint tea settled it')).toBe('peppermint tea');
    expect(extractRemedy('crackers did the trick')).toBe('crackers');
    expect(extractRemedy('a short walk helped')).toBe('a walk');
  });

  it('detects a positive remedy outcome', () => {
    expect(detectRemedyOutcome('the ginger helped a lot')).toEqual({ remedy: 'ginger' });
    expect(detectRemedyOutcome('that worked, feel better')).toEqual({ remedy: null });
  });

  it('does NOT fire on a negation ("didn\'t help") or a non-outcome', () => {
    expect(detectRemedyOutcome("the ginger didn't help at all")).toBeNull();
    expect(detectRemedyOutcome('still no better')).toBeNull();
    expect(detectRemedyOutcome('I had eggs for breakfast')).toBeNull();
  });
});

describe('daysSinceInjection / localDayOfWeek', () => {
  it('computes days since the injection day', () => {
    // If injection is Monday(1) and today is Wednesday(3) → 2 days after.
    expect(daysSinceInjection('Monday', 3)).toBe(2);
    // Injection day itself → 0.
    expect(daysSinceInjection('Monday', 1)).toBe(0);
    // The day after wraps correctly across the week (Sat injection, Sun today).
    expect(daysSinceInjection('Saturday', 0)).toBe(1);
  });

  it('is null when no injection day is set or the day is unrecognized', () => {
    expect(daysSinceInjection(null, 3)).toBeNull();
    expect(daysSinceInjection('someday', 3)).toBeNull();
  });

  it('returns a 0-6 day index for a valid timezone', () => {
    const dow = localDayOfWeek('America/New_York');
    expect(dow).toBeGreaterThanOrEqual(0);
    expect(dow).toBeLessThanOrEqual(6);
  });
});

describe('analyzeSymptomPattern', () => {
  const ep = (symptom: string, days: number | null, remedy: string | null): SymptomEpisode => ({
    symptom,
    days_since_injection: days,
    dose_mg: 0.5,
    remedy_helped: remedy,
    created_at: new Date(),
  });

  it('returns null when there are no prior episodes of the symptom', () => {
    expect(analyzeSymptomPattern('nausea', [])).toBeNull();
    expect(analyzeSymptomPattern('nausea', [ep('fatigue', 1, null)])).toBeNull();
  });

  it('surfaces a clear timing pattern (majority day-since-injection)', () => {
    const prior = [ep('nausea', 1, 'ginger'), ep('nausea', 1, null), ep('nausea', 3, null)];
    const p = analyzeSymptomPattern('nausea', prior)!;
    expect(p.count).toBe(3);
    expect(p.typicalTiming).toBe('the day after your shot');
    expect(p.topRemedy).toBe('ginger');
  });

  it('does NOT over-claim a timing when there is no majority', () => {
    const prior = [ep('nausea', 0, null), ep('nausea', 2, null), ep('nausea', 4, null)];
    const p = analyzeSymptomPattern('nausea', prior)!;
    expect(p.typicalTiming).toBeNull();
  });
});

describe('buildSymptomRecallNote', () => {
  it('is null when there is no pattern', () => {
    expect(buildSymptomRecallNote(null)).toBeNull();
  });

  it('recalls timing + remedy as facts, never as a list', () => {
    const note = buildSymptomRecallNote({
      symptom: 'nausea',
      count: 3,
      typicalTiming: 'the day after your shot',
      topRemedy: 'ginger',
    });
    expect(note).toContain('SYMPTOM MEMORY');
    expect(note).toContain('the day after your shot');
    expect(note).toContain('ginger');
  });

  it('acknowledges a recurring symptom even without timing/remedy (count >= 2)', () => {
    const note = buildSymptomRecallNote({ symptom: 'headache', count: 2, typicalTiming: null, topRemedy: null });
    expect(note).toContain('SYMPTOM MEMORY');
    expect(note).toContain('headache');
  });

  it('is null for a single prior episode with no timing/remedy (nothing to recall)', () => {
    expect(buildSymptomRecallNote({ symptom: 'headache', count: 1, typicalTiming: null, topRemedy: null })).toBeNull();
  });
});

describe('buildInjectionDaySymptomNote', () => {
  it('warns about the strongest timed pattern with the remedy that helped', () => {
    const note = buildInjectionDaySymptomNote([
      { symptom: 'nausea', count: 3, typicalTiming: 'the day after your shot', topRemedy: 'ginger' },
      { symptom: 'fatigue', count: 2, typicalTiming: 'on injection day', topRemedy: null },
    ])!;
    expect(note).toContain('INJECTION-DAY HEADS-UP');
    expect(note).toContain('nausea');
    expect(note).toContain('ginger');
  });

  it('is null when no pattern has a confident timing', () => {
    expect(buildInjectionDaySymptomNote([{ symptom: 'nausea', count: 1, typicalTiming: null, topRemedy: null }])).toBeNull();
    expect(buildInjectionDaySymptomNote([])).toBeNull();
  });
});
