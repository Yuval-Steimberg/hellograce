/**
 * Dashboard data helpers (2026-07-02) — pure derivations for Grace's user-facing
 * progress dashboard. Kept free of I/O so the math (GLP-1 week, weight progress,
 * logging streak, symptom-pattern shaping) is fully unit-testable; the route
 * layer does the DB reads and hands raw rows in.
 */

import { analyzeSymptomPattern, type SymptomEpisode } from './symptom-intelligence.js';

const MS_PER_DAY = 86_400_000;

/** Whole weeks (1-indexed) since the user's GLP-1 start date. Week 1 = the first
 *  7 days. Null when there's no start date or it's in the future. */
export function glp1WeekNumber(startDate: string | Date | null | undefined, now: Date = new Date()): number | null {
  if (!startDate) return null;
  const start = new Date(startDate);
  if (Number.isNaN(start.getTime())) return null;
  const days = Math.floor((now.getTime() - start.getTime()) / MS_PER_DAY);
  if (days < 0) return null;
  return Math.floor(days / 7) + 1;
}

export interface WeightProgress {
  start: number | null;
  current: number | null;
  goal: number | null;
  /** Pounds lost from the starting weight (positive = lost). Null if unknown. */
  lostLbs: number | null;
  /** Pounds still to go to reach the goal (>= 0). Null if unknown. */
  toGoLbs: number | null;
  /** 0-100 progress from start → goal. Null when start/goal missing or start==goal. */
  pct: number | null;
}

/** Compute weight progress from the three anchor weights (all in lbs). */
export function weightProgress(
  start: number | null | undefined,
  current: number | null | undefined,
  goal: number | null | undefined,
): WeightProgress {
  const s = start ?? null;
  const c = current ?? null;
  const g = goal ?? null;
  const lostLbs = s != null && c != null ? Math.round((s - c) * 10) / 10 : null;
  const toGoLbs = c != null && g != null ? Math.round(Math.max(0, c - g) * 10) / 10 : null;
  let pct: number | null = null;
  if (s != null && g != null && c != null && s !== g) {
    const total = s - g;
    const done = s - c;
    pct = Math.round(Math.max(0, Math.min(100, (done / total) * 100)));
  }
  return { start: s, current: c, goal: g, lostLbs, toGoLbs, pct };
}

/** Current consecutive-day food-logging streak (ending today or yesterday), from
 *  per-day totals shaped `{ day: 'YYYY-MM-DD', item_count }`, most recent LAST. A
 *  day counts when at least one food was logged. Allows the streak to "still be
 *  alive" if today has no log yet but yesterday did. */
export function loggingStreak(days: Array<{ day: string; item_count: number }>): number {
  const logged = new Set(days.filter((d) => d.item_count > 0).map((d) => d.day));
  if (logged.size === 0) return 0;
  // Walk backward from the most recent day present in the series.
  const sorted = [...days].map((d) => d.day).sort();
  const last = sorted[sorted.length - 1]!;
  let cursor = new Date(`${last}T00:00:00Z`);
  // If the most recent day itself wasn't logged, the streak can only be alive
  // via the day before (grace for "haven't logged yet today").
  if (!logged.has(last)) cursor = new Date(cursor.getTime() - MS_PER_DAY);
  let streak = 0;
  for (let i = 0; i < 400; i++) {
    const key = cursor.toISOString().slice(0, 10);
    if (logged.has(key)) {
      streak++;
      cursor = new Date(cursor.getTime() - MS_PER_DAY);
    } else {
      break;
    }
  }
  return streak;
}

export interface SymptomPatternView {
  symptom: string;
  count: number;
  typicalTiming: string | null;
  topRemedy: string | null;
}

/**
 * Shape the user's raw symptom episodes into per-symptom pattern cards for the
 * dashboard: group by symptom, analyze each, and order by how often it's come up.
 * (`analyzeSymptomPattern` treats the passed episodes as prior history, so the
 * count reflects everything recorded — correct for a progress view.)
 */
export function summarizeSymptoms(episodes: SymptomEpisode[]): SymptomPatternView[] {
  const bySymptom = new Map<string, SymptomEpisode[]>();
  for (const e of episodes) {
    const arr = bySymptom.get(e.symptom) ?? [];
    arr.push(e);
    bySymptom.set(e.symptom, arr);
  }
  const views: SymptomPatternView[] = [];
  for (const [symptom, eps] of bySymptom) {
    const p = analyzeSymptomPattern(symptom, eps);
    if (p) views.push({ symptom: p.symptom, count: p.count, typicalTiming: p.typicalTiming, topRemedy: p.topRemedy });
  }
  return views.sort((a, b) => b.count - a.count);
}
