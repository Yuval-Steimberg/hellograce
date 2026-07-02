/**
 * Per-user food "logging day" window (2026-07-02).
 *
 * The food / protein / calorie day is the user's LOCAL CALENDAR DAY: it runs
 * from 12:00 AM to 11:59 PM in their timezone, and totals reset at local
 * midnight. In practice this is exactly "from when you wake up until 11:59 PM"
 * for anyone asleep overnight — the day is already fresh by the time they wake,
 * and it closes at 11:59 PM the same night. (Superseded the earlier
 * wake_time-to-next-wake_time window, which let a day bleed ~7h past midnight.)
 *
 * A row's logging day is simply its LOCAL date:
 *     (created_at AT TIME ZONE tz)::date
 * "Today" = that value equals the same expression evaluated for now().
 *
 * Existing rows are never moved — totals are computed dynamically from this
 * window, so a timezone change in Settings immediately re-buckets "today".
 *
 * EVERY food_logs "today"/per-day query AND the Redis cache key MUST use these
 * helpers (SQL) and computeUserLoggingDay (JS) so the window is identical
 * across the DB and the cache. Do NOT hand-roll the boundary anywhere else.
 */

/** Default wake time when the user hasn't set one. Retained for callers that
 *  still read a wake time; the food-day boundary no longer depends on it. */
export const DEFAULT_WAKE_TIME = '07:00';

/**
 * CTE named `user_tz` exposing the user's timezone (`tz`) for the user
 * identified by `$1` (phone == food_logs.user_id). Prepend to a food_logs query.
 * (A `wake` interval is still selected for backward compatibility with any
 * query that references it, but the day boundary itself is local midnight.)
 */
export const USER_DAY_CTE = `WITH user_tz AS (
         SELECT COALESCE(NULLIF(timezone, ''), 'UTC') AS tz,
                COALESCE(NULLIF(wake_time, ''), '${DEFAULT_WAKE_TIME}')::interval AS wake
         FROM users WHERE phone = $1
       )`;

/** SQL: the logging-day date for a timestamp column (or `now()`) — LOCAL
 *  calendar day in the user's timezone (midnight → 11:59 PM). */
export const userDayExpr = (col: string): string =>
  `(${col} AT TIME ZONE user_tz.tz)::date`;

/** SQL predicate: the row's timestamp column is in the CURRENT logging day. */
export const isCurrentUserDay = (col: string): string =>
  `${userDayExpr(col)} = ${userDayExpr('now()')}`;

/** Parse a "HH:MM" wake string into [hour, minute], defaulting to 07:00. */
export function parseWakeTime(wake: string | null | undefined): [number, number] {
  const m = /^(\d{1,2}):(\d{2})/.exec((wake ?? '').trim());
  if (!m) return [7, 0];
  const h = Math.min(23, Math.max(0, Number(m[1])));
  const mi = Math.min(59, Math.max(0, Number(m[2])));
  return [h, mi];
}

/**
 * JS twin of the SQL window: the user's current logging-day date (YYYY-MM-DD),
 * used as the Redis cache key so L2 matches the DB exactly. Equivalent to
 * `(now() AT TIME ZONE tz)::date` — the LOCAL calendar day.
 *
 * `wakeTime` is accepted for signature compatibility with existing callers but
 * no longer affects the boundary (the day is the local calendar day).
 */
export function computeUserLoggingDay(
  timezone: string | null | undefined,
  _wakeTime?: string | null | undefined,
  now: Date = new Date(),
): string {
  const tz = timezone && timezone.length > 0 ? timezone : 'UTC';
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric', month: '2-digit', day: '2-digit', hour12: false,
    }).formatToParts(now);
  } catch {
    parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'UTC',
      year: 'numeric', month: '2-digit', day: '2-digit', hour12: false,
    }).formatToParts(now);
  }
  const get = (t: string): number => Number(parts.find((p) => p.type === t)?.value ?? '0');
  const y = get('year'), mo = get('month'), d = get('day');
  return new Date(Date.UTC(y, mo - 1, d)).toISOString().slice(0, 10);
}
