import { describe, it, expect } from 'vitest';
import { resolveTemporalContext, buildTemporalContextBlock } from './temporal-context.js';

describe('resolveTemporalContext', () => {
  it('gives the FULL local date (not just weekday) — the production hallucination fix', () => {
    // 2026-07-03 16:42Z = 19:42 in Jerusalem (UTC+3 summer). Uri's real case.
    const t = resolveTemporalContext('Asia/Jerusalem', new Date('2026-07-03T16:42:00Z'));
    expect(t.humanDate).toContain('July 3, 2026');
    expect(t.year).toBe(2026);
    expect(t.isoDate).toBe('2026-07-03');
    expect(t.time12).toBe('7:42 PM');
    expect(t.timeOfDay).toBe('evening');
    expect(t.timezone).toBe('Asia/Jerusalem');
    expect(t.usedFallbackTz).toBe(false);
  });

  it('walks yesterday/tomorrow consistently with today', () => {
    const t = resolveTemporalContext('Asia/Jerusalem', new Date('2026-07-03T16:42:00Z'));
    expect(t.yesterdayHuman).toContain('July 2, 2026');
    expect(t.tomorrowHuman).toContain('July 4, 2026');
    // tomorrow's weekday is the day AFTER today's weekday
    const WD = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const todayIdx = WD.indexOf(t.weekday);
    expect(t.tomorrowHuman.startsWith(WD[(todayIdx + 1) % 7])).toBe(true);
    expect(t.yesterdayHuman.startsWith(WD[(todayIdx + 6) % 7])).toBe(true);
    expect(t.next7Days).toHaveLength(7);
    expect(t.next7Days[0]).toContain('Jul 4');
  });

  it('applies the timezone across the UTC midnight boundary (not UTC date)', () => {
    // 04:30Z Jan 15 = 23:30 EST Jan 14 in New York (UTC-5 winter).
    const t = resolveTemporalContext('America/New_York', new Date('2026-01-15T04:30:00Z'));
    expect(t.humanDate).toContain('January 14, 2026');
    expect(t.hour24).toBe(23);
    expect(t.timeOfDay).toBe('night');
    expect(t.time12).toBe('11:30 PM');
  });

  it('crosses month/year boundaries when walking days', () => {
    const t = resolveTemporalContext('UTC', new Date('2025-12-31T12:00:00Z'));
    expect(t.humanDate).toContain('December 31, 2025');
    expect(t.tomorrowHuman).toContain('January 1, 2026');
    expect(t.yesterdayHuman).toContain('December 30, 2025');
    expect(t.next7Days[0]).toContain('Jan 1');
  });

  it('normalizes local midnight to 12:00 AM / hour 0', () => {
    const t = resolveTemporalContext('UTC', new Date('2026-07-03T00:00:00Z'));
    expect(t.hour24).toBe(0);
    expect(t.time12).toBe('12:00 AM');
    expect(t.timeOfDay).toBe('night');
  });

  it('renders local noon as 12:00 PM', () => {
    const t = resolveTemporalContext('UTC', new Date('2026-07-03T12:00:00Z'));
    expect(t.time12).toBe('12:00 PM');
    expect(t.timeOfDay).toBe('afternoon');
  });

  it('falls back safely on an invalid timezone (never throws, still full date)', () => {
    const t = resolveTemporalContext('Not/AZone', new Date('2026-07-03T16:00:00Z'));
    expect(t.usedFallbackTz).toBe(true);
    expect(t.timezone).toBe('America/New_York');
    expect(t.humanDate).toContain('2026');
  });

  it('falls back when no timezone is provided', () => {
    const t = resolveTemporalContext(null, new Date('2026-07-03T16:00:00Z'));
    expect(t.usedFallbackTz).toBe(true);
    expect(t.humanDate).toContain('2026');
  });
});

describe('buildTemporalContextBlock', () => {
  it('is authoritative and forbids the false real-time claim', () => {
    const block = buildTemporalContextBlock('Asia/Jerusalem', new Date('2026-07-03T16:42:00Z'));
    expect(block).toContain('July 3, 2026');
    expect(block).toContain('authoritative');
    expect(block.toLowerCase()).toContain('real-time');
    expect(block).toContain('Yesterday was');
    expect(block).toContain('next 7 days');
  });
});
