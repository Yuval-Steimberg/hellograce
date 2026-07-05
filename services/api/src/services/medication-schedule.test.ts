import { describe, it, expect } from 'vitest';
import {
  computeInjectionSchedule,
  detectInjectionTimingIntent,
  buildInjectionTimingReply,
  buildScheduleFactLine,
  cadenceOf,
} from './medication-schedule.js';
import { resolveTemporalContext, utcBaseFromIso, formatCalendarDate } from './temporal-context.js';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const NOW = new Date('2026-07-03T12:00:00Z');
const tctx = resolveTemporalContext('UTC', NOW);
const base = utcBaseFromIso(tctx.isoDate);

describe('cadenceOf', () => {
  it('maps medication types to cadence', () => {
    expect(cadenceOf('weekly_injection')).toBe('weekly');
    expect(cadenceOf('daily_pill')).toBe('daily');
    expect(cadenceOf('daily_injection')).toBe('daily');
    expect(cadenceOf('unknown')).toBe('unknown');
  });
});

describe('computeInjectionSchedule — weekly (Uri: Zepbound, Saturday)', () => {
  it('computes an N-days-ahead injection day with the real date', () => {
    const injDay = WEEKDAYS[(tctx.weekdayIndex + 4) % 7]!; // 4 days ahead of today
    const s = computeInjectionSchedule({ medicationType: 'weekly_injection', injectionDay: injDay, timezone: 'UTC' }, NOW);
    expect(s.cadence).toBe('weekly');
    expect(s.knowsSchedule).toBe(true);
    expect(s.isToday).toBe(false);
    expect(s.daysUntilNext).toBe(4);
    expect(s.nextHuman).toBe(formatCalendarDate(base, 4).long);
  });

  it('handles injection day == today (next in 7, last 7 days ago)', () => {
    const s = computeInjectionSchedule({ medicationType: 'weekly_injection', injectionDay: tctx.weekday, timezone: 'UTC' }, NOW);
    expect(s.isToday).toBe(true);
    expect(s.daysUntilNext).toBe(0);
    expect(s.daysSinceLast).toBe(7);
    expect(s.lastHuman).toBe(formatCalendarDate(base, -7).long);
  });

  it('computes the previous occurrence for "last shot"', () => {
    const injDay = WEEKDAYS[(tctx.weekdayIndex + 2) % 7]!; // 2 ahead → last was 5 ago
    const s = computeInjectionSchedule({ medicationType: 'weekly_injection', injectionDay: injDay, timezone: 'UTC' }, NOW);
    expect(s.daysUntilNext).toBe(2);
    expect(s.daysSinceLast).toBe(5);
    expect(s.lastHuman).toBe(formatCalendarDate(base, -5).long);
  });

  it('does not claim to know the schedule when injection day is missing', () => {
    const s = computeInjectionSchedule({ medicationType: 'weekly_injection', injectionDay: null, timezone: 'UTC' }, NOW);
    expect(s.knowsSchedule).toBe(false);
    expect(s.nextHuman).toBeNull();
  });
});

describe('computeInjectionSchedule — daily', () => {
  it('a daily pill has a dose every day (next = today)', () => {
    const s = computeInjectionSchedule({ medicationType: 'daily_pill', injectionDay: null, timezone: 'UTC' }, NOW);
    expect(s.cadence).toBe('daily');
    expect(s.knowsSchedule).toBe(true);
    expect(s.isToday).toBe(true);
    expect(s.daysUntilNext).toBe(0);
    expect(s.nextHuman).toBe(formatCalendarDate(base, 0).long);
  });
});

describe('detectInjectionTimingIntent', () => {
  const cases: Array<[string, ReturnType<typeof detectInjectionTimingIntent>]> = [
    ['When is my next injection?', 'next'],
    ['When is my next dose?', 'next'],
    ['when is my next shot', 'next'],
    ['how many days until my shot?', 'next'],
    ['what day do I take my next pill', 'next'],
    ['when should I inject next?', 'next'],
    ['when was my last injection?', 'last'],
    ['how many days since my last shot?', 'last'],
    ['when did I last inject?', 'last'],
    ['is today my shot day?', 'today'],
    ['do I inject today?', 'today'],
    ['is today an injection day', 'today'],
    // Not injection-timing:
    ['what should I eat for dinner?', null],
    ['when is my next reminder?', null],
    ['I feel nauseous', null],
    ['how much protein today?', null],
    // ONSET (when they STARTED) is NOT timing — must NOT return "today is your
    // shot day". Regression: the exact reported production failure.
    ['When I started taking the injection', null],
    ['when did I start ozempic', null],
    ['when I started with glp?', null],
    ['how long have I been on ozempic', null],
    ['when was my first shot', null],
  ];
  it.each(cases)('%s → %s', (text, expected) => {
    expect(detectInjectionTimingIntent(text)).toBe(expected);
  });
});

describe('buildInjectionTimingReply — never denies', () => {
  const url = 'https://graceglp.com/settings';

  it('answers next weekly shot with the concrete date', () => {
    const injDay = WEEKDAYS[(tctx.weekdayIndex + 4) % 7]!;
    const s = computeInjectionSchedule({ medicationType: 'weekly_injection', injectionDay: injDay, timezone: 'UTC' }, NOW);
    const r = buildInjectionTimingReply('next', s, 'Zepbound', url);
    expect(r).toContain('in 4 days');
    expect(r).toContain('Zepbound');
    expect(r.toLowerCase()).not.toContain("can't tell");
    expect(r.toLowerCase()).not.toContain('access to');
  });

  it('asks for the day (never denies) when the schedule is unknown', () => {
    const s = computeInjectionSchedule({ medicationType: 'weekly_injection', injectionDay: null, timezone: 'UTC' }, NOW);
    const r = buildInjectionTimingReply('next', s, 'Zepbound', url);
    expect(r.toLowerCase()).toContain('which day');
    expect(r.toLowerCase()).not.toContain('cannot');
    expect(r.toLowerCase()).not.toContain("don't have access");
  });

  it('answers a daily med as daily', () => {
    const s = computeInjectionSchedule({ medicationType: 'daily_pill', injectionDay: null, timezone: 'UTC' }, NOW);
    const r = buildInjectionTimingReply('next', s, 'Rybelsus', url);
    expect(r.toLowerCase()).toContain('daily');
  });

  it('answers last-shot and is-today', () => {
    const s = computeInjectionSchedule({ medicationType: 'weekly_injection', injectionDay: tctx.weekday, timezone: 'UTC' }, NOW);
    expect(buildInjectionTimingReply('today', s, 'Zepbound', url).toLowerCase()).toContain('yes');
    expect(buildInjectionTimingReply('last', s, 'Zepbound', url).toLowerCase()).toContain('last shot');
  });
});

describe('buildScheduleFactLine', () => {
  it('grounds the prompt and forbids denial', () => {
    const injDay = WEEKDAYS[(tctx.weekdayIndex + 4) % 7]!;
    const s = computeInjectionSchedule({ medicationType: 'weekly_injection', injectionDay: injDay, timezone: 'UTC' }, NOW);
    const line = buildScheduleFactLine(s, 'Zepbound')!;
    expect(line).toContain('MEDICATION SCHEDULE');
    expect(line).toContain('in 4 days');
    expect(line.toLowerCase()).toContain('never say you can');
  });

  it('returns null when a weekly day is unknown (gather flow owns it)', () => {
    const s = computeInjectionSchedule({ medicationType: 'weekly_injection', injectionDay: null, timezone: 'UTC' }, NOW);
    expect(buildScheduleFactLine(s, 'Zepbound')).toBeNull();
  });
});
