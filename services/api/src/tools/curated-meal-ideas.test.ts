import { describe, it, expect } from 'vitest';
import { getCuratedFoodIdeas, __testing } from './curated-meal-ideas.js';
import type { DietaryRestriction } from '@grace/shared';

const VEGAN: DietaryRestriction = {
  label: 'VEGAN',
  forbidden: ['chicken', 'beef', 'pork', 'salmon', 'tuna', 'fish', 'shrimp', 'egg', 'eggs', 'cheese', 'yogurt', 'milk'],
  allowed: ['tofu', 'tempeh', 'lentils', 'chickpeas'],
};

const VEGETARIAN: DietaryRestriction = {
  label: 'VEGETARIAN',
  forbidden: ['chicken', 'beef', 'pork', 'salmon', 'tuna', 'fish', 'shrimp'],
  allowed: ['eggs', 'cheese', 'tofu', 'lentils'],
};

const PESCATARIAN: DietaryRestriction = {
  label: 'PESCATARIAN',
  forbidden: ['chicken', 'beef', 'pork'],
  allowed: ['salmon', 'tuna', 'shrimp', 'eggs'],
};

describe('curated-meal-ideas', () => {
  it('returns 4 ideas for omnivore + lunch', () => {
    const r = getCuratedFoodIdeas({
      userId: 'u1',
      query: 'what should I eat for lunch',
      mealType: 'lunch',
      dietaryRestriction: null,
      foodDislikes: [],
    });
    expect(r).not.toBeNull();
    expect(r!.length).toBe(4);
    expect(r![0]).toHaveProperty('name');
    expect(r![0]).toHaveProperty('protein_g');
    expect(r![0]).toHaveProperty('why');
  });

  it('returns 4 ideas for vegan + breakfast', () => {
    const r = getCuratedFoodIdeas({
      userId: 'u1',
      query: 'vegan breakfast ideas',
      mealType: 'breakfast',
      dietaryRestriction: VEGAN,
      foodDislikes: [],
    });
    expect(r).not.toBeNull();
    expect(r!.length).toBe(4);
    // Vegan cell should contain plant proteins, not eggs/dairy.
    const names = r!.map((i) => i.name.toLowerCase()).join(' ');
    expect(names).not.toMatch(/\b(eggs?|cheese|yogurt|chicken|salmon)\b/);
  });

  it('returns 4 ideas for pescatarian + dinner', () => {
    const r = getCuratedFoodIdeas({
      userId: 'u1',
      query: 'pescatarian dinner',
      mealType: 'dinner',
      dietaryRestriction: PESCATARIAN,
      foodDislikes: [],
    });
    expect(r).not.toBeNull();
    const names = r!.map((i) => i.name.toLowerCase()).join(' ');
    // No chicken/beef/pork
    expect(names).not.toMatch(/\b(chicken|beef|pork)\b/);
  });

  it('returns null for "general" meal type (not curated)', () => {
    const r = getCuratedFoodIdeas({
      userId: 'u1',
      query: 'snack ideas right now',
      mealType: 'general',
      dietaryRestriction: null,
      foodDislikes: [],
    });
    expect(r).toBeNull();
  });

  it('returns null for "dessert" meal type (not curated)', () => {
    const r = getCuratedFoodIdeas({
      userId: 'u1',
      query: 'dessert?',
      mealType: 'dessert',
      dietaryRestriction: null,
      foodDislikes: [],
    });
    expect(r).toBeNull();
  });

  it('overrides profile diet when query explicitly says "vegan"', () => {
    // User is omnivore but asks for vegan dinner — should get vegan cell.
    const r = getCuratedFoodIdeas({
      userId: 'u1',
      query: 'any vegan dinner ideas',
      mealType: 'dinner',
      dietaryRestriction: null,
      foodDislikes: [],
    });
    expect(r).not.toBeNull();
    const names = r!.map((i) => i.name.toLowerCase()).join(' ');
    expect(names).not.toMatch(/\b(chicken|beef|pork|salmon|fish|shrimp|eggs?|yogurt)\b/);
  });

  it('filters out ideas containing user dislikes', () => {
    const r = getCuratedFoodIdeas({
      userId: 'u1',
      query: 'lunch',
      mealType: 'lunch',
      dietaryRestriction: VEGETARIAN,
      foodDislikes: ['eggs', 'cheese'],
    });
    expect(r).not.toBeNull();
    // Ideas that mention eggs or cheese should be filtered out.
    for (const idea of r!) {
      expect(idea.name.toLowerCase()).not.toMatch(/\b(eggs?|cheese)\b/);
    }
  });

  it('returns null when dislikes wipe out the cell', () => {
    // Vegan + dislikes covering everything → null
    const r = getCuratedFoodIdeas({
      userId: 'u1',
      query: 'lunch',
      mealType: 'lunch',
      dietaryRestriction: VEGAN,
      foodDislikes: ['tofu', 'tempeh', 'lentils', 'chickpeas', 'beans', 'quinoa', 'falafel', 'edamame'],
    });
    expect(r).toBeNull();
  });

  it('different users on same day see different starting points', () => {
    // The rotation seed is hash(userId|dayNumber|meal|diet) % 8, so any two
    // specific user IDs collide on ~1 in 8 calendar days — asserting on a
    // fixed pair made this test date-flaky (it failed on 2026-06-10).
    // Instead assert the spread across 10 users: the chance that ALL ten
    // hash to the same start offset on any given day is (1/8)^9 ≈ 7e-9.
    const firstIdeas = new Set(
      Array.from({ length: 10 }, (_, i) =>
        getCuratedFoodIdeas({
          userId: `user-${i}-${i * 7919}`,
          query: 'breakfast',
          mealType: 'breakfast',
          dietaryRestriction: null,
          foodDislikes: [],
        })!.map((idea) => idea.name).join('|'),
      ),
    );
    expect(firstIdeas.size).toBeGreaterThan(1);
  });

  it('same user + same day returns the same 4 ideas (stable)', () => {
    const opts = {
      userId: 'u1',
      query: 'lunch',
      mealType: 'lunch',
      dietaryRestriction: null,
      foodDislikes: [],
    } as const;
    const r1 = getCuratedFoodIdeas(opts);
    const r2 = getCuratedFoodIdeas(opts);
    expect(r1).not.toBeNull();
    expect(r2).not.toBeNull();
    expect(r1!.map((i) => i.name)).toEqual(r2!.map((i) => i.name));
  });

  it('pickDietKey: vegan keyword in query overrides profile', () => {
    expect(__testing.pickDietKey('vegan ideas', null)).toBe('vegan');
    expect(__testing.pickDietKey('vegetarian lunch', null)).toBe('vegetarian');
    expect(__testing.pickDietKey('pescatarian dinner', null)).toBe('pescatarian');
    expect(__testing.pickDietKey('lunch ideas', VEGAN)).toBe('vegan');
    expect(__testing.pickDietKey('lunch ideas', null)).toBe('omnivore');
  });

  it('every (diet × meal) cell has ≥4 ideas', () => {
    const diets = ['omnivore', 'vegetarian', 'vegan', 'pescatarian'] as const;
    const meals = ['breakfast', 'lunch', 'dinner', 'snack'] as const;
    for (const d of diets) {
      for (const m of meals) {
        const cell = __testing.CURATED_IDEAS[d][m];
        expect(cell.length, `${d} × ${m}`).toBeGreaterThanOrEqual(4);
      }
    }
  });

  it('every idea has a non-empty name and a reason', () => {
    for (const d of Object.values(__testing.CURATED_IDEAS)) {
      for (const m of Object.values(d)) {
        for (const idea of m) {
          expect(idea.name.length).toBeGreaterThan(3);
          expect(idea.why.length).toBeGreaterThan(3);
        }
      }
    }
  });
});
