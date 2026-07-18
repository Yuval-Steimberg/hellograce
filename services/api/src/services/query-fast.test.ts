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
    expect(r!.text).toMatch(/graceglp\.com\/settings/);
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

describe('start_date: broadened detection + never fabricates (2026-07-05)', () => {
  const startUser = (glp1_start_date: string | null) => ({
    getById: vi.fn().mockResolvedValue({ glp1_start_date, medication: 'Ozempic' }),
    getTodaysFoodSummary: vi.fn(),
  } as unknown as UserService);

  it('detects the no-"did" phrasings that used to misroute to injection timing', () => {
    expect(__testing.START_DATE_RE.test('when I started taking the injection')).toBe(true);
    expect(__testing.START_DATE_RE.test('when I started with glp')).toBe(true);
    expect(__testing.START_DATE_RE.test('when did I start ozempic')).toBe(true);
    expect(__testing.START_DATE_RE.test('how long have I been on ozempic')).toBe(true);
  });

  it('answers from a plausible stored date (no fabrication)', async () => {
    const iso = new Date(Date.now() - 21 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const r = await tryQueryFast('when did I start ozempic', { users: startUser(iso), logger: noopLogger, userId: 'u1' });
    expect(r!.category).toBe('start_date');
    expect(r!.text).toMatch(/week \d+/);
    expect(r!.text).toContain('Ozempic');
  });

  it('asks for the date when none on file — never invents one', async () => {
    const r = await tryQueryFast('when did I start', { users: startUser(null), logger: noopLogger, userId: 'u1' });
    expect(r!.category).toBe('start_date');
    expect(r!.text.toLowerCase()).toContain("don't have your start date");
    expect(r!.text).not.toMatch(/\b(19|20)\d{2}\b/);
  });

  it('flags an implausible stored date instead of parroting it', async () => {
    const r = await tryQueryFast('when did I start', { users: startUser('1999-01-05'), logger: noopLogger, userId: 'u1' });
    expect(r!.category).toBe('start_date');
    expect(r!.text.toLowerCase()).toContain("doesn't look right");
  });

  it('will not pin a week number from an implausible date', async () => {
    const r = await tryQueryFast('what week am I on', { users: startUser('1999-01-05'), logger: noopLogger, userId: 'u1' });
    expect(r!.category).toBe('week_number');
    expect(r!.text.toLowerCase()).toContain("doesn't look right");
  });

  it('uses a caller-supplied user and NEVER re-fetches via getById (encryption-safe)', async () => {
    // Regression (2026-07-18): under field encryption, getById(phone) reads null
    // (no phone_hash lookup) → every settings read here silently failed. The
    // unified path now passes the already-loaded user; getById must not be hit.
    const iso = new Date(Date.now() - 21 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const getById = vi.fn().mockResolvedValue(null); // simulate the encryption miss
    const users = { getById, getTodaysFoodSummary: vi.fn() } as unknown as UserService;
    const r = await tryQueryFast('when did I start ozempic', {
      users, logger: noopLogger, userId: 'u1',
      user: { glp1_start_date: iso, medication: 'Ozempic' } as never,
    });
    expect(getById).not.toHaveBeenCalled();
    expect(r!.category).toBe('start_date');
    expect(r!.text).toMatch(/week \d+/);
  });

  it('honors a caller-supplied null user (loaded-but-absent) without re-fetching', async () => {
    const getById = vi.fn().mockResolvedValue({ glp1_start_date: '2026-01-01', medication: 'Ozempic' });
    const users = { getById, getTodaysFoodSummary: vi.fn() } as unknown as UserService;
    const r = await tryQueryFast('when did I start ozempic', {
      users, logger: noopLogger, userId: 'u1', user: null,
    });
    expect(getById).not.toHaveBeenCalled();
    expect(r).toBeNull();
  });
});

describe('food_summary_today: aggregated, non-repetitive summary (2026-06-11)', () => {
  it('explodes a multi-item meal label and shows a sectioned summary', async () => {
    // "3 eggs + salad + 1 can tuna + 1 cup rice" → exploded + aggregated.
    // No raw " + " label; the leading count on portion words ("1 can tuna")
    // stays part of the serving, not a multiplier.
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
    expect(r!.text).not.toMatch(/\s\+\s/);
    expect(r!.text).toContain('Eggs × 3');
    expect(r!.text).toContain('Salad');
    expect(r!.text).toContain('1 can tuna');
    expect(r!.text).toContain('45g protein');
    expect(r!.text).toContain('680 calories');
  });

  it('aggregates duplicate foods into "Name × N" instead of repeating them', async () => {
    // The exact complaint: a repetitive raw dump. 3× chicken, 2× rice,
    // 3× "2 eggs" (→ 6 eggs) must collapse, not repeat.
    const users = {
      getById: vi.fn().mockResolvedValue({ protein_goal_grams: 200, calorie_goal_kcal: 3500 }),
      getTodaysFoodSummary: vi.fn().mockResolvedValue({
        protein_g: 291,
        calories: 3340,
        items: [
          'chicken breast (4oz)', 'chicken breast (4oz)', 'chicken breast (4oz)',
          'rice (1 cup)', 'rice (1 cup)',
          '2 eggs', '2 eggs', '2 eggs',
        ],
        items_detailed: [],
      }),
    } as unknown as UserService;
    const r = await tryQueryFast('show my food log', { users, logger: noopLogger, userId: 'u1' });
    expect(r).not.toBeNull();
    expect(r!.text).toContain('Eggs × 6');
    expect(r!.text).toContain('Chicken breast × 3');
    expect(r!.text).toContain('Rice × 2');
    // Totals are unchanged by aggregation.
    expect(r!.text).toContain('291g protein');
    expect(r!.text).toContain('3,340 calories');
    // No vague tail, no repeated raw entries.
    expect(r!.text).not.toMatch(/and \d+ more/i);
    expect(r!.text.match(/chicken breast/gi)?.length).toBe(1);
  });

  it('rolls a long tail into a meaningful count (never "and 12 more")', async () => {
    const items = [
      'chicken breast (4oz)', 'chicken breast (4oz)', 'chicken breast (4oz)',
      'rice (1 cup)', 'rice (1 cup)',
      '2 eggs', '2 eggs', '2 eggs',
      'apple', 'banana', 'protein shake', 'almonds', 'broccoli', 'salmon (5oz)',
    ];
    const users = {
      getById: vi.fn().mockResolvedValue({ protein_goal_grams: 200, calorie_goal_kcal: 3500 }),
      getTodaysFoodSummary: vi.fn().mockResolvedValue({
        protein_g: 291, calories: 3340, items, items_detailed: [],
      }),
    } as unknown as UserService;
    const r = await tryQueryFast('summarize my meals', { users, logger: noopLogger, userId: 'u1' });
    expect(r).not.toBeNull();
    expect(r!.text).toMatch(/plus \d+ more foods?/i);
    expect(r!.text).not.toMatch(/and \d+ more\b/i);
  });

  it('uses a clean one-line sentence for a few foods', async () => {
    const users = {
      getById: vi.fn().mockResolvedValue({ protein_goal_grams: 80, calorie_goal_kcal: 1800 }),
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
      "Today you've had Greek yogurt with hemp seeds, and Apple. That's 30g protein and 450 calories.",
    );
  });
});

describe('daily planning / focus — switches to planning mode (2026-06-14)', () => {
  // Production failure: after "I'm hungry. My stomach hurts and I'm nervous",
  // "What should I focus on today?" CONTINUED the symptom discussion instead
  // of answering with goals + progress. query-fast runs before history, so the
  // old topic can never anchor this answer.
  it('"What should I focus on today?" leads with protein goal + progress', async () => {
    const users = mockUsers({ protein_goal_grams: 120, todayProtein: 35 });
    const r = await tryQueryFast('What should I focus on today?', { users, logger: noopLogger, userId: 'u1' });
    expect(r).not.toBeNull();
    expect(r!.category).toBe('daily_focus');
    expect(r!.text).toContain('120g');
    expect(r!.text).toContain('35g');
    expect(r!.text).toContain('85g'); // remaining
    // Symptoms are NEVER the answer here.
    expect(r!.text.toLowerCase()).not.toContain('nervous');
  });

  it('"Hi what I should focus today" (greeting prefix, no delimiter) routes to planning', async () => {
    const users = mockUsers({ protein_goal_grams: 100, todayProtein: 40 });
    const r = await tryQueryFast('Hi what I should focus today', { users, logger: noopLogger, userId: 'u1' });
    expect(r).not.toBeNull();
    expect(r!.category).toBe('daily_focus');
    expect(r!.text).toContain('60g'); // 100 - 40
  });

  it('adds a weight-progress clause when current + goal weight are known', async () => {
    const users = mockUsers({ protein_goal_grams: 100, todayProtein: 40, current_weight: 180, goal_weight: 160 });
    const r = await tryQueryFast('what are my priorities today', { users, logger: noopLogger, userId: 'u1' });
    expect(r!.category).toBe('daily_focus');
    expect(r!.text).toContain('160 lbs goal');
    expect(r!.text).toContain('20 lbs');
  });

  it('honest profile-based default when no goal and nothing logged', async () => {
    const users = {
      getById: vi.fn().mockResolvedValue({ protein_goal_grams: null, calorie_goal_kcal: null }),
      getTodaysFoodSummary: vi.fn().mockResolvedValue({ protein_g: 0, calories: 0, items: [], items_detailed: [] }),
    } as unknown as UserService;
    const r = await tryQueryFast('give me a plan for today', { users, logger: noopLogger, userId: 'u1' });
    expect(r!.category).toBe('daily_focus');
    expect(r!.text).toMatch(/don't have much from today yet/i);
    expect(r!.text).toMatch(/logged anything yet today/i);
  });

  it('"what\'s my goal today" → planning, but bare "what\'s my protein goal" stays protein_goal', async () => {
    const users = mockUsers({ protein_goal_grams: 90, todayProtein: 10 });
    const focus = await tryQueryFast("what's my goal today", { users, logger: noopLogger, userId: 'u1' });
    expect(focus!.category).toBe('daily_focus');
    const goal = await tryQueryFast("what's my protein goal", { users, logger: noopLogger, userId: 'u1' });
    expect(goal!.category).toBe('protein_goal');
  });

  it('"Feeling good. What should I focus on today" → planning with status ack', async () => {
    const users = mockUsers({ protein_goal_grams: 120, todayProtein: 35 });
    const r = await tryQueryFast('Feeling good. What should I focus on today', { users, logger: noopLogger, userId: 'u1' });
    expect(r!.category).toBe('daily_focus');
    expect(r!.text).toMatch(/^Good to hear\./);
    expect(r!.text).toContain('120g');
  });
});

describe('multi-intent: status preamble + question (2026-06-14)', () => {
  // Production failure (WhatsApp screenshot): "Feeling good. What I ate today"
  // → Grace asked the user to LIST their foods instead of checking the log.
  // The anchored patterns matched whole turns only, so the "Feeling good."
  // preamble blocked the food-history question. Now we strip a pure
  // status/greeting clause and route on the surviving question.
  it('"Feeling good. What I ate today" → food summary, with a status ack', async () => {
    const users = {
      getById: vi.fn().mockResolvedValue({ protein_goal_grams: 80, calorie_goal_kcal: 1800 }),
      getTodaysFoodSummary: vi.fn().mockResolvedValue({
        protein_g: 34, calories: 410, items: ['eggs', 'yogurt', 'coffee'], items_detailed: [],
      }),
    } as unknown as UserService;
    const r = await tryQueryFast('Feeling good. What I ate today', { users, logger: noopLogger, userId: 'u1' });
    expect(r).not.toBeNull();
    expect(r!.category).toBe('food_summary_today');
    expect(r!.text).toMatch(/^Good to hear\./);
    expect(r!.text).toContain('Eggs');
    expect(r!.text).toContain('34g protein');
  });

  it('empty log still answers the question instead of asking the user to list food', async () => {
    const users = {
      getById: vi.fn().mockResolvedValue({ protein_goal_grams: 80 }),
      getTodaysFoodSummary: vi.fn().mockResolvedValue({
        protein_g: 0, calories: 0, items: [], items_detailed: [],
      }),
    } as unknown as UserService;
    const r = await tryQueryFast('Feeling good. What have I eaten so far', { users, logger: noopLogger, userId: 'u1' });
    expect(r).not.toBeNull();
    expect(r!.category).toBe('food_summary_today');
    expect(r!.text).toMatch(/nothing logged yet/i);
  });

  it('"Feeling great, how much protein today?" → protein_today with ack', async () => {
    const users = mockUsers({ protein_goal_grams: 100, todayProtein: 40 });
    const r = await tryQueryFast('Feeling great, how much protein today?', { users, logger: noopLogger, userId: 'u1' });
    expect(r).not.toBeNull();
    expect(r!.category).toBe('protein_today');
    expect(r!.text).toMatch(/^Good to hear\./);
    expect(r!.text).toContain('40g protein');
  });

  it('a tired preamble gets a sympathetic ack', async () => {
    const users = mockUsers({ todayProtein: 40, protein_goal_grams: 100 });
    const r = await tryQueryFast("I'm exhausted. how much protein today", { users, logger: noopLogger, userId: 'u1' });
    expect(r).not.toBeNull();
    expect(r!.category).toBe('protein_today');
    expect(r!.text).toMatch(/wiped/i);
  });

  it('does NOT fast-path when a clause is a food LOG (must reach the orchestrator)', async () => {
    // "I ate eggs" is a write action, not a query-fast category, so it counts
    // as a second substantive clause → bail so the log is never dropped.
    const users = mockUsers();
    const r = await tryQueryFast('I ate eggs. how much protein today', { users, logger: noopLogger, userId: 'u1' });
    expect(r).toBeNull();
  });

  it('does NOT fast-path two substantive questions', async () => {
    const users = mockUsers();
    const r = await tryQueryFast("what's my weight goal? how much protein today", { users, logger: noopLogger, userId: 'u1' });
    expect(r).toBeNull();
  });

  it('a bare food-history question (no preamble) still works unchanged', async () => {
    const users = {
      getById: vi.fn().mockResolvedValue({ protein_goal_grams: 80 }),
      getTodaysFoodSummary: vi.fn().mockResolvedValue({
        protein_g: 34, calories: 410, items: ['eggs'], items_detailed: [],
      }),
    } as unknown as UserService;
    const r = await tryQueryFast('What I ate today', { users, logger: noopLogger, userId: 'u1' });
    expect(r).not.toBeNull();
    expect(r!.category).toBe('food_summary_today');
    // No ack prefix when there was no status preamble.
    expect(r!.text).not.toMatch(/^Good to hear\./);
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
    expect(r!.text).toMatch(/graceglp\.com\/settings/);
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
    expect(r!.text).toMatch(/graceglp\.com\/settings/);
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

describe('calories/protein LEFT today (2026-06-11 fix — was leaking to knowledge_direct)', () => {
  it('"how many calories do I have left today?" → calorie_today with correct remaining', async () => {
    const users = mockUsers({ todayCalories: 500, calorie_goal_kcal: 1500 });
    const r = await tryQueryFast('how many calories do I have left today?', { users, logger: noopLogger, userId: 'u1' });
    expect(r).not.toBeNull();
    expect(r!.category).toBe('calorie_today');
    expect(r!.text).toMatch(/1000 kcal left/);
  });

  it('"calories remaining?" → calorie_today', async () => {
    const users = mockUsers({ todayCalories: 300, calorie_goal_kcal: 1800 });
    const r = await tryQueryFast('calories remaining?', { users, logger: noopLogger, userId: 'u1' });
    expect(r).not.toBeNull();
    expect(r!.category).toBe('calorie_today');
    expect(r!.text).toMatch(/1500 kcal left/);
  });

  it('"how much protein do I have left?" → protein_today with correct remaining', async () => {
    const users = mockUsers({ todayProtein: 30, protein_goal_grams: 90 });
    const r = await tryQueryFast('how much protein do I have left?', { users, logger: noopLogger, userId: 'u1' });
    expect(r).not.toBeNull();
    expect(r!.category).toBe('protein_today');
    expect(r!.text).toMatch(/60g left/);
  });

  it('"how many more calories can I eat today?" → calorie_today', async () => {
    const users = mockUsers({ todayCalories: 900, calorie_goal_kcal: 1500 });
    const r = await tryQueryFast('how many more calories can I eat today?', { users, logger: noopLogger, userId: 'u1' });
    expect(r).not.toBeNull();
    expect(r!.category).toBe('calorie_today');
    expect(r!.text).toMatch(/600 kcal left/);
  });

  it('does NOT hijack compound messages', async () => {
    const users = mockUsers({});
    const r = await tryQueryFast('how many calories do I have left today? also I just ate eggs', { users, logger: noopLogger, userId: 'u1' });
    expect(r).toBeNull();
  });

  // ── 2026-06-11 WhatsApp screenshot regressions ──────────────────────────
  describe('screenshot regressions (2026-06-11)', () => {
    it('bare "What is my target?" → protein_goal (no protein/calorie word)', async () => {
      const users = mockUsers({ protein_goal_grams: 60 });
      const r = await tryQueryFast('What is my target?', { users, logger: noopLogger, userId: 'u1' });
      expect(r).not.toBeNull();
      expect(r!.category).toBe('protein_goal');
      expect(r!.text).toMatch(/60g/);
    });

    it('bare "what\'s my goal?" → protein_goal', () => {
      expect(__testing.BARE_TARGET_RE.test("what's my goal")).toBe(true);
      expect(__testing.BARE_TARGET_RE.test('what is my target')).toBe(true);
      expect(__testing.BARE_TARGET_RE.test('tell me my goal')).toBe(true);
    });

    it('"How much protein I had" (dropped auxiliary) → protein_today', async () => {
      const users = mockUsers({ todayProtein: 15, protein_goal_grams: 60 });
      const r = await tryQueryFast('How much protein I had', { users, logger: noopLogger, userId: 'u1' });
      expect(r).not.toBeNull();
      expect(r!.category).toBe('protein_today');
      expect(r!.text).toMatch(/15g protein today/);
    });

    it('PROTEIN_TODAY_RE matches "protein I ate/had/got"', () => {
      expect(__testing.PROTEIN_TODAY_RE.test('how much protein i had')).toBe(true);
      expect(__testing.PROTEIN_TODAY_RE.test('how much protein i ate')).toBe(true);
      expect(__testing.PROTEIN_TODAY_RE.test('how much protein i got')).toBe(true);
    });
  });
});
