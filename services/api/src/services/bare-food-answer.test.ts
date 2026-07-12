import { describe, it, expect } from 'vitest';
import { bareFoodAnswer } from './ai.service.js';

/**
 * bareFoodAnswer recovers a verb-less food reply ("Turkey sandwich") that the
 * structured extractor returns `none` for — the exact reply a user gives when
 * answering Grace's "what did you have?". Without it the food vanished and the
 * follow-up portion answer had nothing to attach to (prod 2026-07-11: a turkey
 * sandwich was never logged across an entire clarification loop).
 */
describe('bareFoodAnswer — recover a verb-less food reply in a food context', () => {
  const foodCtx = 'Logged yogurt. You’re at about 30g protein and 550 calories today, a rough estimate, tell me the portion if you want it exact.';
  const askCtx = 'What kind of sandwich was it, and how much?';

  it('recovers a bare food name when Grace just talked about food', () => {
    expect(bareFoodAnswer('Turkey sandwich', foodCtx)).toBe('turkey sandwich');
    expect(bareFoodAnswer('chicken', askCtx)).toBe('chicken');
    expect(bareFoodAnswer('a protein shake', foodCtx)).toBe('protein shake');
  });

  it('strips a leading article and trailing punctuation', () => {
    expect(bareFoodAnswer('the turkey sandwich.', foodCtx)).toBe('turkey sandwich');
    expect(bareFoodAnswer('some crackers', foodCtx)).toBe('crackers');
  });

  it('strips a leading CONNECTOR so a continuation logs a clean name', () => {
    // prod 2026-07-11: "And a sandwich" pended as "and a sandwich" → "what was in
    // the AND A sandwich?" then "Veggie and a sandwich" mis-split into two items.
    expect(bareFoodAnswer('And a sandwich', foodCtx)).toBe('sandwich');
    expect(bareFoodAnswer('also a protein shake', foodCtx)).toBe('protein shake');
    expect(bareFoodAnswer('plus some yogurt', foodCtx)).toBe('yogurt');
  });

  it('does NOT fire out of food context (no food-related prior turn)', () => {
    expect(bareFoodAnswer('Turkey sandwich', 'Good morning! How are you feeling today?')).toBeNull();
    expect(bareFoodAnswer('chicken', null)).toBeNull();
  });

  it('does NOT fire on a question, a plan, a preference, or a diary query', () => {
    expect(bareFoodAnswer('what should I have for lunch?', foodCtx)).toBeNull();
    expect(bareFoodAnswer('any ideas for dinner', foodCtx)).toBeNull();
    expect(bareFoodAnswer('that sounds good', foodCtx)).toBeNull();
    expect(bareFoodAnswer('what have I eaten today', foodCtx)).toBeNull();
  });

  it('does NOT fire on a non-food short message', () => {
    expect(bareFoodAnswer('thanks so much', foodCtx)).toBeNull();
    expect(bareFoodAnswer('feeling great', foodCtx)).toBeNull();
  });

  it('does NOT fire on an over-long message (that goes through extraction)', () => {
    expect(
      bareFoodAnswer('I had a big turkey sandwich earlier with a side of chips', foodCtx),
    ).toBeNull();
  });

  it('does NOT fire on an edit/mutation', () => {
    expect(bareFoodAnswer('remove the sandwich', foodCtx)).toBeNull();
  });
});
