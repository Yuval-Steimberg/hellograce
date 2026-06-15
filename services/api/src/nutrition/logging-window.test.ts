import { describe, it, expect } from 'vitest';
import {
  USER_DAY_CTE,
  userDayExpr,
  isCurrentUserDay,
  parseWakeTime,
  computeUserLoggingDay,
  DEFAULT_WAKE_TIME,
} from './logging-window.js';

describe('logging-window SQL helpers', () => {
  it('CTE selects tz AND wake interval from the user row', () => {
    expect(USER_DAY_CTE).toMatch(/AS tz/);
    expect(USER_DAY_CTE).toMatch(/::interval AS wake/);
    expect(USER_DAY_CTE).toContain(DEFAULT_WAKE_TIME);
    expect(USER_DAY_CTE).toMatch(/FROM users WHERE phone = \$1/);
  });

  it('userDayExpr shifts the local time back by wake before taking the date', () => {
    expect(userDayExpr('fl.created_at')).toBe(
      '((fl.created_at AT TIME ZONE user_tz.tz) - user_tz.wake)::date',
    );
  });

  it('isCurrentUserDay compares the row day to now()\'s day, both wake-shifted', () => {
    const sql = isCurrentUserDay('fl.created_at');
    expect(sql).toContain('- user_tz.wake)::date');
    expect(sql).toContain('now() AT TIME ZONE user_tz.tz');
    expect(sql).toMatch(/=/);
  });
});

describe('parseWakeTime', () => {
  it('parses HH:MM', () => expect(parseWakeTime('09:30')).toEqual([9, 30]));
  it('defaults to 07:00 on missing/garbage', () => {
    expect(parseWakeTime(null)).toEqual([7, 0]);
    expect(parseWakeTime('')).toEqual([7, 0]);
    expect(parseWakeTime('nonsense')).toEqual([7, 0]);
  });
  it('clamps out-of-range values', () => {
    expect(parseWakeTime('99:99')).toEqual([23, 59]);
  });
});

describe('computeUserLoggingDay ↔ SQL window parity (spot checks)', () => {
  // The JS key must equal ((now() AT TIME ZONE tz) - wake)::date.
  it('matches the wake boundary for the default 07:00', () => {
    expect(computeUserLoggingDay('UTC', undefined, new Date('2026-06-07T06:59:00Z'))).toBe('2026-06-06');
    expect(computeUserLoggingDay('UTC', undefined, new Date('2026-06-07T07:00:00Z'))).toBe('2026-06-07');
  });
});

describe('per-user logging day — spec scenarios', () => {
  // Spec example: a user who wakes at 7:00 AM. Meals after 7 AM belong to that
  // day; a pre-wake snack belongs to the day that began the previous 7 AM.
  it('wakes 07:00 — an 8 AM meal is today, a 2 AM snack is the prior day', () => {
    const wake = '07:00';
    expect(computeUserLoggingDay('UTC', wake, new Date('2026-06-15T08:00:00Z'))).toBe('2026-06-15');
    expect(computeUserLoggingDay('UTC', wake, new Date('2026-06-15T02:00:00Z'))).toBe('2026-06-14');
    // 23:30 the same night is still the 15th's logging day (before the next 7 AM).
    expect(computeUserLoggingDay('UTC', wake, new Date('2026-06-15T23:30:00Z'))).toBe('2026-06-15');
  });

  // A custom wake time shifts the boundary, never midnight or a fixed 5am.
  it('a late riser (wake 10:00) — a 9 AM meal still counts toward yesterday', () => {
    expect(computeUserLoggingDay('UTC', '10:00', new Date('2026-06-15T09:00:00Z'))).toBe('2026-06-14');
    expect(computeUserLoggingDay('UTC', '10:00', new Date('2026-06-15T10:00:00Z'))).toBe('2026-06-15');
  });

  // Updating wake time in Settings must re-bucket the SAME timestamp dynamically
  // (no rows move — totals are recomputed from the current window).
  it('changing wake time re-buckets the same timestamp', () => {
    const ts = new Date('2026-06-15T06:30:00Z'); // 6:30 AM local
    expect(computeUserLoggingDay('UTC', '06:00', ts)).toBe('2026-06-15'); // wake 6 → after wake → today
    expect(computeUserLoggingDay('UTC', '07:00', ts)).toBe('2026-06-14'); // wake 7 → before wake → yesterday
  });

  // Missing wake time falls back to the safe 07:00 default (not midnight).
  it('missing wake time uses the 07:00 safe default', () => {
    expect(computeUserLoggingDay('UTC', null, new Date('2026-06-15T06:30:00Z'))).toBe('2026-06-14');
    expect(computeUserLoggingDay('UTC', '', new Date('2026-06-15T07:30:00Z'))).toBe('2026-06-15');
  });

  // The window is computed in the user's own timezone.
  it('respects the user timezone (New York, wake 07:00)', () => {
    // 2026-06-15T10:30Z = 06:30 EDT → before 7 AM local → prior logging day.
    expect(computeUserLoggingDay('America/New_York', '07:00', new Date('2026-06-15T10:30:00Z'))).toBe('2026-06-14');
    // 2026-06-15T11:30Z = 07:30 EDT → after 7 AM local → today.
    expect(computeUserLoggingDay('America/New_York', '07:00', new Date('2026-06-15T11:30:00Z'))).toBe('2026-06-15');
  });
});
