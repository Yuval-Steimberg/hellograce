import { describe, it, expect } from 'vitest';
import { isWaterQuery, isWaterLog, parseWaterOz } from './water.js';

describe('parseWaterOz', () => {
  it('parses oz', () => expect(parseWaterOz('Had already 65 oz today')).toBe(65));
  it('parses cups (8 oz)', () => expect(parseWaterOz('drank 2 cups')).toBe(16));
  it('parses a glass (8 oz)', () => expect(parseWaterOz('a glass of water')).toBe(8));
  it('parses ml → oz', () => expect(parseWaterOz('500 ml of water')).toBe(17));
  it('parses liters', () => expect(parseWaterOz('1 liter')).toBe(34));
  it('sums multiple amounts', () => expect(parseWaterOz('a glass and 12 oz')).toBe(20));
  it('null when no amount', () => expect(parseWaterOz('drank some water')).toBeNull());
});

describe('isWaterQuery — TOTAL questions only (not the goal/education ask)', () => {
  for (const m of [
    'How much water I had today already',
    'how much water today',
    'how much water have I had',
    "what's my water total",
    'my water today',
    'water so far?',
  ]) {
    it(`"${m}" → water total query`, () => expect(isWaterQuery(m)).toBe(true));
  }
  it('a bare "how much water" stays a goal/education question (NOT a total query)', () => {
    expect(isWaterQuery('How much water')).toBe(false);
    expect(isWaterQuery('how much water should I drink')).toBe(false);
  });
  it('protein / non-water questions are not water queries', () => {
    expect(isWaterQuery('how much protein today')).toBe(false);
    expect(isWaterQuery('how much protein left')).toBe(false);
  });
});

describe('isWaterLog', () => {
  it('explicit water + amount', () => {
    expect(isWaterLog('I drank a glass of water')).toBe(true);
    expect(isWaterLog('had 20 oz of water')).toBe(true);
  });
  it('drink verb + volume, no water word ("I drank 20 oz")', () => {
    expect(isWaterLog('I drank 20 oz')).toBe(true);
  });
  it('bare volume counts as water ONLY with water context in the prior turn', () => {
    const waterCtx = 'Aim for around 64-80 oz of water a day, sipped through the day.';
    expect(isWaterLog('Had already 65 oz today', waterCtx)).toBe(true); // the production case
    expect(isWaterLog('Had already 65 oz today')).toBe(false);          // no context → not water
  });
  it('a volume about solid food is NOT water', () => {
    expect(isWaterLog('1 cup of rice')).toBe(false);
    expect(isWaterLog('drank a coffee')).toBe(false);
  });
  it('a question is never a log', () => {
    expect(isWaterLog('how much water today?')).toBe(false);
  });
});
