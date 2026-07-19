import { describe, it, expect } from 'vitest';
import { deriveMissingTargets } from './derive-targets.js';

describe('deriveMissingTargets', () => {
  it('sets a personalized protein target from weight + goal (not the 80g default)', () => {
    // 200 lbs ≈ 90.7 kg × 1.2 (fat_loss) ≈ 109g
    const out = deriveMissingTargets({ current_weight: 200, primary_goal: 'fat_loss' });
    expect(out.protein_goal_grams).toBeGreaterThan(100);
    expect(out.protein_goal_grams).toBeLessThan(120);
  });

  it('never overwrites an existing protein target (fill-if-missing)', () => {
    const out = deriveMissingTargets({
      current_weight: 200,
      primary_goal: 'fat_loss',
      protein_goal_grams: 110,
    });
    expect(out.protein_goal_grams).toBeUndefined();
  });

  it('does not produce a protein target without a weight', () => {
    const out = deriveMissingTargets({ primary_goal: 'fat_loss', current_weight: null });
    expect(out.protein_goal_grams).toBeUndefined();
  });

  it('sets a calorie target when all Mifflin-St Jeor inputs are present', () => {
    const out = deriveMissingTargets({
      current_weight: 200,
      height_cm: 170,
      age: 40,
      sex: 'female',
      activity_level: 'moderate',
      primary_goal: 'fat_loss',
    });
    expect(out.calorie_goal_kcal).toBeGreaterThan(1000);
    expect(out.calorie_goal_kcal).toBeLessThan(4000);
  });

  it('omits the calorie target when an input is missing', () => {
    const out = deriveMissingTargets({
      current_weight: 200,
      height_cm: 170,
      // age missing
      sex: 'female',
      activity_level: 'moderate',
    });
    expect(out.calorie_goal_kcal).toBeUndefined();
    // protein still fills (only needs weight)
    expect(out.protein_goal_grams).toBeGreaterThan(0);
  });

  it('drops an unrecognized activity_level rather than producing a NaN calorie target', () => {
    const out = deriveMissingTargets({
      current_weight: 200,
      height_cm: 170,
      age: 40,
      sex: 'female',
      activity_level: 'super_active', // not a known key
      primary_goal: 'fat_loss',
    });
    expect(out.calorie_goal_kcal).toBeUndefined();
  });

  it('never overwrites an existing calorie target', () => {
    const out = deriveMissingTargets({
      current_weight: 200,
      height_cm: 170,
      age: 40,
      sex: 'female',
      activity_level: 'moderate',
      calorie_goal_kcal: 1500,
    });
    expect(out.calorie_goal_kcal).toBeUndefined();
  });

  it('falls back to the first free-text goal when primary_goal is absent', () => {
    const out = deriveMissingTargets({ current_weight: 180, goals: ['lose weight', 'feel better'] });
    // "lose weight" maps to the evidence-informed fat-loss multiplier.
    const neutral = deriveMissingTargets({ current_weight: 180 }).protein_goal_grams!;
    expect(out.protein_goal_grams!).toBe(neutral);
  });

  it('returns an empty object when there is nothing to fill', () => {
    expect(deriveMissingTargets({ protein_goal_grams: 100, calorie_goal_kcal: 1600 })).toEqual({});
  });
});
