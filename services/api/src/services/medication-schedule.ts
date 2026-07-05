/**
 * Schedule truth for medication timing — the single deterministic source for
 * "when is my next / last injection / dose / shot / pill", cadence-aware.
 *
 * Why: the same question reached three different code paths in prod and gave
 * three answers — a right one ("next dose in 4 days"), a wrong explanation
 * ("that's your weight/muscle math"), and a flat denial ("I can't tell you when
 * your next injection is"). Everything timing-related now routes through here:
 * one computation, one voice, never a denial, cadence-correct for weekly
 * injectables AND daily pills/injectables.
 *
 * Pure + deterministic (takes `now`), reusing the temporal module's date math so
 * dates never drift across timezones/DST.
 */

import { resolveTemporalContext, utcBaseFromIso, formatCalendarDate } from './temporal-context.js';

export type MedicationType = 'weekly_injection' | 'daily_pill' | 'daily_injection' | 'unknown';
export type Cadence = 'weekly' | 'daily' | 'unknown';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function cadenceOf(t: MedicationType): Cadence {
  if (t === 'weekly_injection') return 'weekly';
  if (t === 'daily_pill' || t === 'daily_injection') return 'daily';
  return 'unknown';
}

/** The noun to use for the medication event, given its type. */
export function doseNoun(t: MedicationType): string {
  if (t === 'daily_pill') return 'dose';
  return 'shot';
}

export interface ScheduleInput {
  medicationType: MedicationType;
  medicationName?: string | null;
  injectionDay?: string | null; // weekday name, e.g. "Saturday"
  timezone?: string | null;
}

export interface InjectionSchedule {
  cadence: Cadence;
  medicationType: MedicationType;
  injectionDay: string | null;
  /** For weekly meds, whether we know the injection weekday. Daily meds don't need one. */
  knowsSchedule: boolean;
  isToday: boolean;
  daysUntilNext: number | null;
  nextHuman: string | null;   // "Saturday, July 4, 2026"
  nextShort: string | null;   // "Sat Jul 4"
  daysSinceLast: number | null;
  lastHuman: string | null;
}

/**
 * Compute the medication schedule deterministically from the profile + timezone.
 * Weekly: next/last occurrence of `injectionDay`. Daily: every day (next = today).
 */
export function computeInjectionSchedule(input: ScheduleInput, now: Date = new Date()): InjectionSchedule {
  const cadence = cadenceOf(input.medicationType);
  const t = resolveTemporalContext(input.timezone, now);
  const base = utcBaseFromIso(t.isoDate);
  const todayIdx = t.weekdayIndex >= 0 ? t.weekdayIndex : 0;

  const out: InjectionSchedule = {
    cadence,
    medicationType: input.medicationType,
    injectionDay: input.injectionDay ?? null,
    knowsSchedule: false,
    isToday: false,
    daysUntilNext: null,
    nextHuman: null,
    nextShort: null,
    daysSinceLast: null,
    lastHuman: null,
  };

  if (cadence === 'daily') {
    // A daily medication has a dose every day; "next" is today, "last" was yesterday.
    out.knowsSchedule = true;
    out.isToday = true;
    out.daysUntilNext = 0;
    const today = formatCalendarDate(base, 0);
    out.nextHuman = today.long;
    out.nextShort = today.short;
    out.daysSinceLast = 1;
    out.lastHuman = formatCalendarDate(base, -1).long;
    return out;
  }

  // Weekly (or unknown that still has an injection day we can honor).
  const injIdx = input.injectionDay ? WEEKDAYS.indexOf(input.injectionDay) : -1;
  if (injIdx === -1) {
    // We don't know the day — knowsSchedule stays false so callers ASK, never deny.
    return out;
  }

  out.knowsSchedule = true;
  const untilNext = (injIdx - todayIdx + 7) % 7; // 0 = today
  out.isToday = untilNext === 0;
  out.daysUntilNext = untilNext;
  const next = formatCalendarDate(base, untilNext);
  out.nextHuman = next.long;
  out.nextShort = next.short;

  // Last occurrence: if today is injection day, the previous one was 7 days ago.
  const sinceLast = ((todayIdx - injIdx + 7) % 7) || 7;
  out.daysSinceLast = sinceLast;
  out.lastHuman = formatCalendarDate(base, -sinceLast).long;

  return out;
}

// ── Intent detection ─────────────────────────────────────────────────────────

export type InjectionTimingIntent = 'next' | 'last' | 'today' | null;

const MED_EVENT = '(injection|injections|shot|shots|jab|jabs|dose|doses|dosage|pen|pens|pill|pills|meds?|medication)';
const NEXT_RE = new RegExp(
  `\\b(when('?s| is| will| do| does| should)?|what day|which day|how many days?\\s+(until|till|til|before)|how long\\s+(until|till|til|before)|next)\\b[^?]*\\b(next\\s+|upcoming\\s+)?${MED_EVENT}\\b`,
  'i',
);
const NEXT_VERB_RE = /\b(when|what day|which day)\b[^?]*\b(do|should) i\b[^?]*\b(inject|take|dose|jab)\b/i;
const LAST_RE = new RegExp(
  `\\b(when('?s| was| did)?|what day|how many days?\\s+(since|ago)|how long ago)\\b[^?]*\\b(last|previous|most recent)\\s+${MED_EVENT}\\b`,
  'i',
);
const LAST_VERB_RE = /\b(when did i (last|previously)|how long (ago|since) did i)\b[^?]*\b(inject|take|dose|jab)\b/i;
const TODAY_RE = new RegExp(
  `\\b(is (today|it) my\\s+(injection|shot|dose|jab)\\s*(day)?|is today (a |an )?(injection|shot|dose)\\s*day|do i (inject|take|jab|dose)\\s+today|am i (injecting|dosing)\\s+today)\\b`,
  'i',
);

// ONSET (when they STARTED the medication) is a different question from timing
// (when the NEXT/LAST dose is). "When I started taking the injection" must NOT
// resolve to "today is your shot day" — it routes to the start-date handler. We
// exclude onset phrasing here so timing never steals it, in either reply path.
const ONSET_RE =
  /\b(when(?:'?s| is| was| did)?\s+(?:i\s+)?(?:first\s+)?(?:start|started|starting|begin|began|beginning)\b|i\s+(?:first\s+)?(?:start|started|begin|began)\b|how long\s+(?:have i been|since i (?:start|began|first))|(?:my\s+)?start\s+date|first\s+(?:shot|injection|dose|jab)\b)/i;

/** Classify a chat message's injection/dose TIMING intent (cheap deterministic regex). */
export function detectInjectionTimingIntent(text: string): InjectionTimingIntent {
  const s = (text ?? '').trim();
  if (!s) return null;
  // A "when did I START" question is about onset, not the next/last dose.
  if (ONSET_RE.test(s)) return null;
  if (TODAY_RE.test(s)) return 'today';
  if (LAST_RE.test(s) || LAST_VERB_RE.test(s)) return 'last';
  if (NEXT_RE.test(s) || NEXT_VERB_RE.test(s)) return 'next';
  return null;
}

// ── Deterministic reply builder (never denies) ───────────────────────────────

export function buildInjectionTimingReply(
  intent: Exclude<InjectionTimingIntent, null>,
  sched: InjectionSchedule,
  medicationName: string | null,
  settingsUrl: string,
): string {
  const med = medicationName && medicationName.trim() ? medicationName.trim() : null;
  const noun = doseNoun(sched.medicationType);

  // We don't know the schedule → ASK for the missing day, never deny capability.
  if (!sched.knowsSchedule) {
    if (sched.cadence === 'daily') {
      return `${med ? `${med} is` : 'It\'s'} a daily medication, so you have a ${noun} every day. If you want, tell me the time you usually take it and I'll keep it in mind.`;
    }
    return `Which day of the week do you take ${med ?? 'it'}? Tell me and I'll keep track of your ${noun} day so I can always let you know when the next one's coming — you can also set it in Settings: ${settingsUrl}.`;
  }

  if (sched.cadence === 'daily') {
    if (intent === 'last') return `${med ?? 'It'} is a daily medication, so your last ${noun} was yesterday (or earlier today).`;
    if (intent === 'today') return `Yes — ${med ?? 'it'} is daily, so you have a ${noun} every day, including today.`;
    return `${med ?? 'It'} is a daily medication — you take a ${noun} every day, so there's one today. Just keep to your usual time.`;
  }

  // Weekly.
  const dayName = sched.injectionDay;
  if (intent === 'last') {
    return `Your last ${noun} was ${sched.lastHuman} — ${sched.daysSinceLast} day${sched.daysSinceLast === 1 ? '' : 's'} ago.`;
  }
  if (intent === 'today') {
    if (sched.isToday) return `Yes — today (${dayName}) is your ${noun} day. 💙`;
    return `Not today — your ${noun} day is ${dayName}. The next one is ${nextPhrase(sched)} (${sched.nextHuman}).`;
  }
  // next
  if (sched.isToday) return `Today (${dayName}) is your ${med ? `${med} ` : ''}${noun} day.`;
  return `Your next ${med ? `${med} ` : ''}${noun} is ${nextPhrase(sched)} — ${sched.nextHuman}.`;
}

function nextPhrase(sched: InjectionSchedule): string {
  const d = sched.daysUntilNext;
  if (d == null) return 'coming up';
  if (d === 0) return 'today';
  if (d === 1) return 'tomorrow';
  return `in ${d} days`;
}

/**
 * A compact schedule FACT line for injection into the reply prompt (so any
 * phrasing the model does handle is grounded, and it never denies the capability).
 */
export function buildScheduleFactLine(sched: InjectionSchedule, medicationName: string | null): string | null {
  const med = medicationName && medicationName.trim() ? medicationName.trim() : 'their medication';
  const noun = doseNoun(sched.medicationType);
  if (sched.cadence === 'daily') {
    return `MEDICATION SCHEDULE: ${med} is DAILY — a ${noun} every day. If they ask when their next dose is, it's today; never say you can't tell them.`;
  }
  if (!sched.knowsSchedule) return null; // no day known — the gather flow handles it
  if (sched.isToday) {
    return `MEDICATION SCHEDULE: today is their ${med} ${noun} day (${sched.injectionDay}). Next after today is in 7 days. Their last ${noun} was ${sched.lastHuman}. Never say you can't tell them their injection timing.`;
  }
  return `MEDICATION SCHEDULE: their ${med} ${noun} day is ${sched.injectionDay}. Next ${noun}: ${nextPhrase(sched)} (${sched.nextHuman}). Last ${noun}: ${sched.lastHuman} (${sched.daysSinceLast} days ago). Never say you can't tell them their injection timing — you know it.`;
}
