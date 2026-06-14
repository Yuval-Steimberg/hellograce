import { describe, it, expect, vi } from 'vitest';
import type { Pool } from 'pg';
import type { Logger } from 'pino';
import { tryFoodLogFastResponse } from './food-log-fast.js';

const stubLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

function makePool(dailyProtein = 12, dailyCalories = 140): Pool {
  return {
    query: vi.fn().mockImplementation((sql: string) => {
      if (sql.includes('INSERT INTO food_logs')) {
        return Promise.resolve({ rowCount: 1, rows: [{ id: 'x' }] });
      }
      if (sql.includes('SUM(fl.protein_g)')) {
        return Promise.resolve({
          rows: [{ total_protein_g: dailyProtein, total_calories: dailyCalories }],
        });
      }
      return Promise.resolve({ rows: [] });
    }),
  } as unknown as Pool;
}

describe('tryFoodLogFastResponse', () => {
  it('handles "I ate two eggs" with the goal-aware template', async () => {
    const pool = makePool(12, 140);
    const result = await tryFoodLogFastResponse('I ate two eggs', {
      pool, logger: stubLogger, userId: '+15551234567',
      intentType: 'food_log', proteinGoalGrams: 60,
    });
    expect(result).not.toBeNull();
    expect(result!.macros.protein_g).toBe(12);
    expect(result!.macros.food).toBe('2 eggs');
    expect(result!.dailyProteinG).toBe(12);
    // Response should mention the food, the protein, and the goal
    expect(result!.text).toContain('12');
    expect(result!.text).toContain('60');
    // CRITICAL: must NOT echo "I ate two eggs" verbatim at the start
    expect(result!.text).not.toMatch(/^I ate two eggs/i);
  });

  it('logs the clear item AND asks about a trailing vague snack (2026-06-14)', async () => {
    const pool = makePool(12, 140);
    const result = await tryFoodLogFastResponse('Had two eggs. Now having a small snack', {
      pool, logger: stubLogger, userId: '+15551234567',
      intentType: 'food_log', proteinGoalGrams: 60,
    });
    // Only fires if the eggs resolved in the macro table; if so, the snack ask
    // must be appended (never silently dropped).
    if (result) {
      expect(result.text).toContain('12');
      expect(result.text).toMatch(/what was the snack/i);
    }
  });

  it('uses a no-goal template when proteinGoalGrams is null', async () => {
    const pool = makePool(12, 140);
    const result = await tryFoodLogFastResponse('I ate two eggs', {
      pool, logger: stubLogger, userId: '+15551234567',
      intentType: 'food_log', proteinGoalGrams: null,
    });
    expect(result).not.toBeNull();
    // No-goal templates should not contain "/0g" garbage
    expect(result!.text).not.toContain('/0g');
    expect(result!.text).toContain('12');
  });

  it('returns null when intent is not food_log', async () => {
    const pool = makePool();
    const result = await tryFoodLogFastResponse('I ate two eggs', {
      pool, logger: stubLogger, userId: '+15551234567',
      intentType: 'emotional', proteinGoalGrams: 60,
    });
    expect(result).toBeNull();
  });

  it('returns null on question messages', async () => {
    const pool = makePool();
    const result = await tryFoodLogFastResponse('How much protein in two eggs?', {
      pool, logger: stubLogger, userId: '+15551234567',
      intentType: 'food_log', proteinGoalGrams: 60,
    });
    expect(result).toBeNull();
  });

  // Regression 2026-06-13: bare vague foods must NOT fast-log with an assumed
  // portion ("I had pizza" → "Logged pizza (2 slices), 22g"). They defer to
  // the pipeline's vague-food clarification gate.
  it('returns null for a vague bare food ("I had pizza") so it routes to clarification', async () => {
    const pool = makePool();
    const result = await tryFoodLogFastResponse('I had pizza', {
      pool, logger: stubLogger, userId: '+15551234567',
      intentType: 'food_log', proteinGoalGrams: 60,
    });
    expect(result).toBeNull();
    // and it never touched the DB (no fabricated log)
    expect((pool.query as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it('still fast-logs when a portion IS given ("2 slices of pizza")', async () => {
    const pool = makePool(22, 540);
    const result = await tryFoodLogFastResponse('2 slices of pizza', {
      pool, logger: stubLogger, userId: '+15551234567',
      intentType: 'food_log', proteinGoalGrams: 60,
    });
    expect(result).not.toBeNull();
    expect(result!.macros.protein_g).toBe(22);
  });

  it('returns null on negation', async () => {
    const pool = makePool();
    const result1 = await tryFoodLogFastResponse("I didn't eat eggs today", {
      pool, logger: stubLogger, userId: '+15551234567',
      intentType: 'food_log', proteinGoalGrams: 60,
    });
    expect(result1).toBeNull();
    const result2 = await tryFoodLogFastResponse('I skipped breakfast', {
      pool, logger: stubLogger, userId: '+15551234567',
      intentType: 'food_log', proteinGoalGrams: 60,
    });
    expect(result2).toBeNull();
  });

  it('returns null when food is not in the fast-lookup table', async () => {
    const pool = makePool();
    const result = await tryFoodLogFastResponse('I ate beef stroganoff with mushrooms', {
      pool, logger: stubLogger, userId: '+15551234567',
      intentType: 'food_log', proteinGoalGrams: 60,
    });
    expect(result).toBeNull();
  });

  it('returns null on messages longer than 80 chars', async () => {
    const pool = makePool();
    const longMsg = 'I ate two eggs ' + 'with toast and butter and jam and coffee'.repeat(2);
    const result = await tryFoodLogFastResponse(longMsg, {
      pool, logger: stubLogger, userId: '+15551234567',
      intentType: 'food_log', proteinGoalGrams: 60,
    });
    expect(result).toBeNull();
  });

  it('survives DB error by returning null (caller falls through)', async () => {
    const pool = {
      query: vi.fn().mockRejectedValue(new Error('pool dead')),
    } as unknown as Pool;
    const result = await tryFoodLogFastResponse('I ate two eggs', {
      pool, logger: stubLogger, userId: '+15551234567',
      intentType: 'food_log', proteinGoalGrams: 60,
    });
    expect(result).toBeNull();
  });

  it('handles "2 eggs" without preamble', async () => {
    const pool = makePool(12, 140);
    const result = await tryFoodLogFastResponse('2 eggs', {
      pool, logger: stubLogger, userId: '+15551234567',
      intentType: 'food_log', proteinGoalGrams: 80,
    });
    expect(result).not.toBeNull();
    expect(result!.macros.protein_g).toBe(12);
  });

  it('handles "protein shake" with high protein value', async () => {
    const pool = makePool(25, 130);
    const result = await tryFoodLogFastResponse('Just had a protein shake', {
      pool, logger: stubLogger, userId: '+15551234567',
      intentType: 'food_log', proteinGoalGrams: 80,
    });
    expect(result).not.toBeNull();
    expect(result!.macros.protein_g).toBe(25);
  });

  it('returns null on empty / whitespace-only input', async () => {
    const pool = makePool();
    expect(await tryFoodLogFastResponse('', {
      pool, logger: stubLogger, userId: '+15551234567',
      intentType: 'food_log', proteinGoalGrams: 60,
    })).toBeNull();
    expect(await tryFoodLogFastResponse('   ', {
      pool, logger: stubLogger, userId: '+15551234567',
      intentType: 'food_log', proteinGoalGrams: 60,
    })).toBeNull();
  });
});
