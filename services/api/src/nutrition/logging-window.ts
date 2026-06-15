/**
 * Per-user food "logging day" window (2026-06-15).
 *
 * The food / protein / calorie day starts at each user's wake_time (NOT local
 * midnight) and runs 24 hours to the next wake_time. So someone who wakes at
 * 7:00 AM has a day of [07:00, 07:00 next day); a 1 AM snack counts toward the
 * day that began at the previous 7:00 AM.
 *
 * A row's logging day is its LOCAL timestamp shifted back by wake_time, taken
 * as a date:
 *     ((created_at AT TIME ZONE tz) - wake)::date
 * "Today" = that value equals the same expression evaluated for now().
 *
 * Missing/blank wake_time falls back to 07:00 (safe default). Existing rows are
 * never moved — totals are computed dynamically from this window, so changing
 * wake_time in Settings immediately changes which rows count as "today".
 *
 * EVERY food_logs "today"/per-day query AND the Redis cache key MUST use these
 * helpers (SQL) and computeUserLoggingDay (JS) so the window is identical
 * across the DB and the cache. Do NOT hand-roll the boundary anywhere else.
 */

/** Default wake time when the user hasn't set one. */
export const DEFAULT_WAKE_TIME = '07:00';

/**
 * CTE named `user_tz` exposing the user's timezone (`tz`) and wake offset
 * (`wake`, a Postgres interval) for the user identified by `$1`
 * (phone == food_logs.user_id). Prepend to a food_logs query.
 */
export const USER_DAY_CTE = `WITH user_tz AS (
         SELECT COALESCE(NULLIF(timezone, ''), 'UTC') AS tz,
                COALESCE(NULLIF(wake_time, ''), '${DEFAULT_WAKE_TIME}')::interval AS wake
         FROM users WHERE phone = $1
       )`;

/** SQL: the logging-day date for a timestamp column (or `now()`). */
export const userDayExpr = (col: string): string =>
  `((${col} AT TIME ZONE user_tz.tz) - user_tz.wake)::date`;

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
 * `((now() AT TIME ZONE tz) - wake)::date`.
 */
export function computeUserLoggingDay(
  timezone: string | null | undefined,
  wakeTime: string | null | undefined,
  now: Date = new Date(),
): string {
  const tz = timezone && timezone.length > 0 ? timezone : 'UTC';
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(now);
  } catch {
    parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'UTC',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(now);
  }
  const get = (t: string): number => Number(parts.find((p) => p.type === t)?.value ?? '0');
  const y = get('year'), mo = get('month'), d = get('day');
  let h = get('hour');
  if (h === 24) h = 0; // some environments emit '24' at local midnight
  const mi = get('minute');
  const [wh, wm] = parseWakeTime(wakeTime);
  // Shift the local date back one day when the current local time is before
  // wake — that places pre-wake hours in the day that began the prior wake.
  let date = new Date(Date.UTC(y, mo - 1, d));
  if (h * 60 + mi < wh * 60 + wm) date = new Date(date.getTime() - 86_400_000);
  return date.toISOString().slice(0, 10);
}
