import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  recordSymptom,
  readStack,
  shouldEscalate,
  clearStack,
  SYMPTOM_TTL_SECONDS,
  STACKING_THRESHOLD,
  __testing,
} from './symptom-stack.js';

const noopLogger = { info: () => {}, warn: () => {}, error: () => {} };

/** Minimal in-memory Redis stub with the subset of operations the module
 *  uses. Stores values as strings; ttl tracked per key but checked only
 *  by the test by advancing time manually. */
function makeRedis() {
  const lists = new Map<string, string[]>();
  const ttls = new Map<string, number>();
  let now = Date.now();
  return {
    rpush: vi.fn(async (k: string, v: string) => {
      const arr = lists.get(k) ?? [];
      arr.push(v);
      lists.set(k, arr);
      return arr.length;
    }),
    lrange: vi.fn(async (k: string, _start: number, _end: number) => {
      return [...(lists.get(k) ?? [])];
    }),
    ltrim: vi.fn(async (k: string, start: number, end: number) => {
      const arr = lists.get(k) ?? [];
      // Standard Redis LTRIM semantics for negative indices: -N..-1 keeps last N.
      const len = arr.length;
      const lo = start < 0 ? Math.max(0, len + start) : start;
      const hi = end < 0 ? len + end : end;
      lists.set(k, arr.slice(lo, hi + 1));
      return 'OK';
    }),
    expire: vi.fn(async (k: string, ttl: number) => {
      ttls.set(k, now + ttl * 1000);
      return 1;
    }),
    del: vi.fn(async (k: string) => {
      const had = lists.has(k);
      lists.delete(k);
      ttls.delete(k);
      return had ? 1 : 0;
    }),
    __advanceTime(ms: number) {
      now += ms;
    },
    __reset() {
      lists.clear();
      ttls.clear();
      now = Date.now();
    },
    __peekList(k: string) {
      return lists.get(k);
    },
  };
}

describe('symptom-stack', () => {
  let redis: ReturnType<typeof makeRedis>;
  const phone = '+15551234567';
  const deps = { redis: null as any, logger: noopLogger };

  beforeEach(() => {
    redis = makeRedis();
    deps.redis = redis as any;
  });

  it('records a single symptom and reports it in the stack', async () => {
    const stack = await recordSymptom(phone, 'gi_severe', deps);
    expect(stack.count).toBe(1);
    expect(stack.categories).toEqual(['gi_severe']);
    expect(redis.rpush).toHaveBeenCalledWith(__testing.KEY_PREFIX + phone, expect.any(String));
    expect(redis.expire).toHaveBeenCalledWith(__testing.KEY_PREFIX + phone, SYMPTOM_TTL_SECONDS);
  });

  it('does NOT escalate on a single symptom', async () => {
    const stack = await recordSymptom(phone, 'gi_severe', deps);
    expect(shouldEscalate(stack)).toBe(false);
  });

  it('escalates when 2 DISTINCT categories accumulate within the window', async () => {
    await recordSymptom(phone, 'gi_severe', deps);
    const stack = await recordSymptom(phone, 'cardio', deps);
    expect(stack.categories.sort()).toEqual(['cardio', 'gi_severe']);
    expect(shouldEscalate(stack)).toBe(true);
  });

  it('does NOT escalate on REPEATED same-category symptoms (set semantics)', async () => {
    await recordSymptom(phone, 'gi_severe', deps);
    await recordSymptom(phone, 'gi_severe', deps);
    const stack = await recordSymptom(phone, 'gi_severe', deps);
    expect(stack.count).toBe(3);
    expect(stack.categories).toEqual(['gi_severe']);
    expect(shouldEscalate(stack)).toBe(false);
  });

  it('escalates on 3-turn accumulating example (gi_severe → cardio → neuro)', async () => {
    // The exact example from the audit brief.
    await recordSymptom(phone, 'gi_severe', deps);
    expect(shouldEscalate(await readStack(phone, deps))).toBe(false);

    await recordSymptom(phone, 'cardio', deps);
    expect(shouldEscalate(await readStack(phone, deps))).toBe(true);

    // Further symptoms keep the escalation state.
    const final = await recordSymptom(phone, 'neuro', deps);
    expect(final.categories.length).toBe(3);
    expect(shouldEscalate(final)).toBe(true);
  });

  it('drops stale entries past the TTL window from the read view', async () => {
    // Insert an old entry directly via rpush with a stale timestamp.
    const oldEntry = JSON.stringify({
      category: 'gi_severe',
      ts: Date.now() - (SYMPTOM_TTL_SECONDS + 60) * 1000,
    });
    await redis.rpush(__testing.KEY_PREFIX + phone, oldEntry);
    // Add a fresh symptom in a different category.
    await recordSymptom(phone, 'cardio', deps);
    const stack = await readStack(phone, deps);
    // The old gi_severe entry is past the cutoff; only cardio counts.
    expect(stack.categories).toEqual(['cardio']);
    expect(shouldEscalate(stack)).toBe(false);
  });

  it('clearStack empties the user state', async () => {
    await recordSymptom(phone, 'gi_severe', deps);
    await recordSymptom(phone, 'cardio', deps);
    expect(shouldEscalate(await readStack(phone, deps))).toBe(true);

    await clearStack(phone, deps);
    const stack = await readStack(phone, deps);
    expect(stack.count).toBe(0);
    expect(shouldEscalate(stack)).toBe(false);
  });

  it('STACKING_THRESHOLD is 2 (matches the audit decision)', () => {
    expect(STACKING_THRESHOLD).toBe(2);
  });

  it('handles Redis read failure by returning empty stack (no crash)', async () => {
    const failing = {
      rpush: vi.fn(async () => 1),
      lrange: vi.fn(async () => { throw new Error('redis down'); }),
      ltrim: vi.fn(async () => 'OK'),
      expire: vi.fn(async () => 1),
      del: vi.fn(async () => 0),
    };
    const stack = await readStack(phone, { redis: failing as any, logger: noopLogger });
    expect(stack.count).toBe(0);
    expect(stack.categories).toEqual([]);
  });

  it('handles Redis write failure gracefully', async () => {
    const failing = {
      rpush: vi.fn(async () => { throw new Error('redis down'); }),
      lrange: vi.fn(async () => []),
      ltrim: vi.fn(async () => 'OK'),
      expire: vi.fn(async () => 1),
      del: vi.fn(async () => 0),
    };
    // Should not throw.
    const stack = await recordSymptom(phone, 'cardio', { redis: failing as any, logger: noopLogger });
    expect(stack).toBeDefined();
  });
});

describe('symptom-stack: cross-category combinations', () => {
  const phone = '+15559999999';
  let redis: ReturnType<typeof makeRedis>;
  const deps = { redis: null as any, logger: noopLogger };

  beforeEach(() => {
    redis = makeRedis();
    deps.redis = redis as any;
  });

  it('allergic + gi_severe escalates', async () => {
    await recordSymptom(phone, 'allergic', deps);
    const stack = await recordSymptom(phone, 'gi_severe', deps);
    expect(shouldEscalate(stack)).toBe(true);
  });

  it('dehydration + weakness escalates', async () => {
    await recordSymptom(phone, 'dehydration', deps);
    const stack = await recordSymptom(phone, 'weakness', deps);
    expect(shouldEscalate(stack)).toBe(true);
  });

  it('cardio alone does NOT escalate', async () => {
    const stack = await recordSymptom(phone, 'cardio', deps);
    expect(shouldEscalate(stack)).toBe(false);
  });
});
