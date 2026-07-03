/**
 * Temporal truth — the single, authoritative source of "what time is it for this
 * user" that gets injected into EVERY reply prompt (direct, compact, proactive).
 *
 * Why this exists: the model cannot know the real date. Left to guess, it invents
 * one (production bug: "Today is Tuesday, May 14, 2024" for a 2026 user, plus a
 * false "I have access to real-time information" claim). The old context injected
 * only the weekday ("Today is: Tuesday"), so the model filled in the month/year
 * itself. This module computes the FULL local date/time deterministically from the
 * user's timezone and hands the model everything it could be asked, so no phrasing
 * of "what day/date/time is it" can ever drift.
 *
 * Pure + deterministic: takes `now` so it's trivially unit-testable, and never
 * throws (a bad timezone falls back to a sensible default).
 */

const WEEKDAYS = [
  'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday',
] as const;

const DEFAULT_TZ = 'America/New_York';

export interface TemporalContext {
  timezone: string;
  /** 0 = Sunday … 6 = Saturday, in the user's local timezone. */
  weekdayIndex: number;
  weekday: string;
  /** ISO calendar date in the user's tz, e.g. "2026-07-03". */
  isoDate: string;
  year: number;
  /** Human date, e.g. "Saturday, July 3, 2026". */
  humanDate: string;
  /** Local wall-clock, e.g. "7:42 PM". */
  time12: string;
  hour24: number;
  /** night | morning | afternoon | evening. */
  timeOfDay: 'night' | 'morning' | 'afternoon' | 'evening';
  yesterdayHuman: string;
  tomorrowHuman: string;
  /** Next 7 calendar days (starting tomorrow), e.g. ["Sun Jul 4", …]. */
  next7Days: string[];
  /** True when the provided timezone was invalid and we fell back. */
  usedFallbackTz: boolean;
}

interface LocalParts { year: number; month: number; day: number; weekday: string; hour: number; minute: number }

function safeParts(now: Date, tz: string): LocalParts | null {
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      weekday: 'long', hour: '2-digit', minute: '2-digit', hour12: false,
    });
    const p = fmt.formatToParts(now);
    const get = (t: string) => p.find((x) => x.type === t)?.value ?? '';
    const year = parseInt(get('year'), 10);
    const month = parseInt(get('month'), 10);
    const day = parseInt(get('day'), 10);
    const weekday = get('weekday');
    // Intl renders midnight as "24" in hour12:false; normalize to 0.
    let hour = parseInt(get('hour'), 10);
    if (hour === 24) hour = 0;
    const minute = parseInt(get('minute'), 10);
    if (!year || !month || !day || !weekday) return null;
    return { year, month, day, weekday, hour, minute };
  } catch {
    return null;
  }
}

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const SHORT_MONTHS = MONTHS.map((m) => m.slice(0, 3));

/** Format a UTC-anchored calendar date (offset k days from a base) as "Weekday, Month D, YYYY". */
function humanFromUtc(baseUtcMs: number, k: number): { long: string; short: string; weekday: string } {
  const d = new Date(baseUtcMs + k * 86_400_000);
  const wd = WEEKDAYS[d.getUTCDay()] ?? 'Sunday';
  const mo = d.getUTCMonth();
  const day = d.getUTCDate();
  const yr = d.getUTCFullYear();
  const monthLong = MONTHS[mo] ?? '';
  const monthShort = SHORT_MONTHS[mo] ?? '';
  return {
    long: `${wd}, ${monthLong} ${day}, ${yr}`,
    short: `${wd.slice(0, 3)} ${monthShort} ${day}`,
    weekday: wd,
  };
}

/** A UTC-midnight epoch representing a local ISO date ("2026-07-03") — the safe
 *  base for walking calendar days in pure UTC. */
export function utcBaseFromIso(isoDate: string): number {
  const [y, m, d] = isoDate.split('-').map((n) => parseInt(n, 10));
  return Date.UTC(y || 1970, (m || 1) - 1, d || 1);
}

/** Format a calendar date `offsetDays` from a UTC-midnight base, e.g.
 *  { long: "Saturday, July 4, 2026", short: "Sat Jul 4", weekday: "Saturday" }. */
export function formatCalendarDate(baseUtcMs: number, offsetDays = 0): { long: string; short: string; weekday: string } {
  return humanFromUtc(baseUtcMs, offsetDays);
}

export function resolveTemporalContext(timezone: string | null | undefined, now: Date = new Date()): TemporalContext {
  const requested = (timezone || '').trim();
  let usedFallbackTz = false;
  let parts = requested ? safeParts(now, requested) : null;
  let tz = requested;
  if (!parts) {
    usedFallbackTz = !!requested || true; // fell back (either bad tz, or none provided)
    tz = DEFAULT_TZ;
    parts = safeParts(now, tz) ?? { year: 1970, month: 1, day: 1, weekday: 'Thursday', hour: 0, minute: 0 };
  }

  const { year, month, day, weekday, hour, minute } = parts;
  // A UTC midnight that REPRESENTS the user's local calendar day — safe to walk by
  // ±1 day in pure UTC (no DST math), then format back with getUTC*.
  const baseUtc = Date.UTC(year, month - 1, day);

  const timeOfDay = hour < 5 ? 'night' : hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : hour < 21 ? 'evening' : 'night';
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  const ampm = hour < 12 ? 'AM' : 'PM';
  const time12 = `${h12}:${String(minute).padStart(2, '0')} ${ampm}`;

  const today = humanFromUtc(baseUtc, 0);
  const next7Days = [1, 2, 3, 4, 5, 6, 7].map((k) => humanFromUtc(baseUtc, k).short);

  return {
    timezone: tz,
    weekdayIndex: WEEKDAYS.indexOf(weekday as (typeof WEEKDAYS)[number]),
    weekday,
    isoDate: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
    year,
    humanDate: today.long,
    time12,
    hour24: hour,
    timeOfDay,
    yesterdayHuman: humanFromUtc(baseUtc, -1).long,
    tomorrowHuman: humanFromUtc(baseUtc, 1).long,
    next7Days,
    usedFallbackTz,
  };
}

/**
 * The prompt block. Authoritative, compact, and phrased so the model treats it as
 * ground truth for ANY date/day/time question — and never claims real-time access.
 */
export function buildTemporalContextBlock(timezone: string | null | undefined, now: Date = new Date()): string {
  const t = resolveTemporalContext(timezone, now);
  return [
    'CURRENT DATE & TIME (authoritative — this is the real current date for THIS user; use it for any date/day/time question, never guess a date, never say you don\'t know today\'s date, never claim to have "real-time" access):',
    `- Right now it is ${t.humanDate}, ${t.time12} (${t.timezone}) — ${t.timeOfDay}.`,
    `- Yesterday was ${t.yesterdayHuman}. Tomorrow is ${t.tomorrowHuman}.`,
    `- The next 7 days are: ${t.next7Days.join(', ')}.`,
  ].join('\n');
}
