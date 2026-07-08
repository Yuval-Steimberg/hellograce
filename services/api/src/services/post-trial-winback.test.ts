import { describe, it, expect } from 'vitest';
import {
  POST_TRIAL_WINBACK_STAGES,
  nextWinbackStage,
  isInWinbackTcpaWindow,
  repliedRecently,
  sentWinbackRecently,
  isPaidUser,
  buildWinbackMessage,
  buildWinbackHelpReply,
  buildWinbackStopReply,
  isWinbackStopIntent,
  isWinbackHelpIntent,
  type WinbackUser,
} from './post-trial-winback.js';

const TRIAL_DAYS = 3;
const DAY = 24 * 3_600_000;
// Trial started 10 days ago → ended 7 days ago.
const trialStart = new Date(Date.now() - 10 * DAY);
const trialEnd = new Date(trialStart.getTime() + TRIAL_DAYS * DAY);

const base = (over: Partial<WinbackUser> = {}): WinbackUser => ({
  trial_start: trialStart,
  is_paid: false,
  is_pro: false,
  winback_stage: 0,
  winback_last_sent_at: null,
  ...over,
});

describe('post-trial win-back — the state machine (Post_Trial_Winback.mmd)', () => {
  it('has the 5 stages with the spec waits (0/2/3/5/4 days)', () => {
    expect(POST_TRIAL_WINBACK_STAGES.map((s) => s.key)).toEqual([
      'trial_expired_nudge', 'winback_value', 'winback_social', 'winback_final', 'churn_feedback_ask',
    ]);
    expect(POST_TRIAL_WINBACK_STAGES.map((s) => s.waitDays)).toEqual([0, 2, 3, 5, 4]);
  });

  it('stage 1 is due as soon as the trial has expired', () => {
    const due = nextWinbackStage(base(), new Date(), TRIAL_DAYS);
    expect(due?.index).toBe(0);
    expect(due?.stage.key).toBe('trial_expired_nudge');
  });

  it('does NOT fire before the trial ends', () => {
    const freshTrial = base({ trial_start: new Date(Date.now() - 1 * DAY) }); // 1 day in, 3-day trial
    expect(nextWinbackStage(freshTrial, new Date(), TRIAL_DAYS)).toBeNull();
  });

  it('never fires without a trial', () => {
    expect(nextWinbackStage(base({ trial_start: null }), new Date(), TRIAL_DAYS)).toBeNull();
  });

  it('stage 2 waits 2 days after the stage-1 send', () => {
    const justSent = base({ winback_stage: 1, winback_last_sent_at: new Date(Date.now() - 1 * DAY) });
    expect(nextWinbackStage(justSent, new Date(), TRIAL_DAYS)).toBeNull(); // only 1 day elapsed
    const twoDaysLater = base({ winback_stage: 1, winback_last_sent_at: new Date(Date.now() - 2 * DAY) });
    expect(nextWinbackStage(twoDaysLater, new Date(), TRIAL_DAYS)?.stage.key).toBe('winback_value');
  });

  it('walks 1→2→3→4→5 then STOPS forever', () => {
    // stage 3 after a 3-day wait, stage 4 after 5, stage 5 after 4
    expect(nextWinbackStage(base({ winback_stage: 2, winback_last_sent_at: new Date(Date.now() - 3 * DAY) }), new Date(), TRIAL_DAYS)?.stage.key).toBe('winback_social');
    expect(nextWinbackStage(base({ winback_stage: 3, winback_last_sent_at: new Date(Date.now() - 5 * DAY) }), new Date(), TRIAL_DAYS)?.stage.key).toBe('winback_final');
    expect(nextWinbackStage(base({ winback_stage: 4, winback_last_sent_at: new Date(Date.now() - 4 * DAY) }), new Date(), TRIAL_DAYS)?.stage.key).toBe('churn_feedback_ask');
    // stage 5 sent → sequence complete, never again
    expect(nextWinbackStage(base({ winback_stage: 5, winback_last_sent_at: new Date(Date.now() - 30 * DAY) }), new Date(), TRIAL_DAYS)).toBeNull();
  });

  it('trialEnd math: stage 1 due exactly at/after trial end, not before', () => {
    expect(nextWinbackStage(base(), new Date(trialEnd.getTime() - 1000), TRIAL_DAYS)).toBeNull();
    expect(nextWinbackStage(base(), new Date(trialEnd.getTime() + 1000), TRIAL_DAYS)?.index).toBe(0);
  });
});

describe('post-trial win-back — guards', () => {
  it('TCPA window is 8am–9pm local', () => {
    expect(isInWinbackTcpaWindow(7)).toBe(false);
    expect(isInWinbackTcpaWindow(8)).toBe(true);
    expect(isInWinbackTcpaWindow(20)).toBe(true);
    expect(isInWinbackTcpaWindow(21)).toBe(false);
  });
  it('holds when the user replied within 6h', () => {
    expect(repliedRecently({ last_reply_at: new Date(Date.now() - 2 * 3_600_000) }, new Date())).toBe(true);
    expect(repliedRecently({ last_reply_at: new Date(Date.now() - 8 * 3_600_000) }, new Date())).toBe(false);
    expect(repliedRecently({ last_reply_at: null }, new Date())).toBe(false);
  });
  it('holds when a win-back went out within 36h', () => {
    expect(sentWinbackRecently({ winback_last_sent_at: new Date(Date.now() - 10 * 3_600_000) }, new Date())).toBe(true);
    expect(sentWinbackRecently({ winback_last_sent_at: new Date(Date.now() - 40 * 3_600_000) }, new Date())).toBe(false);
  });
  it('paid/pro users are excluded', () => {
    expect(isPaidUser({ is_paid: true, is_pro: false })).toBe(true);
    expect(isPaidUser({ is_paid: false, is_pro: true })).toBe(true);
    expect(isPaidUser({ is_paid: false, is_pro: false })).toBe(false);
  });
});

describe('post-trial win-back — message copy', () => {
  const ctx = { firstName: 'Yuval', upgradeUrl: 'https://graceglp.com/upgrade?phone=%2B1', meals: 8, checkins: 5 };
  it('stage 1 nudge carries the paywall link, no emoji', () => {
    const m = buildWinbackMessage('trial_expired_nudge', ctx);
    expect(m).toContain(ctx.upgradeUrl);
    expect(m).toMatch(/trial/i);
    expect(m).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u); // no emoji
  });
  it('value stage cites the trial stats', () => {
    expect(buildWinbackMessage('winback_value', ctx)).toMatch(/8 meals and 5 check-ins/);
  });
  it('value stage degrades gracefully with no stats', () => {
    expect(buildWinbackMessage('winback_value', { upgradeUrl: ctx.upgradeUrl })).toContain(ctx.upgradeUrl);
  });
  it('final stage invites HELP; churn stage asks the question with NO link', () => {
    expect(buildWinbackMessage('winback_final', ctx)).toMatch(/reply help/i);
    const churn = buildWinbackMessage('churn_feedback_ask', ctx);
    expect(churn).toMatch(/price, timing, or me/i);
    expect(churn).not.toContain('http');
  });
});

describe('post-trial win-back — reply intents', () => {
  it('detects STOP intent', () => {
    for (const t of ['STOP', 'stop', 'unsubscribe', 'cancel', 'opt out', 'no more']) {
      expect(isWinbackStopIntent(t), t).toBe(true);
    }
    expect(isWinbackStopIntent('stopped by the store')).toBe(false); // "stopped" ≠ "stop" (word boundary)
    expect(isWinbackStopIntent('I ate a sandwich')).toBe(false);
  });
  it('detects HELP intent', () => {
    expect(isWinbackHelpIntent('HELP')).toBe(true);
    expect(isWinbackHelpIntent('help me plan dinner')).toBe(true);
    expect(isWinbackHelpIntent('no thanks')).toBe(false);
  });

  it('HELP reply keeps the door open with the link and invites the blocker', () => {
    const r = buildWinbackHelpReply({ firstName: 'Yuval', upgradeUrl: 'https://graceglp.com/upgrade?phone=%2B1' });
    expect(r).toContain('https://graceglp.com/upgrade?phone=%2B1');
    expect(r).toMatch(/Yuval/);
    expect(r).toMatch(/cost or timing/i);
    expect(r).toMatch(/\?$/); // ends by inviting a reply
  });

  it('STOP reply confirms without pressure and leaves the door open', () => {
    const r = buildWinbackStopReply('Yuval');
    expect(r).toMatch(/stop the check-ins/i);
    expect(r).toMatch(/text me/i);
    expect(r).not.toContain('http'); // no link on an opt-out
  });

  it('reply builders are name-safe when no first name', () => {
    expect(buildWinbackHelpReply({ upgradeUrl: 'https://x/u' })).toMatch(/^Happy to help\./);
    expect(buildWinbackStopReply(null)).toMatch(/^You got it —/);
  });
});
