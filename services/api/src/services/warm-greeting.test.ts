import { describe, it, expect } from 'vitest';
import { buildWarmGreeting } from './ai.service.js';

/**
 * A greeting gets an INSTANT, warm, day-aware reply (the Nudge model) — no LLM,
 * so it's fast and never a dry generic line. References the user's real local
 * weekday/time and offers a hand.
 */
describe('buildWarmGreeting — warm, day-aware, deterministic', () => {
  // 2026-07-08T15:00:00Z is a Wednesday; in Asia/Jerusalem = 18:00 (evening).
  const when = new Date('2026-07-08T15:00:00Z');
  it('greets back, names the local weekday/time, and offers help', () => {
    const g = buildWarmGreeting('user1|hey', 'Asia/Jerusalem', when);
    expect(g.toLowerCase()).toMatch(/hey|hi/);
    expect(g).toMatch(/Wednesday|evening/); // day-aware from the real zone
    expect(g.toLowerCase()).toMatch(/day|meal|chat|log|food/); // offers a hand
  });
  it('is deterministic for a given seed', () => {
    expect(buildWarmGreeting('u|hey', 'America/New_York', when)).toBe(buildWarmGreeting('u|hey', 'America/New_York', when));
  });
  it('varies across seeds (not one fixed line)', () => {
    expect(buildWarmGreeting('a|hey', 'UTC', when)).not.toBe(buildWarmGreeting('zzz|hey', 'UTC', when));
  });
  it('never throws on a null timezone (falls back to a real reply)', () => {
    expect(buildWarmGreeting('u|hi', null, when).length).toBeGreaterThan(10);
  });
});
