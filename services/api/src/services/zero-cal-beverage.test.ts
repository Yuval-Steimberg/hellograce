import { describe, it, expect } from 'vitest';
import { zeroCalBeverageMention } from './ai.service.js';

describe('zeroCalBeverageMention — acknowledge a zero-calorie drink, never a caloric one', () => {
  it('detects clearly calorie-free drinks', () => {
    expect(zeroCalBeverageMention('ate two eggs and drank black coffee')).toBe('black coffee');
    expect(zeroCalBeverageMention('just had a coffee')).toBe('coffee');
    expect(zeroCalBeverageMention('had some green tea')).toBe('tea');
    expect(zeroCalBeverageMention('a diet coke with lunch')).toBe('diet soda');
  });

  it('does NOT flag a caloric coffee/tea drink as calorie-free', () => {
    expect(zeroCalBeverageMention('a latte and 2 eggs')).toBeNull();
    expect(zeroCalBeverageMention('coffee with milk and sugar')).toBeNull();
    expect(zeroCalBeverageMention('a caramel macchiato')).toBeNull();
    expect(zeroCalBeverageMention('sweet tea')).toBeNull();
    expect(zeroCalBeverageMention('chai latte with oat milk')).toBeNull();
  });

  it('returns null when no beverage is mentioned', () => {
    expect(zeroCalBeverageMention('two eggs and toast')).toBeNull();
    expect(zeroCalBeverageMention('chicken and rice')).toBeNull();
    expect(zeroCalBeverageMention('')).toBeNull();
  });
});
