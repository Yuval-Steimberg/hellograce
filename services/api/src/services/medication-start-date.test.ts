import { describe, it, expect } from 'vitest';
import {
  isPlausibleStartDate,
  parseStartDateStatement,
  parseDateExpression,
  buildStartDateAnswer,
  buildStartDateCaptureReply,
  glp1WeekNumber,
  formatStartDate,
} from './medication-start-date.js';

// Fixed "now": Sunday, July 5, 2026 (matches the reported screenshots).
const NOW = new Date('2026-07-05T12:00:00Z');
const iso = (d: Date) => d.toISOString().slice(0, 10);

describe('isPlausibleStartDate', () => {
  it('rejects the garbage "Jan 5, 1999" value', () => {
    expect(isPlausibleStartDate('1999-01-05', NOW)).toBe(false);
  });
  it('rejects future dates', () => {
    expect(isPlausibleStartDate('2027-01-01', NOW)).toBe(false);
  });
  it('rejects null / empty / invalid', () => {
    expect(isPlausibleStartDate(null, NOW)).toBe(false);
    expect(isPlausibleStartDate('', NOW)).toBe(false);
    expect(isPlausibleStartDate('not-a-date', NOW)).toBe(false);
  });
  it('accepts a real recent GLP-1 start date', () => {
    expect(isPlausibleStartDate('2026-05-01', NOW)).toBe(true);
    expect(isPlausibleStartDate('2015-01-01', NOW)).toBe(true);
    expect(isPlausibleStartDate(NOW, NOW)).toBe(true);
  });
});

describe('parseDateExpression', () => {
  it('parses absolute "Month D, YYYY"', () => {
    expect(iso(parseDateExpression('i started ozempic on may 3, 2026', NOW)!)).toBe('2026-05-03');
  });
  it('parses "Month D" with no year → most recent past', () => {
    expect(iso(parseDateExpression('started march 10', NOW)!)).toBe('2026-03-10');
  });
  it('rolls a not-yet-happened month/day back a year', () => {
    // Dec 1 hasn't happened yet in July 2026 → last year.
    expect(iso(parseDateExpression('december 1', NOW)!)).toBe('2025-12-01');
  });
  it('parses "in Month" → 1st of that month', () => {
    expect(iso(parseDateExpression('in may', NOW)!)).toBe('2026-05-01');
  });
  it('parses "Month YYYY"', () => {
    expect(iso(parseDateExpression('march 2026', NOW)!)).toBe('2026-03-01');
  });
  it('parses ISO', () => {
    expect(iso(parseDateExpression('2026-05-01', NOW)!)).toBe('2026-05-01');
  });
  it('parses numeric M/D/YYYY', () => {
    expect(iso(parseDateExpression('5/3/2026', NOW)!)).toBe('2026-05-03');
  });
  it('parses relative "N weeks ago"', () => {
    expect(iso(parseDateExpression('6 weeks ago', NOW)!)).toBe('2026-05-24');
  });
  it('parses relative "a month ago"', () => {
    expect(iso(parseDateExpression('a month ago', NOW)!)).toBe('2026-06-05');
  });
  it('parses duration "for 8 weeks"', () => {
    expect(iso(parseDateExpression('for 8 weeks', NOW)!)).toBe('2026-05-10');
  });
  it('returns null when there is no date', () => {
    expect(parseDateExpression('i started ozempic', NOW)).toBeNull();
  });
});

describe('parseStartDateStatement — captures a stated start date', () => {
  it('captures "I started Ozempic on May 3, 2026"', () => {
    expect(parseStartDateStatement('I started Ozempic on May 3, 2026', NOW)?.iso).toBe('2026-05-03');
  });
  it('captures "I started ozempic in May"', () => {
    expect(parseStartDateStatement('I started ozempic in May', NOW)?.iso).toBe('2026-05-01');
  });
  it('captures "I began the shots 6 weeks ago"', () => {
    expect(parseStartDateStatement('I began the shots 6 weeks ago', NOW)?.iso).toBe('2026-05-24');
  });
  it('captures "been on it for 8 weeks"', () => {
    expect(parseStartDateStatement("I've been on it for 8 weeks", NOW)?.iso).toBe('2026-05-10');
  });
  it('captures "my first shot was 2026-05-01"', () => {
    expect(parseStartDateStatement('my first shot was 2026-05-01', NOW)?.iso).toBe('2026-05-01');
  });
  it('captures "I started taking it in March"', () => {
    expect(parseStartDateStatement('I started taking it in March', NOW)?.iso).toBe('2026-03-01');
  });

  // ── Must NOT capture ──────────────────────────────────────────────────────
  it('does NOT capture an unrelated "started" with an incidental med word', () => {
    expect(parseStartDateStatement('I started eating better 2 weeks ago after my injection', NOW)).toBeNull();
  });
  it('does NOT capture "I started this diet 3 weeks ago" (determiner, not the drug)', () => {
    expect(parseStartDateStatement('I started this diet 3 weeks ago', NOW)).toBeNull();
  });
  it('does NOT capture "I start my day with coffee at 7"', () => {
    expect(parseStartDateStatement('I start my day with coffee 2 hours ago', NOW)).toBeNull();
  });
  it('does NOT capture a question about the start date', () => {
    expect(parseStartDateStatement('when did I start ozempic?', NOW)).toBeNull();
    expect(parseStartDateStatement('When I started taking the injection', NOW)).toBeNull();
  });
  it('does NOT capture an onset with no date', () => {
    expect(parseStartDateStatement('I started ozempic', NOW)).toBeNull();
  });
  it('does NOT store an implausible stated date (1999)', () => {
    expect(parseStartDateStatement('I started ozempic in january 1999', NOW)).toBeNull();
  });
  it('does NOT store a future stated date', () => {
    expect(parseStartDateStatement('I started ozempic on 8/1/2026', NOW)).toBeNull();
  });
});

describe('buildStartDateAnswer — never fabricates', () => {
  it('answers from a plausible stored date with the real date + week', () => {
    const r = buildStartDateAnswer('2026-05-24', 'Ozempic', 'https://x/settings', NOW);
    expect(r).toContain('May 24, 2026');
    expect(r).toMatch(/week \d+/);
    expect(r).toContain('Ozempic');
  });
  it('asks for the date when none on file (no invented date)', () => {
    const r = buildStartDateAnswer(null, 'Ozempic', 'https://x/settings', NOW);
    expect(r.toLowerCase()).toContain("don't have your start date");
    expect(r).not.toMatch(/\b(19|20)\d{2}\b/); // no year fabricated
  });
  it('flags an implausible stored date instead of parroting it', () => {
    const r = buildStartDateAnswer('1999-01-05', 'Ozempic', 'https://x/settings', NOW);
    expect(r.toLowerCase()).toContain("doesn't look right");
    expect(r).toContain('January 5, 1999'); // shown as the wrong value, not asserted as truth
  });
});

describe('buildStartDateCaptureReply', () => {
  it('confirms the saved date + week', () => {
    const r = buildStartDateCaptureReply(new Date('2026-05-24T00:00:00Z'), 'Ozempic', NOW);
    expect(r).toContain('May 24, 2026');
    expect(r.toLowerCase()).toContain('saved your start date');
    expect(r).toMatch(/week \d+/);
  });
});

describe('helpers', () => {
  it('glp1WeekNumber is 1-indexed', () => {
    expect(glp1WeekNumber(new Date('2026-07-05T00:00:00Z'), NOW)).toBe(1);
    expect(glp1WeekNumber(new Date('2026-06-28T00:00:00Z'), NOW)).toBe(2);
  });
  it('formatStartDate renders UTC fields', () => {
    expect(formatStartDate(new Date('2026-05-03T00:00:00Z'))).toBe('May 3, 2026');
  });
});
