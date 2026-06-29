import { describe, it, expect } from 'vitest';
import { parseFoodImageAnalysis } from './ai.service.js';

describe('parseFoodImageAnalysis', () => {
  it('auto-logs a confident, clearly-eaten plated meal', () => {
    const block = [
      'IMAGE_TYPE: food',
      'MEAL_STATUS: eaten_meal',
      'ITEMS: grilled chicken breast 140g, brown rice 180g, steamed broccoli 80g',
      'TOTAL: protein 48g | calories 520kcal',
      'CONFIDENCE: high',
      'ASK:',
    ].join('\n');
    const r = parseFoodImageAnalysis(block);
    expect(r.autoLog).toBe(true);
    expect(r.mealStatus).toBe('eaten_meal');
    expect(r.proteinTotal).toBe(48);
    expect(r.caloriesTotal).toBe(520);
    expect(r.items).toContain('chicken');
  });

  it('does NOT auto-log a basket of bananas — the production regression', () => {
    // The exact failure: a fruit bowl was logged as "your meal, 22.5g protein".
    const block = [
      'IMAGE_TYPE: food',
      'MEAL_STATUS: ambiguous',
      'ITEMS: banana 1 medium 120g',
      'TOTAL: protein 1.5g | calories 105kcal',
      'CONFIDENCE: medium',
      'ASK: Those look like a few bananas — did you eat some, and how many?',
    ].join('\n');
    const r = parseFoodImageAnalysis(block);
    expect(r.autoLog).toBe(false);
    expect(r.mealStatus).toBe('ambiguous');
    expect(r.ask).toMatch(/did you eat/i);
    // Realistic protein for a banana — never the inflated 22g.
    expect(r.proteinTotal).toBeLessThan(5);
  });

  it('does NOT auto-log a low-confidence eaten meal (defers to a question)', () => {
    const block = [
      'IMAGE_TYPE: food',
      'MEAL_STATUS: eaten_meal',
      'ITEMS: mixed stir-fry ~300g',
      'TOTAL: protein 25g | calories 400kcal',
      'CONFIDENCE: low',
      'ASK:',
    ].join('\n');
    expect(parseFoodImageAnalysis(block).autoLog).toBe(false);
  });

  it('does NOT auto-log when no protein total parsed', () => {
    const block = [
      'IMAGE_TYPE: food',
      'MEAL_STATUS: eaten_meal',
      'ITEMS: some food',
      'CONFIDENCE: high',
    ].join('\n');
    const r = parseFoodImageAnalysis(block);
    expect(r.proteinTotal).toBeNull();
    expect(r.autoLog).toBe(false);
  });

  it('defaults to ambiguous when MEAL_STATUS is missing (fail-safe: never silently logs)', () => {
    const block = 'IMAGE_TYPE: food\nITEMS: pizza 2 slices\nTOTAL: protein 24g\nCONFIDENCE: high';
    const r = parseFoodImageAnalysis(block);
    expect(r.mealStatus).toBe('ambiguous');
    expect(r.autoLog).toBe(false);
  });
});
