import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  TodayFoodCacheService,
  __testing,
} from './today-food-cache.js';
import { computeUserLoggingDay } from '../nutrition/logging-window.js';

const noopLogger = { info: () => {}, warn: () => {}, error: () => {} };

function makeRedis() {
  const store = new Map<string, string>();
  return {
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    set: vi.fn(async (k: string, v: string, _mode?: string, _ttl?: number) => {
      store.set(k, v);
      return 'OK';
    }),
    del: vi.fn(async (...keys: string[]) => {
      let count = 0;
      for (const k of keys) {
        if (store.delete(k)) count++;
      }
      return count;
    }),
    __store: store,
  };
}

const PHONE = '+15551234567';
const SAMPLE = {
  protein_g: 45,
  calories: 680,
  items: ['3 eggs', 'tuna', 'rice'],
  items_detailed: [
    { food: '3 eggs', protein_g: 18, calories: 220, logged_at: '2026-06-07T08:30:00.000Z' },
    { food: 'tuna', protein_g: 25, calories: 150, logged_at: '2026-06-07T12:00:00.000Z' },
    { food: 'rice', protein_g: 2, calories: 310, logged_at: '2026-06-07T12:00:00.000Z' },
  ],
};

describe('computeUserLoggingDay — local calendar day, midnight → 11:59 PM (2026-07-02)', () => {
  it('returns YYYY-MM-DD format', () => {
    expect(computeUserLoggingDay('UTC', '07:00', new Date('2026-06-07T12:00:00.000Z')))
      .toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('noon → that calendar day', () => {
    expect(computeUserLoggingDay('UTC', '07:00', new Date('2026-06-07T12:00:00.000Z')))
      .toBe('2026-06-07');
  });

  it('early morning (06:59) is the SAME calendar day', () => {
    expect(computeUserLoggingDay('UTC', '07:00', new Date('2026-06-07T06:59:00.000Z')))
      .toBe('2026-06-07');
  });

  it('a 1 AM snack counts toward that calendar day (not the prior day)', () => {
    expect(computeUserLoggingDay('UTC', '07:00', new Date('2026-06-07T01:00:00.000Z')))
      .toBe('2026-06-07');
  });

  it('local midnight starts the new day; 11:59 PM is still the old day', () => {
    expect(computeUserLoggingDay('UTC', '07:00', new Date('2026-06-07T23:59:00.000Z'))).toBe('2026-06-07');
    expect(computeUserLoggingDay('UTC', '07:00', new Date('2026-06-08T00:00:00.000Z'))).toBe('2026-06-08');
  });

  it('ignores wake time (boundary is midnight, not wake)', () => {
    expect(computeUserLoggingDay('UTC', '09:00', new Date('2026-06-07T08:00:00.000Z'))).toBe('2026-06-07');
    expect(computeUserLoggingDay('UTC', null, new Date('2026-06-07T06:00:00.000Z'))).toBe('2026-06-07');
    expect(computeUserLoggingDay('UTC', '', new Date('2026-06-07T08:00:00.000Z'))).toBe('2026-06-07');
  });

  it('uses the user timezone (Asia/Jerusalem, +3)', () => {
    // 2026-06-07 03:00 UTC = 06:00 Jerusalem → the 7th locally
    expect(computeUserLoggingDay('Asia/Jerusalem', '07:00', new Date('2026-06-07T03:00:00.000Z')))
      .toBe('2026-06-07');
    // 2026-06-07 22:00 UTC = 01:00 Jerusalem on the 8th → the 8th locally
    expect(computeUserLoggingDay('Asia/Jerusalem', '07:00', new Date('2026-06-07T22:00:00.000Z')))
      .toBe('2026-06-08');
  });

  it('invalid / empty timezone falls back to UTC', () => {
    expect(computeUserLoggingDay('Mars/Olympus', '07:00', new Date('2026-06-07T12:00:00.000Z'))).toBe('2026-06-07');
    expect(computeUserLoggingDay('', '07:00', new Date('2026-06-07T12:00:00.000Z'))).toBe('2026-06-07');
  });
});

describe('TodayFoodCacheService — basic flow', () => {
  let redis: ReturnType<typeof makeRedis>;
  let cache: TodayFoodCacheService;

  beforeEach(() => {
    redis = makeRedis();
    cache = new TodayFoodCacheService(redis as any, noopLogger);
  });

  it('returns null on miss', async () => {
    const result = await cache.get(PHONE, 'UTC');
    expect(result).toBeNull();
  });

  it('roundtrips: set → get returns the value', async () => {
    await cache.set(PHONE, 'UTC', SAMPLE);
    const result = await cache.get(PHONE, 'UTC');
    expect(result).toEqual(SAMPLE);
  });

  it('uses TTL on set', async () => {
    await cache.set(PHONE, 'UTC', SAMPLE);
    expect(redis.set).toHaveBeenCalledWith(
      expect.stringContaining(__testing.KEY_PREFIX + PHONE),
      expect.any(String),
      'EX',
      __testing.TTL_SECONDS,
    );
  });

  it('invalidate drops the key', async () => {
    await cache.set(PHONE, 'UTC', SAMPLE);
    expect(await cache.get(PHONE, 'UTC')).toEqual(SAMPLE);
    await cache.invalidate(PHONE, 'UTC');
    expect(await cache.get(PHONE, 'UTC')).toBeNull();
  });

  it('invalidate drops BOTH today and yesterday keys (midnight-boundary safety)', async () => {
    await cache.invalidate(PHONE, 'UTC');
    // Should call del with 2 keys (today + yesterday)
    expect(redis.del).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
    );
    const callArgs = redis.del.mock.calls[0]!;
    expect(callArgs.length).toBe(2);
  });

  it('key is scoped per user', async () => {
    const phoneA = '+15550000001';
    const phoneB = '+15550000002';
    await cache.set(phoneA, 'UTC', SAMPLE);
    expect(await cache.get(phoneB, 'UTC')).toBeNull();
    expect(await cache.get(phoneA, 'UTC')).toEqual(SAMPLE);
  });

  it('key is scoped per logging day (cross-day isolation)', async () => {
    const day1 = new Date('2026-06-07T12:00:00.000Z');
    const day2 = new Date('2026-06-08T12:00:00.000Z');
    const k1 = __testing.buildKey(PHONE, computeUserLoggingDay('UTC', '07:00', day1));
    const k2 = __testing.buildKey(PHONE, computeUserLoggingDay('UTC', '07:00', day2));
    expect(k1).not.toBe(k2);
  });
});

describe('TodayFoodCacheService — graceful degradation', () => {
  const phone = '+15551234567';

  it('no-op when constructed with undefined Redis (testing/disabled mode)', async () => {
    const c = new TodayFoodCacheService(undefined, noopLogger);
    await c.set(phone, 'UTC', SAMPLE);
    expect(await c.get(phone, 'UTC')).toBeNull();
    await c.invalidate(phone, 'UTC'); // should not throw
  });

  it('returns null on Redis read failure (no throw)', async () => {
    const failing = {
      get: vi.fn(async () => { throw new Error('redis down'); }),
      set: vi.fn(async () => 'OK'),
      del: vi.fn(async () => 0),
    };
    const c = new TodayFoodCacheService(failing as any, noopLogger);
    const result = await c.get(phone, 'UTC');
    expect(result).toBeNull();
  });

  it('swallows Redis write failure (no throw)', async () => {
    const failing = {
      get: vi.fn(async () => null),
      set: vi.fn(async () => { throw new Error('redis down'); }),
      del: vi.fn(async () => 0),
    };
    const c = new TodayFoodCacheService(failing as any, noopLogger);
    await expect(c.set(phone, 'UTC', SAMPLE)).resolves.toBeUndefined();
  });

  it('swallows Redis invalidate failure', async () => {
    const failing = {
      get: vi.fn(async () => null),
      set: vi.fn(async () => 'OK'),
      del: vi.fn(async () => { throw new Error('redis down'); }),
    };
    const c = new TodayFoodCacheService(failing as any, noopLogger);
    await expect(c.invalidate(phone, 'UTC')).resolves.toBeUndefined();
  });
});
