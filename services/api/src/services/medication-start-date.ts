/**
 * GLP-1 START DATE — deterministic capture + truth for "when did I start".
 *
 * Why this exists: "when did I start taking the injection" was (a) misrouted to
 * the next-shot-day intercept, and (b) when it did reach the model it FABRICATED
 * a date + week count + physical-appearance fluff ("September 15, 2024 … your 8th
 * week … your jawline …") — none of it from the stored `glp1_start_date`. The
 * governing rule from the user: Grace must NEVER fabricate a date (or any settings
 * datum). She answers from what's stored, and if it's missing or clearly wrong she
 * asks the user to confirm / set it — she never invents one.
 *
 * This module owns:
 *  - `isPlausibleStartDate` — a stored/parsed GLP-1 start date must fall in a
 *    sane window (GLP-1 era → today). "Jan 5, 1999" and any future date are NOT
 *    plausible, so we treat them as unknown and ask, rather than parroting them.
 *  - `parseStartDateStatement` — capture a start date the user STATES in chat
 *    ("I started Ozempic on May 3", "began the shots 6 weeks ago", "my first
 *    injection was 2026-05-01"). High-precision: needs a first-person onset + a
 *    parseable date, and the parsed date must be plausible — otherwise null (we
 *    never store garbage).
 *  - week-number math + the deterministic confirm/answer builders.
 *
 * Pure + deterministic (every function takes `now`), so it's trivially testable
 * and never drifts across timezones.
 */

const MONTHS: Record<string, number> = {
  january: 0, jan: 0,
  february: 1, feb: 1,
  march: 2, mar: 2,
  april: 3, apr: 3,
  may: 4,
  june: 5, jun: 5,
  july: 6, jul: 6,
  august: 7, aug: 7,
  september: 8, sep: 8, sept: 8,
  october: 9, oct: 9,
  november: 10, nov: 10,
  december: 11, dec: 11,
};

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** The earliest a GLP-1 start date could plausibly be (the modern GLP-1 era). */
const MIN_PLAUSIBLE_YEAR = 2015;

/** Format a UTC-anchored date as "May 3, 2026". */
export function formatStartDate(d: Date): string {
  return `${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

/** A GLP-1 start date is plausible if it's within [2015-01-01, today]. */
export function isPlausibleStartDate(date: Date | string | null | undefined, now: Date = new Date()): boolean {
  if (!date) return false;
  const d = typeof date === 'string' ? new Date(date) : date;
  if (Number.isNaN(d.getTime())) return false;
  if (d.getUTCFullYear() < MIN_PLAUSIBLE_YEAR) return false;
  // Not in the future (allow up to end of today in any timezone → +1 day slack).
  if (d.getTime() > now.getTime() + 86_400_000) return false;
  return true;
}

/** 1-indexed GLP-1 week number (week 1 = the first 7 days). */
export function glp1WeekNumber(start: Date, now: Date = new Date()): number {
  return Math.floor((now.getTime() - start.getTime()) / (7 * 86_400_000)) + 1;
}

/** A warm, human "N weeks/months ago" phrase for a plausible start date. */
export function timeSincePhrase(start: Date, now: Date = new Date()): string {
  const weeks = Math.floor((now.getTime() - start.getTime()) / (7 * 86_400_000));
  if (weeks <= 0) return 'this week';
  if (weeks === 1) return 'about a week ago';
  if (weeks < 9) return `about ${weeks} weeks ago`;
  const months = Math.round((now.getTime() - start.getTime()) / (30.44 * 86_400_000));
  if (months < 12) return `about ${months} months ago`;
  const years = Math.floor(months / 12);
  const rem = months % 12;
  if (rem === 0) return `about ${years} year${years === 1 ? '' : 's'} ago`;
  return `about ${years} year${years === 1 ? '' : 's'} and ${rem} month${rem === 1 ? '' : 's'} ago`;
}

// ── Onset detection ──────────────────────────────────────────────────────────
// A first-person statement that the user BEGAN their medication, with the onset
// bound DIRECTLY to the medication so an unrelated "start" can't be captured
// ("I started eating better 2 weeks ago after my injection" must NOT match — the
// onset there is about eating, not the drug). Two accepted shapes:
//   1. "my/the first shot|injection|dose|jab|pen …"  (the med IS the noun)
//   2. onset verb + optional connectors + a medication word/pronoun
// A medication NOUN (always unambiguous as the onset object).
const MED_NOUN =
  '(?:ozempic|wegovy|mounjaro|zepbound|saxenda|rybelsus|semaglutide|tirzepatide|glp-?1|glp|injections?|shots?|jabs?|pens?|the\\s+(?:medication|meds|treatment|drug)|meds?|medication|treatment)';
// A pronoun object. "it"/"them" are always objects (and are only reachable here
// when bound directly to the onset verb, e.g. "started (taking) it"). "this" is
// determiner-risky, so it counts ONLY as a standalone object followed by a time
// expression — "I started this 3 weeks ago" ✓, "I started this diet 3 weeks ago" ✗.
const MED_PRONOUN = '(?:it|them|this(?=\\s+(?:for|since|back|ago|about|around|in|on|last|\\d|a\\s+(?:day|week|month|year))))';
const ONSET_MED_RE = new RegExp(
  '\\b(?:' +
    '(?:my\\s+|the\\s+)?first\\s+(?:shot|injection|dose|jab|pen)\\b' +
    '|' +
    "(?:i\\s+(?:first\\s+)?(?:started|start|begun|began|begin)|i(?:'ve| have)\\s+been\\s+(?:on|taking)|been\\s+(?:on|taking))" +
    '\\s+(?:my\\s+|the\\s+|taking\\s+|on\\s+|using\\s+|doing\\s+|with\\s+)*' +
    '(?:' + MED_NOUN + '\\b|' + MED_PRONOUN + ')' +
  ')',
  'i',
);

export interface ParsedStartDate {
  iso: string;   // "2026-05-03"
  date: Date;    // UTC-midnight
}

/**
 * Parse a start date the user STATES in a chat message. Returns null unless there
 * is a clear first-person onset bound to the medication AND a parseable, PLAUSIBLE
 * date. Never returns an implausible date (we don't store garbage).
 */
export function parseStartDateStatement(text: string, now: Date = new Date()): ParsedStartDate | null {
  const s = (text ?? '').trim();
  if (!s) return null;
  if (!ONSET_MED_RE.test(s)) return null;

  const parsed = parseDateExpression(s, now);
  if (!parsed) return null;
  if (!isPlausibleStartDate(parsed, now)) return null;
  return { iso: toIso(parsed), date: parsed };
}

function toIso(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function mkUtc(year: number, month0: number, day: number): Date {
  return new Date(Date.UTC(year, month0, day));
}

/**
 * Extract a date from free text. Handles, in priority order:
 *  - relative: "6 weeks ago", "3 months ago", "a week ago", "last month", "2 years back"
 *  - ISO: 2026-05-03
 *  - "Month D[, YYYY]" / "D Month [YYYY]" / "Month YYYY" / "Month" (bare)
 *  - numeric M/D[/YYYY]
 * A date with no year resolves to the MOST RECENT PAST occurrence (never the
 * future). Returns a UTC-midnight Date, or null.
 */
export function parseDateExpression(text: string, now: Date = new Date()): Date | null {
  const s = text.toLowerCase();
  const todayUtc = mkUtc(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());

  // ── Relative ("N units ago" / "a unit ago" / "last week/month/year") ────────
  const rel = /\b(?:(\d{1,3})|a|an|one)\s+(day|week|month|year)s?\s+(?:ago|back)\b/.exec(s);
  if (rel) {
    const n = rel[1] ? parseInt(rel[1], 10) : 1;
    return subtractUnit(todayUtc, n, rel[2] as Unit);
  }
  // Duration since onset ("been on it for 8 weeks" / "for the past 2 months") →
  // started N units ago. Safe here: this parser is only invoked after an onset+med
  // match, so "for N weeks" reads as time-on-medication.
  const dur = /\bfor\s+(?:the\s+(?:past|last)\s+)?(?:(\d{1,3})|a|an)\s+(day|week|month|year)s?\b/.exec(s);
  if (dur) {
    const n = dur[1] ? parseInt(dur[1], 10) : 1;
    return subtractUnit(todayUtc, n, dur[2] as Unit);
  }
  const lastUnit = /\blast\s+(week|month|year)\b/.exec(s);
  if (lastUnit) return subtractUnit(todayUtc, 1, lastUnit[1] as Unit);

  // ── ISO YYYY-MM-DD ──────────────────────────────────────────────────────────
  const iso = /\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/.exec(s);
  if (iso) {
    const y = parseInt(iso[1] ?? '', 10);
    const m0 = parseInt(iso[2] ?? '', 10) - 1;
    const day = parseInt(iso[3] ?? '', 10);
    const d = mkUtc(y, m0, day);
    return validCalendar(d, y, m0, day) ? d : null;
  }

  // ── "Month D, YYYY" / "Month D" / "Month YYYY" / "Mon D" ───────────────────
  const monthName = '(january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sept|sep|october|oct|november|nov|december|dec)';
  const md = new RegExp(`\\b${monthName}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`).exec(s);
  if (md) {
    const mo = monthIdx(md[1]);
    const day = parseInt(md[2] ?? '', 10);
    if (mo != null && day >= 1 && day <= 31) {
      if (md[3]) return mkUtc(parseInt(md[3], 10), mo, day);
      return mostRecentPast(mo, day, todayUtc);
    }
  }
  // "D Month YYYY" / "D Month" / "D of Month"
  const dm = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${monthName}\\.?(?:,?\\s+(\\d{4}))?\\b`).exec(s);
  if (dm) {
    const mo = monthIdx(dm[2]);
    const day = parseInt(dm[1] ?? '', 10);
    if (mo != null && day >= 1 && day <= 31) {
      if (dm[3]) return mkUtc(parseInt(dm[3], 10), mo, day);
      return mostRecentPast(mo, day, todayUtc);
    }
  }
  // "in Month YYYY" / "Month YYYY" / bare "in March" → 1st of that month
  const monthYear = new RegExp(`\\b${monthName}\\.?\\s+(\\d{4})\\b`).exec(s);
  if (monthYear) {
    const mo = monthIdx(monthYear[1]);
    if (mo != null) return mkUtc(parseInt(monthYear[2] ?? '', 10), mo, 1);
  }
  const bareMonth = new RegExp(`\\b(?:in|since|around|about|early|mid|late)\\s+${monthName}\\.?\\b`).exec(s);
  if (bareMonth) {
    const mo = monthIdx(bareMonth[1]);
    if (mo != null) return mostRecentPast(mo, 1, todayUtc);
  }

  // ── Numeric M/D[/YYYY] or M/D/YY ────────────────────────────────────────────
  const num = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/.exec(s);
  if (num) {
    const mo = parseInt(num[1] ?? '', 10) - 1;
    const day = parseInt(num[2] ?? '', 10);
    if (mo >= 0 && mo <= 11 && day >= 1 && day <= 31) {
      if (num[3]) {
        let yr = parseInt(num[3], 10);
        if (yr < 100) yr += 2000;
        return mkUtc(yr, mo, day);
      }
      return mostRecentPast(mo, day, todayUtc);
    }
  }

  return null;
}

/** Month index (0-11) for a name/abbrev, or null. */
function monthIdx(name: string | undefined): number | null {
  if (!name) return null;
  const m = MONTHS[name.toLowerCase()];
  return m == null ? null : m;
}

type Unit = 'day' | 'week' | 'month' | 'year';

function subtractUnit(base: Date, n: number, unit: Unit): Date {
  const d = new Date(base.getTime());
  if (unit === 'day') d.setUTCDate(d.getUTCDate() - n);
  else if (unit === 'week') d.setUTCDate(d.getUTCDate() - n * 7);
  else if (unit === 'month') d.setUTCMonth(d.getUTCMonth() - n);
  else d.setUTCFullYear(d.getUTCFullYear() - n);
  return d;
}

/** The most recent PAST occurrence of month/day relative to today (this year, or
 *  last year if that date hasn't happened yet this year). */
function mostRecentPast(month0: number, day: number, todayUtc: Date): Date {
  const yr = todayUtc.getUTCFullYear();
  const thisYear = mkUtc(yr, month0, day);
  return thisYear.getTime() > todayUtc.getTime() ? mkUtc(yr - 1, month0, day) : thisYear;
}

function validCalendar(d: Date, y: number, m0: number, day: number): boolean {
  return d.getUTCFullYear() === y && d.getUTCMonth() === m0 && d.getUTCDate() === day;
}

// ── Deterministic reply builders ─────────────────────────────────────────────

/** Confirm a start date we just captured from the user's message. */
export function buildStartDateCaptureReply(date: Date, medName: string | null, now: Date = new Date()): string {
  const med = medName && medName.trim() ? medName.trim() : 'your GLP-1';
  const week = glp1WeekNumber(date, now);
  const weekPart = week >= 1 ? ` That puts you in week ${week} of ${med}.` : '';
  return `Got it — I've saved your start date as ${formatStartDate(date)}.${weekPart} You can adjust it anytime in Settings.`;
}

/**
 * Answer "when did I start" from the stored date. NEVER fabricates:
 *  - plausible date  → the real date + how long ago + week number.
 *  - missing date    → ask the user (offer Settings), don't guess.
 *  - implausible date ("Jan 5, 1999") → flag it and ask them to confirm, don't
 *    parrot the wrong value.
 */
export function buildStartDateAnswer(
  stored: Date | string | null | undefined,
  medName: string | null,
  settingsUrl: string,
  now: Date = new Date(),
): string {
  const med = medName && medName.trim() ? medName.trim() : 'your GLP-1';
  if (!stored) {
    return `I don't have your start date on file yet — when did you take your first ${med} shot? Tell me the date and I'll save it, or add it in Settings: ${settingsUrl}.`;
  }
  const d = typeof stored === 'string' ? new Date(stored) : stored;
  if (!isPlausibleStartDate(d, now)) {
    const shown = Number.isNaN(d.getTime()) ? null : formatStartDate(d);
    return `The start date I have on file${shown ? ` (${shown})` : ''} doesn't look right. When did you actually start ${med}? Tell me the date and I'll fix it, or update it in Settings: ${settingsUrl}.`;
  }
  const week = glp1WeekNumber(d, now);
  const weekPart = week >= 1 ? ` — that's ${timeSincePhrase(d, now)}, so you're in week ${week}` : '';
  return `You started ${med} on ${formatStartDate(d)}${weekPart}.`;
}
