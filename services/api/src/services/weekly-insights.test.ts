import { describe, it, expect } from 'vitest';
import {
  weeklyProteinStats,
  weeklyWaterStats,
  weekWeightDelta,
  plateauSignal,
  buildWeeklyInsight,
  computeWeeklyStats,
  type WeightPoint,
} from './weekly-insights.js';

const iso = (daysAgo: number, now = NOW) => new Date(now.getTime() - daysAgo * 24 * 3_600_000).toISOString();
const NOW = new Date('2026-07-04T12:00:00Z');

describe('weeklyProteinStats', () => {
  it('averages over logged days only', () => {
    const r = weeklyProteinStats([
      { day: 'd1', protein: 100, itemCount: 3 },
      { day: 'd2', protein: 0, itemCount: 0 }, // not logged — excluded
      { day: 'd3', protein: 80, itemCount: 2 },
    ]);
    expect(r.daysLogged).toBe(2);
    expect(r.avg).toBe(90);
  });
  it('returns null avg when nothing logged', () => {
    expect(weeklyProteinStats([{ day: 'd', protein: 0, itemCount: 0 }])).toEqual({ avg: null, daysLogged: 0 });
  });
});

describe('weeklyWaterStats', () => {
  it('counts days at goal and averages logged days', () => {
    const r = weeklyWaterStats([{ day: 'a', oz: 70 }, { day: 'b', oz: 40 }, { day: 'c', oz: 0 }], 64);
    expect(r.daysAtGoal).toBe(1);
    expect(r.daysLogged).toBe(2);
    expect(r.avg).toBe(55);
    expect(r.window).toBe(3);
  });
});

describe('weekWeightDelta', () => {
  it('reports loss over the last 7 days (negative)', () => {
    const series: WeightPoint[] = [
      { date: iso(6), weight: 200 },
      { date: iso(1), weight: 198.6 },
    ];
    expect(weekWeightDelta(series, NOW)).toBe(-1.4);
  });
  it('is null with fewer than two in-window points', () => {
    expect(weekWeightDelta([{ date: iso(1), weight: 200 }], NOW)).toBeNull();
    // a point older than 7 days is out of window
    expect(weekWeightDelta([{ date: iso(20), weight: 205 }, { date: iso(1), weight: 200 }], NOW)).toBeNull();
  });
});

describe('plateauSignal', () => {
  it('flags a stall when weight is flat across ≥14 days', () => {
    const series: WeightPoint[] = [
      { date: iso(21), weight: 200 },
      { date: iso(1), weight: 199.6 },
    ];
    const p = plateauSignal(series, NOW);
    expect(p?.stalled).toBe(true);
    expect(p?.days).toBeGreaterThanOrEqual(14);
  });
  it('does NOT flag a stall when weight is clearly dropping', () => {
    const series: WeightPoint[] = [
      { date: iso(21), weight: 205 },
      { date: iso(1), weight: 198 },
    ];
    expect(plateauSignal(series, NOW)?.stalled).toBe(false);
  });
  it('returns null without a ≥14-day span', () => {
    expect(plateauSignal([{ date: iso(5), weight: 200 }, { date: iso(1), weight: 200 }], NOW)).toBeNull();
  });
});

describe('buildWeeklyInsight', () => {
  it('never claims causation for a stall + strong habits', () => {
    const text = buildWeeklyInsight({
      weightDeltaLbs: null,
      plateau: { stalled: true, days: 21, deltaLbs: -0.2 },
      avgProtein: 130,
      proteinGoal: 130,
      daysProteinLogged: 6,
      daysWaterAtGoal: 6,
      waterDaysWindow: 7,
    });
    expect(text).toBeTruthy();
    expect(text!.toLowerCase()).not.toMatch(/caused|because of your|is why/);
    expect(text!.toLowerCase()).toMatch(/measurements often move before the scale|still be real progress/);
  });

  it('flags low fluids as "worth watching", not blame', () => {
    const text = buildWeeklyInsight({
      weightDeltaLbs: -1.2,
      plateau: null,
      avgProtein: 120,
      proteinGoal: 130,
      daysProteinLogged: 5,
      daysWaterAtGoal: 2,
      waterDaysWindow: 7,
    });
    expect(text).toMatch(/down 1.2 lb/);
    expect(text!.toLowerCase()).toMatch(/worth watching/);
  });

  it('returns null when there is nothing honest to say', () => {
    expect(
      buildWeeklyInsight({
        weightDeltaLbs: null,
        plateau: null,
        avgProtein: null,
        proteinGoal: null,
        daysProteinLogged: 0,
        daysWaterAtGoal: 0,
        waterDaysWindow: 0,
      }),
    ).toBeNull();
  });
});

describe('computeWeeklyStats', () => {
  it('assembles the full block', () => {
    const stats = computeWeeklyStats({
      proteinHistory7: [{ day: 'a', protein: 120, itemCount: 3 }, { day: 'b', protein: 100, itemCount: 2 }],
      weightSeries: [{ date: iso(6), weight: 200 }, { date: iso(1), weight: 198.5 }],
      waterHistory: [{ day: 'a', oz: 70 }, { day: 'b', oz: 50 }],
      proteinGoal: 130,
      waterGoalMin: 64,
      now: NOW,
    });
    expect(stats.avgProtein).toBe(110);
    expect(stats.daysProteinLogged).toBe(2);
    expect(stats.weightDeltaLbs).toBe(-1.5);
    expect(stats.insight).toBeTruthy();
  });
});
