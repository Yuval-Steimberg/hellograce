import { createHash } from 'crypto';
import type { Pool } from 'pg';
import type { Logger } from 'pino';
import type { LLMProvider } from '@grace/shared';
import type { Tool } from '@grace/ai-core';
import type { UsdaFoodService } from '../services/usda-food.service.js';

interface FoodEstimate {
  food: string;
  protein_g: number;
  calories: number;
  confidence: 'low' | 'medium' | 'high';
}

const FOOD_SYSTEM_PROMPT = `You estimate protein and calories from a casual food description. Use USDA-anchored values.

DECOMPOSITION RULE — CRITICAL:
If the description has multiple items (joined by "and", "with", "plus", commas), DECOMPOSE first, look each up, then SUM. Never match a compound description to a single anchor.

Examples:
  "salad and an omelet with 2 eggs" → salad (3g, 100kcal) + 2-egg omelet (12g, 180kcal) = 15g, 280kcal
  "chicken and rice" → 30g, 450kcal (matches anchor directly)
  "yogurt with granola and banana" → Greek yogurt (17g) + granola (4g) + banana (1g) = 22g, 360kcal
  "toast with peanut butter" → toast (3g) + PB 2tbsp (8g) = 11g, 270kcal

KEY ANCHORS (per serving):
  1 egg=6g/70kcal | 2 eggs/omelet=12g/180kcal | 3 eggs/omelet=18g/270kcal
  chicken 4oz=30g/180kcal | salmon 5oz=28g/280kcal | tuna 1can=20g/110kcal
  steak 5oz=35g/350kcal | ground beef 4oz=22g/280kcal | shrimp 4oz=24g/100kcal
  Greek yogurt 1cup=17g/100kcal | cottage cheese 1/2cup=14g/100kcal
  tofu 4oz=10g/80kcal | black beans 1/2cup=8g/110kcal | lentils 1/2cup=9g/115kcal
  peanut butter 2tbsp=8g/190kcal | almonds 1oz=6g/165kcal | hummus 1/4cup=4g/100kcal
  salad plain=3g/100kcal | big salad with veggies=4g/130kcal | broccoli 1cup=2g/30kcal
  rice 1cup=4g/200kcal | quinoa 1cup=8g/220kcal | oatmeal 1cup=6g/150kcal
  toast 1slice=3g/80kcal | bagel=10g/280kcal | pasta plain=8g/220kcal
  banana/apple/orange=1g/80kcal | berries 1cup=1g/85kcal
  protein shake=25g/130kcal | smoothie with protein=18g/280kcal
  sandwich deli=22g/450kcal | wrap=25g/480kcal | pizza 2 slices=22g/540kcal
  burrito=22g/600kcal | sushi roll=12g/250kcal | snack plate (cheese+nuts)=12g/300kcal
  coffee/tea=0g/5kcal

NEVER refuse. NEVER ask for grams or portions. NEVER return 0g for a real food.
Return ONLY this JSON, nothing else: {"food":"<label>","protein_g":<int>,"calories":<int>,"confidence":"low|medium|high"}`;

const RETRY_PROMPT = `Return ONLY valid JSON for this food description. Estimate using common sense.
Format: {"food":"<short label>","protein_g":<integer>,"calories":<integer>,"confidence":"medium"}`;

// Decomposition-only prompt for the USDA path. The LLM splits the description
// into items + estimated grams; USDA provides the actual per-100g constants.
const DECOMPOSE_SYSTEM_PROMPT = `You decompose a casual food description into items with estimated weights in grams.

DECOMPOSITION RULE:
Split compound descriptions ("salad and 2 eggs", "chicken with rice") into separate items. Estimate each item's weight in grams using common portion sizes:
  1 egg = 50g | 1 slice toast = 30g | 1 cup rice cooked = 160g | 1 cup pasta cooked = 140g
  4oz chicken = 113g | 5oz salmon = 142g | 4oz beef = 113g | 4oz tofu = 113g
  1 cup Greek yogurt = 245g | 1/2 cup cottage cheese = 113g | 1 cup oatmeal = 234g
  1 medium banana = 118g | 1 medium apple = 182g | 1 cup berries = 145g
  1 typical salad = 150g | 1 cup cooked vegetables = 150g
  1 slice pizza = 110g | 1 burrito = 350g | 1 sandwich = 220g | 1 wrap = 230g
  1 protein shake = 240g | 1 smoothie = 350g | 1 tablespoon peanut butter = 16g

NEVER ask the user for quantities. ALWAYS estimate.

Output ONLY a JSON object: {"items":[{"name":"<short USDA-searchable name>","grams":<int>},...]}
- Use generic searchable names ("chicken breast", "white rice", "olive oil") not branded names
- Cap at 6 items
- Round grams to nearest 10`;

interface DecomposedItem {
  name: string;
  grams: number;
}

async function decomposeFood(llm: LLMProvider, food: string): Promise<DecomposedItem[] | null> {
  try {
    const resp = await llm.generate({
      messages: [
        { role: 'system', content: DECOMPOSE_SYSTEM_PROMPT },
        { role: 'user', content: food },
      ],
      temperature: 0.1,
      maxOutputTokens: 400,
      responseFormat: 'json',
    });
    const cleaned = resp.text.replace(/```json\n?|\n?```/g, '').trim();
    const obj = JSON.parse(cleaned) as { items?: DecomposedItem[] };
    if (!obj.items || !Array.isArray(obj.items) || obj.items.length === 0) return null;
    return obj.items
      .filter((i) => typeof i?.name === 'string' && typeof i?.grams === 'number' && i.grams > 0)
      .slice(0, 6)
      .map((i) => ({ name: i.name.trim(), grams: Math.round(i.grams) }));
  } catch {
    return null;
  }
}

/**
 * USDA-first estimation. Decomposes the food string into items + grams via
 * LLM, looks up each item in USDA, multiplies, sums. Returns null if any
 * item misses USDA (caller falls back to the legacy LLM-only estimate).
 */
async function estimateViaUsda(
  llm: LLMProvider,
  usda: UsdaFoodService,
  food: string,
): Promise<FoodEstimate | null> {
  if (!usda.enabled()) return null;
  const items = await decomposeFood(llm, food);
  if (!items || items.length === 0) return null;

  let totalProtein = 0;
  let totalCalories = 0;
  let allMatched = true;
  const matchedNames: string[] = [];

  for (const item of items) {
    const lookup = await usda.lookup(item.name);
    if (!lookup) {
      allMatched = false;
      break;
    }
    const factor = item.grams / 100;
    totalProtein += lookup.proteinPer100g * factor;
    totalCalories += lookup.caloriesPer100g * factor;
    matchedNames.push(lookup.display);
  }

  if (!allMatched) return null;

  return {
    food: matchedNames.join(' + '),
    protein_g: Math.max(0, Math.round(totalProtein)),
    calories: Math.max(0, Math.round(totalCalories)),
    confidence: 'high',
  };
}

async function estimateFoodMacros(llm: LLMProvider, food: string): Promise<FoodEstimate | null> {
  // Primary attempt with the full anchor table.
  const resp = await llm.generate({
    messages: [
      { role: 'system', content: FOOD_SYSTEM_PROMPT },
      { role: 'user', content: food },
    ],
    temperature: 0.1,
    maxOutputTokens: 500,
    responseFormat: 'json',
  });
  const primary = parseFoodEstimate(resp.text);
  if (primary && primary.protein_g > 0 && primary.calories > 0) return primary;

  // Retry once with a minimal prompt — long prompts + JSON mode sometimes
  // produce empty output on Gemini Flash. Defensive second attempt.
  const retry = await llm.generate({
    messages: [
      { role: 'system', content: RETRY_PROMPT },
      { role: 'user', content: food },
    ],
    temperature: 0.2,
    maxOutputTokens: 200,
    responseFormat: 'json',
  });
  return parseFoodEstimate(retry.text);
}

function parseFoodEstimate(raw: string): FoodEstimate | null {
  try {
    const cleaned = raw.replace(/```json\n?|\n?```/g, '').trim();
    const obj = JSON.parse(cleaned) as Partial<FoodEstimate>;
    if (
      typeof obj.food !== 'string' ||
      typeof obj.protein_g !== 'number' ||
      typeof obj.calories !== 'number'
    ) {
      return null;
    }
    return {
      food: obj.food,
      protein_g: Math.max(0, Math.round(obj.protein_g)),
      calories: Math.max(0, Math.round(obj.calories)),
      confidence: ['low', 'medium', 'high'].includes(obj.confidence as string)
        ? (obj.confidence as 'low' | 'medium' | 'high')
        : 'medium',
    };
  } catch {
    return null;
  }
}

/**
 * log_food: estimate protein/calories for a food the user mentioned and
 * persist a `food_logs` row.
 *
 * Day-boundary correctness: created_at is now() — the user's "today" total
 * is then computed by getTodaysFoodSummary using the user-local timezone,
 * so the same row always counts toward the correct calendar day.
 *
 * Deduplication: a 60-second dedupe_key prevents webhook retries, image
 * re-analysis, and accidental double-sends from logging the same meal twice.
 * Same user + same raw_text + same minute → single row.
 */
export function makeLogFoodTool(deps: {
  pool: Pool;
  llm: LLMProvider;
  logger: Logger;
  userId: string;
  /** Where this log originated. Defaults to 'text'. Set 'image' or 'voice' upstream. */
  source?: 'text' | 'image' | 'voice';
  /** Optional USDA service. When present and the API key is set, USDA is
   *  consulted first; LLM-only estimation is used as a fallback for novel
   *  or compound items USDA can't match. */
  usda?: UsdaFoodService;
}): Tool {
  return {
    name: 'log_food',
    description: 'Log a food item with estimated protein/calories.',
    async execute(args) {
      const food = typeof args['food'] === 'string' ? (args['food'] as string).trim() : '';
      if (!food) return { ok: false, error: 'no_food_provided' };

      // USDA-first path: decompose with LLM, look up per-100g constants from
      // USDA, multiply + sum. Falls back to the legacy LLM-only estimate when
      // the USDA service isn't configured or any item misses a USDA match.
      let parsed: FoodEstimate | null = null;
      let estimateSource: 'usda' | 'llm' = 'llm';
      if (deps.usda && deps.usda.enabled()) {
        const usdaResult = await estimateViaUsda(deps.llm, deps.usda, food).catch(() => null);
        if (usdaResult) {
          parsed = usdaResult;
          estimateSource = 'usda';
        }
      }
      if (!parsed) parsed = await estimateFoodMacros(deps.llm, food);
      if (!parsed) return { ok: false, error: 'estimate_parse_failed' };
      deps.logger.info({ userId: deps.userId, source: estimateSource, food: parsed.food }, 'tool.log_food.estimate_source');

      // Dedupe key: same user + same normalized raw text + same minute → one row.
      // Tolerates webhook retries (<30s typical) and image re-uploads without
      // blocking legitimate "had eggs again later" entries (>1min apart).
      const minuteBucket = Math.floor(Date.now() / 60_000);
      const normalized = food.toLowerCase().replace(/\s+/g, ' ').trim();
      const dedupeKey = createHash('sha256')
        .update(`${deps.userId}|${normalized}|${minuteBucket}`)
        .digest('hex')
        .slice(0, 32);

      const source = deps.source ?? 'text';
      const result = await deps.pool.query<{ id: string }>(
        `INSERT INTO food_logs (user_id, food, protein_g, calories, confidence, raw_text, source, dedupe_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
         RETURNING id`,
        [deps.userId, parsed.food, parsed.protein_g, parsed.calories, parsed.confidence, food, source, dedupeKey],
      );

      const wasDuplicate = result.rowCount === 0;
      if (wasDuplicate) {
        deps.logger.info(
          { userId: deps.userId, food: parsed.food, source },
          'tool.log_food.deduped',
        );
        // Return the parsed estimate so the LLM can still reference it conversationally,
        // but mark deduped so callers know not to re-add to running totals.
        return { ...parsed, deduped: true };
      }

      // Query the live daily running total AFTER the insert so Grace reports
      // the correct cumulative number, not the stale pre-turn system-prompt snapshot.
      const totalsResult = await deps.pool.query<{ total_protein_g: number; total_calories: number }>(
        `WITH user_tz AS (
           SELECT COALESCE(NULLIF(timezone, ''), 'UTC') AS tz
           FROM users WHERE phone = $1
         )
         SELECT COALESCE(SUM(fl.protein_g), 0) AS total_protein_g,
                COALESCE(SUM(fl.calories), 0) AS total_calories
         FROM food_logs fl, user_tz
         WHERE fl.user_id = $1
           AND (fl.created_at AT TIME ZONE user_tz.tz - INTERVAL '5 hours')::date
               = (now()        AT TIME ZONE user_tz.tz - INTERVAL '5 hours')::date`,
        [deps.userId],
      );
      const dailyProteinG = Math.round(totalsResult.rows[0]?.total_protein_g ?? 0);
      const dailyCalories = Math.round(totalsResult.rows[0]?.total_calories ?? 0);

      deps.logger.info(
        { userId: deps.userId, food: parsed.food, protein: parsed.protein_g, dailyProteinG, source },
        'tool.log_food.ok',
      );
      return { ...parsed, daily_protein_g: dailyProteinG, daily_calories: dailyCalories };
    },
  };
}
