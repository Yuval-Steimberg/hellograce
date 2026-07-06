import { describe, it, expect } from 'vitest';
import { isPortionAffirmation, buildPortionConfirmQuestion, isPortionSensitiveFood, isCompositionAmbiguousFood } from './food-portion.js';
import { hasExplicitQuantity } from '../safety/vague-food.js';

// A composition-ambiguous assembled food (a bare sandwich/wrap) must be ASKED
// about, never logged at an assumed value — even when an article is present.
// Prod (IMG_6699): Grace logged "a sandwich" at ~23g "assuming deli meat"; Nudge
// held it pending and asked. A named filling makes it loggable.
describe('isCompositionAmbiguousFood — ask what is IN it, never assume a filling', () => {
  it('is TRUE for a bare assembled food (even with an article)', () => {
    for (const f of ['sandwich', 'a sandwich', 'wrap', 'a wrap', 'burrito', 'taco', 'sub', 'hoagie', 'quesadilla', 'panini']) {
      expect(isCompositionAmbiguousFood(f), f).toBe(true);
    }
  });
  it('is FALSE once a filling/protein is named (loggable)', () => {
    for (const f of ['turkey sandwich', 'chicken wrap', 'egg sandwich', 'peanut butter sandwich', 'tuna sub', 'veggie burrito', 'ham and cheese sandwich']) {
      expect(isCompositionAmbiguousFood(f), f).toBe(false);
    }
  });
  it('is FALSE for non-assembled foods (protein shake logs at standard, like Nudge)', () => {
    for (const f of ['protein shake', 'apple', 'banana', 'chicken', 'rice', 'yogurt', 'toast', 'burger']) {
      expect(isCompositionAmbiguousFood(f), f).toBe(false);
    }
  });
});

describe('isPortionSensitiveFood — only ask when the portion swings the macros', () => {
  it('is TRUE for portion-variable foods', () => {
    for (const f of ['yogurt with berries', 'chicken', 'rice', 'pasta', 'oatmeal', 'a bowl of cereal', 'cheese', 'almonds', 'smoothie', 'beef and rice']) {
      expect(isPortionSensitiveFood(f), f).toBe(true);
    }
  });
  it('is FALSE for obvious / low-variance foods (just log)', () => {
    for (const f of ['apple', 'banana', 'toast', 'a boiled egg', 'orange', 'protein bar', 'a granola bar']) {
      expect(isPortionSensitiveFood(f), f).toBe(false);
    }
  });
});

describe('isPortionAffirmation', () => {
  it('accepts confirmations of the proposed standard portion', () => {
    for (const t of ['yes', 'yep', 'that\'s right', 'that\'s about right', 'about right', 'the usual', 'standard serving', 'log it', 'that works', 'perfect']) {
      expect(isPortionAffirmation(t), t).toBe(true);
    }
  });
  it('rejects a real portion answer or a new topic', () => {
    for (const t of ['a small cup', '6 oz', 'two cups of rice', 'actually a big bowl', 'what should I eat for dinner', 'no']) {
      expect(isPortionAffirmation(t), t).toBe(false);
    }
  });
});

describe('buildPortionConfirmQuestion', () => {
  it('asks the portion warmly and offers the standard-serving shortcut', () => {
    const q = buildPortionConfirmQuestion([{ item: 'yogurt with berries', protein_g: 18 }]);
    expect(q).toMatch(/yogurt with berries/i);
    expect(q).toMatch(/how much/i);
    expect(q).toMatch(/that'?s about right/i);
  });
  it('asks about EACH dish with a fitting reference, not one generic amount', () => {
    const q = buildPortionConfirmQuestion([{ item: 'chicken', protein_g: null }, { item: 'rice', protein_g: null }]);
    expect(q).toMatch(/chicken and rice/i);
    // per-dish references: a palm-sized piece for chicken, a cup for rice
    expect(q).toMatch(/for the chicken, a palm-sized piece/i);
    expect(q).toMatch(/for the rice, about a cup/i);
    expect(buildPortionConfirmQuestion([])).toBe('');
  });

  it('uses a food-appropriate reference for a single dish (not a blanket cup/container)', () => {
    expect(buildPortionConfirmQuestion([{ item: 'grilled chicken', protein_g: null }])).toMatch(/palm-sized piece/i);
    expect(buildPortionConfirmQuestion([{ item: 'white rice', protein_g: null }])).toMatch(/a cup/i);
    expect(buildPortionConfirmQuestion([{ item: 'greek yogurt', protein_g: null }])).toMatch(/small container/i);
  });

  it('asks what is IN a composition-ambiguous food (not how much), and never guesses the filling', () => {
    const q = buildPortionConfirmQuestion([{ item: 'sandwich', protein_g: null }]);
    expect(q).toMatch(/what was in the sandwich/i);
    expect(q).not.toMatch(/how much/i);
    expect(q.toLowerCase()).toContain('guess'); // "I'd rather log it right than guess"
  });

  it('mixes question types in a multi-item meal (what-was-in-it vs how-much)', () => {
    const q = buildPortionConfirmQuestion([{ item: 'sandwich', protein_g: null }, { item: 'rice', protein_g: null }]);
    expect(q).toMatch(/what was in the sandwich/i);
    expect(q).toMatch(/for the rice, about a cup/i);
  });
});

describe('hasExplicitQuantity — the precision gate', () => {
  it('is FALSE for a portion-less meal (→ ask before logging)', () => {
    for (const t of ['yogurt with berries', 'i ate yogurt with berries', 'chicken and rice', 'had some pasta']) {
      expect(hasExplicitQuantity(t), t).toBe(false);
    }
  });
  it('is TRUE when an amount/unit/size/article is present (→ log)', () => {
    for (const t of ['2 eggs', 'a cup of rice', '6 oz chicken', 'a banana', 'a large yogurt', 'half a sandwich']) {
      expect(hasExplicitQuantity(t), t).toBe(true);
    }
  });
});
