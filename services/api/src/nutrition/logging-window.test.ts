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
