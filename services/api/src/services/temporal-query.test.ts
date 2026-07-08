import { describe, it, expect } from 'vitest';
import { detectTemporalQuery, buildLocalTimeReply, buildDayResetReply, friendlyZone } from './temporal-query.js';

describe('detectTemporalQuery', () => {
  it('detects local-time questions', () => {
    for (const t of ['What is my local time', "what's my local time?", 'what time is it', 'my current time']) {
      expect(detectTemporalQuery(t), t).toBe('local_time');
    }
  });
  it('detects day/diary-reset questions', () => {
    for (const t of ['When my diary resets', 'when does my diary reset?', 'what time does my day reset', 'when do my totals reset']) {
      expect(detectTemporalQuery(t), t).toBe('day_reset');
    }
  });
  it('does NOT fire for the reset COMMAND or unrelated messages', () => {
    for (const t of ['reset my food log', 'I ate 2 eggs', 'what should I eat', 'clear my diary']) {
      expect(detectTemporalQuery(t), t).toBe(null);
    }
  });
  it('does NOT steal a TIMING question ("what time is it best to inject")', () => {
    for (const t of ['what time is it best to inject', 'what time is it good to take my pill', 'what time is it ideal to eat', 'what time is it to weigh in']) {
      expect(detectTemporalQuery(t), t).toBe(null);
    }
    // but a plain clock question still resolves
    expect(detectTemporalQuery('what time is it now')).toBe('local_time');
    expect(detectTemporalQuery('what time is it here')).toBe('local_time');
  });
});

describe('deterministic replies use the REAL timezone (prod IMG_6720/6721)', () => {
  // 2026-07-06T21:25:00Z: New York = 5:25 PM, Jerusalem = 12:25 AM (next day).
  const now = new Date('2026-07-06T21:25:00Z');
  it('local time is the user timezone, not a New York guess', () => {
    const israel = buildLocalTimeReply('Asia/Jerusalem', now);
    expect(israel).toMatch(/12:25\s*AM/i);
    expect(israel).toContain('Jerusalem time');
    expect(israel).not.toMatch(/5:25|New York/i);
    // A genuine New York user still gets New York.
    expect(buildLocalTimeReply('America/New_York', now)).toMatch(/5:25\s*PM/i);
  });
  it('never hedges capability ("I don\'t have access to your clock")', () => {
    const r = buildLocalTimeReply('Asia/Jerusalem', now);
    expect(r.toLowerCase()).not.toMatch(/don'?t have|access|device'?s clock|internal clock/);
  });
  it('day-reset answer is grounded (midnight local), not "your device/app settings"', () => {
    const r = buildDayResetReply('Asia/Jerusalem', now);
    expect(r).toMatch(/midnight/i);
    expect(r).toContain('Jerusalem time');
    expect(r.toLowerCase()).not.toMatch(/device or.*app settings|app settings/);
  });
  it('friendlyZone reads the city', () => {
    expect(friendlyZone('Asia/Jerusalem')).toBe('Jerusalem time');
    expect(friendlyZone('America/New_York')).toBe('New York time');
  });
});
