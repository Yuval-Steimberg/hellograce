import { describe, it, expect } from 'vitest';
import {
  isMacroConsistent,
  macroSanityConfidence,
  isRoughConfidence,
  worstConfidence,
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
