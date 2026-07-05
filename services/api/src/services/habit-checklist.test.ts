import { describe, it, expect } from 'vitest';
import {
  detectHabitCheck,
  detectSkipFoodLogging,
  buildHabitCheckReply,
  HABIT_KEYS,
} from './habit-checklist.js';

describe('detectHabitCheck — fires on explicit completion phrasing', () => {
  it('checks multiple macro habits from one message', () => {
    expect(detectHabitCheck('I hit protein and water today').sort()).toEqual(['fluids', 'protein']);
  });
  it('movement from "done with movement"', () => {
    expect(detectHabitCheck('Done with movement')).toEqual(['movement']);
  });
  it('strength implies movement too', () => {
    expect(detectHabitCheck('did my strength training').sort()).toEqual(['movement', 'strength']);
  });
  it('supplements from "took my vitamins"', () => {
    expect(detectHabitCheck('took my vitamins')).toEqual(['supplements']);
  });
  it('weighed_in from "weighed in"', () => {
    expect(detectHabitCheck('weighed in this morning')).toEqual(['weighed_in']);
  });
  it('ate_enough from "ate enough today"', () => {
    expect(detectHabitCheck('I ate enough today')).toEqual(['ate_enough']);
  });
  it('symptoms_managed from "managed my nausea"', () => {
    expect(detectHabitCheck('managed my nausea today')).toEqual(['symptoms_managed']);
  });
  it('hit my protein goal → protein', () => {
    expect(detectHabitCheck('hit my protein goal')).toEqual(['protein']);
  });
});

describe('detectHabitCheck — does NOT hijack food logging or questions', () => {
  const shouldNotFire = [
    'I ate high-protein chicken and rice',   // food log — names a food
    'I had a protein shake',                 // food — protein shake is a food
    'got a protein bar',                     // food
    'what protein should I eat?',            // question
    'how much water should I drink',         // question (no completion + no '?') stays empty
    'I drank a green smoothie',              // consumption of a specific food
    'protein is important on GLP-1',         // no completion frame
    'I want to hit my protein goal',         // aspiration is fine to miss (conservative)
    '',
  ];
  for (const msg of shouldNotFire) {
    it(`passes: "${msg}"`, () => {
      expect(detectHabitCheck(msg)).toEqual([]);
    });
  }

  it('does not check injected from chat (state machine owns it)', () => {
    expect(detectHabitCheck('I injected today')).not.toContain('injected');
  });
});

describe('detectSkipFoodLogging', () => {
  it('detects reluctance to log food', () => {
    expect(detectSkipFoodLogging("I don't want to log food today")).toBe(true);
    expect(detectSkipFoodLogging('not logging today')).toBe(true);
    expect(detectSkipFoodLogging('too tired to track everything today')).toBe(true);
  });
  it('does not fire on a normal food log', () => {
    expect(detectSkipFoodLogging('I had eggs for breakfast')).toBe(false);
    expect(detectSkipFoodLogging('log my chicken and rice')).toBe(false);
  });
});

describe('buildHabitCheckReply', () => {
  it('names the checked habits warmly', () => {
    const r = buildHabitCheckReply(['protein', 'fluids']);
    expect(r).toMatch(/protein and fluids/);
    expect(r.length).toBeLessThan(420);
  });
});

describe('HABIT_KEYS', () => {
  it('has the 10 canonical habits', () => {
    expect(HABIT_KEYS).toHaveLength(10);
  });
});
