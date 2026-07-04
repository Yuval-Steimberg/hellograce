/**
 * Nudge food extractor, ported faithfully (2026-07-04).
 *
 * Direct port of Nudge's `extractFoodLog` (handle-inbound-sms/index.ts). The
 * model is deliberately SIMPLE and NOT per-item: one message → one food summary
 * `{ foods, protein_g, calories }`. A concrete/specific meal is logged with an
 * estimate; a GENERIC category/restaurant ("pizza", "McDonald's") or a HEDGED
 * portion ("some tofu", "a bit of chicken") returns all-nulls (nothing logged) —
 * the reply prompt then asks. Plans, questions, cravings, and non-food also
 * return nulls. A deterministic vague-portion guard strips a hedged mention even
 * if the model logs it. This is exactly how Nudge decides what enters the diary.
 */

import type { LLMProvider } from '@grace/shared';
import type { Logger } from 'pino';

export interface NudgeFoodExtract {
  foods: string | null;
  protein_g: number | null;
  calories: number | null;
}

const EMPTY: NudgeFoodExtract = { foods: null, protein_g: null, calories: null };

// Nudge's system prompt for the extractor, verbatim (text-only path).
const EXTRACT_SYSTEM = `You extract food intake from a single user message.
Return STRICT JSON: {"foods": string|null, "protein_g": number|null, "calories": number|null}.

Rules:
- Extract when the user is reporting something they ate or drank. Plans, questions, cravings, recipes-they-might-try, menus, groceries → all nulls.
- Be CONSERVATIVE: only name items clearly in the user's text. Do not invent toppings, sauces, sides, or ingredients.
- GENERIC RESTAURANT / BRAND / CATEGORY MENTIONS: if the user only names a restaurant, chain, cuisine, OR a generic food category with no specific type/topping/portion, return ALL NULLS. This includes restaurants ("ate McDonald's", "had KFC", "got Chipotle", "Chinese takeout") AND bare food categories with no detail ("had pizza", "I ate pizza", "had a burger", "ate a sandwich", "had pasta", "had a taco", "had a salad", "had soup", "had a wrap", "had a bowl", "had sushi", "had a hot dog", "had stir fry", "had curry"). Do not guess a default item, do not log "a burger" / "pasta" / "pizza", do not estimate calories/protein. ONLY log when the user gives a specific item (e.g. "a Big Mac and fries", "cheese pizza, 2 slices", "chicken parm sandwich", "spaghetti with meatballs", "2 eggs and chicken and rice").
- VAGUE-PORTION MENTIONS — HARD RULE: if the user's text uses ANY hedging quantifier for a specific food, the entire JSON MUST be all nulls. Hedging quantifiers include (any tense): "some X", "had some X", "a bit of X", "a little X", "a few X", "a handful of X", "a couple X", "a tiny bit of X", "small amount of X", "a piece of X" (no size). Examples that MUST return all nulls: "had some tofu", "a bit of chicken", "a little yogurt", "had some eggs", "a few almonds", "some rice". Do NOT default to "one typical serving". The reply will ask for the portion. Only log once the user gives a CONCRETE amount (a number + unit/item: "3 eggs", "4 oz chicken", "half a cup of rice", "200g salmon", "one medium banana", "two slices of bread") — OR names specific dishes without a hedge ("chicken and rice", "spaghetti with meatballs"), which you may log at a standard serving.
- "foods": short human phrase of what was eaten (e.g. "3 eggs and toast"). Null if not a meal report, only a generic category, or only a vague-portion mention.
- Estimate protein_g and calories using standard portion references (USDA-style): egg≈6g/70cal, slice bread≈3g/80cal, oz chicken≈7g/45cal, cup greek yogurt≈17g/130cal, scoop whey≈24g/120cal, cup milk≈8g/120cal, oz cheese≈7g/110cal, tbsp peanut butter≈4g/95cal, cup cooked rice≈4g/200cal, medium banana≈1g/105cal, cup berries≈1g/70cal.
- Round protein to nearest 5g, calories to nearest 10.
- Plain zero-calorie drinks (water, black coffee, plain tea, diet soda) → all nulls.
- Never include commentary. JSON only.`;

// Deterministic vague-portion guard — Nudge's exact patterns. Strips a log when
// the message hedges the amount AND names no concrete portion anywhere.
const HEDGE_RE = /\b(some|a\s+bit\s+of|a\s+little|little\s+bit\s+of|a\s+few|a\s+handful\s+of|a\s+couple\s+of|a\s+couple|a\s+tiny\s+bit\s+of|small\s+amount\s+of)\s+[a-z]/i;
const CONCRETE_RE = [
  /\b\d+\s*(g|gram|grams|kg|oz|ounce|ounces|lb|lbs|pound|pounds|ml|l|cup|cups|tbsp|tsp|tablespoon|teaspoon|slice|slices|piece|pieces|serving|servings|scoop|scoops|egg|eggs|bowl|bowls|cookie|cookies|cracker|crackers|bar|bars|can|cans|bottle|bottles)\b/i,
  /\b(half|quarter|third|whole|one|two|three|four|five|six|seven|eight|nine|ten|dozen)\s+(a\s+|an\s+)?(cup|slice|piece|serving|scoop|egg|bowl|small|medium|large|block|bar|can|bottle|cookie|cracker|tbsp|tsp|ounce|gram|oz|g)/i,
  /\b\d+\s+[a-z]+s?\b/i,
];

function tripsHedgeGuard(text: string): boolean {
  const t = text.toLowerCase();
  const concrete = CONCRETE_RE.some((re) => re.test(text));
  return HEDGE_RE.test(t) && !concrete;
}

export async function extractNudgeFoodLog(
  llm: LLMProvider,
  logger: Logger,
  userMessage: string,
): Promise<NudgeFoodExtract> {
  const text = (userMessage ?? '').trim();
  if (!text) return { ...EMPTY };
  try {
    const resp = await Promise.race([
      llm.generate({
        messages: [
          { role: 'system', content: EXTRACT_SYSTEM },
          { role: 'user', content: text },
        ],
        temperature: 0.1,
        maxOutputTokens: 150,
        responseFormat: 'json',
        disableThinking: true,
        skipCache: true,
      }),
      new Promise<{ text: string }>((r) => setTimeout(() => r({ text: '' }), 6000)),
    ]);
    const raw = (resp.text ?? '').trim();
    if (!raw) return { ...EMPTY };
    let parsed: Record<string, unknown>;
    try {
      const m = raw.match(/\{[\s\S]*\}/);
      parsed = JSON.parse(m ? m[0] : raw) as Record<string, unknown>;
    } catch {
      return { ...EMPTY };
    }
    let foods = typeof parsed.foods === 'string' && parsed.foods.trim() ? parsed.foods.trim().slice(0, 240) : null;
    let protein_g = typeof parsed.protein_g === 'number' && Number.isFinite(parsed.protein_g) && parsed.protein_g >= 0 && parsed.protein_g <= 300
      ? Math.round(parsed.protein_g) : null;
    let calories = typeof parsed.calories === 'number' && Number.isFinite(parsed.calories) && parsed.calories >= 0 && parsed.calories <= 5000
      ? Math.round(parsed.calories) : null;

    if (foods && tripsHedgeGuard(text)) {
      logger.info({ msg: 'nudge_food.hedge_guard_stripped', text: text.slice(0, 80) });
      foods = null; protein_g = null; calories = null;
    }
    return { foods, protein_g, calories };
  } catch (e) {
    logger.warn({ err: e instanceof Error ? e.message : String(e) }, 'nudge_food.extract_failed');
    return { ...EMPTY };
  }
}
