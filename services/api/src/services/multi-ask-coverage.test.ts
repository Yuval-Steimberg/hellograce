import { describe, it, expect } from 'vitest';
import { askKeywordGroups, uncoveredAskCount, missingAskTopics } from './multi-ask-coverage.js';

const FRIDAY =
  "I'm going to my parents Friday. Can you help me plan what to eat before dinner, what to choose at the meal, and how to handle dessert without feeling guilty?";

describe('askKeywordGroups — only enumerated multi-ask questions', () => {
  it('extracts the three Friday asks', () => {
    const g = askKeywordGroups(FRIDAY);
    expect(g.length).toBe(3);
    expect(g.some((k) => k.includes('dinner'))).toBe(true);
    expect(g.some((k) => k.includes('meal'))).toBe(true);
    expect(g.some((k) => k.includes('dessert'))).toBe(true);
  });
  it('is empty for a single question or a non-question', () => {
    expect(askKeywordGroups('What should I eat before dinner?')).toEqual([]);
    expect(askKeywordGroups('I ate 2 eggs and a salad.')).toEqual([]);
    expect(askKeywordGroups('Can you help me with my protein?')).toEqual([]);
  });
});

describe('uncoveredAskCount — the prod failure (only before-dinner answered)', () => {
  // The exact prod reply: covered "before dinner" (via "before you go") but
  // dropped the at-the-meal advice AND the dessert/guilt part.
  const droppedReply =
    "Nice, sandwich and protein shake. For Friday, try to have a Greek yogurt or some turkey slices about an hour before you go so you aren't arriving hungry.";
  it('flags the two dropped asks', () => {
    expect(uncoveredAskCount(FRIDAY, droppedReply)).toBe(2);
    expect(missingAskTopics(FRIDAY, droppedReply)).toContain('meal');
    expect(missingAskTopics(FRIDAY, droppedReply)).toContain('dessert');
  });
  it('a complete reply is fully covered (0 uncovered)', () => {
    const full =
      "Before you go, have a Greek yogurt so you're not starving. At the meal, fill your plate with the meat first, then a little pasta and bread. And enjoy a small dessert — no guilt, one treat won't undo your progress.";
    expect(uncoveredAskCount(FRIDAY, full)).toBe(0);
  });
  it('returns 0 for messages that are not enumerated multi-asks', () => {
    expect(uncoveredAskCount('What should I eat before dinner?', 'Have some Greek yogurt.')).toBe(0);
  });
});
