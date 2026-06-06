import { describe, it, expect, vi } from 'vitest';
import { tryQueryFast, __testing } from './query-fast.js';
import type { UserService } from '../user/user.service.js';

const noopLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as any;

function mockUsers(overrides: Partial<{
  protein_goal_grams: number | null;
  calorie_goal_kcal: number | null;
  goal_weight: number | null;
  current_weight: number | null;
  starting_weight: number | null;
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
      starting_weight: 'starting_weight' in overrides ? overrides.starting_weight : null,
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
    expect(r).toEqual({
      text: 'Your daily protein target is 90g. Want me to walk through the math?',
      category: 'protein_goal',
    });
  });

  it('returns the calorie goal', async () => {
    const users = mockUsers({ calorie_goal_kcal: 1900 });
    const r = await tryQueryFast("what's my calorie goal", { users, logger: noopLogger, userId: 'u1' });
    expect(r?.text).toBe('Your daily calorie target is 1900 kcal. Want me to walk through the math?');
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

  it('returns a helpful default when protein goal is unset (no orchestrator fallthrough)', async () => {
    // 2026-06-05: was returning null and letting the LLM explain, which in
    // production shipped tone-deaf typed fallbacks ("what kind of meal are
    // you thinking?"). Now ships a research-backed default + settings link.
    const users = mockUsers({ protein_goal_grams: null });
    const r = await tryQueryFast("what's my protein goal", { users, logger: noopLogger, userId: 'u1' });
    expect(r).not.toBeNull();
    expect(r!.category).toBe('protein_goal');
    expect(r!.text).toMatch(/1\.2-1\.6g/);
    expect(r!.text).toMatch(/grace-admin-git-main-yuval-steimbergs-projects\.vercel\.app\/settings/);
  });

  // Production failure 2026-06-05: iPhone auto-corrected the straight
  // apostrophe to U+2019; the regex used U+0027; the message fell through to
  // the orchestrator and shipped the "Give me a moment to get that right for
  // you." safe-fallback. Normalization is now at every matcher entry point.
  it('matches "What’s my week number" with iOS curly apostrophe', async () => {
    const users = {
      getById: vi.fn().mockResolvedValue({
        // Three full weeks before "today" — week 4 of the journey.
        glp1_start_date: new Date(Date.now() - 21 * 24 * 60 * 60 * 1000).toISOString(),
      }),
      getTodaysFoodSummary: vi.fn(),
    } as unknown as UserService;
    const curly = 'What’s my week number';
    const r = await tryQueryFast(curly, { users, logger: noopLogger, userId: 'u1' });
    expect(r).not.toBeNull();
    expect(r!.category).toBe('week_number');
    expect(r!.text).toMatch(/week 4 of your GLP-1 journey/);
  });

  it('matches "I’m at" / "what’s" / "don’t" with curly apostrophes', () => {
    // Direct regex check after the same normalization the function applies.
    const normalize = (s: string) =>
      s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"');
    expect(__testing.PROTEIN_GOAL_RE.test(normalize('What’s my protein goal'))).toBe(true);
    expect(__testing.CALORIE_GOAL_RE.test(normalize('What’s my calorie target'))).toBe(true);
    expect(__testing.WEIGHT_GOAL_RE.test(normalize('What’s my goal weight'))).toBe(true);
  });
});

describe('food_summary_today: multi-item label splitting (2026-06-06)', () => {
  it('splits "3 eggs + salad + 1 can tuna + 1 cup rice" into a natural comma list', async () => {
    // Production failure: log_food.sumItemized joins multi-item meals with
    // " + " for an internal label; that label leaked into the user-facing
    // summary as "Today you've had 3 eggs + salad + 1 can tuna + 1 cup
    // rice. Running total: 45g protein, 680 kcal." Now we split on " + "
    // so the items read naturally.
    const users = {
      getById: vi.fn().mockResolvedValue({
        protein_goal_grams: 80,
        calorie_goal_kcal: 1800,
        goal_weight: 160,
        current_weight: 180,
      }),
      getTodaysFoodSummary: vi.fn().mockResolvedValue({
        protein_g: 45,
        calories: 680,
        items: ['3 eggs + salad + 1 can tuna + 1 cup rice'],
        items_detailed: [],
      }),
    } as unknown as UserService;
    const r = await tryQueryFast('what i ate today?', { users, logger: noopLogger, userId: 'u1' });
    expect(r).not.toBeNull();
    expect(r!.category).toBe('food_summary_today');
    // Each item appears as a standalone comma-separated entry with "and"
    // before the last one. The " + " label is gone.
    expect(r!.text).toBe(
      "Today you've had 3 eggs, salad, 1 can tuna, and 1 cup rice. Running total: 45g protein, 680 kcal.",
    );
    expect(r!.text).not.toMatch(/\+/);
  });

  it('handles already-split items (single-item food_logs rows)', async () => {
    const users = {
      getById: vi.fn().mockResolvedValue({
        protein_goal_grams: 80,
        calorie_goal_kcal: 1800,
        goal_weight: 160,
        current_weight: 180,
      }),
      getTodaysFoodSummary: vi.fn().mockResolvedValue({
        protein_g: 30,
        calories: 450,
        items: ['Greek yogurt with hemp seeds', 'apple'],
        items_detailed: [],
      }),
    } as unknown as UserService;
    const r = await tryQueryFast('what i ate today', { users, logger: noopLogger, userId: 'u1' });
    expect(r).not.toBeNull();
    expect(r!.text).toBe(
      "Today you've had Greek yogurt with hemp seeds, and apple. Running total: 30g protein, 450 kcal.",
    );
  });
});

describe('is_protein_enough / is_calorie_enough (2026-06-06)', () => {
  // Production failure: "Is 80g of protein enough?" routed to knowledge_direct
  // → generic muscle-loss explanation, no comparison to user's 60g target or
  // weight-based formula. Deterministic personalized comparison now ships.
  it('"Is 80g of protein enough?" with goal=60g and weight=180lbs compares to both', async () => {
    const users = mockUsers({ protein_goal_grams: 60, current_weight: 180 });
    const r = await tryQueryFast('Is 80g of protein enough?', { users, logger: noopLogger, userId: 'u1' });
    expect(r).not.toBeNull();
    expect(r!.category).toBe('is_protein_enough');
    expect(r!.text).toMatch(/80g is 20g above your 60g target/);
    expect(r!.text).toMatch(/180 lbs/);
    expect(r!.text).toMatch(/98-131g/);
    expect(r!.text).toMatch(/Want me to walk through the math\?$/);
  });

  it('"Is 80g enough?" (no "protein" word, still classifies)', async () => {
    const users = mockUsers({ protein_goal_grams: 60, current_weight: 180 });
    const r = await tryQueryFast('Is 80g enough?', { users, logger: noopLogger, userId: 'u1' });
    expect(r).not.toBeNull();
    expect(r!.category).toBe('is_protein_enough');
    expect(r!.text).toMatch(/80g is 20g above your 60g target/);
  });

  it('"Is 50g of protein enough?" (below goal) frames the gap', async () => {
    const users = mockUsers({ protein_goal_grams: 60, current_weight: 180 });
    const r = await tryQueryFast('Is 50g of protein enough?', { users, logger: noopLogger, userId: 'u1' });
    expect(r).not.toBeNull();
    expect(r!.text).toMatch(/50g is 10g below your 60g target/);
  });

  it('"Is 60g of protein enough?" (exact match) → hits target exactly', async () => {
    const users = mockUsers({ protein_goal_grams: 60, current_weight: 180 });
    const r = await tryQueryFast('Is 60g of protein enough?', { users, logger: noopLogger, userId: 'u1' });
    expect(r).not.toBeNull();
    expect(r!.text).toMatch(/60g hits your 60g target exactly/);
  });

  it('"Is 80g protein enough?" without weight on file uses only goal', async () => {
    const users = mockUsers({ protein_goal_grams: 60, current_weight: null });
    const r = await tryQueryFast('Is 80g protein enough?', { users, logger: noopLogger, userId: 'u1' });
    expect(r).not.toBeNull();
    expect(r!.text).toMatch(/80g is 20g above your 60g target/);
    expect(r!.text).not.toMatch(/lbs/);
  });

  it('"Is 80g of protein enough?" with no goal and no weight → general answer', async () => {
    const users = mockUsers({ protein_goal_grams: null, current_weight: null });
    const r = await tryQueryFast('Is 80g of protein enough?', { users, logger: noopLogger, userId: 'u1' });
    expect(r).not.toBeNull();
    expect(r!.text).toMatch(/Share your weight and I can be precise/);
  });

  it('"Is 1800 kcal enough?" with calorie goal=1800 hits target exactly', async () => {
    const users = mockUsers({ calorie_goal_kcal: 1800 });
    const r = await tryQueryFast('Is 1800 kcal enough?', { users, logger: noopLogger, userId: 'u1' });
    expect(r).not.toBeNull();
    expect(r!.category).toBe('is_calorie_enough');
    expect(r!.text).toMatch(/1800 kcal hits your 1800 kcal target exactly/);
  });

  it('"Is 1500 calories enough?" with calorie goal=1800 → below target', async () => {
    const users = mockUsers({ calorie_goal_kcal: 1800 });
    const r = await tryQueryFast('Is 1500 calories enough?', { users, logger: noopLogger, userId: 'u1' });
    expect(r).not.toBeNull();
    expect(r!.text).toMatch(/1500 kcal is 300 kcal below your 1800 kcal target/);
  });

  it('does NOT match "is it enough" (no number)', async () => {
    const users = mockUsers({ protein_goal_grams: 60, current_weight: 180 });
    const r = await tryQueryFast('is it enough', { users, logger: noopLogger, userId: 'u1' });
    expect(r).toBeNull();
  });

  it('does NOT match "is 80 enough" (no unit — ambiguous)', async () => {
    const users = mockUsers({ protein_goal_grams: 60, current_weight: 180 });
    const r = await tryQueryFast('is 80 enough', { users, logger: noopLogger, userId: 'u1' });
    expect(r).toBeNull();
  });
});

describe('starting_weight + weight_progress (2026-06-06 — coverage audit)', () => {
  it('"What is my starting weight?" with value returns it', async () => {
    const users = mockUsers({ starting_weight: 200 });
    const r = await tryQueryFast('What is my starting weight?', { users, logger: noopLogger, userId: 'u1' });
    expect(r).not.toBeNull();
    expect(r!.category).toBe('starting_weight');
    expect(r!.text).toBe('Your starting weight is 200 lbs.');
  });

  it('"What is my starting weight?" without value says "not on file"', async () => {
    const users = mockUsers({ starting_weight: null });
    const r = await tryQueryFast("What's my starting weight?", { users, logger: noopLogger, userId: 'u1' });
    expect(r).not.toBeNull();
    expect(r!.category).toBe('starting_weight');
    expect(r!.text).toMatch(/don't have your starting weight on file/);
    expect(r!.text).toMatch(/grace-admin-git-main-yuval-steimbergs-projects\.vercel\.app\/settings/);
  });

  it('"How much have I lost?" with both weights computes the loss', async () => {
    const users = mockUsers({ starting_weight: 200, current_weight: 180, goal_weight: 160 });
    const r = await tryQueryFast('How much have I lost?', { users, logger: noopLogger, userId: 'u1' });
    expect(r).not.toBeNull();
    expect(r!.category).toBe('weight_progress');
    expect(r!.text).toMatch(/down 20 lbs from 200 lbs/);
    expect(r!.text).toMatch(/180 lbs now/);
    expect(r!.text).toMatch(/20 lbs to your 160 lbs goal/);
  });

  it('"How much have I lost?" without starting_weight is HONEST, never fabricates', async () => {
    const users = mockUsers({ starting_weight: null, current_weight: 180 });
    const r = await tryQueryFast('How much have I lost?', { users, logger: noopLogger, userId: 'u1' });
    expect(r).not.toBeNull();
    expect(r!.category).toBe('weight_progress');
    expect(r!.text).toMatch(/your starting weight isn't on file/);
    expect(r!.text).toMatch(/grace-admin-git-main-yuval-steimbergs-projects\.vercel\.app\/settings/);
    // Sanity: no fabricated number.
    expect(r!.text).not.toMatch(/down \d+ lbs/);
  });

  it('"Weight loss so far" without current_weight asks for it', async () => {
    const users = mockUsers({ starting_weight: 200, current_weight: null });
    const r = await tryQueryFast('Weight loss so far', { users, logger: noopLogger, userId: 'u1' });
    expect(r).not.toBeNull();
    expect(r!.text).toMatch(/Your starting weight is 200 lbs but I don't have a recent weight/);
  });

  it('"Am I down any weight?" with equal weights says same, no fabrication', async () => {
    const users = mockUsers({ starting_weight: 180, current_weight: 180 });
    const r = await tryQueryFast('Am I down any weight?', { users, logger: noopLogger, userId: 'u1' });
    expect(r).not.toBeNull();
    expect(r!.text).toMatch(/same as your starting weight/);
  });

  it('"How much have I lost?" when current is HIGHER than starting handles gracefully', async () => {
    const users = mockUsers({ starting_weight: 180, current_weight: 195 });
    const r = await tryQueryFast('How much have I lost?', { users, logger: noopLogger, userId: 'u1' });
    expect(r).not.toBeNull();
    expect(r!.text).toMatch(/195 lbs, which is 15 lbs above your 180 lbs starting weight/);
  });

  it('"What did I start at?" matches starting_weight read pattern', async () => {
    const users = mockUsers({ starting_weight: 220 });
    const r = await tryQueryFast('what did I start at?', { users, logger: noopLogger, userId: 'u1' });
    expect(r).not.toBeNull();
    expect(r!.category).toBe('starting_weight');
    expect(r!.text).toBe('Your starting weight is 220 lbs.');
  });
});
