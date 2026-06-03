import { describe, it, expect, vi } from 'vitest';
import { __testing, makeSearchFoodIdeasTool } from './search-food-ideas.js';

const stubLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Parameters<typeof makeSearchFoodIdeasTool>[0]['logger'];

describe('search_food_ideas — cache key (Phase 16 latency)', () => {
  it('returns the same key for the same dietary + dislikes + meal in the same hour bucket', () => {
    const k1 = __testing.buildCacheKey(
      'what should I eat for lunch',
      { label: 'vegan' } as never,
      ['mushrooms', 'olives'],
    );
    const k2 = __testing.buildCacheKey(
      "any lunch ideas?",
      { label: 'vegan' } as never,
      ['olives', 'mushrooms'],
    );
    // Both queries normalize to mealType=lunch, dislikes sorted equally
    expect(k1).toBe(k2);
  });

  it('produces different keys for different dietary restrictions', () => {
    const vegan = __testing.buildCacheKey('what should I eat for lunch', { label: 'vegan' } as never, []);
    const veg = __testing.buildCacheKey('what should I eat for lunch', { label: 'vegetarian' } as never, []);
    expect(vegan).not.toBe(veg);
  });

  it('produces different keys for different meal types', () => {
    const lunch = __testing.buildCacheKey('what for lunch', null, []);
    const dinner = __testing.buildCacheKey('what for dinner', null, []);
    expect(lunch).not.toBe(dinner);
  });

  it('extracts meal type from common phrasings', () => {
    expect(__testing.extractMealType('what should I eat for breakfast?')).toBe('breakfast');
    expect(__testing.extractMealType('any lunch ideas?')).toBe('lunch');
    expect(__testing.extractMealType('what about dinner?')).toBe('dinner');
    expect(__testing.extractMealType('snack ideas')).toBe('snack');
    expect(__testing.extractMealType('what should I eat?')).toBe('general');
  });

  it('hour bucket cleanly partitions the day into 4 windows', () => {
    expect(__testing.hourBucket(new Date('2026-06-03T02:00:00Z'))).toBe(0);
    expect(__testing.hourBucket(new Date('2026-06-03T07:00:00Z'))).toBe(1);
    expect(__testing.hourBucket(new Date('2026-06-03T13:00:00Z'))).toBe(2);
    expect(__testing.hourBucket(new Date('2026-06-03T19:00:00Z'))).toBe(3);
  });

  it('returns ok with cached ideas when Redis has a hit', async () => {
    const cached = [
      { name: 'Greek yogurt with hemp seeds', protein_g: 18, why: 'fast prep' },
    ];
    const redis = {
      get: vi.fn().mockResolvedValue(JSON.stringify(cached)),
      set: vi.fn(),
    } as never;
    const llm = { generate: vi.fn() };
    const tool = makeSearchFoodIdeasTool({
      llm: llm as never,
      logger: stubLogger,
      userId: 'u1',
      redis,
      dietaryRestriction: { label: 'none' } as never,
      foodDislikes: [],
    });
    const res = await tool.execute({ query: 'what should I eat for lunch' });
    expect(res.ok).toBe(true);
    expect((res as { ideas: unknown }).ideas).toEqual(cached);
    // LLM must NOT have been called on a cache hit
    expect(llm.generate).not.toHaveBeenCalled();
  });

  it('falls through to the LLM call when Redis misses', async () => {
    const redis = {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue('OK'),
    } as never;
    const llm = {
      generate: vi.fn().mockResolvedValue({
        text: JSON.stringify([{ name: 'tofu bowl', protein_g: 22, why: 'vegan-friendly' }]),
      }),
    };
    const tool = makeSearchFoodIdeasTool({
      llm: llm as never,
      logger: stubLogger,
      userId: 'u1',
      redis,
      dietaryRestriction: { label: 'vegan' } as never,
      foodDislikes: [],
    });
    const res = await tool.execute({ query: 'what should I eat for lunch' });
    expect(res.ok).toBe(true);
    expect(llm.generate).toHaveBeenCalledOnce();
  });
});
