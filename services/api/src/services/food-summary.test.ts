import { describe, it, expect } from 'vitest';
import { aggregateFoodItems, formatAggregatedInline, renderDailyFoodSummary } from './food-summary.js';

describe('aggregateFoodItems', () => {
  it('dedupes identical foods into a single entry with a count', () => {
    const agg = aggregateFoodItems(['chicken breast (4oz)', 'chicken breast (4oz)', 'chicken breast (4oz)']);
    expect(agg).toHaveLength(1);
    expect(agg[0]).toEqual({ name: 'Chicken breast', qty: 3 });
  });

  it('sums leading quantities for the same food ("2 eggs" ×3 → Eggs ×6)', () => {
    const agg = aggregateFoodItems(['2 eggs', '2 eggs', '2 eggs']);
    expect(agg[0]).toEqual({ name: 'Eggs', qty: 6 });
  });

  it('strips portion parentheticals when grouping', () => {
    const agg = aggregateFoodItems(['rice (1 cup)', 'rice (1 cup)']);
    expect(agg[0]).toEqual({ name: 'Rice', qty: 2 });
  });

  it('explodes multi-item meal labels joined with " + "', () => {
    const agg = aggregateFoodItems(['3 eggs + salad + 1 cup rice']);
    const names = agg.map((a) => a.name);
    expect(names).toContain('Eggs');
    expect(names).toContain('Salad');
    // "1 cup rice" keeps its serving wording (the 1 is not a multiplier).
    expect(names).toContain('1 cup rice');
  });

  it('does NOT treat a count before a portion word as a multiplier', () => {
    const agg = aggregateFoodItems(['1 can tuna', '1 can tuna']);
    expect(agg[0]!.name).toBe('1 can tuna');
    expect(agg[0]!.qty).toBe(2); // logged twice
  });

  it('orders by quantity descending, stable on ties', () => {
    const agg = aggregateFoodItems([
      'rice (1 cup)', 'rice (1 cup)',
      '2 eggs', '2 eggs', '2 eggs',
      'apple',
    ]);
    expect(agg.map((a) => a.name)).toEqual(['Eggs', 'Rice', 'Apple']);
    expect(agg.map((a) => a.qty)).toEqual([6, 2, 1]);
  });

  it('returns [] for empty / whitespace input', () => {
    expect(aggregateFoodItems([])).toEqual([]);
    expect(aggregateFoodItems(['', '   '])).toEqual([]);
  });
});

describe('formatAggregatedInline', () => {
  it('renders "Name ×N", omitting ×1', () => {
    const out = formatAggregatedInline([
      { name: 'Eggs', qty: 6 },
      { name: 'Chicken breast', qty: 3 },
      { name: 'Apple', qty: 1 },
    ]);
    expect(out).toBe('Eggs × 6, Chicken breast × 3, Apple');
  });

  it('rolls overflow into a meaningful "+N more items" (never a raw dump)', () => {
    const items = Array.from({ length: 14 }, (_, i) => ({ name: `Food${i}`, qty: 1 }));
    const out = formatAggregatedInline(items, 10);
    expect(out).toContain('+4 more items');
    expect(out).not.toMatch(/and \d+ more/i);
  });
});

describe('renderDailyFoodSummary', () => {
  it('one clean line: aggregated foods + prose totals', () => {
    const out = renderDailyFoodSummary(
      ['chicken breast (4oz)', 'chicken breast (4oz)', 'chicken breast (4oz)',
        'rice (1 cup)', 'rice (1 cup)', '2 eggs', '2 eggs', '2 eggs'],
      134, 1360,
    );
    expect(out).toBe(
      "Today you've had Eggs × 6, Chicken breast × 3, and Rice × 2. That's 134g protein and 1,360 calories.",
    );
    expect(out).not.toContain('\n'); // single line — survives the WhatsApp enforcer
  });

  it('rolls a long tail into "plus N more foods", never "and N more"', () => {
    const items = [
      'chicken breast (4oz)', 'chicken breast (4oz)', 'chicken breast (4oz)',
      'rice (1 cup)', 'rice (1 cup)', '2 eggs', '2 eggs', '2 eggs',
      'apple', 'banana', 'almonds', 'broccoli', 'salmon (5oz)',
    ];
    const out = renderDailyFoodSummary(items, 141, 2015);
    expect(out).toMatch(/plus \d+ more foods?/);
    expect(out).not.toMatch(/and \d+ more\b/i);
    expect(out).toContain('141g protein and 2,015 calories');
    expect(out.match(/chicken breast/gi)?.length).toBe(1); // never repeated
  });

  it('handles an empty log', () => {
    expect(renderDailyFoodSummary([], 0, 0)).toMatch(/nothing logged yet/i);
  });

  it('omits calories when zero', () => {
    expect(renderDailyFoodSummary(['black coffee'], 0, 0)).toBe(
      "Today you've had Black coffee. That's 0g protein.",
    );
  });
});
