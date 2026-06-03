import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UserService } from './user.service.js';

function makePool(rows: any[]) {
  return {
    query: vi.fn().mockResolvedValue({ rows }),
  } as any;
}

describe('UserService.getTodaysFoodSummary caching', () => {
  let pool: any;
  let svc: UserService;
  beforeEach(() => {
    pool = makePool([
      { food: 'eggs', protein_g: 12, calories: 140, created_at: new Date() },
      { food: 'oats', protein_g: 5, calories: 150, created_at: new Date() },
    ]);
    svc = new UserService(pool);
  });

  it('serves the second call from cache (one DB roundtrip)', async () => {
    const a = await svc.getTodaysFoodSummary('+15551234');
    const b = await svc.getTodaysFoodSummary('+15551234');
    expect(a.protein_g).toBe(17);
    expect(b.protein_g).toBe(17);
    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  it('invalidateTodaysFoodCache() forces a fresh read', async () => {
    await svc.getTodaysFoodSummary('+15551234');
    svc.invalidateTodaysFoodCache('+15551234');
    await svc.getTodaysFoodSummary('+15551234');
    expect(pool.query).toHaveBeenCalledTimes(2);
  });

  it('caches per-user (different users do not share)', async () => {
    await svc.getTodaysFoodSummary('+15551111');
    await svc.getTodaysFoodSummary('+15552222');
    expect(pool.query).toHaveBeenCalledTimes(2);
  });
});

describe('UserService.getKnownFacts caching', () => {
  let pool: any;
  let svc: UserService;
  beforeEach(() => {
    pool = makePool([{ fact: 'vegan', category: 'diet', confidence: 'high' }]);
    svc = new UserService(pool);
  });

  it('serves the second call from cache', async () => {
    const a = await svc.getKnownFacts('+15551234');
    const b = await svc.getKnownFacts('+15551234');
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  it('caches per (userId, limit) key', async () => {
    await svc.getKnownFacts('+15551234', 30);
    await svc.getKnownFacts('+15551234', 10);
    expect(pool.query).toHaveBeenCalledTimes(2);
  });

  it('invalidateKnownFactsCache forces a fresh read', async () => {
    await svc.getKnownFacts('+15551234');
    svc.invalidateKnownFactsCache('+15551234');
    // Note: cache key includes limit, so we need same limit
    await svc.getKnownFacts('+15551234');
    expect(pool.query).toHaveBeenCalledTimes(2);
  });

  it('returns [] on DB error and does NOT cache the empty result', async () => {
    pool.query = vi.fn().mockRejectedValueOnce(new Error('boom'));
    const a = await svc.getKnownFacts('+15551234');
    expect(a).toEqual([]);
    // Next call should hit the DB again (no cache poisoning)
    pool.query = vi.fn().mockResolvedValueOnce({ rows: [{ fact: 'vegan', category: 'diet', confidence: 'high' }] });
    const b = await svc.getKnownFacts('+15551234');
    expect(b).toHaveLength(1);
  });
});
