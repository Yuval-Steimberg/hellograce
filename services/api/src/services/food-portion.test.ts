import { describe, it, expect } from 'vitest';
import { isPortionAffirmation, buildPortionConfirmQuestion, isPortionSensitiveFood } from './food-portion.js';
import { hasExplicitQuantity } from '../safety/vague-food.js';

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
