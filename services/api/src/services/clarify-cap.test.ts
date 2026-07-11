import { describe, it, expect } from 'vitest';
import { PRIOR_FOOD_CLARIFY_RE, pendingFoodStuck } from './ai.service.js';
import { buildPortionConfirmQuestion } from './food-portion.js';

describe('pendingFoodStuck — per-food anti-loop (does not punish new foods)', () => {
  const asst = (content: string) => ({ role: 'assistant', content });

  it('does NOT cap a NEW food just because earlier DIFFERENT foods were each clarified', () => {
    // The exact prod regression: a sandwich took two legit clarifications, then a
    // fresh yogurt/crackers turn must still be ASKED, not auto-logged.
    const history = [
      asst('Ooh okay, what kind of sandwich was it?'),
      asst('Nice, turkey is such a great protein boost. Do you know how many slices or what the portion size was?'),
    ];
    expect(pendingFoodStuck(['yogurt', 'crackers'], history)).toBe(false);
  });

  it('DOES cap the SAME food asked about 2+ times (a real "how much lox" loop)', () => {
    const history = [
      asst('Got it — how much lox did you have, roughly a palm-sized piece?'),
      asst('Just to log it right — how much lox was it?'),
    ];
    expect(pendingFoodStuck(['lox'], history)).toBe(true);
  });

  it('does NOT cap with fewer than two prior clarify questions', () => {
    expect(pendingFoodStuck(['lox'], [asst('how much lox was it?')])).toBe(false);
    expect(pendingFoodStuck(['lox'], [])).toBe(false);
  });

  it('ignores non-clarify assistant turns and user turns', () => {
    const history = [
      { role: 'user', content: 'how much lox how much lox' },
      asst("Logged your eggs — you're at 12g today."),
      asst('Nice, that adds up. Have a good one!'),
    ];
    expect(pendingFoodStuck(['lox'], history)).toBe(false);
  });
});

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
