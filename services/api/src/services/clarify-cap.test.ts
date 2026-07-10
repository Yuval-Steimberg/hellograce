import { describe, it, expect } from 'vitest';
import { PRIOR_FOOD_CLARIFY_RE } from './ai.service.js';
import { buildPortionConfirmQuestion } from './food-portion.js';

/**
 * The live-path anti-loop cap (runUnifiedReply) counts how many food
 * clarification questions Grace ALREADY asked in history by matching her prior
 * assistant turns against PRIOR_FOOD_CLARIFY_RE. For the cap to actually fire,
 * that regex MUST match the questions Grace's own asker (buildPortionConfirmQuestion)
 * produces. This test locks that link so the cap can never silently stop counting.
 */
describe('clarify-cap: PRIOR_FOOD_CLARIFY_RE matches every question buildPortionConfirmQuestion asks', () => {
  const cases: Array<Array<{ item: string; protein_g: number | null }>> = [
    [{ item: 'protein shake', protein_g: null }],                                   // scoops/brand
    [{ item: 'sandwich', protein_g: null }],                                        // what was in
    [{ item: 'lox', protein_g: null }],                                             // About how much
    [{ item: 'yogurt with berries', protein_g: null }],                             // About how much
    [{ item: 'rice', protein_g: null }, { item: 'chicken', protein_g: null }],      // multi-dish
    [{ item: 'salad', protein_g: null }, { item: 'protein shake', protein_g: null }], // mixed multi
  ];

  it.each(cases)('matches the clarify for %j', (...items) => {
    const q = buildPortionConfirmQuestion(items as Array<{ item: string; protein_g: number | null }>);
    expect(PRIOR_FOOD_CLARIFY_RE.test(q)).toBe(true);
  });

  it('does NOT match a normal (non-clarifying) assistant reply', () => {
    expect(PRIOR_FOOD_CLARIFY_RE.test("Nice, that's 22g protein so far today.")).toBe(false);
    expect(PRIOR_FOOD_CLARIFY_RE.test("Logged your eggs — you're off to a strong start 🤍")).toBe(false);
    expect(PRIOR_FOOD_CLARIFY_RE.test('Your next reminder is tomorrow morning around 8:00 AM.')).toBe(false);
  });
});
