import { describe, it, expect } from 'vitest';
import { buildTemporalContextBlock } from './temporal-context.js';
import {
  detectInjectionTimingIntent,
  computeInjectionSchedule,
  buildInjectionTimingReply,
} from './medication-schedule.js';
import { mightStateProfileChange } from './profile-extract.js';
import { checkBannedPhrases, getToolAwareFallback } from '@grace/ai-core';

/**
 * Grounding replay — reproduces the exact production transcript for Uri
 * (+972…) on 2026-07-03 so every failure that happened that day is locked as a
 * regression test. Uri: Zepbound (weekly), injects Saturday, Asia/Jerusalem.
 *
 * 2026-06-30 09:00Z is a TUESDAY in Jerusalem → Tue→Sat is exactly the "4 days"
 * from the screenshot, next shot 2026-07-04.
 */
const NOW = new Date('2026-06-30T09:00:00Z');
const URI = {
  medicationType: 'weekly_injection' as const,
  medicationName: 'Zepbound',
  injectionDay: 'Saturday',
  timezone: 'Asia/Jerusalem',
};
const SETTINGS = 'https://graceglp.com/settings';

describe('grounding replay — Uri transcript (2026-07-03)', () => {
  it('"When is my next injection?" → grounded date, never a denial', () => {
    expect(detectInjectionTimingIntent('When is my next injection?')).toBe('next');
    const r = buildInjectionTimingReply('next', computeInjectionSchedule(URI, NOW), 'Zepbound', SETTINGS);
    expect(r).toContain('in 4 days');
    expect(r).toContain('Saturday, July 4, 2026');
    expect(checkBannedPhrases(r)).toHaveLength(0);
  });

  it('"When is my next dose?" resolves through the SAME path (not a 2nd behavior)', () => {
    expect(detectInjectionTimingIntent('When is my next dose?')).toBe('next');
    expect(detectInjectionTimingIntent('when is my next shot')).toBe('next');
  });

  it('"what day is today?" → the real date is in the prompt (no 2024 hallucination)', () => {
    const block = buildTemporalContextBlock('Asia/Jerusalem', NOW);
    expect(block).toContain('June 30, 2026');
    expect(block).not.toContain('2024');
    expect(block.toLowerCase()).toContain('real-time'); // the "never claim real-time" instruction
  });

  it('"How 4 days?" → explained as the calendar gap, not weight/muscle math', () => {
    const prior = buildInjectionTimingReply('next', computeInjectionSchedule(URI, NOW), 'Zepbound', SETTINGS);
    const fb = getToolAwareFallback('general', [], { isReasoningRequest: true, lastAssistantMessage: prior, userMessage: 'How 4 days?' });
    expect(fb).toMatch(/calendar|shot day|date/i);
    expect(fb).not.toMatch(/weight|muscle/i);
  });

  it('the three bad Grace outputs from the screenshot are ALL caught by the content guard', () => {
    // 1. injection capability denial
    expect(checkBannedPhrases('I cannot tell you when your next injection is.').length).toBeGreaterThan(0);
    // 2. medical-record deflection
    expect(checkBannedPhrases("I don't have access to your personal medical records or treatment plan.").length).toBeGreaterThan(0);
    // 3. hallucinated date + false real-time claim
    expect(checkBannedPhrases('Yes, I am sure today is Tuesday, May 14, 2024. I have access to real-time information.').length).toBeGreaterThan(0);
  });

  it('"my shot day is Saturday" would be captured to the profile (durable memory)', () => {
    expect(mightStateProfileChange('my shot day is Saturday')).toBe(true);
  });

  it('cadence nuance: a daily-pill user (Rybelsus) gets a DAILY answer, not a weekly count', () => {
    const s = computeInjectionSchedule({ medicationType: 'daily_pill', medicationName: 'Rybelsus', injectionDay: null, timezone: 'Asia/Jerusalem' }, NOW);
    const r = buildInjectionTimingReply('next', s, 'Rybelsus', SETTINGS);
    expect(r.toLowerCase()).toContain('daily');
    expect(r).not.toContain('4 days');
  });

  it('missing injection day → ASK, never deny', () => {
    const s = computeInjectionSchedule({ medicationType: 'weekly_injection', medicationName: 'Zepbound', injectionDay: null, timezone: 'Asia/Jerusalem' }, NOW);
    const r = buildInjectionTimingReply('next', s, 'Zepbound', SETTINGS);
    expect(r.toLowerCase()).toContain('which day');
    expect(checkBannedPhrases(r)).toHaveLength(0);
  });

  it('"when was my last shot?" / "is today my shot day?" resolve too', () => {
    expect(detectInjectionTimingIntent('when was my last shot?')).toBe('last');
    expect(detectInjectionTimingIntent('is today my shot day?')).toBe('today');
  });
});
