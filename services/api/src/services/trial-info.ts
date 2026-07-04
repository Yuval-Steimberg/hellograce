/**
 * Trial-status answers — deterministic, so Grace never invents a trial length.
 *
 * Production failure (from the Nudge-style review): a user was told the trial was
 * "7 days" but got cut off at 3 — a broken-promise churn, not a price objection.
 * Root cause: the access gate is 3 days (webhook.ts) but nothing GROUNDED that in
 * the reply path, so the LLM guessed. This module is the single source of truth
 * for "how long is my trial / when does it end / when am I charged", computed from
 * `trial_start` + TRIAL_DAYS. The webhook access gate imports TRIAL_DAYS from here
 * too, so the number can never drift between the gate and what Grace says.
 */

/** The free-trial length in days. THE single source of truth — the webhook
 *  access gate imports this so "3 days" is stated identically everywhere. */
export const TRIAL_DAYS = 3;

const DAY_MS = 24 * 3_600_000;

export type TrialIntent = 'length' | 'billing' | null;

const TRIAL_LENGTH_RE =
  /\b(how\s+(long|many\s+days?)\b[^?]*\b(trial|free)|trial\b[^?]*\b(how\s+long|left|remaining|end|over|last|expire|up)|when\b[^?]*\btrial\b[^?]*\b(end|over|up|expire|start)|(days?|time)\s+(left|remaining)\b[^?]*\btrial|my\s+trial\b|free\s+trial\b[^?]*\b(how\s+long|when|left))/i;

const BILLING_RE =
  /\b(when\b[^?]*\b(charged?|billed?|pay|paid|charge\s+me)|do\s+i\s+(have\s+to\s+)?pay\b|is\s+(this|it|grace)\s+free\b|how\s+much\b[^?]*\b(cost|charge|pay|is\s+(this|it|grace))|start\s+(charging|billing)|when\s+does\s+it\s+cost)/i;

/**
 * Detect an explicit trial-length / billing-timing question. Kept tight so a
 * passing mention ("free to eat whatever") doesn't trigger — it requires an
 * explicit trial/charge phrasing.
 */
export function detectTrialQuestion(text: string): TrialIntent {
  const t = (text ?? '').trim();
  if (t.length === 0 || t.length > 240) return null;
  if (TRIAL_LENGTH_RE.test(t)) return 'length';
  if (BILLING_RE.test(t)) return 'billing';
  return null;
}

export interface TrialUser {
  trial_start?: string | Date | null;
  is_paid?: boolean | null;
  is_pro?: boolean | null;
  timezone?: string | null;
}

function fmtDate(d: Date, tz: string | null | undefined): string {
  try {
    return new Intl.DateTimeFormat('en-US', {
      month: 'short', day: 'numeric', timeZone: tz || 'UTC',
    }).format(d);
  } catch {
    return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(d);
  }
}

/** Whole days left in the trial (0 when it has ended). */
export function trialDaysLeft(trialStart: Date, now: Date): number {
  const end = trialStart.getTime() + TRIAL_DAYS * DAY_MS;
  return Math.max(0, Math.ceil((end - now.getTime()) / DAY_MS));
}

/**
 * Build the deterministic trial-status reply. Correctness-critical: this is the
 * exact answer Grace gives about trial length/timing, never an LLM guess.
 */
export function buildTrialReply(user: TrialUser, intent: TrialIntent, now: Date = new Date()): string {
  if (user.is_paid || user.is_pro) {
    return "You're all set on the paid plan — no trial clock ticking, I'm here for the long haul. 🧡";
  }

  const ts = user.trial_start ? new Date(user.trial_start) : null;
  if (!ts || Number.isNaN(ts.getTime())) {
    return `Once you're set up you get a free ${TRIAL_DAYS}-day trial to try everything — logging meals, protein, side effects, the works. No charge during the trial.`;
  }

  const end = new Date(ts.getTime() + TRIAL_DAYS * DAY_MS);
  const left = trialDaysLeft(ts, now);
  const tz = user.timezone;

  if (left <= 0) {
    return `Your free ${TRIAL_DAYS}-day trial has wrapped up (it ran ${fmtDate(ts, tz)}–${fmtDate(end, tz)}). To keep going with me, you can upgrade anytime — want the link?`;
  }

  const dayWord = left === 1 ? 'day' : 'days';
  const base = `You're on a free ${TRIAL_DAYS}-day trial — it started ${fmtDate(ts, tz)} and runs through ${fmtDate(end, tz)}, so you've got ${left} ${dayWord} left.`;
  if (intent === 'billing') {
    return `${base} You won't be charged anything during the trial — after it ends you can choose to continue on a paid plan, and I'll remind you before then. 🧡`;
  }
  return `${base} After that you can keep going on a paid plan — I'll give you a heads-up before it ends. 🧡`;
}
