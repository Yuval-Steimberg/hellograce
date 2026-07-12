/**
 * Nightly end-of-day summary (2026-07-06) — a SEPARATE system from reminders.
 *
 * This module owns the DATA + TEXT of Grace's once-a-day recap: it aggregates
 * everything the user logged during their local day and renders a short, warm,
 * DETERMINISTIC message (no LLM — so a logged number can never be fabricated or
 * mis-shaped, per the project's hard "never fabricate a datum" rule). The
 * scheduling / send / dedup lives in scheduler.ts's own `sendDailySummaries`
 * pass — this file stays pure of cron/lock concerns and is fully unit-testable.
 *
 * Every read is best-effort: a missing table or DB error degrades that one
 * field to empty/zero, never throwing, so a summary is always renderable.
 */

import type { Pool } from 'pg';
import type { GraceUser } from '../user/user.service.js';
import { computeUserLoggingDay } from '../nutrition/logging-window.js';
import { getTodaysWaterOz } from './water-log.js';
import { getTodaysHabits } from './habit-store.js';
import { habitLabel, type HabitKey } from './habit-checklist.js';
import { computeInjectionSchedule, type MedicationType } from './medication-schedule.js';
import { WATER_GOAL_MIN_OZ } from '../nutrition/water.js';

/** Minimal slice of UserService this module needs — keeps tests light and the
 *  module decoupled from the full (huge) UserService surface. */
export interface DailySummaryUserReads {
  getTodaysFoodSummary(userId: string): Promise<{
    protein_g: number;
    calories: number;
    items: string[];
    items_detailed: Array<{ food: string; protein_g: number; calories: number; logged_at: string }>;
  }>;
  getRecentSymptomEpisodes(userId: string, limit?: number): Promise<Array<{
    symptom: string;
    days_since_injection: number | null;
    dose_mg: number | null;
    remedy_helped: string | null;
    created_at: Date;
  }>>;
  getWeightHistory(userId: string, limit?: number): Promise<Array<{ weight: number; created_at: Date }>>;
}

export interface DailySummaryDeps {
  users: DailySummaryUserReads;
  pool: Pool;
}

/** The aggregated snapshot of one user's logged day. */
export interface DailySummaryData {
  /** User's local logging day, YYYY-MM-DD. */
  date: string;
  food: {
    proteinG: number;
    calories: number;
    mealCount: number;
    items: string[];
  };
  /** Total oz today, or null when water isn't tracked / table not migrated. */
  waterOz: number | null;
  /** Habit keys checked off today. */
  habits: HabitKey[];
  /** Convenience flags derived from `habits` (there is no separate movement store). */
  movement: boolean;
  strength: boolean;
  /** Distinct symptom labels logged today. */
  symptoms: string[];
  /** Weight in lbs if the user logged one TODAY, else null. */
  weightLoggedToday: number | null;
  injection: {
    /** They confirmed their shot today (injection_done_at falls on today). */
    doneToday: boolean;
    /** Today is their weekly injection day. */
    isInjectionDayToday: boolean;
    /** Tomorrow is their weekly injection day. */
    tomorrowIsInjectionDay: boolean;
  };
}

/** Minimal, self-contained medication-type inference (mirrors
 *  ai.service.inferMedicationType — inlined to avoid importing that huge module
 *  into this lean, isolated file). Med names are stable, so drift risk is nil. */
function inferMedType(medication: string | null | undefined): MedicationType {
  if (!medication) return 'unknown';
  const med = medication.toLowerCase();
  if (/rybelsus/.test(med)) return 'daily_pill';
  if (/saxenda|victoza|liraglutide/.test(med)) return 'daily_injection';
  if (/ozempic|wegovy|mounjaro|zepbound|semaglutide|tirzepatide/.test(med)) return 'weekly_injection';
  return 'unknown';
}

function localDayOf(user: GraceUser, when: Date): string {
  return computeUserLoggingDay(user.timezone, user.wake_time, when);
}

// ── Send-window math (pure) ──────────────────────────────────────────────────
// The end-of-day slot tracks the USER'S BEDTIME: 30 min before their sleep_time,
// so a 22:00 sleeper gets it ~21:30 and a midnight sleeper ~23:30 (the old fixed
// 19:00–21:00 clamp pinned everyone to 21:00 regardless of when they actually go
// to bed). It's floored at 18:00 (a sane evening floor so a mis-set early
// sleep_time can't fire mid-afternoon) and capped at 23:30 so the recap always
// lands BEFORE local midnight — the moment the logging day rolls, after which the
// numbers would belong to a fresh day. This pass runs outside processUser, so it
// is NOT subject to the 21:00 quiet-hours block; the 23:30 cap is the ceiling.

/** Minutes-from-local-midnight of the low/high clamp + the default. */
const SUMMARY_MIN_TARGET = 18 * 60; // 18:00 — earliest an evening recap may fire
const SUMMARY_MAX_TARGET = 23 * 60 + 30; // 23:30 — latest, still before midnight
const SUMMARY_DEFAULT_TARGET = 21 * 60; // 21:00 when no sleep schedule
const SUMMARY_OFFSET_BEFORE_SLEEP = 30; // minutes before sleep_time
// A sleep_time before noon means the user goes to bed AFTER midnight (e.g. "00:00",
// "01:30") — "30 min before" would cross into the next day, so recap the ending
// day just before midnight (the cap) instead of firing at ~00:30 the next morning.
const SUMMARY_AFTER_MIDNIGHT_CUTOFF = 12 * 60; // 12:00
/** How wide the eligible send window is (minutes). */
export const DAILY_SUMMARY_WINDOW_MIN = 15;

function parseHhMm(value: string | null | undefined): number | null {
  const m = /^(\d{1,2}):(\d{2})/.exec((value ?? '').trim());
  if (!m) return null;
  const h = Math.min(23, Math.max(0, Number(m[1])));
  const mi = Math.min(59, Math.max(0, Number(m[2])));
  return h * 60 + mi;
}

/**
 * The target minute-of-day (local) to send the summary: the user's BEDTIME
 * minus 30 min, clamped to [18:00, 23:30]; 21:00 when sleep_time is
 * missing/unparseable; 23:30 for an after-midnight bedtime (sleep_time before
 * noon) so the recap still lands before the logging day rolls at midnight.
 * Pure — the scheduler supplies the user, this returns a stable target.
 */
export function dailySummaryTargetMinutes(user: Pick<GraceUser, 'sleep_time'>): number {
  const sleepMin = parseHhMm(user.sleep_time);
  if (sleepMin == null) return SUMMARY_DEFAULT_TARGET;
  // After-midnight bedtime → recap the ending day just before midnight.
  if (sleepMin < SUMMARY_AFTER_MIDNIGHT_CUTOFF) return SUMMARY_MAX_TARGET;
  const target = sleepMin - SUMMARY_OFFSET_BEFORE_SLEEP;
  return Math.min(SUMMARY_MAX_TARGET, Math.max(SUMMARY_MIN_TARGET, target));
}

/** Is the user's current local minute-of-day inside the summary send window? */
export function isInDailySummaryWindow(
  localMinutesOfDay: number,
  targetMinutes: number,
  windowMin: number = DAILY_SUMMARY_WINDOW_MIN,
): boolean {
  return localMinutesOfDay >= targetMinutes && localMinutesOfDay < targetMinutes + windowMin;
}

/**
 * Collect everything the user logged for their current local day. Best-effort:
 * each source degrades to empty/zero on error, so this never throws.
 */
export async function gatherDailySummaryData(
  deps: DailySummaryDeps,
  user: GraceUser,
  now: Date = new Date(),
): Promise<DailySummaryData> {
  const todayKey = localDayOf(user, now);

  const [food, waterOz, habits, symptomsRaw, weightRows] = await Promise.all([
    deps.users
      .getTodaysFoodSummary(user.phone)
      .catch(() => ({ protein_g: 0, calories: 0, items: [] as string[], items_detailed: [] })),
    getTodaysWaterOz(deps.pool, user.phone), // already null-on-error
    getTodaysHabits(deps.pool, user.phone, todayKey), // already []-on-error
    deps.users.getRecentSymptomEpisodes(user.phone).catch(() => []),
    deps.users.getWeightHistory(user.phone, 3).catch(() => []),
  ]);

  // Symptoms logged specifically today, de-duplicated, preserving first-seen order.
  const symptomsToday: string[] = [];
  for (const ep of symptomsRaw) {
    if (localDayOf(user, new Date(ep.created_at)) !== todayKey) continue;
    if (!symptomsToday.includes(ep.symptom)) symptomsToday.push(ep.symptom);
  }

  // Weight is "today's" only if the most recent entry falls on today's local day.
  const weightLoggedToday =
    weightRows.length > 0 && localDayOf(user, new Date(weightRows[0]!.created_at)) === todayKey
      ? Number(weightRows[0]!.weight)
      : null;

  const doneToday = user.injection_done_at
    ? localDayOf(user, new Date(user.injection_done_at)) === todayKey
    : false;

  const sched = computeInjectionSchedule(
    {
      medicationType: inferMedType(user.medication),
      medicationName: user.medication,
      injectionDay: user.injection_day,
      timezone: user.timezone,
    },
    now,
  );
  // "Injection day" is only meaningful for a weekly injectable; daily meds have
  // no special day, so we never surface an injection-day heads-up for them.
  const weekly = sched.cadence === 'weekly';

  return {
    date: todayKey,
    food: {
      proteinG: Math.round(food.protein_g || 0),
      calories: Math.round(food.calories || 0),
      mealCount: food.items_detailed?.length ?? food.items?.length ?? 0,
      items: food.items ?? [],
    },
    waterOz,
    habits,
    movement: habits.includes('movement'),
    strength: habits.includes('strength'),
    symptoms: symptomsToday,
    weightLoggedToday,
    injection: {
      doneToday,
      isInjectionDayToday: weekly && sched.isToday,
      tomorrowIsInjectionDay: weekly && sched.daysUntilNext === 1,
    },
  };
}

/**
 * Did the user actually LOG anything today? Injection/schedule CONTEXT (today or
 * tomorrow is a shot day) does not count on its own — only real logged activity
 * does — because on a zero-log day the product decision is to send nothing.
 * Confirming today's shot (`doneToday`) IS a logged action and counts.
 */
export function hasLoggedData(data: DailySummaryData): boolean {
  return (
    data.food.proteinG > 0 ||
    data.food.calories > 0 ||
    data.food.mealCount > 0 ||
    (data.waterOz != null && data.waterOz > 0) ||
    data.habits.length > 0 ||
    data.symptoms.length > 0 ||
    data.weightLoggedToday != null ||
    data.injection.doneToday
  );
}

// ── Deterministic render ─────────────────────────────────────────────────────
// A warm, short, human wrap-up assembled entirely from the real logged numbers.
// No LLM: numbers can never be fabricated or mis-shaped. Tone rules (per spec):
// short, friendly, encouraging, practical, NEVER judgmental or medical. Soft
// hedges only ("looked a little", "could", "might"). Never "you failed / should
// have / adherence". Sent with raw:true so the line breaks survive the outbound
// sanitizer (which otherwise flattens label-colon lines).

const OPENINGS = [
  'Nice work today 💛',
  "Here's your quick day recap 💛",
  'Your day, wrapped up 💛',
  'Quick recap of your day 💛',
];

const CLOSINGS = [
  'Small steps. 💛',
  'Small steps count.',
  "You're building consistency.",
  'One day at a time. 💛',
];

/** Stable per-day pick so wording varies day to day but is fixed within a run. */
function pickByDate<T>(pool: readonly T[], dateKey: string): T {
  let h = 0;
  for (let i = 0; i < dateKey.length; i++) h = (h * 31 + dateKey.charCodeAt(i)) >>> 0;
  return pool[h % pool.length]!;
}

function cap(s: string): string {
  return s.length ? s[0]!.toUpperCase() + s.slice(1) : s;
}

function waterLine(oz: number): string {
  const cups = Math.round(oz / 8);
  return cups >= 1 ? `Water: ${cups} cup${cups > 1 ? 's' : ''}` : `Water: ${oz} oz`;
}

/** Habit keys already surfaced by their own recap line, so we don't repeat them. */
const HABITS_SHOWN_ELSEWHERE: ReadonlySet<HabitKey> = new Set<HabitKey>([
  'movement',
  'strength',
  'weighed_in',
  'injected',
  'protein',
]);

function buildRecapLines(data: DailySummaryData): string[] {
  const lines: string[] = [];

  if (data.food.proteinG > 0 || data.food.mealCount > 0) {
    lines.push(`Protein: ${data.food.proteinG}g`);
  }
  if (data.food.calories > 0) lines.push(`Calories: ${data.food.calories}`);
  if (data.waterOz != null && data.waterOz > 0) lines.push(waterLine(data.waterOz));
  if (data.movement) lines.push('Movement: got some in');
  if (data.strength) lines.push('Strength: done 💪');
  if (data.food.mealCount > 0) {
    lines.push(`Meals: ${data.food.mealCount} logged`);
  }
  if (data.weightLoggedToday != null) {
    lines.push(`Weight: ${Math.round(data.weightLoggedToday)} lbs logged`);
  }
  if (data.injection.doneToday) lines.push('Injection: done ✅');
  if (data.symptoms.length > 0) {
    lines.push(`Symptoms: ${data.symptoms.map(cap).join(', ')}`);
  }

  // Any remaining checked habits not already represented by a line above.
  const extraHabits = data.habits.filter((k) => !HABITS_SHOWN_ELSEWHERE.has(k));
  if (extraHabits.length > 0) {
    const labels = extraHabits.slice(0, 3).map((k) => habitLabel(k).toLowerCase());
    const tail = extraHabits.length > 3 ? `${labels.join(', ')} and more` : labels.join(', ');
    lines.push(`Checked off: ${tail}`);
  }

  return lines;
}

/** The "My take:" conclusion — soft, honest, at most two clauses. */
function buildConclusion(data: DailySummaryData, proteinGoal: number | null): string {
  const clauses: string[] = [];

  if (proteinGoal && proteinGoal > 0 && (data.food.proteinG > 0 || data.food.mealCount > 0)) {
    if (data.food.proteinG >= proteinGoal) clauses.push('protein was right on target');
    else if (data.food.proteinG >= proteinGoal * 0.8) clauses.push('protein was close to your goal');
    else clauses.push('protein came in a little under your goal');
  } else if (data.food.proteinG > 0) {
    clauses.push('you got some protein in');
  }

  if (data.waterOz != null) {
    if (data.waterOz >= WATER_GOAL_MIN_OZ) clauses.push('fluids looked solid');
    else if (data.waterOz > 0) clauses.push('fluids looked a little light');
  }

  if (data.movement) clauses.push('and you got movement in — a real consistency win');

  if (clauses.length === 0) {
    return 'My take: you showed up and logged today, and that consistency is what adds up.';
  }
  return `My take: ${cap(clauses.join(', '))}.`;
}

const NAUSEA_RE = /naus|vomit/i;

/** One or two practical, non-medical suggestions for tomorrow, priority-ordered. */
function buildSuggestions(data: DailySummaryData, proteinGoal: number | null): string[] {
  const out: string[] = [];

  if (data.injection.tomorrowIsInjectionDay) {
    out.push(
      'with your shot coming up, keeping meals simple with easy protein and fluids can help you feel steadier',
    );
  }
  if (data.symptoms.some((s) => NAUSEA_RE.test(s))) {
    out.push(
      'with the nausea today, smaller, gentler meals and easy protein might sit better tomorrow',
    );
  }

  const proteinLow =
    proteinGoal && proteinGoal > 0 && data.food.proteinG < proteinGoal * 0.8;
  if (proteinLow) {
    out.push('your easiest win is probably adding 20–30g of protein earlier in the day');
  }

  const waterLow = data.waterOz != null && data.waterOz < WATER_GOAL_MIN_OZ;
  if (waterLow) {
    out.push('try keeping water close by in the morning so it’s easy to sip');
  }

  if (!data.movement && out.length < 2) {
    out.push('even a short walk counts if you’re up for it');
  }

  if (out.length === 0) {
    out.push('keep it simple — protein, water, and a little movement is plenty');
  }

  return out.slice(0, 2);
}

/**
 * Render the full nightly summary message. Deterministic; call `hasLoggedData`
 * first and skip sending when it's false (zero-log days send nothing).
 */
export function renderDailySummary(
  data: DailySummaryData,
  user: Pick<GraceUser, 'protein_goal_grams'>,
): string {
  const proteinGoal = user.protein_goal_grams ?? null;
  const opening = pickByDate(OPENINGS, data.date);
  const recap = buildRecapLines(data);
  const conclusion = buildConclusion(data, proteinGoal);
  const suggestions = buildSuggestions(data, proteinGoal);
  const closing = pickByDate(CLOSINGS, data.date);

  const parts: string[] = [opening];
  if (recap.length > 0) parts.push(recap.join('\n'));
  parts.push(conclusion);

  const suggestionText =
    suggestions.length === 2
      ? `Tomorrow, ${suggestions[0]}. And ${suggestions[1]}.`
      : `Tomorrow, ${suggestions[0]}.`;
  parts.push(suggestionText);

  // A gentle, non-alarming clinician nudge only when symptoms were logged.
  if (data.symptoms.length > 0) {
    parts.push('If anything sticks around or gets worse, a quick word with your clinician is worth it.');
  }

  parts.push(closing);

  return parts.join('\n\n');
}
