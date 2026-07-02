import { describe, it, expect } from 'vitest';
import {
  USER_DAY_CTE,
  userDayExpr,
  isCurrentUserDay,
  parseWakeTime,
  computeUserLoggingDay,
  DEFAULT_WAKE_TIME,
} from './logging-window.js';

describe('logging-window SQL helpers (local calendar day)', () => {
  it('CTE selects tz from the user row', () => {
    expect(USER_DAY_CTE).toMatch(/AS tz/);
    expect(USER_DAY_CTE).toContain(DEFAULT_WAKE_TIME);
    expect(USER_DAY_CTE).toMatch(/FROM users WHERE phone = \$1/);
  });

  it('userDayExpr takes the LOCAL date (no wake shift)', () => {
    expect(userDayExpr('fl.created_at')).toBe('(fl.created_at AT TIME ZONE user_tz.tz)::date');
    expect(userDayExpr('fl.created_at')).not.toContain('wake');
  });

  it('isCurrentUserDay compares the row local date to now()\'s local date', () => {
    const sql = isCurrentUserDay('fl.created_at');
    expect(sql).toContain('(fl.created_at AT TIME ZONE user_tz.tz)::date');
    expect(sql).toContain('(now() AT TIME ZONE user_tz.tz)::date');
    expect(sql).not.toContain('wake');
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

describe('computeUserLoggingDay — local calendar day (midnight → 11:59 PM)', () => {
  it('is the local date regardless of wake time', () => {
    // Early morning and late night on the same calendar day → same day.
    expect(computeUserLoggingDay('UTC', '07:00', new Date('2026-06-15T02:00:00Z'))).toBe('2026-06-15');
    expect(computeUserLoggingDay('UTC', '07:00', new Date('2026-06-15T08:00:00Z'))).toBe('2026-06-15');
    expect(computeUserLoggingDay('UTC', '07:00', new Date('2026-06-15T23:59:00Z'))).toBe('2026-06-15');
    // Midnight starts the next day.
    expect(computeUserLoggingDay('UTC', '07:00', new Date('2026-06-16T00:00:00Z'))).toBe('2026-06-16');
  });

  it('ignores wake time entirely (same timestamp, different wake → same day)', () => {
    const ts = new Date('2026-06-15T06:30:00Z');
    expect(computeUserLoggingDay('UTC', '06:00', ts)).toBe('2026-06-15');
    expect(computeUserLoggingDay('UTC', '10:00', ts)).toBe('2026-06-15');
    expect(computeUserLoggingDay('UTC', null, ts)).toBe('2026-06-15');
  });

  it('is computed in the user timezone', () => {
    // 2026-06-15T02:30Z = 2026-06-14 22:30 EDT → still the 14th locally.
    expect(computeUserLoggingDay('America/New_York', '07:00', new Date('2026-06-15T02:30:00Z'))).toBe('2026-06-14');
    // 2026-06-15T05:00Z = 2026-06-15 01:00 EDT → the 15th locally (new calendar day).
    expect(computeUserLoggingDay('America/New_York', '07:00', new Date('2026-06-15T05:00:00Z'))).toBe('2026-06-15');
  });

  it('a pre-wake snack now counts toward the day it happened (calendar day), not the prior day', () => {
    // 1 AM local on the 16th → the 16th (previously would have been the 15th).
    expect(computeUserLoggingDay('UTC', '07:00', new Date('2026-06-16T01:00:00Z'))).toBe('2026-06-16');
  });
});
