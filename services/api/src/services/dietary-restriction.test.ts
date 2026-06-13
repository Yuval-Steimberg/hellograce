import { describe, it, expect } from 'vitest';
import { buildRestrictionFromLabel, effectiveDietaryRestriction } from './ai.service.js';

describe('buildRestrictionFromLabel — signup diet types (2026-06-13)', () => {
  it('maps vegan/vegetarian/pescatarian', () => {
    expect(buildRestrictionFromLabel('vegan')?.label).toBe('VEGAN');
    expect(buildRestrictionFromLabel('Vegetarian')?.label).toBe('VEGETARIAN');
    expect(buildRestrictionFromLabel('pescatarian')?.label).toBe('PESCATARIAN');
    expect(buildRestrictionFromLabel('plant-based')?.label).toBe('VEGAN');
  });

  it('maps kosher / halal / gluten-free / dairy-free (incl. separators + synonyms)', () => {
    expect(buildRestrictionFromLabel('kosher')?.label).toBe('KOSHER');
    expect(buildRestrictionFromLabel('halal')?.label).toBe('HALAL');
    expect(buildRestrictionFromLabel('gluten-free')?.label).toBe('GLUTEN-FREE');
    expect(buildRestrictionFromLabel('gluten free')?.label).toBe('GLUTEN-FREE');
    expect(buildRestrictionFromLabel('celiac')?.label).toBe('GLUTEN-FREE');
    expect(buildRestrictionFromLabel('dairy_free')?.label).toBe('DAIRY-FREE');
    expect(buildRestrictionFromLabel('lactose intolerant')?.label).toBe('DAIRY-FREE');
  });

  it('forbids the obvious conflicts', () => {
    expect(buildRestrictionFromLabel('vegan')?.forbidden).toContain('chicken');
    expect(buildRestrictionFromLabel('kosher')?.forbidden).toContain('pork');
    expect(buildRestrictionFromLabel('kosher')?.forbidden).toContain('shrimp');
    expect(buildRestrictionFromLabel('halal')?.forbidden).toContain('alcohol');
    expect(buildRestrictionFromLabel('gluten-free')?.forbidden).toContain('bread');
    expect(buildRestrictionFromLabel('dairy-free')?.forbidden).toContain('cheese');
  });

  it('returns null for unknown labels', () => {
    expect(buildRestrictionFromLabel('whatever')).toBeNull();
    expect(buildRestrictionFromLabel('')).toBeNull();
  });
});

describe('effectiveDietaryRestriction — reads pattern OR signup free-text', () => {
  it('uses dietary_pattern when set', () => {
    expect(effectiveDietaryRestriction({ dietary_pattern: 'vegan' })?.label).toBe('VEGAN');
  });

  it('falls back to the signup dietary_restriction free-text (the bug)', () => {
    // Production: vegan set at signup landed in dietary_restriction, not the
    // pattern enum, so food recs ignored it and suggested salmon/chicken.
    expect(effectiveDietaryRestriction({ dietary_pattern: null, dietary_restriction: 'vegan' })?.label).toBe('VEGAN');
    expect(effectiveDietaryRestriction({ dietary_restriction: 'kosher' })?.label).toBe('KOSHER');
    expect(effectiveDietaryRestriction({ dietary_restriction: 'gluten free' })?.label).toBe('GLUTEN-FREE');
  });

  it('pattern wins over a (recognized) restriction; null when neither maps', () => {
    expect(effectiveDietaryRestriction({ dietary_pattern: 'vegan', dietary_restriction: 'kosher' })?.label).toBe('VEGAN');
    expect(effectiveDietaryRestriction({ dietary_restriction: 'no spicy food' })).toBeNull();
    expect(effectiveDietaryRestriction(null)).toBeNull();
  });
});
