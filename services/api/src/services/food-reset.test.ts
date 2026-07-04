import { describe, it, expect } from 'vitest';
import { detectFoodReset, buildFoodResetReply } from './food-reset.js';

describe('detectFoodReset', () => {
  it('fires on explicit reset/clear requests', () => {
    for (const t of [
      'reset my food log',
      'clear today\'s food',
      'clear my food log',
      'wipe today\'s food',
      'delete all my food today',
      'remove all my food entries',
      'start over with my food',
      'zero out my calories today',
      'clean out today\'s food diary',
      'reset today',
    ]) {
      expect(detectFoodReset(t), t).toBe(true);
    }
  });

  it('does NOT fire on a single-item delete', () => {
    for (const t of [
      'remove the pizza',
      'delete the yogurt',
      'take off the eggs',
      'undo the last one',
    ]) {
      expect(detectFoodReset(t), t).toBe(false);
    }
  });

  it('does NOT fire on food logs, questions, or unrelated messages', () => {
    for (const t of [
      'I ate yogurt with berries',
      'how much protein did I have today',
      'what should I eat for dinner',
      'clear my head',
      'reset my password',
      'I want to start fresh tomorrow with my diet',
    ]) {
      expect(detectFoodReset(t), t).toBe(false);
    }
  });

  it('builds a confirmation for a real reset and an empty-day case', () => {
    expect(buildFoodResetReply(5)).toMatch(/cleared today'?s food log/i);
    expect(buildFoodResetReply(5)).toMatch(/0g protein/i);
    expect(buildFoodResetReply(0)).toMatch(/already empty/i);
  });
});
