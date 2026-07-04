/**
 * Weekly insight helpers — pure, no I/O, no schema.
 *
 * Turns the data the dashboard already has (per-day protein history, weight
 * series, per-day water) into weekly averages, this-week weight change, a
 * conservative plateau signal, and ONE hedged human-readable insight.
 *
 * Design guardrails:
 *   - Never overclaim causation. The insight uses "that can be part of why…" /
 *     "worth watching", never "this caused your stall".
 *   - Require enough data before asserting anything. A plateau is only flagged
 *     with real weigh-ins spanning ≥14 days; averages only from logged days.
 *   - Every field is null/empty-safe so a data-thin user degrades to "not much
 *     logged yet", never a fabricated number.
 */

export interface ProteinDay {
  day: string;
  protein: number;
  itemCount: number;
}
export interface WeightPoint {
  date: string; // ISO
  weight: number;
}
export interface WaterDay {
  day: string;
  oz: number;
}

export interface PlateauSignal {
  /** True when weight has been essentially flat across a ≥2-week span. */
  stalled: boolean;
  /** Days between the two compared weigh-ins. */
  days: number;
  /** Net change over that span (negative = loss). */
  deltaLbs: number;
}

export interface WeeklyStats {
  avgProtein: number | null;
  proteinGoal: number | null;
  daysProteinLogged: number;
  avgOz: number | null;
  daysWaterLogged: number;
  daysWaterAtGoal: number;
  waterDaysWindow: number;
  /** This-week weight change in lbs (negative = loss), null if <2 weigh-ins. */
  weightDeltaLbs: number | null;
  plateau: PlateauSignal | null;
  insight: string | null;
}

const WEEK_MS = 7 * 24 * 3_600_000;
const PLATEAU_MIN_SPAN_MS = 14 * 24 * 3_600_000;

/** Average protein over LOGGED days only (days with an item), + how many. */
export function weeklyProteinStats(history: ProteinDay[]): { avg: number | null; daysLogged: number } {
  const logged = (history ?? []).filter((d) => d.itemCount > 0);
  if (logged.length === 0) return { avg: null, daysLogged: 0 };
  const avg = Math.round(logged.reduce((s, d) => s + d.protein, 0) / logged.length);
  return { avg, daysLogged: logged.length };
}

/** Water consistency over the window: avg oz on logged days, days logged, days at goal. */
export function weeklyWaterStats(
  history: WaterDay[],
  goalMin: number,
): { avg: number | null; daysLogged: number; daysAtGoal: number; window: number } {
  const days = history ?? [];
  const logged = days.filter((d) => d.oz > 0);
  const avg = logged.length ? Math.round(logged.reduce((s, d) => s + d.oz, 0) / logged.length) : null;
  const daysAtGoal = days.filter((d) => d.oz >= goalMin).length;
  return { avg, daysLogged: logged.length, daysAtGoal, window: days.length };
}

/** This-week weight change: latest minus the earliest weigh-in within 7 days.
 *  Negative = loss. Null when fewer than two in-window points. */
export function weekWeightDelta(series: WeightPoint[], now: Date = new Date()): number | null {
  const inWindow = (series ?? [])
    .filter((p) => Number.isFinite(p.weight) && now.getTime() - new Date(p.date).getTime() <= WEEK_MS)
    .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
  if (inWindow.length < 2) return null;
  return Math.round((inWindow[inWindow.length - 1]!.weight - inWindow[0]!.weight) * 10) / 10;
}

/**
 * Conservative plateau detector. Compares the latest weigh-in to the earliest
 * one at least 14 days older; flags a stall when the net change is within the
 * larger of ±1.0 lb or ±1% of body weight. Returns null when there aren't two
 * weigh-ins spanning ≥14 days (not enough signal to claim anything).
 */
export function plateauSignal(series: WeightPoint[], _now: Date = new Date()): PlateauSignal | null {
  const pts = (series ?? [])
    .filter((p) => Number.isFinite(p.weight))
    .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
  if (pts.length < 2) return null;
  const latest = pts[pts.length - 1]!;
  // Earliest point that is ≥14 days before the latest.
  const older = pts.find((p) => new Date(latest.date).getTime() - new Date(p.date).getTime() >= PLATEAU_MIN_SPAN_MS);
  if (!older) return null;
  const days = Math.round((new Date(latest.date).getTime() - new Date(older.date).getTime()) / (24 * 3_600_000));
  const deltaLbs = Math.round((latest.weight - older.weight) * 10) / 10;
  const threshold = Math.max(1.0, older.weight * 0.01);
  return { stalled: Math.abs(deltaLbs) <= threshold, days, deltaLbs };
}

/**
 * One hedged, human-readable insight combining the week's weight movement with
 * protein consistency and fluids. Never asserts causation. Returns null when
 * there isn't enough to say something honest.
 */
export function buildWeeklyInsight(s: {
  weightDeltaLbs: number | null;
  plateau: PlateauSignal | null;
  avgProtein: number | null;
  proteinGoal: number | null;
  daysProteinLogged: number;
  daysWaterAtGoal: number;
  waterDaysWindow: number;
}): string | null {
  const parts: string[] = [];

  // Weight movement (only when we have a real delta).
  if (s.weightDeltaLbs != null) {
    if (s.weightDeltaLbs < -0.2) parts.push(`You're down ${Math.abs(s.weightDeltaLbs)} lb this week`);
    else if (s.weightDeltaLbs > 0.2) parts.push(`Your weight is up ${s.weightDeltaLbs} lb this week`);
    else parts.push(`Your weight held about steady this week`);
  } else if (s.plateau?.stalled) {
    parts.push(`Your weight's been about flat for ${Math.round(s.plateau.days / 7)} weeks`);
  }

  // Protein consistency (hedged, supportive).
  if (s.avgProtein != null && s.proteinGoal) {
    const strongDays = s.daysProteinLogged;
    if (s.avgProtein >= s.proteinGoal * 0.9) {
      parts.push(`your protein was strong on ${strongDays} of the days you logged`);
    } else {
      parts.push(`your protein averaged ${s.avgProtein}g against your ${s.proteinGoal}g goal`);
    }
  }

  // Fluids — only surface as a "watch" when notably low, never as blame.
  if (s.waterDaysWindow > 0 && s.daysWaterAtGoal <= Math.floor(s.waterDaysWindow / 2)) {
    parts.push(`fluids were on the low side ${s.waterDaysWindow - s.daysWaterAtGoal} of ${s.waterDaysWindow} days, which is worth watching`);
  }

  if (parts.length === 0) return null;

  // Add a gentle, non-causal framing when there's a stall alongside good habits.
  let text = joinHuman(parts) + '.';
  if (s.plateau?.stalled && s.avgProtein != null && s.proteinGoal && s.avgProtein >= s.proteinGoal * 0.9) {
    text += ' A flat week with solid protein and training can still be real progress — measurements often move before the scale.';
  }
  return text;
}

function joinHuman(parts: string[]): string {
  if (parts.length === 1) return capitalize(parts[0]!);
  const first = capitalize(parts[0]!);
  const rest = parts.slice(1);
  return `${first}, but ${rest.join(', and ')}`;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Aggregate everything into the weekly stats block used by the dashboard. */
export function computeWeeklyStats(input: {
  proteinHistory7: ProteinDay[];
  weightSeries: WeightPoint[];
  waterHistory: WaterDay[];
  proteinGoal: number | null;
  waterGoalMin: number;
  now?: Date;
}): WeeklyStats {
  const now = input.now ?? new Date();
  const p = weeklyProteinStats(input.proteinHistory7);
  const w = weeklyWaterStats(input.waterHistory, input.waterGoalMin);
  const weightDeltaLbs = weekWeightDelta(input.weightSeries, now);
  const plateau = plateauSignal(input.weightSeries, now);
  const insight = buildWeeklyInsight({
    weightDeltaLbs,
    plateau,
    avgProtein: p.avg,
    proteinGoal: input.proteinGoal,
    daysProteinLogged: p.daysLogged,
    daysWaterAtGoal: w.daysAtGoal,
    waterDaysWindow: w.window,
  });
  return {
    avgProtein: p.avg,
    proteinGoal: input.proteinGoal,
    daysProteinLogged: p.daysLogged,
    avgOz: w.avg,
    daysWaterLogged: w.daysLogged,
    daysWaterAtGoal: w.daysAtGoal,
    waterDaysWindow: w.window,
    weightDeltaLbs,
    plateau,
    insight,
  };
}
