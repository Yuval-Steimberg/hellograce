import { describe, it, expect } from 'vitest';
import { glp1WeekNumber, weightProgress, loggingStreak, summarizeSymptoms } from './dashboard-data.js';
import type { SymptomEpisode } from './symptom-intelligence.js';

describe('glp1WeekNumber', () => {
  it('counts whole weeks since the start date (week 1 = first 7 days)', () => {
    const now = new Date('2026-03-01T12:00:00Z');
    expect(glp1WeekNumber('2026-03-01', now)).toBe(1); // day 0 -> week 1
    expect(glp1WeekNumber('2026-02-23', now)).toBe(1); // 6 days -> week 1
    expect(glp1WeekNumber('2026-02-22', now)).toBe(2); // 7 days -> week 2
    expect(glp1WeekNumber('2026-02-01', now)).toBe(5); // 28 days -> week 5
  });

  it('is null for no date or a future date', () => {
    const now = new Date('2026-03-01T12:00:00Z');
    expect(glp1WeekNumber(null, now)).toBeNull();
    expect(glp1WeekNumber('2026-04-01', now)).toBeNull();
    expect(glp1WeekNumber('not-a-date', now)).toBeNull();
  });
});

describe('weightProgress', () => {
  it('computes lost, to-go, and percent from start/current/goal', () => {
    const p = weightProgress(220, 200, 180);
    expect(p.lostLbs).toBe(20);
    expect(p.toGoLbs).toBe(20);
    expect(p.pct).toBe(50);
  });

  it('clamps percent to 0-100 and never negative to-go', () => {
    expect(weightProgress(220, 170, 180).toGoLbs).toBe(0); // past goal
    expect(weightProgress(220, 170, 180).pct).toBe(100);
    expect(weightProgress(220, 225, 180).pct).toBe(0); // gained
  });

  it('returns nulls when anchors are missing', () => {
    const p = weightProgress(null, 200, null);
    expect(p.lostLbs).toBeNull();
    expect(p.toGoLbs).toBeNull();
    expect(p.pct).toBeNull();
  });
});

describe('loggingStreak', () => {
  it('counts consecutive logged days ending today', () => {
    const days = [
      { day: '2026-03-01', item_count: 2 },
      { day: '2026-03-02', item_count: 1 },
      { day: '2026-03-03', item_count: 3 },
    ];
    expect(loggingStreak(days)).toBe(3);
  });

  it('breaks the streak on a gap', () => {
    const days = [
      { day: '2026-03-01', item_count: 2 },
      { day: '2026-03-02', item_count: 0 },
      { day: '2026-03-03', item_count: 1 },
    ];
    expect(loggingStreak(days)).toBe(1);
  });

  it('stays alive when today has no log yet but yesterday did', () => {
    const days = [
      { day: '2026-03-01', item_count: 2 },
      { day: '2026-03-02', item_count: 2 },
      { day: '2026-03-03', item_count: 0 }, // today, not logged yet
    ];
    expect(loggingStreak(days)).toBe(2);
  });

  it('is 0 when nothing is logged', () => {
    expect(loggingStreak([{ day: '2026-03-03', item_count: 0 }])).toBe(0);
    expect(loggingStreak([])).toBe(0);
  });
});

describe('summarizeSymptoms', () => {
  const ep = (symptom: string, days: number | null, remedy: string | null): SymptomEpisode => ({
    symptom, days_since_injection: days, dose_mg: 0.5, remedy_helped: remedy, created_at: new Date(),
  });

  it('groups by symptom and orders by frequency', () => {
    const eps = [
      ep('nausea', 1, 'ginger'), ep('nausea', 1, null), ep('nausea', 1, null),
      ep('fatigue', 2, null),
    ];
    const out = summarizeSymptoms(eps);
    expect(out[0]!.symptom).toBe('nausea');
    expect(out[0]!.count).toBe(3);
    expect(out[0]!.typicalTiming).toBe('the day after your shot');
    expect(out[0]!.topRemedy).toBe('ginger');
    expect(out[1]!.symptom).toBe('fatigue');
  });

  it('returns an empty array when there are no episodes', () => {
    expect(summarizeSymptoms([])).toEqual([]);
  });
});
