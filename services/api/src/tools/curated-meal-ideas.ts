/**
 * Curated GLP-1 meal idea bank for the `search_food_ideas` tool.
 *
 * Mirrors what COMMON_FOODS does for `log_food`: when the user's request
 * fits one of the standard (diet × meal-type) cells, we return 4 hand-
 * picked GLP-1-friendly ideas in ~5–15 ms — no Redis lookup, no Google-
 * Search grounding, no LLM call.
 *
 * Latency budget shape:
 *   Curated hit  → ~5–15 ms   (this module)        ← NEW
 *   Cache hit    → ~20–60 ms  (Redis GET)
 *   Cache miss   → ~2000–4000 ms (Gemini + Google Search)
 *
 * Coverage: 4 diets (omnivore / vegetarian / vegan / pescatarian) × 4 meal
 * types (breakfast / lunch / dinner / snack) = 16 cells × 8 ideas =
 * 128 ideas. The fast-path filters by user dislikes; if fewer than 3
 * ideas survive the filter, we return null so the LLM still runs.
 *
 * Variety: per-call we pick a stable-but-rotating window of 4 ideas
 * seeded by (userId + day + mealType + diet). Same user gets the same
 * 4 ideas on the same day for the same request, different days surface
 * different combinations, and two users asking the same thing see
 * different rotations.
 *
 * Each idea was hand-picked to be:
 *   - Specific (a real dish, not "high-protein snack")
 *   - GLP-1 friendly (small portion, protein-dense, easy on slowed digestion)
 *   - Realistic for a busy adult (5–15 min prep or grab-and-go)
 */

import { createHash } from 'node:crypto';
import type { FoodIdea } from './search-food-ideas.js';
import type { DietaryRestriction } from '@grace/shared';

type DietKey = 'omnivore' | 'vegetarian' | 'vegan' | 'pescatarian';
type MealKey = 'breakfast' | 'lunch' | 'dinner' | 'snack';

// ─── The bank ────────────────────────────────────────────────────────────────

const CURATED_IDEAS: Record<DietKey, Record<MealKey, FoodIdea[]>> = {
  omnivore: {
    breakfast: [
      { name: 'Greek yogurt with hemp seeds and berries', protein_g: 22, why: 'protein-dense and gentle on slowed digestion' },
      { name: 'Two-egg veggie omelet with feta', protein_g: 18, why: 'quick to make and easy to digest' },
      { name: 'Cottage cheese with peaches', protein_g: 16, why: 'high protein, low volume — sits well' },
      { name: 'Smoked salmon on rye toast', protein_g: 14, why: 'omega-3s and protein without feeling heavy' },
      { name: 'Turkey breakfast sausage with one egg', protein_g: 16, why: 'protein-forward without feeling heavy' },
      { name: 'Overnight oats with protein powder and chia', protein_g: 22, why: 'fiber + protein keeps you steady through morning' },
      { name: 'Egg bites with cheddar and spinach', protein_g: 14, why: 'small portion, easy on the stomach' },
      { name: 'Plain Greek yogurt parfait with almonds', protein_g: 18, why: 'crunchy texture without bulk' },
    ],
    lunch: [
      { name: 'Grilled chicken Caesar salad (light dressing)', protein_g: 32, why: 'lean protein with greens; small enough not to feel stuck' },
      { name: 'Tuna salad on a bed of mixed greens', protein_g: 24, why: 'no bread bulk; high-protein and hydrating' },
      { name: 'Chicken and avocado wrap (half portion)', protein_g: 22, why: 'half-portion keeps it light on GLP-1' },
      { name: 'Turkey and hummus pita pocket', protein_g: 22, why: 'small and balanced protein-fat-carb' },
      { name: 'Chipotle bowl with chicken, beans, lots of veggies, no rice', protein_g: 35, why: 'high protein without the heavy carb load' },
      { name: 'Cobb salad with grilled chicken', protein_g: 30, why: 'mixed textures and protein-dense' },
      { name: 'Salmon poke bowl (half rice, double protein)', protein_g: 28, why: 'lean protein with omega-3s' },
      { name: 'Beef and broccoli stir-fry (small portion)', protein_g: 22, why: 'protein-forward Asian flavor without feeling overstuffed' },
    ],
    dinner: [
      { name: 'Baked salmon with roasted asparagus', protein_g: 30, why: 'omega-3s and a small protein-veg plate that sits well' },
      { name: 'Grilled chicken breast with Brussels sprouts', protein_g: 32, why: 'lean and easy to portion-control' },
      { name: 'Turkey meatballs with marinara over zucchini noodles', protein_g: 28, why: 'high protein, light carbs — gentle on slowed digestion' },
      { name: 'Beef and vegetable stir-fry over cauliflower rice', protein_g: 28, why: 'protein-dense without the heavy carb load' },
      { name: 'Shrimp scampi with sautéed spinach', protein_g: 25, why: 'small portion of seafood with greens; quick to digest' },
      { name: 'Pork tenderloin with green beans', protein_g: 28, why: 'lean cut of pork that\'s easy to portion' },
      { name: 'Mediterranean chicken plate (chicken, tzatziki, cucumber)', protein_g: 30, why: 'lean protein with cooling yogurt and crunch' },
      { name: 'Bunless turkey burger with side salad', protein_g: 28, why: 'high protein, no bread bulk' },
    ],
    snack: [
      { name: 'Hard-boiled egg with cherry tomatoes', protein_g: 6, why: 'tiny portion, quick protein hit' },
      { name: 'Turkey jerky and a few almonds', protein_g: 13, why: 'portable, no prep, dense protein' },
      { name: 'Cottage cheese with cucumber slices', protein_g: 14, why: 'high protein, low volume' },
      { name: 'String cheese and a small apple', protein_g: 7, why: 'classic balance that sits well' },
      { name: 'Greek yogurt with a drizzle of honey', protein_g: 17, why: 'protein-dense without bulk' },
      { name: 'A few slices of deli turkey rolled around cheese', protein_g: 14, why: 'no-prep protein snack' },
      { name: 'Edamame in the pod (1 cup)', protein_g: 11, why: 'eating slowly keeps you ahead of fullness' },
      { name: 'Tuna packet on a few crackers', protein_g: 17, why: 'shelf-stable and high protein' },
    ],
  },
  vegetarian: {
    breakfast: [
      { name: 'Greek yogurt with hemp seeds and berries', protein_g: 22, why: 'protein-dense and gentle on slowed digestion' },
      { name: 'Two-egg veggie omelet with feta', protein_g: 18, why: 'quick to make and easy to digest' },
      { name: 'Cottage cheese with peaches', protein_g: 16, why: 'high protein, low volume — sits well' },
      { name: 'Scrambled eggs with whole-grain toast', protein_g: 16, why: 'simple, complete protein breakfast' },
      { name: 'Egg bites with spinach and cheese', protein_g: 14, why: 'small portion, easy on the stomach' },
      { name: 'Overnight oats with whey protein and chia', protein_g: 22, why: 'fiber + protein keeps you steady through morning' },
      { name: 'Plain skyr with sliced almonds and cinnamon', protein_g: 18, why: 'super high protein per cup' },
      { name: 'Smoothie with whey, kefir, and frozen berries', protein_g: 28, why: 'easy on the stomach when solids feel heavy' },
    ],
    lunch: [
      { name: 'Greek salad with chickpeas and feta', protein_g: 18, why: 'fiber and protein together; light on GLP-1' },
      { name: 'Lentil soup with side of cottage cheese', protein_g: 22, why: 'plant protein duo that sits well' },
      { name: 'Hummus and veggie bowl with hard-boiled egg', protein_g: 16, why: 'mixed textures, balanced macros' },
      { name: 'Caprese with white beans and basil', protein_g: 18, why: 'protein from beans and cheese in a small plate' },
      { name: 'Egg salad on lettuce wraps', protein_g: 16, why: 'no bread bulk; classic protein lunch' },
      { name: 'Greek yogurt bowl with veggies and crackers', protein_g: 20, why: 'savory yogurt twist for variety' },
      { name: 'Black bean and quinoa bowl with avocado', protein_g: 18, why: 'complete plant protein, balanced fats' },
      { name: 'Cottage cheese with cucumber and everything seasoning', protein_g: 22, why: 'high protein, low effort' },
    ],
    dinner: [
      { name: 'Baked eggplant parm with mozzarella (small portion)', protein_g: 22, why: 'Italian flavor without overdoing volume' },
      { name: 'Paneer tikka with sautéed greens', protein_g: 24, why: 'high-protein Indian dish that sits well' },
      { name: 'Tofu stir-fry with broccoli and ginger', protein_g: 22, why: 'protein-dense, gentle on the stomach' },
      { name: 'Lentil dal with a small portion of rice', protein_g: 18, why: 'plant protein and warmth — easy to digest' },
      { name: 'Chickpea and spinach curry over cauliflower rice', protein_g: 16, why: 'high fiber, high protein, low carb load' },
      { name: 'Veggie omelet with side salad', protein_g: 16, why: 'simple, balanced, easy on slowed digestion' },
      { name: 'Halloumi and roasted vegetable plate', protein_g: 22, why: 'salty, satisfying protein in a small portion' },
      { name: 'Black bean enchilada (single, with extra cheese)', protein_g: 18, why: 'small Mexican plate that satisfies' },
    ],
    snack: [
      { name: 'Hard-boiled egg with cherry tomatoes', protein_g: 6, why: 'tiny portion, quick protein hit' },
      { name: 'Cottage cheese with cucumber slices', protein_g: 14, why: 'high protein, low volume' },
      { name: 'String cheese and a small apple', protein_g: 7, why: 'classic balance that sits well' },
      { name: 'Greek yogurt with a drizzle of honey', protein_g: 17, why: 'protein-dense without bulk' },
      { name: 'Edamame in the pod (1 cup)', protein_g: 11, why: 'eating slowly keeps you ahead of fullness' },
      { name: 'Roasted chickpeas (small handful)', protein_g: 6, why: 'crunchy and portable, fiber + protein' },
      { name: 'Skyr with a few walnuts', protein_g: 19, why: 'one of the highest-protein dairy options' },
      { name: 'Babybel cheese and a few grapes', protein_g: 5, why: 'no-prep portion-controlled snack' },
    ],
  },
  vegan: {
    breakfast: [
      { name: 'Tofu scramble with spinach and nutritional yeast', protein_g: 18, why: 'high plant protein, savory breakfast' },
      { name: 'Overnight oats with pea protein, chia, and almond milk', protein_g: 22, why: 'fiber and plant protein in one prep-ahead bowl' },
      { name: 'Smoothie with pea protein, frozen berries, and oat milk', protein_g: 25, why: 'easy on the stomach when solids feel heavy' },
      { name: 'Chia pudding with hemp seeds and berries', protein_g: 12, why: 'small portion, balanced macros' },
      { name: 'Tempeh bacon with avocado toast', protein_g: 18, why: 'protein-forward plant breakfast' },
      { name: 'Soy yogurt with granola and walnuts', protein_g: 14, why: 'plant protein with crunch' },
      { name: 'Vegan protein pancakes with peanut butter', protein_g: 20, why: 'satisfying when you want something hot' },
      { name: 'Edamame and avocado on toast', protein_g: 14, why: 'simple, plant-protein-forward' },
    ],
    lunch: [
      { name: 'Lentil and quinoa bowl with roasted veggies', protein_g: 18, why: 'complete plant protein and fiber' },
      { name: 'Chickpea salad sandwich (small portion)', protein_g: 14, why: 'mashed chickpea filling like tuna salad' },
      { name: 'Tofu Buddha bowl with tahini and greens', protein_g: 22, why: 'protein-dense, balanced macros' },
      { name: 'Black bean burrito bowl (no rice or half rice)', protein_g: 18, why: 'high protein without the heavy carb load' },
      { name: 'Tempeh wrap with hummus and veggies', protein_g: 22, why: 'two plant proteins in one small wrap' },
      { name: 'Lentil soup with a small piece of bread', protein_g: 18, why: 'warming and protein-rich' },
      { name: 'Edamame and quinoa salad with mint', protein_g: 18, why: 'fresh, light, high protein' },
      { name: 'Falafel bowl with cucumber and tahini', protein_g: 16, why: 'small portion of Middle Eastern flavors' },
    ],
    dinner: [
      { name: 'Tofu stir-fry with broccoli and ginger', protein_g: 22, why: 'protein-dense, gentle on the stomach' },
      { name: 'Tempeh chili with white beans', protein_g: 24, why: 'two plant proteins, warming and satisfying' },
      { name: 'Lentil dal with sautéed spinach (skip the rice)', protein_g: 18, why: 'plant protein and warmth — easy to digest' },
      { name: 'Chickpea curry over cauliflower rice', protein_g: 16, why: 'high fiber, high protein, low carb load' },
      { name: 'Black bean tacos with avocado and salsa', protein_g: 15, why: 'small, balanced, fiber + plant protein' },
      { name: 'Tofu pad thai (light on noodles)', protein_g: 20, why: 'Asian flavor with high protein' },
      { name: 'Stuffed bell peppers with lentils and quinoa', protein_g: 18, why: 'all-in-one veggie + plant protein meal' },
      { name: 'Vegan Beyond burger with side salad', protein_g: 20, why: 'when you want classic burger flavor' },
    ],
    snack: [
      { name: 'Edamame in the pod (1 cup)', protein_g: 11, why: 'eating slowly keeps you ahead of fullness' },
      { name: 'Roasted chickpeas (small handful)', protein_g: 6, why: 'crunchy and portable, fiber + plant protein' },
      { name: 'Soy yogurt with hemp seeds', protein_g: 12, why: 'plant protein duo' },
      { name: 'Hummus with cucumber slices', protein_g: 6, why: 'low-volume, balanced plant snack' },
      { name: 'Vegan protein bar (RXBAR, Aloha, or GoMacro)', protein_g: 12, why: 'portable plant protein on busy days' },
      { name: 'Almond butter on apple slices', protein_g: 7, why: 'classic sweet-savory balance' },
      { name: 'Trail mix with pumpkin seeds and dried fruit', protein_g: 6, why: 'portable plant protein and fiber' },
      { name: 'Vegan protein shake (pea protein + almond milk)', protein_g: 22, why: 'liquid option when solids feel heavy' },
    ],
  },
  pescatarian: {
    breakfast: [
      { name: 'Smoked salmon on rye toast with cream cheese', protein_g: 16, why: 'omega-3s and protein without feeling heavy' },
      { name: 'Greek yogurt with hemp seeds and berries', protein_g: 22, why: 'protein-dense and gentle on slowed digestion' },
      { name: 'Two-egg omelet with smoked salmon', protein_g: 22, why: 'high protein, light feel' },
      { name: 'Cottage cheese with peaches', protein_g: 16, why: 'high protein, low volume — sits well' },
      { name: 'Scrambled eggs with avocado', protein_g: 14, why: 'balanced protein-fat breakfast' },
      { name: 'Plain skyr with sliced almonds and cinnamon', protein_g: 18, why: 'super high protein per cup' },
      { name: 'Egg bites with spinach and cheese', protein_g: 14, why: 'small portion, easy on the stomach' },
      { name: 'Overnight oats with whey protein and chia', protein_g: 22, why: 'fiber + protein keeps you steady through morning' },
    ],
    lunch: [
      { name: 'Tuna salad on a bed of mixed greens', protein_g: 24, why: 'no bread bulk; high-protein and hydrating' },
      { name: 'Salmon poke bowl (half rice, double protein)', protein_g: 28, why: 'lean protein with omega-3s' },
      { name: 'Shrimp and avocado salad', protein_g: 22, why: 'light, high protein, balanced fats' },
      { name: 'Sushi (6 pieces of nigiri, salmon or tuna)', protein_g: 18, why: 'small portion, lean fish protein' },
      { name: 'Greek salad with grilled shrimp', protein_g: 24, why: 'Mediterranean flavors with seafood' },
      { name: 'Tuna packet on a small bed of crackers', protein_g: 20, why: 'pantry-staple high-protein lunch' },
      { name: 'Smoked salmon with cucumber slices', protein_g: 18, why: 'protein-dense, hydrating' },
      { name: 'Lentil soup with a side of cottage cheese', protein_g: 22, why: 'plant + dairy protein combo' },
    ],
    dinner: [
      { name: 'Baked salmon with roasted asparagus', protein_g: 30, why: 'omega-3s and a small protein-veg plate that sits well' },
      { name: 'Shrimp scampi with sautéed spinach', protein_g: 25, why: 'small portion of seafood with greens; quick to digest' },
      { name: 'Cod with steamed broccoli and lemon', protein_g: 28, why: 'lean white fish, light on the stomach' },
      { name: 'Tuna steak with green beans', protein_g: 32, why: 'high protein, low volume' },
      { name: 'Tofu and shrimp stir-fry with bok choy', protein_g: 26, why: 'two protein sources, Asian flavors' },
      { name: 'Halibut with roasted Brussels sprouts', protein_g: 30, why: 'lean white fish and gentle vegetables' },
      { name: 'Scallops with sautéed zucchini', protein_g: 23, why: 'small elegant plate, easy to digest' },
      { name: 'Salmon with cauliflower mash', protein_g: 28, why: 'protein-forward, comforting, low carb' },
    ],
    snack: [
      { name: 'Tuna packet on a few crackers', protein_g: 17, why: 'shelf-stable and high protein' },
      { name: 'Hard-boiled egg with cherry tomatoes', protein_g: 6, why: 'tiny portion, quick protein hit' },
      { name: 'Cottage cheese with cucumber slices', protein_g: 14, why: 'high protein, low volume' },
      { name: 'Smoked salmon roll-ups with cream cheese', protein_g: 14, why: 'no-prep protein snack' },
      { name: 'String cheese and a small apple', protein_g: 7, why: 'classic balance that sits well' },
      { name: 'Greek yogurt with a drizzle of honey', protein_g: 17, why: 'protein-dense without bulk' },
      { name: 'Edamame in the pod (1 cup)', protein_g: 11, why: 'eating slowly keeps you ahead of fullness' },
      { name: 'Sardines on a few crackers', protein_g: 22, why: 'high protein and omega-3s in a small portion' },
    ],
  },
};

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Returns 4 curated ideas for the user's diet × meal-type cell, filtered by
 * forbidden ingredients, with a stable-but-rotating selection seeded by
 * (userId + day + meal + diet). Returns null when:
 *   - the meal type isn't one we curate ('general' or 'dessert')
 *   - fewer than 3 ideas survive the dislike filter
 *   - any other reason we'd rather let the LLM run
 */
export function getCuratedFoodIdeas(opts: {
  userId: string;
  query: string;
  mealType: string;
  dietaryRestriction: DietaryRestriction | null | undefined;
  foodDislikes: string[];
}): FoodIdea[] | null {
  const mealKey = normalizeMealKey(opts.mealType);
  if (!mealKey) return null;

  const dietKey = pickDietKey(opts.query, opts.dietaryRestriction ?? null);
  const cell = CURATED_IDEAS[dietKey][mealKey];
  if (!cell || cell.length === 0) return null;

  // Build forbidden token set: dietary restriction forbidden words +
  // user-provided dislikes (lowercased and tokenized). Also add the
  // singular/plural variant of each token so "eggs" matches "egg" and
  // "lentils" matches "lentil".
  const forbidden = new Set<string>();
  const addWithStem = (tok: string) => {
    if (tok.length < 2) return;
    forbidden.add(tok);
    if (tok.endsWith('s')) forbidden.add(tok.slice(0, -1));
    else forbidden.add(tok + 's');
  };
  for (const word of opts.dietaryRestriction?.forbidden ?? []) {
    addWithStem(word.toLowerCase());
  }
  for (const dislike of opts.foodDislikes ?? []) {
    for (const tok of dislike.toLowerCase().split(/[\s,]+/).filter(Boolean)) {
      addWithStem(tok);
    }
  }

  // Filter out any idea whose name contains a forbidden token as a whole word.
  const survivors = cell.filter((idea) => !ideaConflictsWith(idea, forbidden));
  if (survivors.length < 3) return null;

  // Rotate the slice based on a stable seed so the same user on the same day
  // sees the same 4 ideas — but tomorrow they see a different set.
  const day = Math.floor(Date.now() / (24 * 60 * 60 * 1000));
  const seed = createHash('sha1')
    .update(`${opts.userId}|${day}|${mealKey}|${dietKey}`)
    .digest();
  const startIdx = seed.readUInt32BE(0) % survivors.length;
  const out: FoodIdea[] = [];
  for (let i = 0; i < Math.min(4, survivors.length); i++) {
    out.push(survivors[(startIdx + i) % survivors.length]!);
  }
  return out;
}

function ideaConflictsWith(idea: FoodIdea, forbidden: Set<string>): boolean {
  if (forbidden.size === 0) return false;
  const tokens = idea.name.toLowerCase().split(/[^a-z]+/).filter(Boolean);
  for (const tok of tokens) {
    if (forbidden.has(tok)) return true;
  }
  return false;
}

function normalizeMealKey(mealType: string): MealKey | null {
  switch (mealType) {
    case 'breakfast':
    case 'lunch':
    case 'dinner':
    case 'snack':
      return mealType;
    default:
      return null;
  }
}

/**
 * If the user's query text overrides their profile diet (e.g. "any vegan
 * dinner ideas" from an omnivore who's trying meatless Monday), pick the
 * cell matching the query rather than the profile.
 */
function pickDietKey(
  query: string,
  profile: DietaryRestriction | null,
): DietKey {
  const lower = query.toLowerCase();
  if (/\bvegan\b/.test(lower)) return 'vegan';
  if (/\bvegetarian\b/.test(lower)) return 'vegetarian';
  if (/\bpescatarian\b/.test(lower)) return 'pescatarian';
  if (!profile) return 'omnivore';
  switch (profile.label) {
    case 'VEGAN':
      return 'vegan';
    case 'VEGETARIAN':
      return 'vegetarian';
    case 'PESCATARIAN':
      return 'pescatarian';
    default:
      return 'omnivore';
  }
}

// Test exports
export const __testing = { CURATED_IDEAS, normalizeMealKey, pickDietKey, ideaConflictsWith };
