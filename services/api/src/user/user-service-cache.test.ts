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

describe('UserService.decryptUser — never leaks ciphertext (2026-06-18)', () => {
  const BLOB = 'enc:0b5f95fcc08abfd1d100b3bbf8:9fc0bd0f16e13c33736d4:e869b61ae8988e421a3b221721444616';

  it('nullifies an undecryptable medication blob when encryption is disabled', async () => {
    // No initFieldEncryption() called in this file → encryption disabled.
    const pool = makePool([
      { id: 'u1', phone: '+15551234', medication: BLOB, first_name: BLOB },
    ]);
    const svc = new UserService(pool);
    const u = await svc.getByPhone('+15551234');
    expect(u?.medication).toBeNull();
    expect(u?.first_name).toBeNull();
  });

  it('passes through a plaintext medication untouched', async () => {
    const pool = makePool([
      { id: 'u2', phone: '+15559999', medication: 'Wegovy', first_name: 'Sam' },
    ]);
    const svc = new UserService(pool);
    const u = await svc.getByPhone('+15559999');
    expect(u?.medication).toBe('Wegovy');
    expect(u?.first_name).toBe('Sam');
  });
});
