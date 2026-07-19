import { describe, it, expect, vi } from 'vitest';
import {
  getPendingFood,
  setPendingFood,
  addPendingFood,
  resolvePendingFood,
  clearPendingFood,
} from './food-pending-store.js';

function fakeRedis() {
  const store = new Map<string, string>();
  return {
    store,
    set: vi.fn(async (k: string, v: string) => { store.set(k, v); return 'OK'; }),
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    del: vi.fn(async (k: string) => (store.delete(k) ? 1 : 0)),
  };
}

const PHONE = '+15551234567';

describe('food-pending-store', () => {
  it('round-trips pending items', async () => {
    const redis = fakeRedis();
    await setPendingFood(redis as never, PHONE, [{ item: 'pizza', clarify_question: 'How many slices?', ts: 1 }]);
    const got = await getPendingFood(redis as never, PHONE);
    expect(got).toHaveLength(1);
    expect(got[0]?.item).toBe('pizza');
  });

  it('addPendingFood dedupes case-insensitively', async () => {
    const redis = fakeRedis();
    await addPendingFood(redis as never, PHONE, [{ item: 'Pizza', clarify_question: 'q1' }]);
    await addPendingFood(redis as never, PHONE, [{ item: 'pizza', clarify_question: 'q2' }, { item: 'burger', clarify_question: 'q3' }]);
    const got = await getPendingFood(redis as never, PHONE);
    expect(got.map((p) => p.item.toLowerCase()).sort()).toEqual(['burger', 'pizza']);
  });

  it('resolvePendingFood removes the matching item (fuzzy on the food word)', async () => {
    const redis = fakeRedis();
    await setPendingFood(redis as never, PHONE, [
      { item: 'spaghetti', clarify_question: 'how much?', ts: 1 },
      { item: 'pizza', clarify_question: 'how many?', ts: 1 },
    ]);
    // edit_ref "the spaghetti" should clear the spaghetti pending row
    await resolvePendingFood(redis as never, PHONE, 'the spaghetti');
    const got = await getPendingFood(redis as never, PHONE);
    expect(got.map((p) => p.item)).toEqual(['pizza']);
  });

  it('clearing the last item deletes the key', async () => {
    const redis = fakeRedis();
    await setPendingFood(redis as never, PHONE, [{ item: 'pizza', clarify_question: null, ts: 1 }]);
    await resolvePendingFood(redis as never, PHONE, 'pizza');
    expect(redis.del).toHaveBeenCalled();
    expect(await getPendingFood(redis as never, PHONE)).toEqual([]);
  });

  it('no-ops safely without redis', async () => {
    expect(await getPendingFood(undefined, PHONE)).toEqual([]);
    await expect(setPendingFood(undefined, PHONE, [])).resolves.toBeUndefined();
    await expect(addPendingFood(undefined, PHONE, [{ item: 'x', clarify_question: null }])).resolves.toBeUndefined();
    await expect(clearPendingFood(undefined, PHONE)).resolves.toBeUndefined();
  });

  it('falls back to the durable database row and rehydrates Redis', async () => {
    const redis = fakeRedis();
    redis.get.mockRejectedValueOnce(new Error('redis unavailable'));
    const pool = {
      query: vi.fn(async () => ({
        rows: [{ items: [{ item: 'pasta', clarify_question: 'How much?', ts: 1 }] }],
      })),
    };
    const got = await getPendingFood(redis as never, PHONE, pool as never);
    expect(got.map((p) => p.item)).toEqual(['pasta']);
    expect(pool.query).toHaveBeenCalled();
    expect(redis.set).toHaveBeenCalled();
  });
});
