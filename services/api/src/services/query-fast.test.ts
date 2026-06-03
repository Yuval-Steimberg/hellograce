import { describe, it, expect, vi } from 'vitest';
import { tryQueryFast, __testing } from './query-fast.js';
import type { UserService } from '../user/user.service.js';

const noopLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as any;

function mockUsers(overrides: Partial<{
  protein_goal_grams: number | null;
  calorie_goal_kcal: number | null;
  goal_weight: number | null;
  current_weight: number | null;
  todayProtein: number;
  todayCalories: number;
}> = {}): UserService {
  // Use `in overrides` checks so an EXPLICIT null override is preserved
  // (vs. defaulting to 80/1800/160). Tests pass `{ protein_goal_grams: null }`
  // to verify the unset-goal branch.
  return {
    getById: vi.fn().mockResolvedValue({
      protein_goal_grams: 'protein_goal_grams' in overrides ? overrides.protein_goal_grams : 80,
      calorie_goal_kcal: 'calorie_goal_kcal' in overrides ? overrides.calorie_goal_kcal : 1800,
      goal_weight: 'goal_weight' in overrides ? overrides.goal_weight : 160,
      current_weight: 'current_weight' in overrides ? overrides.current_weight : 180,
    }),
    getTodaysFoodSummary: vi.fn().mockResolvedValue({
      protein_g: overrides.todayProtein ?? 45,
      calories: overrides.todayCalories ?? 1200,
      items: [],
      items_detailed: [],
    }),
  } as unknown as UserService;
}

describe('query-fast pattern matchers', () => {
  it('matches protein goal questions', () => {
    expect(__testing.PROTEIN_GOAL_RE.test("what's my protein goal")).toBe(true);
    expect(__testing.PROTEIN_GOAL_RE.test('what is my protein target')).toBe(true);
    expect(__testing.PROTEIN_GOAL_RE.test('whats my daily protein goal')).toBe(true);
    expect(__testing.PROTEIN_GOAL_RE.test('what is the protein target?')).toBe(true);
  });

  it('does NOT match protein-LEFT questions (must go through full pipeline)', () => {
    expect(__testing.PROTEIN_GOAL_RE.test("what's my protein left")).toBe(false);
    expect(__testing.PROTEIN_GOAL_RE.test('how much protein do I have left')).toBe(false);
    expect(__testing.PROTEIN_GOAL_RE.test('protein remaining today')).toBe(false);
  });

  it('matches calorie + weight goal questions', () => {
    expect(__testing.CALORIE_GOAL_RE.test("what's my calorie goal")).toBe(true);
    expect(__testing.CALORIE_GOAL_RE.test('what is my kcal target')).toBe(true);
    expect(__testing.WEIGHT_GOAL_RE.test("what's my weight goal")).toBe(true);
    expect(__testing.WEIGHT_GOAL_RE.test('what is my target weight')).toBe(true);
  });

  it('matches protein/calorie today questions', () => {
    expect(__testing.PROTEIN_TODAY_RE.test('how much protein have i had today')).toBe(true);
    expect(__testing.PROTEIN_TODAY_RE.test('how much protein did i eat today')).toBe(true);
    expect(__testing.PROTEIN_TODAY_RE.test("what's my protein today")).toBe(true);
    expect(__testing.CALORIE_TODAY_RE.test('how many calories have i had today')).toBe(true);
    expect(__testing.CALORIE_TODAY_RE.test('how many cal did i eat')).toBe(true);
  });

  it('matches progress questions', () => {
    expect(__testing.PROGRESS_TODAY_RE.test('how am i doing today')).toBe(true);
    expect(__testing.PROGRESS_TODAY_RE.test('how am i doing on protein')).toBe(true);
    expect(__testing.PROGRESS_TODAY_RE.test('progress check')).toBe(true);
    expect(__testing.PROGRESS_TODAY_RE.test('where am i at')).toBe(true);
  });
});

describe('tryQueryFast', () => {
  it('returns the protein goal in lbs', async () => {
    const users = mockUsers({ protein_goal_grams: 90 });
    const r = await tryQueryFast("what's my protein goal", { users, logger: noopLogger, userId: 'u1' });
    expect(r).toEqual({ text: 'Your daily protein target is 90g.', category: 'protein_goal' });
  });

  it('returns the calorie goal', async () => {
    const users = mockUsers({ calorie_goal_kcal: 1900 });
    const r = await tryQueryFast("what's my calorie goal", { users, logger: noopLogger, userId: 'u1' });
    expect(r?.text).toBe('Your daily calorie target is 1900 kcal.');
    expect(r?.category).toBe('calorie_goal');
  });

  it('returns weight goal with diff when current_weight present', async () => {
    const users = mockUsers({ goal_weight: 150, current_weight: 175 });
    const r = await tryQueryFast("what's my weight goal", { users, logger: noopLogger, userId: 'u1' });
    expect(r?.text).toBe('Your goal weight is 150 lbs — about 25 lbs to go from 175 lbs.');
  });

  it('shows protein today with remaining', async () => {
    const users = mockUsers({ protein_goal_grams: 80, todayProtein: 45 });
    const r = await tryQueryFast('how much protein have i had today', { users, logger: noopLogger, userId: 'u1' });
    expect(r?.text).toBe("You're at 45g protein today — 35g left to hit your 80g target.");
  });

  it('shows target-hit message when at goal', async () => {
    const users = mockUsers({ protein_goal_grams: 80, todayProtein: 82 });
    const r = await tryQueryFast('how much protein have i had today', { users, logger: noopLogger, userId: 'u1' });
    expect(r?.text).toBe("You're at 82g protein today — you hit your 80g target.");
  });

  it('combines protein + calories on progress check', async () => {
    const users = mockUsers({ protein_goal_grams: 80, calorie_goal_kcal: 1800, todayProtein: 50, todayCalories: 1000 });
    const r = await tryQueryFast('how am i doing today', { users, logger: noopLogger, userId: 'u1' });
    expect(r?.text).toBe("You're at 50g protein, 30g to go for 80g and 1000 kcal, 800 left of 1800 today.");
  });

  it('returns null on unrelated message', async () => {
    const users = mockUsers();
    const r = await tryQueryFast('I ate 2 eggs', { users, logger: noopLogger, userId: 'u1' });
    expect(r).toBeNull();
  });

  it('returns null when message is compound (anchored regex bails)', async () => {
    const users = mockUsers();
    const r = await tryQueryFast("what's my protein goal? also i ate eggs", { users, logger: noopLogger, userId: 'u1' });
    expect(r).toBeNull();
  });

  it('returns null when goal is unset (lets LLM explain)', async () => {
    const users = mockUsers({ protein_goal_grams: null });
    const r = await tryQueryFast("what's my protein goal", { users, logger: noopLogger, userId: 'u1' });
    expect(r).toBeNull();
  });
});
