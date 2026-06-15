import { describe, it, expect, vi } from 'vitest';
import {
  setActiveMeal,
  getActiveMeal,
  clearActiveMeal,
  ACTIVE_MEAL_TTL_SECONDS,
} from './meal-recommendation-store.js';

/** Tiny in-memory Redis stand-in covering the get/set/del subset we use. */
function fakeRedis() {
  const store = new Map<string, string>();
  return {
    store,
    set: vi.fn(async (k: string, v: string, _ex?: string, _ttl?: number) => {
      store.set(k, v);
      return 'OK';
    }),
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    del: vi.fn(async (k: string) => (store.delete(k) ? 1 : 0)),
  };
}

describe('meal-recommendation-store', () => {
  it('round-trips a stored meal with status suggested', async () => {
    const redis = fakeRedis();
    await setActiveMeal(redis as never, '+15551234567', 'halloumi and roasted vegetable plate');
    const got = await getActiveMeal(redis as never, '+15551234567');
    expect(got?.meal).toBe('halloumi and roasted vegetable plate');
    expect(got?.status).toBe('suggested');
    // TTL passed through to redis.set
    expect(redis.set).toHaveBeenCalledWith(expect.any(String), expect.any(String), 'EX', ACTIVE_MEAL_TTL_SECONDS);
  });

  it('ignores too-short meal names', async () => {
    const redis = fakeRedis();
    await setActiveMeal(redis as never, '+1', 'ok');
    expect(redis.set).not.toHaveBeenCalled();
    expect(await getActiveMeal(redis as never, '+1')).toBeNull();
  });

  it('clear removes the stored meal', async () => {
    const redis = fakeRedis();
    await setActiveMeal(redis as never, '+1', 'lentil dal');
    await clearActiveMeal(redis as never, '+1');
    expect(await getActiveMeal(redis as never, '+1')).toBeNull();
  });

  it('no-ops (never throws) when redis is undefined', async () => {
    await expect(setActiveMeal(undefined, '+1', 'lentil dal')).resolves.toBeUndefined();
    await expect(getActiveMeal(undefined, '+1')).resolves.toBeNull();
    await expect(clearActiveMeal(undefined, '+1')).resolves.toBeUndefined();
  });

  it('returns null on malformed stored JSON', async () => {
    const redis = fakeRedis();
    redis.store.set('meal:rec:+1', '{not json');
    expect(await getActiveMeal(redis as never, '+1')).toBeNull();
  });
});
