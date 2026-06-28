/**
 * Reminder service (2026-06-15).
 *
 * The single source of truth for ANSWERING user questions about their
 * reminders / check-ins in chat. Grace is an INTERFACE to the reminder system,
 * not a reminder manager:
 *   - The Settings page OWNS configuration (wake/sleep time, cadence, injection day).
 *   - The scheduler OWNS delivery.
 *   - Grace OWNS explanation: she reads the actual config and explains it,
 *     redirecting to Settings for any change. She NEVER creates/edits/disables
 *     reminders in chat, and she NEVER exposes platform/LLM limitations
 *     ("I can't send reminders", "I don't have the ability to initiate messages").
 *
 * Schedule math is kept in lockstep with the scheduler (scheduler.ts):
 *   - morning  → wake_time (+ MORNING_OFFSET_MIN)
 *   - midday   → Mon/Wed/Fri ~11am–2pm
 *   - evening  → Tue/Thu/Sun, sleep_time − EVENING_LEAD_MIN
 *   - injection day → injection-specific flow REPLACES the regular schedule
 *   - quiet hours 21:00–07:00 local: nothing fires
 *   - checkin_days_interval: a day can be skipped entirely (every-N-days)
 *   - paused: no reminders at all
 *
 * Times are computed DYNAMICALLY from the user's wake/sleep settings — never
 * hardcoded clock times. Pure functions (no I/O) so they're easy to unit-test.
 */

export interface ReminderUser {
  timezone?: string | null;
  wake_time?: string | null;
  sleep_time?: string | null;
  injection_day?: string | null;
  checkin_count_per_day?: number | null;
  checkin_days_interval?: number | null;
  paused?: boolean | null;
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;
const MIDDAY_DAYS = new Set([1, 3, 5]); // Mon, Wed, Fri
const EVENING_DAYS = new Set([2, 4, 0]); // Tue, Thu, Sun

/** Offset (minutes) applied to wake_time for the morning reminder window. */
export const MORNING_OFFSET_MIN = 0;
/** Lead time (minutes) before sleep_time for the evening wind-down reminder. */
export const EVENING_LEAD_MIN = 90;

const QUIET_START_MIN = 21 * 60; // 21:00 local
const QUIET_END_MIN = 7 * 60; // 07:00 local

export type ReminderKind = 'morning' | 'midday' | 'evening' | 'injection' | 'none';

export interface NextReminder {
  kind: ReminderKind;
  /** Human "when": "this morning", "this evening", "tomorrow morning", "Monday morning". */
  when: string;
  /** Clock label like "8:00 AM" (null for the fuzzy midday window). */
  timeLabel: string | null;
  /** Full phrase: "tomorrow morning around 8:00 AM". */
  phrase: string;
}

export interface ReminderSchedule {
  enabled: boolean;
  paused: boolean;
  timezone: string;
  wakeLabel: string;
  sleepLabel: string | null;
  morningLabel: string;
  eveningLabel: string | null;
  countPerDay: number;
  daysInterval: number;
  injectionDay: string | null;
  isInjectionDayToday: boolean;
  next: NextReminder | null;
}

/** Read the user's local wall clock as a Date in local fields. */
function localNow(tz: string, date = new Date()): Date {
  const safeTz = tz || 'America/New_York';
  for (const zone of [safeTz, 'America/New_York']) {
    try {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: zone,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
      }).formatToParts(date);
      const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '0';
      return new Date(`${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}`);
    } catch {
      /* try next zone */
    }
  }
  return date;
}

/** Days since the unix epoch for a local calendar date (matches scheduler phase). */
function dayNumber(localDate: Date): number {
  return Math.floor(Date.parse(localDate.toISOString().slice(0, 10)) / 86_400_000);
}

function parseHm(value: string | null | undefined, fallback: [number, number]): [number, number] {
  if (!value) return fallback;
  const [h, m] = value.split(':').map(Number);
  return [Number.isFinite(h) ? h! : fallback[0], Number.isFinite(m) ? m! : fallback[1]];
}

/** "8:00 AM" / "8:30 PM". */
export function formatClock(h: number, m: number): string {
  const period = h < 12 ? 'AM' : 'PM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${period}`;
}

/**
 * Morning "when" phrase that always names the actual day, so a reminder answer
 * is never ambiguous about which day it means:
 *   offset 0 → "this morning"
 *   offset 1 → "tomorrow (Sunday) morning"  (keeps "tomorrow" warmth + the day)
 *   offset≥2 → "Sunday morning"
 */
function morningWhen(offset: number, dow: number): string {
  if (offset === 0) return 'this morning';
  if (offset === 1) return `tomorrow (${DAYS[dow]}) morning`;
  return `${DAYS[dow]} morning`;
}

/** Is the given local calendar date a scheduled (non-skipped) day? */
function dayEligible(localDate: Date, daysInterval: number): boolean {
  if (daysInterval <= 1) return true;
  return dayNumber(localDate) % daysInterval === 0;
}

function addLocalDays(localDate: Date, days: number): Date {
  const d = new Date(localDate);
  d.setDate(d.getDate() + days);
  return d;
}

/**
 * Compute the user's reminder schedule + next reminder, deterministically, from
 * their profile. `now` is injectable for tests.
 */
export function computeReminderSchedule(user: ReminderUser, now: Date = new Date()): ReminderSchedule {
  const timezone = user.timezone || 'America/New_York';
  const nowLocal = localNow(timezone, now);
  const [wh, wm] = parseHm(user.wake_time, [8, 0]);
  const [sh, sm] = parseHm(user.sleep_time, [22, 0]);
  const wakeMin = Math.max(wh * 60 + wm + MORNING_OFFSET_MIN, QUIET_END_MIN);
  const eveningMin = sh * 60 + sm - EVENING_LEAD_MIN;
  const morningLabel = formatClock(Math.floor(wakeMin / 60), wakeMin % 60);
  const sleepLabel = user.sleep_time ? formatClock(sh, sm) : null;
  const eveningLabel = user.sleep_time && eveningMin > 0 && eveningMin < QUIET_START_MIN
    ? formatClock(Math.floor(eveningMin / 60), eveningMin % 60)
    : null;
  const countPerDay = Math.min(3, Math.max(1, user.checkin_count_per_day ?? 2));
  const daysInterval = Math.max(1, user.checkin_days_interval ?? 1);
  const injectionDay = user.injection_day ?? null;
  const isInjectionDayToday = !!injectionDay && injectionDay === DAYS[nowLocal.getDay()];
  const paused = !!user.paused;

  const next = paused ? null : computeNext(nowLocal, {
    wakeMin, eveningMin, eveningLabel, daysInterval, injectionDay,
  });

  return {
    enabled: !paused,
    paused,
    timezone,
    wakeLabel: morningLabel,
    sleepLabel,
    morningLabel,
    eveningLabel,
    countPerDay,
    daysInterval,
    injectionDay,
    isInjectionDayToday,
    next,
  };
}

function computeNext(
  nowLocal: Date,
  cfg: {
    wakeMin: number;
    eveningMin: number;
    eveningLabel: string | null;
    daysInterval: number;
    injectionDay: string | null;
  },
): NextReminder | null {
  const nowMin = nowLocal.getHours() * 60 + nowLocal.getMinutes();
  const wakeLabel = formatClock(Math.floor(cfg.wakeMin / 60), cfg.wakeMin % 60);

  // Walk forward up to a week to find the next eligible occurrence.
  for (let offset = 0; offset <= 7; offset++) {
    const day = addLocalDays(nowLocal, offset);
    const dow = day.getDay();
    const isInjDay = !!cfg.injectionDay && cfg.injectionDay === DAYS[dow];
    const whenPrefix = offset === 0 ? 'this' : offset === 1 ? 'tomorrow' : DAYS[dow];

    // Injection day replaces the regular schedule with the injection flow.
    if (isInjDay) {
      // Morning injection message at wake time.
      if (offset > 0 || nowMin <= cfg.wakeMin + 60) {
        const when = morningWhen(offset, dow);
        return { kind: 'injection', when, timeLabel: wakeLabel, phrase: `${when} around ${wakeLabel} (your injection-day check-in)` };
      }
      // Past the morning window on injection day → the follow-up comes later today.
      if (offset === 0) {
        return { kind: 'injection', when: 'later today', timeLabel: null, phrase: 'later today (your injection-day follow-up)' };
      }
      continue;
    }

    if (!dayEligible(day, cfg.daysInterval)) continue;

    // Morning.
    if (offset > 0 || nowMin <= cfg.wakeMin + 60) {
      const when = morningWhen(offset, dow);
      return { kind: 'morning', when, timeLabel: wakeLabel, phrase: `${when} around ${wakeLabel}` };
    }

    // Same-day midday (Mon/Wed/Fri) — only relevant for offset 0.
    if (offset === 0 && MIDDAY_DAYS.has(dow) && nowMin <= 14 * 60) {
      return { kind: 'midday', when: 'today', timeLabel: null, phrase: 'today around midday (between 11 AM and 2 PM)' };
    }

    // Same-day evening (Tue/Thu/Sun) — only relevant for offset 0.
    if (offset === 0 && EVENING_DAYS.has(dow) && cfg.eveningLabel && nowMin <= cfg.eveningMin) {
      return { kind: 'evening', when: 'this evening', timeLabel: cfg.eveningLabel, phrase: `this evening around ${cfg.eveningLabel}` };
    }

    // Nothing left today — keep walking to the next eligible morning.
    if (offset === 0) continue;
    void whenPrefix;
  }
  return null;
}

// ── Chat intent detection ───────────────────────────────────────────────────

// "When is my next reminder?", "what time will you text me?", "do I have
// reminders?", "are reminders on?" — a STATUS / explanation request.
const REMINDER_STATUS_RE =
  /\b(when('?s| is| will| are)?\s+(my\s+)?(next\s+)?(reminders?|check.?ins?|messages?|texts?)|what time (will|do) you (text|message|check|remind)|when (will|do) you (text|message|check|remind)|will you (text|message|remind|check)\b[^?]{0,30}\b(tomorrow|today|morning|evening|tonight)|(?:do|have) i (have|got)\s+(any\s+)?(reminders?|check.?ins?)\b|are (my\s+)?(reminders?|check.?ins?)\s+(on|enabled|set up|scheduled|turned on|off)|is (my\s+)?(reminder|check.?in)\s+(on|set|scheduled)|(do you|would you|will you)\s+(send|do)\s+(me\s+)?(a\s+|any\s+)?(reminders?|check.?ins?)\b)/i;

// "How do reminders work?", "how often do you text?", "explain reminders".
const REMINDER_EXPLAIN_RE =
  /\b(how (do|does|often)\s+(your\s+|the\s+|my\s+)?(reminders?|check.?ins?|messages?)\s+(work|happen|come)|how (often|many times) (do|will) you (text|message|check|remind)|how many (reminders?|check.?ins?|messages?)\s+(a day|per day|daily|do i get)|explain (the\s+|my\s+)?(reminders?|check.?ins?)|how do you (decide when to|know when to) (text|message|remind))\b/i;

// "Remind me at 3pm", "set a reminder for 6", "can you remind me to ..." — a
// CHANGE / custom-reminder request → Settings (Grace can't customize in chat).
const REMINDER_CHANGE_RE =
  /\b(remind me (at|every|to|in|tomorrow|tonight|later|each|on)|set (a |up a )?reminder|schedule (a )?reminder|can you remind me|could you remind me|send me a reminder (at|every|on|tomorrow)|add (a )?reminder|turn (on|off) (my )?reminders|disable (my )?reminders|enable (my )?reminders|change (my )?reminder (time|times|to))\b/i;

export type ReminderIntent = 'next' | 'explain' | 'change' | null;

/** Classify a chat message's reminder intent (deterministic, cheap regex). */
export function detectReminderIntent(text: string): ReminderIntent {
  const t = (text ?? '').trim();
  if (t.length === 0) return null;
  // Change requests win — "can you remind me at 3pm" is a change, not a status.
  if (REMINDER_CHANGE_RE.test(t)) return 'change';
  if (REMINDER_STATUS_RE.test(t)) return 'next';
  if (REMINDER_EXPLAIN_RE.test(t)) return 'explain';
  return null;
}

// ── Reply builders (Grace's voice: explain + redirect, never deny) ──────────

/** Answer "when is my next reminder?" / "would you send a reminder tomorrow?" */
export function buildNextReminderReply(user: ReminderUser, settingsUrl: string, now: Date = new Date()): string {
  const sched = computeReminderSchedule(user, now);
  if (sched.paused) {
    return `Your reminders are paused right now, so I won't send scheduled check-ins until you turn them back on. You can do that anytime in Settings: ${settingsUrl}`;
  }
  if (!sched.next) {
    return `Your reminders are on. You can see and adjust the timing anytime in Settings: ${settingsUrl}`;
  }
  if (sched.isInjectionDayToday && sched.next.kind === 'injection') {
    return `Your next reminder is ${sched.next.phrase}. Today's an injection day, so it replaces the usual check-ins. You can adjust your reminder times in Settings: ${settingsUrl}`;
  }
  // Phrase the basis correctly: morning reminders follow wake time, evening
  // ones follow sleep time. (Prod bug: always said "based on your wake-up time"
  // even for an evening reminder.)
  const basis = sched.next.kind === 'evening' ? 'your bedtime' : sched.next.kind === 'morning' ? 'your wake-up time' : 'your settings';
  return `Your next reminder is ${sched.next.phrase}, based on ${basis}. Want a different time? Tell me when you usually wake up and head to bed, or set it in Settings: ${settingsUrl}`;
}

/** Answer "how do reminders work?" / "how often do you text?" */
export function buildReminderExplainReply(user: ReminderUser, settingsUrl: string, now: Date = new Date()): string {
  const sched = computeReminderSchedule(user, now);
  if (sched.paused) {
    return `Reminders are paused right now. When they're on, I send up to ${sched.countPerDay} a day — a morning check-in around your wake-up time, and sometimes an evening one before bed. You can turn them back on in Settings: ${settingsUrl}`;
  }
  const evening = sched.eveningLabel ? `, and an evening wind-down around ${sched.eveningLabel} on some days` : '';
  return `I send up to ${sched.countPerDay} check-in${sched.countPerDay === 1 ? '' : 's'} a day — a morning one around ${sched.morningLabel}${evening}. Times follow your wake and sleep settings, so to change them just update your preferences in Settings: ${settingsUrl}`;
}

/** Answer a CHANGE / custom-reminder request — redirect to Settings, never deny capability. */
export function buildReminderChangeReply(settingsUrl: string): string {
  return `I can't customize reminder times through chat, but you can set exactly when reminders arrive in Settings — just update your wake-up time or reminder preferences there: ${settingsUrl}`;
}
