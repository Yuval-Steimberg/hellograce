/**
 * Habit-checklist persistence (Feature gap 2).
 *
 * One row per (user, habit, day) in habit_logs. A checklist is a per-day TOGGLE:
 * check = idempotent INSERT … ON CONFLICT DO NOTHING, uncheck = DELETE, read
 * today = WHERE day = <today>. `day` is the user's LOCAL logging day (a
 * 'YYYY-MM-DD' string from nutrition/logging-window.computeUserLoggingDay),
 * passed in by the caller so the store stays pure of timezone logic.
 *
 * Every op is best-effort — returns empty / no-ops when the table hasn't been
 * migrated yet, so the feature degrades silently instead of crashing a turn.
 */
import type { Pool } from 'pg';
import { HABIT_KEYS, type HabitKey } from './habit-checklist.js';

const KEY_SET: ReadonlySet<string> = new Set(HABIT_KEYS);

/** Idempotently mark habits done for the given local day. Unknown keys ignored. */
export async function checkHabits(
  pool: Pool,
  userId: string,
  keys: HabitKey[],
  day: string,
  source: 'chat' | 'dashboard',
): Promise<void> {
  const valid = keys.filter((k) => KEY_SET.has(k));
  if (valid.length === 0) return;
  try {
    await Promise.all(
      valid.map((key) =>
        pool.query(
          `INSERT INTO habit_logs (user_id, habit_key, day, source)
           VALUES ($1, $2, $3::date, $4)
           ON CONFLICT (user_id, habit_key, day) DO NOTHING`,
          [userId, key, day, source],
        ),
      ),
    );
  } catch {
    /* best-effort — table may not be migrated */
  }
}

/** Remove a habit check for the given local day (uncheck). */
export async function uncheckHabit(pool: Pool, userId: string, key: HabitKey, day: string): Promise<void> {
  if (!KEY_SET.has(key)) return;
  try {
    await pool.query(
      `DELETE FROM habit_logs WHERE user_id = $1 AND habit_key = $2 AND day = $3::date`,
      [userId, key, day],
    );
  } catch {
    /* best-effort */
  }
}

/** The habit keys checked for the given local day. [] on any error. */
export async function getTodaysHabits(pool: Pool, userId: string, day: string): Promise<HabitKey[]> {
  try {
    const { rows } = await pool.query<{ habit_key: string }>(
      `SELECT habit_key FROM habit_logs WHERE user_id = $1 AND day = $2::date`,
      [userId, day],
    );
    return rows.map((r) => r.habit_key).filter((k): k is HabitKey => KEY_SET.has(k));
  } catch {
    return [];
  }
}
