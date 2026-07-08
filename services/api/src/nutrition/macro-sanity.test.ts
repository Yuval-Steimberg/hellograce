import { describe, it, expect } from 'vitest';
import {
  isMacroConsistent,
  macroSanityConfidence,
  isRoughConfidence,
  worstConfidence,
  isMaterialMacro,
} from './macro-sanity.js';

describe('isMacroConsistent — protein kcal cannot exceed total kcal', () => {
  it('accepts realistic items', () => {
    expect(isMacroConsistent(18, 210)).toBe(true); // 3 eggs: 72 <= 220
    expect(isMacroConsistent(4, 200)).toBe(true); // 1 cup rice
    expect(isMacroConsistent(31, 165)).toBe(true); // 4oz chicken breast: 124 <= 173
  });
  it('flags an impossible estimate', () => {
    expect(isMacroConsistent(40, 60)).toBe(false); // 160 kcal of protein in a 60 kcal food
    expect(isMacroConsistent(30, 100)).toBe(false); // 120 > 105
  });
  it('is non-committal when there is nothing to check', () => {
    expect(isMacroConsistent(null, 200)).toBe(true);
    expect(isMacroConsistent(20, null)).toBe(true);
    expect(isMacroConsistent(20, 0)).toBe(true);
    expect(isMacroConsistent(0, 0)).toBe(true);
  });
  it('allows a 5% rounding tolerance', () => {
    expect(isMacroConsistent(26, 100)).toBe(true); // 104 <= 105
    expect(isMacroConsistent(27, 100)).toBe(false); // 108 > 105
  });
});

describe('macroSanityConfidence — downgrade only, never upgrade', () => {
  it('keeps the base confidence for a consistent item', () => {
    expect(macroSanityConfidence(18, 210, 'high')).toBe('high');
    expect(macroSanityConfidence(4, 200, 'medium')).toBe('medium');
  });
  it('downgrades an impossible estimate to low', () => {
    expect(macroSanityConfidence(40, 60, 'high')).toBe('low');
    expect(macroSanityConfidence(40, 60, 'exact')).toBe('low');
  });
  it('leaves a low estimate low', () => {
    expect(macroSanityConfidence(40, 60, 'low')).toBe('low');
  });
});

describe('isRoughConfidence + worstConfidence', () => {
  it('rough = low or medium', () => {
    expect(isRoughConfidence('low')).toBe(true);
    expect(isRoughConfidence('medium')).toBe(true);
    expect(isRoughConfidence('high')).toBe(false);
    expect(isRoughConfidence('exact')).toBe(false);
    expect(isRoughConfidence(null)).toBe(false);
  });
  it('worstConfidence picks the least confident present value', () => {
    expect(worstConfidence(['exact', 'high', 'medium'])).toBe('medium');
    expect(worstConfidence(['high', 'low'])).toBe('low');
    expect(worstConfidence(['exact', 'exact'])).toBe('exact');
    expect(worstConfidence([null, 'high', null])).toBe('high');
    expect(worstConfidence([null, undefined])).toBe('medium'); // nothing present
    expect(worstConfidence([])).toBe('medium');
  });
});

describe('isMaterialMacro — worth confirming the portion?', () => {
  it('is TRUE for foods with real protein or calories (crackers, yogurt, toast)', () => {
    expect(isMaterialMacro(1, 120)).toBe(true); // crackers: low protein, real calories
    expect(isMaterialMacro(17, 130)).toBe(true); // greek yogurt
    expect(isMaterialMacro(3, 80)).toBe(true); // toast
    expect(isMaterialMacro(6, 70)).toBe(true); // an egg
    expect(isMaterialMacro(1, 105)).toBe(true); // a banana (real calories)
  });
  it('is FALSE for near-zero-macro items (portion never moves the totals)', () => {
    expect(isMaterialMacro(0, 0)).toBe(false); // water
    expect(isMaterialMacro(0, 5)).toBe(false); // black coffee
    expect(isMaterialMacro(0, 2)).toBe(false); // plain tea
    expect(isMaterialMacro(1, 10)).toBe(false); // a mint / sugar-free gum
  });
  it('is FALSE when there are no numbers to weigh (nothing to confirm)', () => {
    expect(isMaterialMacro(null, null)).toBe(false);
    expect(isMaterialMacro(undefined, undefined)).toBe(false);
  });
  it('either floor alone qualifies (≥2g protein OR ≥25 kcal)', () => {
    expect(isMaterialMacro(2, 0)).toBe(true); // protein floor
    expect(isMaterialMacro(0, 25)).toBe(true); // calorie floor
    expect(isMaterialMacro(1, 24)).toBe(false); // both below
  });
});
