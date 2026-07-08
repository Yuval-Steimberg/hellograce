/**
 * Post-trial win-back sequence (2026-07-07) — spec `Post_Trial_Winback.mmd`.
 *
 * A SEPARATE proactive system from reminders and from the existing morning
 * "winback" variant (which re-engages a still-in-trial quiet user). This fires
 * ONLY after the free trial has EXPIRED and the user has NOT paid, walking a
 * fixed 5-stage escalation over ~two weeks, then going silent forever:
 *
 *   Stage 1  Day 0   trial_expired_nudge   direct paywall link
 *   Stage 2  Day +2  winback_value         "your trial stats: N meals, M check-ins"
 *   Stage 3  Day +5  winback_social        "week 2 is when it clicks"
 *   Stage 4  Day +10 winback_final         "last note — reply HELP if cost is the thing"
 *   Stage 5  Day +14 churn_feedback_ask    "was it price, timing, or me?"  → silence
 *
 * State lives in `users.winback_stage` (0 = none sent … 5 = sequence complete)
 * and `users.winback_last_sent_at`. Terminal on: paid (guard), opted-out/paused
 * (guard), or stage 5 sent. Every helper here is PURE so the state machine is
 * unit-testable without a clock, DB, or LLM.
 */
import type { GraceUser } from '../user/user.service.js';

const DAY_MS = 24 * 3_600_000;

export interface WinbackStageDef {
  /** check_ins.type suffix + analytics key. */
  key: 'trial_expired_nudge' | 'winback_value' | 'winback_social' | 'winback_final' | 'churn_feedback_ask';
  /** Days to wait AFTER the previous winback send before this stage is due. The
   *  first stage (index 0) fires as soon as the trial has expired (wait 0). */
  waitDays: number;
}

export const POST_TRIAL_WINBACK_STAGES: readonly WinbackStageDef[] = [
  { key: 'trial_expired_nudge', waitDays: 0 },
  { key: 'winback_value', waitDays: 2 },
  { key: 'winback_social', waitDays: 3 },
  { key: 'winback_final', waitDays: 5 },
  { key: 'churn_feedback_ask', waitDays: 4 },
] as const;

/** Minimum hours since the last win-back SMS before the next may send (spec:
 *  "No winback SMS in last 36h"). The inter-stage waits are all ≥2 days, so this
 *  is a belt-and-suspenders floor against any same-day double-send. */
export const WINBACK_MIN_GAP_HOURS = 36;
/** Hold off if the user replied to Grace within this window (spec: "No user
 *  reply in last 6h") — never talk over a live conversation. */
export const WINBACK_USER_REPLY_QUIET_HOURS = 6;
/** TCPA send window in the user's local time: 8am–9pm inclusive of 8, exclusive of 21. */
export const WINBACK_TCPA_START_HOUR = 8;
export const WINBACK_TCPA_END_HOUR = 21;

export type WinbackUser = Pick<
  GraceUser,
  'trial_start' | 'is_paid' | 'is_pro' | 'winback_stage' | 'winback_last_sent_at'
>;

/** The trial's end (ms) = trial_start + trialDays. Null when no trial started. */
export function trialEndMs(user: Pick<GraceUser, 'trial_start'>, trialDays: number): number | null {
  if (!user.trial_start) return null;
  return new Date(user.trial_start).getTime() + trialDays * DAY_MS;
}

/**
 * The next win-back stage that is DUE for this user, or null. Pure: no guards
 * about paid/opt-out/TCPA/quiet-window here (the scheduler owns those) — this is
 * strictly "given the trial timeline + how many stages we've sent, is the next
 * one time-due?". Returns the 0-based stage index + its definition.
 */
export function nextWinbackStage(
  user: WinbackUser,
  now: Date,
  trialDays: number,
): { index: number; stage: WinbackStageDef } | null {
  const stage = user.winback_stage ?? 0;
  if (stage >= POST_TRIAL_WINBACK_STAGES.length) return null; // sequence complete
  const end = trialEndMs(user, trialDays);
  if (end == null) return null; // never had a trial
  const nowMs = now.getTime();
  if (nowMs < end) return null; // trial hasn't expired yet
  const def = POST_TRIAL_WINBACK_STAGES[stage]!;
  // The first stage fires at/after trial end. Later stages wait `waitDays` since
  // the previous send (falling back to trial end if the timestamp is missing).
  const since = stage === 0
    ? end
    : (user.winback_last_sent_at ? new Date(user.winback_last_sent_at).getTime() : end);
  if (nowMs < since + def.waitDays * DAY_MS) return null;
  return { index: stage, stage: def };
}

/** True when the user's LOCAL hour is inside the TCPA window (8am–9pm). Pass the
 *  hour already localized to the user's timezone. */
export function isInWinbackTcpaWindow(localHour: number): boolean {
  return localHour >= WINBACK_TCPA_START_HOUR && localHour < WINBACK_TCPA_END_HOUR;
}

/** True when the user replied within the quiet window (→ hold the win-back). */
export function repliedRecently(
  user: Pick<GraceUser, 'last_reply_at'>,
  now: Date,
  hours = WINBACK_USER_REPLY_QUIET_HOURS,
): boolean {
  if (!user.last_reply_at) return false;
  return now.getTime() - new Date(user.last_reply_at).getTime() < hours * 3_600_000;
}

/** True when a win-back SMS was sent within the min-gap window (→ hold). */
export function sentWinbackRecently(
  user: Pick<GraceUser, 'winback_last_sent_at'>,
  now: Date,
  hours = WINBACK_MIN_GAP_HOURS,
): boolean {
  if (!user.winback_last_sent_at) return false;
  return now.getTime() - new Date(user.winback_last_sent_at).getTime() < hours * 3_600_000;
}

/** Paid/pro users are done — the sequence must never reach them. */
export function isPaidUser(user: Pick<GraceUser, 'is_paid' | 'is_pro'>): boolean {
  return !!user.is_paid || !!user.is_pro;
}

export interface WinbackMessageContext {
  firstName?: string | null;
  /** Upgrade/paywall link (already host-rewritten by the sender). */
  upgradeUrl: string;
  /** Trial engagement stats for the value stage. */
  meals?: number;
  checkins?: number;
}

/**
 * Build the standalone win-back SMS for a stage. Warm, one-thought, plain text,
 * no emoji, at most one link. The churn-feedback stage carries NO link (it asks
 * a question). Deterministic so the copy is reviewable and testable.
 */
export function buildWinbackMessage(key: WinbackStageDef['key'], ctx: WinbackMessageContext): string {
  const name = ctx.firstName && ctx.firstName.trim() ? ` ${ctx.firstName.trim()}` : '';
  switch (key) {
    case 'trial_expired_nudge':
      return `Hey${name}, your Grace trial just wrapped up. If you want to keep your check-ins and protein tracking going, you can pick up right where you left off here: ${ctx.upgradeUrl}`;
    case 'winback_value': {
      const meals = ctx.meals ?? 0;
      const checkins = ctx.checkins ?? 0;
      const stats = meals > 0 || checkins > 0
        ? `In your trial you logged ${meals} meal${meals === 1 ? '' : 's'} and ${checkins} check-in${checkins === 1 ? '' : 's'} — that is real momentum. `
        : `You got a real start in your trial. `;
      return `${stats}Keep it going whenever you are ready: ${ctx.upgradeUrl}`;
    }
    case 'winback_social':
      return `Most people tell me week 2 is when the GLP-1 support really clicks — the check-ins start to feel like a habit. I would love to be there for yours: ${ctx.upgradeUrl}`;
    case 'winback_final':
      return `Last note from me — if cost is the thing holding you back, just reply HELP and I will see what I can do. Otherwise I will leave you to it: ${ctx.upgradeUrl}`;
    case 'churn_feedback_ask':
      return `No worries if now is not the time${name}. If you are up for it, what made you pause — was it price, timing, or me? It genuinely helps me get better.`;
  }
}

/** A short reply expressing intent to STOP/unsubscribe → opt out, silence forever. */
export function isWinbackStopIntent(text: string): boolean {
  return /^\s*(stop|unsubscribe|cancel|quit|end|opt\s*out|leave me alone|no more|remove me)\b/i.test(text ?? '');
}

/** The "reply HELP if cost is the thing" affordance from the final stage. */
export function isWinbackHelpIntent(text: string): boolean {
  return /^\s*help\b/i.test(text ?? '');
}

/**
 * The reply to a HELP intent from an expired-trial user. The paywall + the final
 * win-back stage both invite "reply HELP", but without this the reply just looped
 * back to the generic paywall. This is the actual affordance: warm, addresses the
 * likely blocker (cost/timing), keeps the door open with the upgrade link, and
 * invites them to say what's holding them back so it can be a conversation, not a
 * wall. Deterministic + plain text (one link) so it's reviewable and testable.
 */
export function buildWinbackHelpReply(ctx: Pick<WinbackMessageContext, 'firstName' | 'upgradeUrl'>): string {
  const name = ctx.firstName && ctx.firstName.trim() ? ` ${ctx.firstName.trim()}` : '';
  return `Happy to help${name}. If cost or timing is the thing holding you back, just tell me — a lot of people find the daily check-ins pay for themselves in momentum, and I would rather find a way to keep you than lose you. Whenever you are ready you can pick up right where you left off here: ${ctx.upgradeUrl}. What is making you pause?`;
}

/** The confirmation for a STOP intent — acknowledge, stop the sequence, leave the
 *  door open without pressure. Sending path also flips the opt-out flag + ends the
 *  win-back sequence so nothing further fires. */
export function buildWinbackStopReply(firstName?: string | null): string {
  const name = firstName && firstName.trim() ? ` ${firstName.trim()}` : '';
  return `You got it${name} — I will stop the check-ins. No hard feelings at all. If you ever want to pick things back up, just text me and I will be right here.`;
}
