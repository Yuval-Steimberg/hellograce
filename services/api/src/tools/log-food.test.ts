import { describe, it, expect } from 'vitest';
import { lookupCommonFoodMacros } from './log-food.js';

describe('lookupCommonFoodMacros — fast-path macro table (2026-06-01)', () => {
  it('matches "2 eggs" exactly', () => {
    const r = lookupCommonFoodMacros('2 eggs');
    expect(r).not.toBeNull();
    expect(r?.protein_g).toBe(12);
    expect(r?.calories).toBe(140);
    expect(r?.confidence).toBe('high');
  });

  it('matches "I just had 2 eggs for breakfast" (article + verb + suffix stripped)', () => {
    const r = lookupCommonFoodMacros('I just had 2 eggs for breakfast');
    expect(r).not.toBeNull();
    expect(r?.protein_g).toBe(12);
  });

  it('matches "Hey, just had 2 eggs" (greeting stripped)', () => {
    const r = lookupCommonFoodMacros('Hey, just had 2 eggs');
    expect(r).not.toBeNull();
    expect(r?.protein_g).toBe(12);
  });

  it('matches "chicken and rice" (compound entry)', () => {
    const r = lookupCommonFoodMacros('chicken and rice');
    expect(r).not.toBeNull();
    expect(r?.protein_g).toBe(34);
  });

  it('prefers the longest matching key ("chicken and rice" wins over "chicken")', () => {
    const r = lookupCommonFoodMacros('had chicken and rice');
    expect(r?.protein_g).toBe(34);
  });

  it('matches "1 chicken breast"', () => {
    expect(lookupCommonFoodMacros('1 chicken breast')?.protein_g).toBe(30);
  });

  it('matches a protein shake by various phrasings', () => {
    expect(lookupCommonFoodMacros('protein shake')?.protein_g).toBe(25);
    expect(lookupCommonFoodMacros('just had a protein shake')?.protein_g).toBe(25);
    expect(lookupCommonFoodMacros('1 scoop protein')?.protein_g).toBe(25);
  });

  it('matches "Greek yogurt" / "cup of Greek yogurt"', () => {
    expect(lookupCommonFoodMacros('Greek yogurt')?.protein_g).toBe(17);
    expect(lookupCommonFoodMacros('cup of Greek yogurt')?.protein_g).toBe(17);
  });

  it('matches "Big Mac"', () => {
    expect(lookupCommonFoodMacros('Big Mac')?.protein_g).toBe(25);
    expect(lookupCommonFoodMacros('I had a Big Mac')?.protein_g).toBe(25);
  });

  it('matches "2 slices of pizza"', () => {
    expect(lookupCommonFoodMacros('2 slices of pizza')?.protein_g).toBe(22);
    expect(lookupCommonFoodMacros('1 slice of pizza')?.protein_g).toBe(11);
  });

  it('returns null for unknown / compound items (falls through to LLM)', () => {
    expect(lookupCommonFoodMacros('vegetarian shepherd pie with lentils')).toBeNull();
    expect(lookupCommonFoodMacros('cheddar chickpea bake')).toBeNull();
    expect(lookupCommonFoodMacros('miso soup with tofu')).toBeNull();
  });

  it('returns null for too-short input', () => {
    expect(lookupCommonFoodMacros('a')).toBeNull();
    expect(lookupCommonFoodMacros('')).toBeNull();
  });

  it('matches "For lunch chicken breast with cup of rice"', () => {
    // The exact multi-meal segment from the 2026-06-01 production failure.
    const r = lookupCommonFoodMacros('For lunch chicken breast with cup of rice');
    expect(r).not.toBeNull();
    // "chicken breast with rice" → 34g (compound entry)
    expect(r?.protein_g).toBe(34);
  });

  it('matches "For breakfast i ate 2 eggs" (production multi-meal segment)', () => {
    const r = lookupCommonFoodMacros('For breakfast i ate 2 eggs');
    expect(r).not.toBeNull();
    expect(r?.protein_g).toBe(12);
  });
});

describe('lookupCommonFoodMacros — Phase 16 expansion (2026-06-03)', () => {
  it('hits Greek yogurt brands', () => {
    expect(lookupCommonFoodMacros('Fage')?.protein_g).toBe(18);
    expect(lookupCommonFoodMacros('I had chobani')?.protein_g).toBe(14);
    expect(lookupCommonFoodMacros('oikos')?.protein_g).toBe(15);
  });

  it('hits cottage cheese full-cup portion', () => {
    expect(lookupCommonFoodMacros('1 cup cottage cheese')?.protein_g).toBe(28);
  });

  it('hits branded protein bars', () => {
    expect(lookupCommonFoodMacros('quest bar')?.protein_g).toBe(20);
    expect(lookupCommonFoodMacros('I had a rxbar')?.protein_g).toBe(12);
    expect(lookupCommonFoodMacros('built bar')?.protein_g).toBe(18);
    expect(lookupCommonFoodMacros('clif bar')?.protein_g).toBe(9);
  });

  it('hits branded shakes', () => {
    expect(lookupCommonFoodMacros('fairlife')?.protein_g).toBe(26);
    expect(lookupCommonFoodMacros('premier protein')?.protein_g).toBe(30);
  });

  it('hits common breakfasts', () => {
    expect(lookupCommonFoodMacros('overnight oats')?.protein_g).toBe(10);
    expect(lookupCommonFoodMacros('avocado toast')?.protein_g).toBe(5);
    expect(lookupCommonFoodMacros('yogurt with berries')?.protein_g).toBe(18);
  });

  it('hits common lunch / dinner items', () => {
    expect(lookupCommonFoodMacros('burrito bowl')?.protein_g).toBe(30);
    expect(lookupCommonFoodMacros('turkey sandwich')?.protein_g).toBe(22);
    expect(lookupCommonFoodMacros('caesar salad with chicken')?.protein_g).toBe(35);
  });

  it('hits asian takeout staples', () => {
    expect(lookupCommonFoodMacros('chicken stir fry')?.protein_g).toBe(30);
    expect(lookupCommonFoodMacros('pad thai')?.protein_g).toBe(16);
    expect(lookupCommonFoodMacros('pho')?.protein_g).toBe(25);
  });

  it('hits packaged tuna / jerky', () => {
    expect(lookupCommonFoodMacros('tuna packet')?.protein_g).toBe(17);
    expect(lookupCommonFoodMacros('I had a turkey jerky')?.protein_g).toBe(12);
  });
});
