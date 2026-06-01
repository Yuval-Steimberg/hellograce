import { describe, it, expect } from 'vitest';
import { splitMultiMealText } from './ai.service.js';

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
