import { describe, it, expect } from 'vitest';
import {
  detectReminderIntent,
  computeReminderSchedule,
  buildNextReminderReply,
  buildReminderExplainReply,
  buildReminderChangeReply,
  wasReminderOffer,
  buildReminderKeptReply,
  formatClock,
  type ReminderUser,
} from './reminder-service.js';

// A fixed instant we can reason about in a known timezone. Use UTC-based local
// times by setting timezone to 'UTC' so the wall clock equals the Date's UTC.
const TZ = 'UTC';
const at = (hhmm: string, dateISO = '2026-06-15') => new Date(`${dateISO}T${hhmm}:00.000Z`);

const baseUser: ReminderUser = {
  timezone: TZ,
  wake_time: '08:00',
  sleep_time: '22:00',
  checkin_count_per_day: 2,
  checkin_days_interval: 1,
  injection_day: null,
  paused: false,
};

describe('formatClock', () => {
  it('formats 12-hour clock with AM/PM', () => {
    expect(formatClock(8, 0)).toBe('8:00 AM');
    expect(formatClock(13, 30)).toBe('1:30 PM');
    expect(formatClock(0, 5)).toBe('12:05 AM');
    expect(formatClock(12, 0)).toBe('12:00 PM');
  });
});

describe('detectReminderIntent', () => {
  it('classifies status questions', () => {
    expect(detectReminderIntent('When is my next reminder?')).toBe('next');
    expect(detectReminderIntent('what time will you text me?')).toBe('next');
    expect(detectReminderIntent('Would you send a reminder tomorrow morning?')).toBe('next');
    expect(detectReminderIntent('do I have any reminders?')).toBe('next');
    expect(detectReminderIntent('are my reminders on?')).toBe('next');
    expect(detectReminderIntent('do you send reminders?')).toBe('next');
    expect(detectReminderIntent('when do you text me?')).toBe('next');
  });
  it('does NOT fire on injection-day questions (their own handler)', () => {
    expect(detectReminderIntent('when is my next injection?')).toBeNull();
  });
  it('classifies explain questions', () => {
    expect(detectReminderIntent('how do reminders work?')).toBe('explain');
    expect(detectReminderIntent('how often do you text me?')).toBe('explain');
    expect(detectReminderIntent('how many reminders a day?')).toBe('explain');
  });
  it('classifies change/custom requests', () => {
    expect(detectReminderIntent('Can you remind me at 3 PM every day?')).toBe('change');
    expect(detectReminderIntent('set a reminder for 6pm')).toBe('change');
    expect(detectReminderIntent('turn off my reminders')).toBe('change');
    expect(detectReminderIntent('remind me to take my pill tonight')).toBe('change');
  });
  it('returns null for unrelated messages', () => {
    expect(detectReminderIntent('I had two eggs')).toBeNull();
    expect(detectReminderIntent('how are you?')).toBeNull();
    expect(detectReminderIntent('')).toBeNull();
  });
});

describe('computeReminderSchedule — next reminder', () => {
  it('before wake time → this morning', () => {
    const s = computeReminderSchedule(baseUser, at('05:00')); // 5am, before 8am wake
    expect(s.next?.kind).toBe('morning');
    expect(s.next?.when).toBe('this morning');
    expect(s.next?.timeLabel).toBe('8:00 AM');
    expect(s.next?.phrase).toContain('8:00 AM');
  });

  it('after morning on a midday day (Mon) → today midday', () => {
    // 2026-06-15 is a Monday (a MIDDAY day). 10:00 is after the morning window.
    const s = computeReminderSchedule(baseUser, at('10:00', '2026-06-15'));
    expect(s.next?.kind).toBe('midday');
    expect(s.next?.when).toBe('today');
  });

  it('evening day after midday-window → this evening', () => {
    // 2026-06-16 is a Tuesday (EVENING day). 15:00 is past morning, evening at 20:30.
    const s = computeReminderSchedule(baseUser, at('15:00', '2026-06-16'));
    expect(s.next?.kind).toBe('evening');
    expect(s.next?.timeLabel).toBe('8:30 PM'); // 22:00 - 90min
  });

  it('late night → tomorrow morning, with the explicit day name', () => {
    const s = computeReminderSchedule(baseUser, at('23:30', '2026-06-16')); // Tuesday night
    expect(s.next?.kind).toBe('morning');
    expect(s.next?.when).toBe('tomorrow (Wednesday) morning');
    expect(s.next?.phrase).toContain('Wednesday');
    expect(s.next?.phrase).toContain('8:00 AM');
  });

  it('injection day today, before morning → injection check-in', () => {
    const u: ReminderUser = { ...baseUser, injection_day: 'Monday' };
    const s = computeReminderSchedule(u, at('06:00', '2026-06-15')); // Monday
    expect(s.isInjectionDayToday).toBe(true);
    expect(s.next?.kind).toBe('injection');
    expect(s.next?.phrase).toMatch(/injection/i);
  });

  // Regression (prod 2026-06: screenshot). At 10:32 PM on an injection day —
  // long after the follow-up was sent and well into quiet hours (21:00+) — Grace
  // wrongly said "later today (injection-day follow-up)". The scheduler sends
  // nothing after 21:00, so the next reminder is TOMORROW morning.
  it('injection day, late night (quiet hours) → tomorrow morning, NOT "later today"', () => {
    const u: ReminderUser = { ...baseUser, injection_day: 'Monday', injection_flow_stage: 'followup_sent' };
    const s = computeReminderSchedule(u, at('22:32', '2026-06-15')); // Monday 10:32 PM
    expect(s.isInjectionDayToday).toBe(true);
    expect(s.next?.kind).toBe('morning');
    expect(s.next?.when).toBe('tomorrow (Tuesday) morning');
    expect(s.next?.phrase).toContain('8:00 AM');
    expect(s.next?.phrase).not.toMatch(/later today/i);
    const reply = buildNextReminderReply(u, URL, at('22:32', '2026-06-15'));
    expect(reply).toMatch(/tomorrow/i);
    expect(reply).not.toMatch(/later today/i);
  });

  it('injection day, daytime, follow-up ALREADY sent → tomorrow morning (not "later today")', () => {
    const u: ReminderUser = { ...baseUser, injection_day: 'Monday', injection_flow_stage: 'followup_sent' };
    const s = computeReminderSchedule(u, at('15:00', '2026-06-15')); // Monday 3 PM
    expect(s.next?.kind).toBe('morning');
    expect(s.next?.phrase).not.toMatch(/later today/i);
  });

  it('injection day, daytime, follow-up still PENDING (done_confirmed) → later today', () => {
    const u: ReminderUser = { ...baseUser, injection_day: 'Monday', injection_flow_stage: 'done_confirmed' };
    const s = computeReminderSchedule(u, at('15:00', '2026-06-15')); // Monday 3 PM
    expect(s.next?.kind).toBe('injection');
    expect(s.next?.phrase).toMatch(/later today/i);
  });

  it('injection day, daytime, no stage info → still assumes a same-day follow-up', () => {
    const u: ReminderUser = { ...baseUser, injection_day: 'Monday' }; // stage undefined
    const s = computeReminderSchedule(u, at('15:00', '2026-06-15'));
    expect(s.next?.kind).toBe('injection');
    expect(s.next?.phrase).toMatch(/later today/i);
  });

  it('paused user → no next reminder, not enabled', () => {
    const s = computeReminderSchedule({ ...baseUser, paused: true }, at('05:00'));
    expect(s.enabled).toBe(false);
    expect(s.paused).toBe(true);
    expect(s.next).toBeNull();
  });

  it('every-other-day cadence skips an ineligible day', () => {
    // daysInterval 2 → roughly every other day. The next reminder must land on
    // an eligible day's morning, never an ineligible one.
    const u: ReminderUser = { ...baseUser, checkin_days_interval: 2 };
    const s = computeReminderSchedule(u, at('23:30', '2026-06-16'));
    expect(s.daysInterval).toBe(2);
    expect(s.next?.kind).toBe('morning');
    // It still resolves to *a* morning (this/tomorrow/named day) — never null.
    expect(s.next?.phrase).toMatch(/morning/i);
  });
});

describe('reminder offer follow-up — understand "no, that\'s good" as keep', () => {
  it('recognizes the prior reminder answer as an offer', () => {
    expect(wasReminderOffer('Your next reminder is tomorrow (Thursday) morning around 7:00 AM, based on your wake-up time. Want a different time?')).toBe(true);
    expect(wasReminderOffer('Want a different time?')).toBe(true);
    expect(wasReminderOffer('You logged chicken and rice, nice work.')).toBe(false);
    expect(wasReminderOffer('')).toBe(false);
    expect(wasReminderOffer(null)).toBe(false);
  });

  it('keep-reply confirms warmly, never restates a time, never denies', () => {
    const r = buildReminderKeptReply();
    expect(r.toLowerCase()).toMatch(/keep your reminders|leave (it|them)/);
    expect(r).not.toMatch(/\d/); // no time restated
    expect(r.toLowerCase()).not.toMatch(/can'?t|unable/);
  });
});

describe('reminder reply builders — never deny capability, always redirect', () => {
  const URL = 'https://graceglp.com/settings';
  const DENIAL = /can'?t send|don'?t have the ability|unable to (send|schedule|initiate)|can'?t schedule|don'?t have access/i;

  it('next-reminder reply states the time + Settings, no denial', () => {
    const r = buildNextReminderReply(baseUser, URL, at('05:00'));
    expect(r).toMatch(/8:00 AM/);
    expect(r).toContain(URL);
    expect(r).not.toMatch(DENIAL);
  });

  it('paused next-reminder reply explains paused + Settings', () => {
    const r = buildNextReminderReply({ ...baseUser, paused: true }, URL, at('05:00'));
    expect(r).toMatch(/paused/i);
    expect(r).toContain(URL);
    expect(r).not.toMatch(DENIAL);
  });

  it('explain reply describes cadence + times, no denial', () => {
    const r = buildReminderExplainReply(baseUser, URL, at('05:00'));
    expect(r).toMatch(/morning/i);
    expect(r).toMatch(/8:00 AM/);
    expect(r).toContain(URL);
    expect(r).not.toMatch(DENIAL);
  });

  it('change reply redirects to Settings without exposing limitations', () => {
    const r = buildReminderChangeReply(URL);
    expect(r).toMatch(/Settings/i);
    expect(r).toContain(URL);
    // "can't customize ... through chat" is allowed (product framing); the
    // banned capability-denials are not.
    expect(r).not.toMatch(DENIAL);
  });
});
