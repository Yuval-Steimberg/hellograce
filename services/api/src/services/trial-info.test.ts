import { describe, it, expect } from 'vitest';
import { detectTrialQuestion, buildTrialReply, trialDaysLeft, TRIAL_DAYS } from './trial-info.js';

describe('detectTrialQuestion', () => {
  it('detects trial-length questions', () => {
    expect(detectTrialQuestion('how long is my trial?')).toBe('length');
    expect(detectTrialQuestion('when does my trial end')).toBe('length');
    expect(detectTrialQuestion('how many days left on my trial')).toBe('length');
    expect(detectTrialQuestion('is my trial over?')).toBe('length');
    expect(detectTrialQuestion('how long is the free trial')).toBe('length');
  });
  it('detects billing/charge-timing questions', () => {
    expect(detectTrialQuestion('when do I get charged?')).toBe('billing');
    expect(detectTrialQuestion('is this free?')).toBe('billing');
    expect(detectTrialQuestion('do I have to pay')).toBe('billing');
  });
  it('does NOT fire on unrelated messages', () => {
    expect(detectTrialQuestion('I had eggs for breakfast')).toBe(null);
    expect(detectTrialQuestion('feel free to suggest a snack')).toBe(null);
    expect(detectTrialQuestion('how much protein is in chicken')).toBe(null);
  });
});

describe('trialDaysLeft', () => {
  const start = new Date('2026-07-04T12:00:00Z');
  it('counts down and floors at 0', () => {
    expect(trialDaysLeft(start, new Date('2026-07-04T13:00:00Z'))).toBe(TRIAL_DAYS);
    expect(trialDaysLeft(start, new Date('2026-07-06T12:00:00Z'))).toBe(1);
    expect(trialDaysLeft(start, new Date('2026-07-08T12:00:00Z'))).toBe(0); // past end
  });
});

describe('buildTrialReply — deterministic, never invents a length', () => {
  const start = new Date('2026-07-04T12:00:00Z');
  it('states the real 3-day length + days left for an active trial', () => {
    const r = buildTrialReply({ trial_start: start.toISOString(), timezone: 'UTC' }, 'length', new Date('2026-07-05T12:00:00Z'));
    expect(r).toMatch(new RegExp(`free ${TRIAL_DAYS}-day trial`));
    expect(r).toMatch(/2 days left/);
    expect(r).not.toMatch(/7[ -]day|week/i); // never the hallucinated "7 days"
  });
  it('handles a wrapped-up trial', () => {
    const r = buildTrialReply({ trial_start: start.toISOString() }, 'length', new Date('2026-07-09T12:00:00Z'));
    expect(r).toMatch(/wrapped up/i);
    expect(r).toMatch(/upgrade/i);
  });
  it('paid users get no trial clock', () => {
    const r = buildTrialReply({ is_paid: true }, 'length');
    expect(r).toMatch(/paid plan/i);
    expect(r).not.toMatch(/\d+-day/);
  });
  it('billing intent explains no charge during trial', () => {
    const r = buildTrialReply({ trial_start: start.toISOString() }, 'billing', new Date('2026-07-05T12:00:00Z'));
    expect(r.toLowerCase()).toMatch(/won'?t be charged|no charge/);
  });
  it('never states a length other than 3 days', () => {
    for (const now of ['2026-07-04T12:00:00Z', '2026-07-05T12:00:00Z', '2026-07-06T12:00:00Z']) {
      const r = buildTrialReply({ trial_start: start.toISOString() }, 'length', new Date(now));
      expect(r).not.toMatch(/\b(5|6|7|10|14|30)-day/);
    }
  });
});
