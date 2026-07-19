import { describe, expect, it, vi } from 'vitest';
import { FoodLedgerService } from './food-ledger.js';

function fakePool(mode: 'replace' | 'remove') {
  const query = vi.fn(async (sql: string) => {
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [], rowCount: null };
    if (sql.includes('FOR UPDATE')) {
      return { rows: [{ id: 'row-1', food: '2 eggs', protein_g: 12, calories: 140 }], rowCount: 1 };
    }
    if (sql.startsWith('UPDATE food_logs')) {
      return { rows: [{ id: 'row-1', food: '3 eggs', protein_g: 18, calories: 210 }], rowCount: 1 };
    }
    if (sql.startsWith('DELETE FROM food_logs')) return { rows: [], rowCount: 1 };
    if (sql.includes('COALESCE(SUM')) {
      return { rows: [{ protein_g: mode === 'replace' ? 18 : 0, calories: mode === 'replace' ? 210 : 0 }], rowCount: 1 };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  });
  const client = { query, release: vi.fn() };
  return { pool: { connect: vi.fn(async () => client) }, client };
}

describe('FoodLedgerService', () => {
  it('replaces a row atomically instead of adding a correction', async () => {
    const { pool, client } = fakePool('replace');
    const cache = { invalidateTodaysFoodCache: vi.fn(async () => undefined) };
    const ledger = new FoodLedgerService(pool as never, cache);
    const out = await ledger.replaceLatest('+1', 'eggs', {
      food: '3 eggs',
      protein_g: 18,
      calories: 210,
    });
    expect(out.updated?.food).toBe('3 eggs');
    expect(client.query).toHaveBeenCalledWith('BEGIN');
    expect(client.query).toHaveBeenCalledWith('COMMIT');
    expect(client.query.mock.calls.some(([sql]) => String(sql).startsWith('INSERT'))).toBe(false);
    expect(cache.invalidateTodaysFoodCache).toHaveBeenCalledWith('+1');
  });

  it('removes and invalidates the daily summary cache after commit', async () => {
    const { pool } = fakePool('remove');
    const cache = { invalidateTodaysFoodCache: vi.fn(async () => undefined) };
    const ledger = new FoodLedgerService(pool as never, cache);
    const out = await ledger.removeLatest('+1', 'eggs');
    expect(out.removed?.food).toBe('2 eggs');
    expect(out.totals.protein_g).toBe(0);
    expect(cache.invalidateTodaysFoodCache).toHaveBeenCalledWith('+1');
  });
});
