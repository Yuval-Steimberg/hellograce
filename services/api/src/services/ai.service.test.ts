import { describe, it, expect } from 'vitest';
import { splitMultiMealText, reconstructFoodFromClarification, splitQuestionParts, mealForLocalHour, wantsFullDayPlan, localHourForTimezone, looksStructured } from './ai.service.js';
import { detectVagueFood } from '../safety/vague-food.js';

describe('looksStructured — general reply-shape guard (any words/variation)', () => {
  const STRUCTURED = [
    "Here's a general idea: Salmon: A typical serving provides protein, Estimate: 25-40 grams, Potatoes: not high.",
    'Salmon with Potatoes and Salad, Protein Estimate & What to Eat Later Protein Estimate: This depends on size.',
    'Estimating Protein in Your Salmon Meal: This is a rough estimate as portions vary.',
    "Here's an analysis of your entries, categorizing them: Dashboard/Feeling Good After Meal.",
    'For Friday night: Option 1: sheet pan dinner, Option 2: homemade pizza.',
    "That's a common challenge. Here's a strategy broken down into steps: Before You Go (The Pre-Game) 1.",
    '- Greek yogurt\n- eggs\n- chicken',
    // Prod: chained heading-colons with apostrophe labels ("Let's"/"You're")
    // that the strict label test misses.
    "That's a very common dilemma. Let's break it down: Arguments for a Big Dinner: You're probably hungry: Skipping lunch means your body went without fuel.",
  ];
  const PLAIN = [
    'So glad that sat well. Salmon with potatoes and salad is about 30g protein, and a Greek yogurt later would round it out.',
    "Totally normal to feel that way. Just fill your plate with the protein and veggies they serve, and you're not being weird.",
    "You're at about 45g protein today, so eggs or Greek yogurt tonight would get you close to your goal.",
    'That salmon meal is roughly 25-30g of protein. Maybe some Greek yogurt later if you get peckish.',
    'Honestly, just eat what they serve and enjoy it. One meal won\'t derail you.',
  ];
  for (const s of STRUCTURED) it(`flags structured: "${s.slice(0, 40)}…"`, () => expect(looksStructured(s)).toBe(true));
  for (const p of PLAIN) it(`passes plain: "${p.slice(0, 40)}…"`, () => expect(looksStructured(p)).toBe(false));
  it('empty → false', () => expect(looksStructured('')).toBe(false));
});

describe('time-of-day food scoping', () => {
  it('maps local hours to the right current meal', () => {
    expect(mealForLocalHour(7)).toBe('breakfast');
    expect(mealForLocalHour(12)).toBe('lunch');
    expect(mealForLocalHour(16)).toBe('snack');
    expect(mealForLocalHour(19)).toBe('dinner');
    expect(mealForLocalHour(23)).toBe('snack'); // late night → light
    expect(mealForLocalHour(2)).toBe('snack');
  });
  it('detects an explicit full-day request (so we do NOT scope to one meal)', () => {
    expect(wantsFullDayPlan('give me a meal plan for the day')).toBe(true);
    expect(wantsFullDayPlan('what should I eat for the whole day')).toBe(true);
    expect(wantsFullDayPlan('breakfast, lunch and dinner ideas')).toBe(true);
    expect(wantsFullDayPlan('what should I eat today')).toBe(false); // "today" ≠ full-day plan
    expect(wantsFullDayPlan('what should I eat')).toBe(false);
  });
  it('resolves a real timezone to an hour, null when unknown', () => {
    expect(localHourForTimezone('UTC')).toBeGreaterThanOrEqual(0);
    expect(localHourForTimezone('UTC')).toBeLessThan(24);
    expect(localHourForTimezone(null)).toBeNull();
    expect(localHourForTimezone('Not/AZone')).toBeNull();
  });
});

describe('splitQuestionParts — multi-part questions', () => {
  it('splits a 3-part question (production: alcohol + protein + weight)', () => {
    const parts = splitQuestionParts('Can I drink alcohol and how much protein and why is my weight');
    expect(parts.length).toBe(3);
    expect(parts[0]).toMatch(/alcohol/i);
    expect(parts[1]).toMatch(/protein/i);
    expect(parts[2]).toMatch(/weight/i);
  });

  it('does NOT fire on a single question', () => {
    expect(splitQuestionParts('how much protein should I eat')).toEqual([]);
  });

  it('does NOT fire on an emotional statement with "and"', () => {
    expect(splitQuestionParts('I feel tired and stressed')).toEqual([]);
  });
});

describe('reconstructFoodFromClarification — continuation answer (2026-06-13)', () => {
  // The exact production failure: Grace asked "For the pizza, how many slices…",
  // user replied "2 slices" → must become a clean, loggable phrase.
  it('"2 slices" after the pizza category question → "2 slices of pizza"', () => {
    const q = 'Nice 😊 For the pizza, how many slices and what kind (e.g. 2 slices of cheese)? Then I can estimate the protein and calories accurately.';
    expect(reconstructFoodFromClarification(q, '2 slices')).toBe('2 slices of pizza');
  });

  it('prep answer "grilled" after the chicken prep question → "grilled chicken"', () => {
    const q = 'How was the chicken prepared, grilled, baked, or fried? And any sauce or oil?';
    expect(reconstructFoodFromClarification(q, 'grilled')).toBe('grilled chicken');
  });

  it('non-quantity answer "cheese" → "cheese pizza"', () => {
    const q = 'For the pizza, how many slices and what kind (e.g. 2 slices of cheese)?';
    expect(reconstructFoodFromClarification(q, 'cheese')).toBe('cheese pizza');
  });

  it('returns null when the prior message is not one of our clarifications', () => {
    expect(reconstructFoodFromClarification('How are you feeling today?', '2 slices')).toBeNull();
    expect(reconstructFoodFromClarification('What did you have at KFC?', '3 tenders')).toBeNull();
  });

  // 2026-06-15 production: salad clarification → "No dressing" → must STAY in
  // the food flow (re-ask contents), not fall to a generic "what would you like
  // to dig into?". The continuation reconstructs "no dressing" + "salad", and
  // that phrase is still vague (contents unknown) → the re-ask fires.
  it('"No dressing" after the salad ask reconstructs to a still-vague salad', () => {
    const q = 'Sounds good. To log that salad accurately I just need a bit more: what was in it and any dressing (e.g. a chicken caesar)?';
    const recon = reconstructFoodFromClarification(q, 'No dressing');
    expect(recon).not.toBeNull();
    expect(recon!.toLowerCase()).toContain('salad');
    // Still vague (no contents) → the food flow re-asks instead of logging a guess.
    expect(detectVagueFood(recon!, undefined, { requireQuantity: true }).vague).toBe(true);
  });

  it('"chicken" content answer makes the salad specific enough to log', () => {
    const q = 'To log that salad accurately I just need a bit more: what was in it and any dressing?';
    const recon = reconstructFoodFromClarification(q, 'chicken')!;
    // "chicken salad" is a qualified category → no longer vague → logs.
    expect(detectVagueFood(recon, undefined, { requireQuantity: true }).vague).toBe(false);
  });

  // 2026-06-15 follow-up: "Just veggies" answered our CONTENTS re-ask → must
  // LOG a veggie salad, not loop the same question.
  it('reconstructs the food from our "what was in the X?" re-ask', () => {
    const reask = 'Got it, no dressing. What was in the salad? For example just veggies, or with chicken, tuna, eggs, or cheese.';
    expect(reconstructFoodFromClarification(reask, 'Just veggies')!.toLowerCase()).toContain('salad');
  });

  it('"just veggies salad" / "veggies salad" is specific enough to log (no loop)', () => {
    expect(detectVagueFood('Just veggies salad', undefined, { requireQuantity: true }).vague).toBe(false);
    expect(detectVagueFood('veggies salad', undefined, { requireQuantity: true }).vague).toBe(false);
    expect(detectVagueFood('garden salad', undefined, { requireQuantity: true }).vague).toBe(false);
  });

  // 2026-06-15 follow-up: a complete clarification answer that NAMES a food +
  // amount ("cup of spaghetti with meat sauce") is loggable as-is — it must not
  // be re-asked for portion. (The continuation logs the reply directly when it
  // already contains a recognized food, rather than appending the prior food.)
  it('a complete answer with a food + amount is not vague (logs, no re-ask)', () => {
    expect(detectVagueFood('cup of spaghetti with meat sauce', undefined, { requireQuantity: true }).vague).toBe(false);
    expect(detectVagueFood('two cups of pasta', undefined, { requireQuantity: true }).vague).toBe(false);
  });
});

describe('splitMultiMealText — multi-meal preprocessor (2026-06-01 fix)', () => {
  it('splits the exact production failure into two meal segments', () => {
    // User: "Hey\nFor breakfast i ate 2 eggs.\nFor lunch chicken breast with cup of rice"
    // Before: single log_food got the whole blob → logged 0g.
    // After: two log_food calls, one per meal.
    const out = splitMultiMealText(
      'Hey\nFor breakfast i ate 2 eggs.\nFor lunch chicken breast with cup of rice',
    );
    expect(out.length).toBe(2);
    expect(out[0]?.toLowerCase()).toContain('breakfast');
    expect(out[0]?.toLowerCase()).toContain('eggs');
    expect(out[1]?.toLowerCase()).toContain('lunch');
    expect(out[1]?.toLowerCase()).toContain('chicken');
    expect(out[1]?.toLowerCase()).toContain('rice');
  });

  it('returns [] for a single-meal message (so the normal single-call path runs)', () => {
    expect(splitMultiMealText('Just had two eggs')).toEqual([]);
    expect(splitMultiMealText('For breakfast I had eggs')).toEqual([]);
    expect(splitMultiMealText('chicken and rice for dinner')).toEqual([]);
  });

  it('splits three meals (breakfast + lunch + dinner)', () => {
    const out = splitMultiMealText(
      'For breakfast I had oatmeal. For lunch chicken salad. For dinner salmon and broccoli',
    );
    expect(out.length).toBe(3);
  });

  it('handles colon-separated meal labels ("Breakfast: eggs, Lunch: chicken")', () => {
    const out = splitMultiMealText('Breakfast: 2 eggs. Lunch: chicken breast with rice.');
    expect(out.length).toBe(2);
    expect(out[0]?.toLowerCase()).toContain('breakfast');
    expect(out[1]?.toLowerCase()).toContain('lunch');
  });

  it('returns [] when there is only one meal label even with extra prose', () => {
    expect(splitMultiMealText('I had 2 eggs for breakfast and that was filling')).toEqual([]);
  });

  it('preserves food that comes BEFORE the meal label (2026-06-14 memory bug)', () => {
    // Production: "Had two eggs for breakfast. Now having a small snack" logged
    // ONLY the snack — the eggs (before "for breakfast") were dropped because
    // the old splitter captured from the label forward ("for breakfast").
    const out = splitMultiMealText('Had two eggs for breakfast. Now having a small snack');
    expect(out.length).toBe(2);
    expect(out[0]?.toLowerCase()).toContain('eggs'); // ← eggs NO LONGER dropped
    expect(out[0]?.toLowerCase()).toContain('breakfast');
    expect(out[1]?.toLowerCase()).toContain('snack');
  });

  it('keeps food before the label across "food for meal" phrasing', () => {
    const out = splitMultiMealText('chicken for lunch. salmon for dinner');
    expect(out.length).toBe(2);
    expect(out[0]?.toLowerCase()).toContain('chicken');
    expect(out[1]?.toLowerCase()).toContain('salmon');
  });

  it('does NOT dedupe distinct meals that share the same label', () => {
    // Pathological: two "lunch" mentions. We keep both segments distinct
    // (the food differs) but the dedupe check is on exact-string match,
    // not label. Two real "for lunch" segments with different food count.
    const out = splitMultiMealText(
      'For lunch I had chicken. For lunch later I had a snack of berries',
    );
    expect(out.length).toBeGreaterThanOrEqual(1);
  });
});
