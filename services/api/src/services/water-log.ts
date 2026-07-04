/**
 * Water logging + today's total (2026-06-15).
 *
 * Deterministic, isolated from food/protein. Insert into water_logs and read
 * the running total over the user's personal wake-time logging day (same
 * window as food — see nutrition/logging-window.ts). Degrades gracefully when
 * the water_logs table hasn't been migrated yet (returns null → caller falls
 * through; never crashes a turn).
 */

import { createHash } from 'crypto';
import type { Pool } from 'pg';
import type { Logger } from 'pino';
import { USER_DAY_CTE, userDayExpr, isCurrentUserDay } from '../nutrition/logging-window.js';
import { WATER_GOAL_MIN_OZ, WATER_GOAL_MAX_OZ } from '../nutrition/water.js';

/** Sum of today's water (oz) over the user's wake-time logging day. Returns
 *  null on any DB error (incl. table-not-migrated) so the caller can fall back. */
export async function getTodaysWaterOz(pool: Pool, userId: string): Promise<number | null> {
  try {
    const { rows } = await pool.query<{ total_oz: number }>(
      `${USER_DAY_CTE}
       SELECT COALESCE(SUM(w.oz), 0) AS total_oz
       FROM water_logs w, user_tz
       WHERE w.user_id = $1
         AND ${isCurrentUserDay('w.created_at')}`,
      [userId],
    );
    return Math.round(Number(rows[0]?.total_oz ?? 0));
  } catch {
    return null;
  }
}

/** Per-user-day water totals (oz) for the last N days, most recent first. Uses
 *  the same wake-time logging window as protein history so "today" lines up
 *  across food + water. Returns [] on any error (incl. table not migrated) so
 *  callers degrade gracefully — never crashes a request. */
export async function getDailyWaterHistory(
  pool: Pool,
  userId: string,
  days = 7,
): Promise<Array<{ day: string; oz: number }>> {
  const safeDays = Math.max(1, Math.min(30, Math.floor(days)));
  try {
    const { rows } = await pool.query<{ day: string; oz: number }>(
      `${USER_DAY_CTE}
       SELECT ${userDayExpr('w.created_at')}::text AS day,
              COALESCE(SUM(w.oz), 0)::int AS oz
       FROM water_logs w, user_tz
       WHERE w.user_id = $1
         AND ${userDayExpr('w.created_at')}
             >= ${userDayExpr('now()')} - ($2::int - 1)
       GROUP BY day
       ORDER BY day DESC`,
      [userId, safeDays],
    );
    return rows.map((r) => ({ day: r.day, oz: Number(r.oz) }));
  } catch {
    return [];
  }
}

/** Format a water total into a warm, goal-aware sentence. */
export function renderWaterTotal(totalOz: number): string {
  if (totalOz <= 0) {
    return `You haven't logged any water yet today. Aim for ${WATER_GOAL_MIN_OZ}-${WATER_GOAL_MAX_OZ} oz, sipped through the day.`;
  }
  if (totalOz >= WATER_GOAL_MIN_OZ) {
    return `You're at ${totalOz} oz of water today, right in the ${WATER_GOAL_MIN_OZ}-${WATER_GOAL_MAX_OZ} oz range. Nice.`;
  }
  const toGo = WATER_GOAL_MIN_OZ - totalOz;
  return `You're at ${totalOz} oz of water today, about ${toGo} oz to reach the ${WATER_GOAL_MIN_OZ} oz mark.`;
}

export interface WaterLogResult {
  /** The user-facing confirmation, e.g. "Logged 65 oz of water. You're at…". */
  text: string;
  loggedOz: number;
  dailyOz: number;
}

/**
 * Insert a water log and return a confirmation with the updated daily total.
 * Returns null when the insert fails (e.g. table not migrated) so the caller
 * can fall through to the normal pipeline instead of claiming a false "Logged".
 */
export async function logWater(
  pool: Pool,
  logger: Logger,
  userId: string,
  oz: number,
  rawText: string,
): Promise<WaterLogResult | null> {
  if (!(oz > 0)) return null;
  const minuteBucket = Math.floor(Date.now() / 60_000);
  const dedupeKey = createHash('sha256')
    .update(`${userId}|water|${rawText.toLowerCase().replace(/\s+/g, ' ')}|${minuteBucket}`)
    .digest('hex')
    .slice(0, 32);
  try {
    await pool.query(
      `INSERT INTO water_logs (user_id, oz, raw_text, source, dedupe_key)
       VALUES ($1, $2, $3, 'text', $4)
       ON CONFLICT (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`,
      [userId, oz, rawText, dedupeKey],
    );
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err), userId }, 'water_log.insert_failed');
    return null;
  }
  const dailyOz = (await getTodaysWaterOz(pool, userId)) ?? oz;
  const goalNote = dailyOz >= WATER_GOAL_MIN_OZ
    ? ` That's in your ${WATER_GOAL_MIN_OZ}-${WATER_GOAL_MAX_OZ} oz range.`
    : ` Aiming for ${WATER_GOAL_MIN_OZ}-${WATER_GOAL_MAX_OZ} oz today.`;
  logger.info({ userId, loggedOz: oz, dailyOz }, 'water_log.ok');
  return {
    text: `Logged ${oz} oz of water. You're at ${dailyOz} oz today.${goalNote}`,
    loggedOz: oz,
    dailyOz,
  };
}
