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

const FOOD_SYSTEM_PROMPT = `You estimate protein and calories for each distinct food item the user mentioned. Use USDA-anchored values.

DECOMPOSITION RULE — CRITICAL:
You MUST emit ONE entry per distinct food item.
  "3 eggs with salad, tuna, rice" → 4 items: eggs / salad / tuna / rice
  "salad and an omelet with 2 eggs" → 2 items: salad + 2-egg omelet
  "yogurt with granola and banana" → 3 items: Greek yogurt + granola + banana
  "toast with peanut butter" → 2 items: toast + peanut butter
  "a burrito" → 1 item (compound dish): burrito
  "a sandwich" → 1 item: sandwich

The server sums your per-item values, so a missing item = a silent undercount. DO NOT collapse multiple foods into a single item.

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
Output the JSON matching the provided schema. Server sums totals.`;

const RETRY_PROMPT = `Decompose this food description into per-item protein and calories. Each distinct item = one entry.
Estimate using common sense; never refuse. The server sums per-item values.`;

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

  // Parallel per-item USDA lookups — each lookup is independent so we fan
  // them out via Promise.all instead of awaiting in a serial for-loop.
  // Saves ~150–300ms per multi-item meal (a 4-item meal goes from
  // 4 × 80ms serial → ~100ms concurrent). If ANY item misses USDA we
  // still fall through to the LLM-only estimate, same as before.
  const lookups = await Promise.all(items.map((item) => usda.lookup(item.name)));
  if (lookups.some((l) => !l)) return null;

  let totalProtein = 0;
  let totalCalories = 0;
  const matchedNames: string[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    const lookup = lookups[i]!;
    const factor = item.grams / 100;
    totalProtein += lookup.proteinPer100g * factor;
    totalCalories += lookup.caloriesPer100g * factor;
    matchedNames.push(lookup.display);
  }

  return {
    food: matchedNames.join(' + '),
    protein_g: Math.max(0, Math.round(totalProtein)),
    calories: Math.max(0, Math.round(totalCalories)),
    confidence: 'high',
  };
}

// 2026-06-04 structural fix (Option B): force the LLM to emit a typed
// items array, then SUM on the server. Eliminates the silent undercount
// class — production failure was "3 eggs with salad, Tuna, Rice" → 45g
// (real ~55g) because the model returned a flat estimate without
// decomposing. The schema forces decomposition because `items` is required
// and validated as a non-empty array.
const FOOD_ITEMS_SCHEMA: import('@grace/shared').ResponseSchema = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Short food label (e.g. "3 eggs", "1 can tuna", "1 cup rice")' },
          protein_g: { type: 'integer', description: 'Estimated grams of protein for THIS item only' },
          calories: { type: 'integer', description: 'Estimated calories for THIS item only' },
        },
        required: ['name', 'protein_g', 'calories'],
      },
      description:
        'EACH distinct food item gets its own entry. If user says "eggs and toast", emit 2 items, not 1. Compound dishes (a burrito, a sandwich) count as ONE item.',
    },
    confidence: {
      type: 'string',
      enum: ['low', 'medium', 'high'],
      description: 'Overall confidence in the estimate (low if portions are very ambiguous)',
    },
  },
  required: ['items', 'confidence'],
};

interface ItemizedEstimate {
  items: Array<{ name: string; protein_g: number; calories: number }>;
  confidence: 'low' | 'medium' | 'high';
}

async function estimateFoodMacros(llm: LLMProvider, food: string): Promise<FoodEstimate | null> {
  // Primary attempt with full anchor table + structured-output schema.
  // The schema GUARANTEES the response is `{items: [...], confidence: ...}`
  // — Gemini's responseSchema enforces shape at the API boundary. We sum
  // on the server, so even if the model gives a per-item estimate that
  // doesn't add up cleanly, the total is internally consistent.
  const resp = await llm.generate({
    messages: [
      { role: 'system', content: FOOD_SYSTEM_PROMPT },
      { role: 'user', content: food },
    ],
    temperature: 0.1,
    maxOutputTokens: 600,
    responseSchema: FOOD_ITEMS_SCHEMA,
  });
  const primary = parseItemizedEstimate(resp.text);
  if (primary) {
    const summed = sumItemized(primary, food);
    if (summed && summed.protein_g > 0 && summed.calories > 0) return summed;
  }

  // Retry once with a minimal prompt — long prompts + JSON mode sometimes
  // produce empty output on Gemini Flash. Same schema; smaller prompt.
  const retry = await llm.generate({
    messages: [
      { role: 'system', content: RETRY_PROMPT },
      { role: 'user', content: food },
    ],
    temperature: 0.2,
    maxOutputTokens: 300,
    responseSchema: FOOD_ITEMS_SCHEMA,
  });
  const retryParsed = parseItemizedEstimate(retry.text);
  if (retryParsed) {
    const summed = sumItemized(retryParsed, food);
    if (summed) return summed;
  }
  return null;
}

function parseItemizedEstimate(raw: string): ItemizedEstimate | null {
  try {
    const cleaned = raw.replace(/```json\n?|\n?```/g, '').trim();
    if (!cleaned) return null;
    const obj = JSON.parse(cleaned) as Partial<ItemizedEstimate>;
    if (!Array.isArray(obj.items) || obj.items.length === 0) return null;
    const validItems = obj.items
      .filter((i): i is { name: string; protein_g: number; calories: number } =>
        i !== null && typeof i === 'object' &&
        typeof i.name === 'string' && i.name.trim().length > 0 &&
        typeof i.protein_g === 'number' && Number.isFinite(i.protein_g) &&
        typeof i.calories === 'number' && Number.isFinite(i.calories)
      )
      .map((i) => ({
        name: i.name.trim(),
        protein_g: Math.max(0, Math.round(i.protein_g)),
        calories: Math.max(0, Math.round(i.calories)),
      }));
    if (validItems.length === 0) return null;
    const conf = ['low', 'medium', 'high'].includes(obj.confidence as string)
      ? (obj.confidence as 'low' | 'medium' | 'high')
      : 'medium';
    return { items: validItems, confidence: conf };
  } catch {
    return null;
  }
}

/** Server-side sum. The single source of truth for totals — even if the
 *  model emits a separate "total" field we ignore it and re-sum locally. */
function sumItemized(itemized: ItemizedEstimate, originalFood: string): FoodEstimate | null {
  const protein = itemized.items.reduce((s, i) => s + i.protein_g, 0);
  const calories = itemized.items.reduce((s, i) => s + i.calories, 0);
  if (protein === 0 && calories === 0) return null;
  // Label: when ≥2 items, joining them gives the user a clean readout
  // ("3 eggs + tuna + rice"). When 1 item, use the original food string
  // as-is so we don't reduce "Greek yogurt with hemp seeds" to "yogurt".
  const label = itemized.items.length === 1
    ? (itemized.items[0]!.name || originalFood)
    : itemized.items.map((i) => i.name).join(' + ');
  return {
    food: label,
    protein_g: Math.max(0, Math.round(protein)),
    calories: Math.max(0, Math.round(calories)),
    confidence: itemized.confidence,
  };
}

// parseFoodEstimate (flat shape) was replaced by parseItemizedEstimate +
// sumItemized when we moved to structured per-item output (2026-06-04).
// Removed to keep the file lean.

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
  /** Optional — invalidated after every successful INSERT so the next
   *  prompt build reads the fresh totals instead of a stale 10s cache. */
  users?: { invalidateTodaysFoodCache: (userId: string) => void };
}): Tool {
  return {
    name: 'log_food',
    description: 'Log a food item with estimated protein/calories.',
    async execute(args) {
      const food = typeof args['food'] === 'string' ? (args['food'] as string).trim() : '';
      if (!food) return { ok: false, error: 'no_food_provided' };

      // Pre-process: strip greeting prefixes ("Hey, ...", "Good morning,
      // ...") that confuse the LLM estimator. Production failure 2026-06-01:
      // user sent "Hey\nFor breakfast i ate 2 eggs..." → 0g logged because
      // "Hey" derailed estimation.
      const cleanedFood = food
        .replace(/^(hey|hi|hello|yo|hiya|good\s+(morning|afternoon|evening|night))[,!.\s]+/i, '')
        .replace(/^(so|ok|okay|um|uh)[,!.\s]+/i, '')
        .trim();
      const foodForEstimate = cleanedFood.length >= 3 ? cleanedFood : food;

      // FAST PATH (NEW 2026-06-01): exact-match the food string against
      // ~80 hand-curated USDA-anchored entries. Saves ~1-2s per log on
      // common foods. Falls through to LLM + USDA on miss.
      let parsed: FoodEstimate | null = lookupCommonFoodMacros(foodForEstimate);
      let estimateSource: 'usda' | 'llm' | 'fast_lookup' = 'llm';
      if (parsed) {
        estimateSource = 'fast_lookup';
        deps.logger.info(
          { userId: deps.userId, food: parsed.food, originalText: food.slice(0, 80) },
          'tool.log_food.fast_lookup_hit',
        );
      }

      // USDA-first path: decompose with LLM, look up per-100g constants from
      // USDA, multiply + sum. Falls back to the legacy LLM-only estimate when
      // the USDA service isn't configured or any item misses a USDA match.
      if (!parsed && deps.usda && deps.usda.enabled()) {
        const usdaResult = await estimateViaUsda(deps.llm, deps.usda, foodForEstimate).catch(() => null);
        if (usdaResult) {
          parsed = usdaResult;
          estimateSource = 'usda';
        }
      }
      if (!parsed) parsed = await estimateFoodMacros(deps.llm, foodForEstimate);
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
      // Invalidate today's food summary cache so the immediately-following
      // prompt build / response includes this new entry (cache TTL is 10s,
      // so without explicit invalidation a quick "what's my total?" follow-
      // up would miss the just-logged item).
      if (!wasDuplicate) {
        deps.users?.invalidateTodaysFoodCache(deps.userId);
      }
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
      // 2026-06-04: explicit field names so the LLM can't misread. Production
      // failure: tool returned `daily_protein_g: 35` but the LLM ignored it
      // and used the pre-log "Total protein TODAY: 0g" from system context,
      // saying "still at 0g for the day" right after logging 35g.
      // The verbose field names below are picked specifically so the LLM
      // physically cannot use the wrong number.
      return {
        ...parsed,
        // Pre-existing fields kept for backward compatibility with any code
        // that reads them. New verbose fields are the source of truth.
        daily_protein_g: dailyProteinG,
        daily_calories: dailyCalories,
        // Explicit, unmistakable field names — the LLM MUST use these.
        this_log_protein_g: parsed.protein_g,
        this_log_calories: parsed.calories,
        daily_protein_g_after_this_log: dailyProteinG,
        daily_calories_after_this_log: dailyCalories,
        instruction_to_grace:
          'When you write the user-facing reply, the running total for today is daily_protein_g_after_this_log. Do not use any older total from the system context block. Compute: "You\'re at " + daily_protein_g_after_this_log + "g today."',
      };
    },
  };
}

// ── Fast macro lookup (2026-06-01 latency + accuracy pass) ─────────────────
// Hand-curated table of ~80 common foods with their USDA-anchored macros.
// Skips the LLM call entirely on a hit — saves ~1-2s per log for the most
// common entries. Values follow USDA FoodData Central per typical serving.
//
// Match logic: normalize the input (lowercase, strip punctuation, collapse
// whitespace, drop articles + meal-context words like "for breakfast"),
// then try exact match, then substring containment of any table key.
//
// The table is INTENTIONALLY conservative — only foods where the protein
// estimate is uncontroversial. Anything compound ("chicken sandwich",
// "veggie wrap") falls through to the LLM estimator which can decompose.

interface CommonMacros {
  food: string;
  protein_g: number;
  calories: number;
}

const COMMON_FOODS: Record<string, CommonMacros> = {
  // Eggs (per egg = 6g protein / 70 kcal)
  '1 egg':                   { food: '1 egg', protein_g: 6, calories: 70 },
  '2 eggs':                  { food: '2 eggs', protein_g: 12, calories: 140 },
  '3 eggs':                  { food: '3 eggs', protein_g: 18, calories: 210 },
  '4 eggs':                  { food: '4 eggs', protein_g: 24, calories: 280 },
  'egg':                     { food: '1 egg', protein_g: 6, calories: 70 },
  'eggs':                    { food: '2 eggs', protein_g: 12, calories: 140 },
  'hard boiled egg':         { food: '1 hard-boiled egg', protein_g: 6, calories: 70 },
  'scrambled eggs':          { food: 'scrambled eggs (2)', protein_g: 12, calories: 180 },
  '2 egg omelet':            { food: '2-egg omelet', protein_g: 12, calories: 180 },
  '3 egg omelet':            { food: '3-egg omelet', protein_g: 18, calories: 270 },
  // Chicken (4 oz / 113 g = 30 g protein / 180 kcal)
  'chicken breast':          { food: 'chicken breast (4oz)', protein_g: 30, calories: 180 },
  '1 chicken breast':        { food: '1 chicken breast', protein_g: 30, calories: 180 },
  'grilled chicken':         { food: 'grilled chicken (4oz)', protein_g: 30, calories: 180 },
  'baked chicken':           { food: 'baked chicken (4oz)', protein_g: 30, calories: 180 },
  'chicken':                 { food: 'chicken (4oz)', protein_g: 30, calories: 180 },
  // Fish
  'salmon':                  { food: 'salmon (5oz)', protein_g: 28, calories: 280 },
  'grilled salmon':          { food: 'grilled salmon (5oz)', protein_g: 28, calories: 280 },
  'tuna':                    { food: 'tuna (1 can)', protein_g: 20, calories: 110 },
  'can of tuna':             { food: '1 can tuna', protein_g: 20, calories: 110 },
  'shrimp':                  { food: 'shrimp (4oz)', protein_g: 24, calories: 100 },
  // Beef / pork
  'steak':                   { food: 'steak (5oz)', protein_g: 35, calories: 350 },
  'ground beef':             { food: 'ground beef (4oz)', protein_g: 22, calories: 280 },
  // Dairy & high-protein
  'greek yogurt':            { food: 'Greek yogurt (1 cup)', protein_g: 17, calories: 100 },
  'cup of greek yogurt':     { food: 'Greek yogurt (1 cup)', protein_g: 17, calories: 100 },
  'cottage cheese':          { food: 'cottage cheese (1/2 cup)', protein_g: 14, calories: 100 },
  'yogurt':                  { food: 'yogurt (1 cup)', protein_g: 8, calories: 130 },
  // Plant-based
  'tofu':                    { food: 'tofu (4oz)', protein_g: 10, calories: 80 },
  'tempeh':                  { food: 'tempeh (3oz)', protein_g: 15, calories: 160 },
  'edamame':                 { food: 'edamame (1 cup shelled)', protein_g: 17, calories: 190 },
  'black beans':             { food: 'black beans (1/2 cup)', protein_g: 8, calories: 110 },
  'lentils':                 { food: 'lentils (1/2 cup)', protein_g: 9, calories: 115 },
  'chickpeas':               { food: 'chickpeas (1/2 cup)', protein_g: 7, calories: 110 },
  'hummus':                  { food: 'hummus (1/4 cup)', protein_g: 4, calories: 100 },
  'peanut butter':           { food: 'peanut butter (2 tbsp)', protein_g: 8, calories: 190 },
  'almonds':                 { food: 'almonds (1 oz)', protein_g: 6, calories: 165 },
  // Carbs (low protein)
  'rice':                    { food: 'rice (1 cup)', protein_g: 4, calories: 200 },
  'cup of rice':             { food: 'rice (1 cup)', protein_g: 4, calories: 200 },
  'quinoa':                  { food: 'quinoa (1 cup)', protein_g: 8, calories: 220 },
  'oatmeal':                 { food: 'oatmeal (1 cup)', protein_g: 6, calories: 150 },
  'pasta':                   { food: 'pasta plain (1 cup)', protein_g: 8, calories: 220 },
  'toast':                   { food: 'toast (1 slice)', protein_g: 3, calories: 80 },
  '1 slice of toast':        { food: '1 slice of toast', protein_g: 3, calories: 80 },
  '2 slices of toast':       { food: '2 slices of toast', protein_g: 6, calories: 160 },
  'bagel':                   { food: 'bagel', protein_g: 10, calories: 280 },
  // Veggies (low protein, log accurately so totals make sense)
  'broccoli':                { food: 'broccoli (1 cup)', protein_g: 2, calories: 30 },
  'spinach':                 { food: 'spinach (1 cup raw)', protein_g: 1, calories: 7 },
  'salad':                   { food: 'salad plain', protein_g: 3, calories: 100 },
  'side salad':              { food: 'side salad', protein_g: 3, calories: 100 },
  // Fruit
  'banana':                  { food: 'banana', protein_g: 1, calories: 110 },
  'apple':                   { food: 'apple', protein_g: 0, calories: 95 },
  'orange':                  { food: 'orange', protein_g: 1, calories: 65 },
  'berries':                 { food: 'berries (1 cup)', protein_g: 1, calories: 85 },
  'strawberries':            { food: 'strawberries (1 cup)', protein_g: 1, calories: 50 },
  'blueberries':             { food: 'blueberries (1 cup)', protein_g: 1, calories: 85 },
  // Shakes / drinks
  'protein shake':           { food: 'protein shake (1 scoop)', protein_g: 25, calories: 130 },
  '1 scoop protein':         { food: 'protein (1 scoop)', protein_g: 25, calories: 130 },
  'whey protein':            { food: 'whey protein (1 scoop)', protein_g: 25, calories: 130 },
  'protein smoothie':        { food: 'protein smoothie', protein_g: 18, calories: 280 },
  'smoothie':                { food: 'smoothie', protein_g: 6, calories: 200 },
  'coffee':                  { food: 'coffee', protein_g: 0, calories: 5 },
  'black coffee':            { food: 'black coffee', protein_g: 0, calories: 5 },
  'latte':                   { food: 'latte (12oz)', protein_g: 8, calories: 150 },
  'cappuccino':              { food: 'cappuccino', protein_g: 6, calories: 80 },
  'tea':                     { food: 'tea', protein_g: 0, calories: 0 },
  // Compound meals — single-anchor entries for things that come together
  'chicken and rice':        { food: 'chicken (4oz) + rice (1 cup)', protein_g: 34, calories: 380 },
  'chicken with rice':       { food: 'chicken (4oz) + rice (1 cup)', protein_g: 34, calories: 380 },
  'chicken breast with rice':{ food: 'chicken breast + rice', protein_g: 34, calories: 380 },
  'salmon and rice':         { food: 'salmon (5oz) + rice (1 cup)', protein_g: 32, calories: 480 },
  'eggs and toast':          { food: '2 eggs + toast', protein_g: 15, calories: 220 },
  'eggs and bacon':          { food: '2 eggs + 2 strips bacon', protein_g: 18, calories: 220 },
  // Fast food
  'big mac':                 { food: 'Big Mac', protein_g: 25, calories: 590 },
  'cheeseburger':            { food: 'cheeseburger', protein_g: 18, calories: 320 },
  'fries':                   { food: 'fries (medium)', protein_g: 4, calories: 380 },
  // Pizza
  'pizza':                   { food: 'pizza (2 slices)', protein_g: 22, calories: 540 },
  '2 slices of pizza':       { food: 'pizza (2 slices)', protein_g: 22, calories: 540 },
  '1 slice of pizza':        { food: 'pizza (1 slice)', protein_g: 11, calories: 270 },

  // ── Phase-16 latency expansion (2026-06-03) ─────────────────────────────
  // Hand-curated, USDA-anchored. Bumps fast-path hit rate from ~40% → ~60–70%.
  // Each entry skips the ~1.5–3.5 s log_food LLM macro chain entirely.

  // High-protein snacks / dairy / packaged
  'plain greek yogurt':      { food: 'plain Greek yogurt (1 cup)', protein_g: 17, calories: 100 },
  'fage':                    { food: 'Fage Greek yogurt (1 cup)', protein_g: 18, calories: 120 },
  'chobani':                 { food: 'Chobani Greek yogurt (1 cup)', protein_g: 14, calories: 140 },
  'oikos':                   { food: 'Oikos Triple Zero (1 cup)', protein_g: 15, calories: 120 },
  'two good':                { food: 'Two Good Greek yogurt (1 cup)', protein_g: 12, calories: 80 },
  'skyr':                    { food: 'skyr (1 cup)', protein_g: 17, calories: 110 },
  'cottage cheese 1 cup':    { food: 'cottage cheese (1 cup)', protein_g: 28, calories: 200 },
  '1 cup cottage cheese':    { food: 'cottage cheese (1 cup)', protein_g: 28, calories: 200 },
  'string cheese':           { food: 'string cheese (1 stick)', protein_g: 7, calories: 80 },
  'cheese stick':            { food: 'cheese stick', protein_g: 7, calories: 80 },
  'babybel':                 { food: 'Babybel cheese', protein_g: 5, calories: 70 },
  // Note: bare "cheddar" / "feta" intentionally excluded — they appear as
  // ingredients in many compound foods (e.g. "cheddar chickpea bake") and
  // would cause the substring matcher to over-trigger. Users say
  // "cheddar cheese" or "1 oz cheddar" if they want to log it standalone,
  // and those still flow to the LLM macro estimator for an accurate number.
  'milk':                    { food: 'milk (1 cup)', protein_g: 8, calories: 130 },
  'glass of milk':           { food: 'milk (1 cup)', protein_g: 8, calories: 130 },
  'almond milk':             { food: 'almond milk (1 cup)', protein_g: 1, calories: 40 },
  'oat milk':                { food: 'oat milk (1 cup)', protein_g: 3, calories: 120 },
  'soy milk':                { food: 'soy milk (1 cup)', protein_g: 7, calories: 100 },
  'kefir':                   { food: 'kefir (1 cup)', protein_g: 11, calories: 110 },

  // Branded protein bars
  'quest bar':               { food: 'Quest bar', protein_g: 20, calories: 200 },
  'rxbar':                   { food: 'RXBAR', protein_g: 12, calories: 210 },
  'rx bar':                  { food: 'RXBAR', protein_g: 12, calories: 210 },
  'built bar':               { food: 'Built Bar', protein_g: 18, calories: 130 },
  'one bar':                 { food: 'ONE Bar', protein_g: 20, calories: 210 },
  'cliff bar':               { food: 'Clif Bar', protein_g: 9, calories: 240 },
  'clif bar':                { food: 'Clif Bar', protein_g: 9, calories: 240 },
  'kind bar':                { food: 'KIND bar', protein_g: 6, calories: 200 },
  'pure protein bar':        { food: 'Pure Protein bar', protein_g: 20, calories: 200 },
  'think bar':               { food: 'Think! protein bar', protein_g: 20, calories: 240 },
  'protein bar':             { food: 'protein bar', protein_g: 20, calories: 210 },

  // Branded shakes / RTD protein drinks
  'fairlife':                { food: 'Fairlife Core Power (14oz)', protein_g: 26, calories: 170 },
  'core power':              { food: 'Core Power shake', protein_g: 26, calories: 170 },
  'premier protein':         { food: 'Premier Protein shake', protein_g: 30, calories: 160 },
  'orgain':                  { food: 'Orgain protein shake', protein_g: 20, calories: 150 },
  'ensure':                  { food: 'Ensure (8oz)', protein_g: 9, calories: 220 },
  'muscle milk':             { food: 'Muscle Milk shake', protein_g: 25, calories: 160 },

  // Tuna / jerky / packaged protein
  'tuna packet':             { food: 'tuna packet (2.6oz)', protein_g: 17, calories: 70 },
  'starkist packet':         { food: 'StarKist tuna packet', protein_g: 17, calories: 70 },
  'salmon packet':           { food: 'salmon packet (2.6oz)', protein_g: 14, calories: 90 },
  'sardines':                { food: 'sardines (1 can)', protein_g: 22, calories: 190 },
  'turkey jerky':            { food: 'turkey jerky (1 oz)', protein_g: 12, calories: 80 },
  'beef jerky':              { food: 'beef jerky (1 oz)', protein_g: 9, calories: 80 },
  'chomps':                  { food: 'Chomps meat stick', protein_g: 9, calories: 100 },

  // Common breakfasts
  'oatmeal with berries':    { food: 'oatmeal + berries', protein_g: 7, calories: 220 },
  'oatmeal with peanut butter': { food: 'oatmeal + peanut butter', protein_g: 14, calories: 340 },
  'overnight oats':          { food: 'overnight oats (1 cup)', protein_g: 10, calories: 280 },
  'avocado toast':           { food: 'avocado toast (1 slice)', protein_g: 5, calories: 220 },
  'eggs and avocado':        { food: '2 eggs + avocado', protein_g: 15, calories: 320 },
  'eggs and toast and coffee': { food: '2 eggs + toast + coffee', protein_g: 15, calories: 220 },
  'yogurt with berries':     { food: 'Greek yogurt + berries', protein_g: 18, calories: 180 },
  'yogurt and granola':      { food: 'Greek yogurt + granola', protein_g: 18, calories: 280 },
  'cereal':                  { food: 'cereal with milk (1 cup)', protein_g: 10, calories: 250 },
  'pancakes':                { food: 'pancakes (2 medium)', protein_g: 8, calories: 220 },
  'waffle':                  { food: 'waffle', protein_g: 5, calories: 220 },
  'bacon':                   { food: 'bacon (2 strips)', protein_g: 6, calories: 80 },
  'sausage':                 { food: 'breakfast sausage (1 link)', protein_g: 5, calories: 90 },
  'breakfast sandwich':      { food: 'breakfast sandwich', protein_g: 18, calories: 380 },

  // Common lunches / dinners
  'chicken salad':           { food: 'chicken salad', protein_g: 25, calories: 350 },
  'tuna salad':              { food: 'tuna salad', protein_g: 22, calories: 320 },
  'turkey sandwich':         { food: 'turkey sandwich', protein_g: 22, calories: 380 },
  'ham sandwich':            { food: 'ham sandwich', protein_g: 18, calories: 360 },
  'grilled cheese':          { food: 'grilled cheese', protein_g: 11, calories: 380 },
  'caesar salad':            { food: 'Caesar salad', protein_g: 8, calories: 300 },
  'caesar salad with chicken': { food: 'Caesar salad + chicken', protein_g: 35, calories: 480 },
  'cobb salad':              { food: 'Cobb salad', protein_g: 30, calories: 480 },
  'burrito bowl':            { food: 'burrito bowl', protein_g: 30, calories: 600 },
  'chipotle bowl':           { food: 'Chipotle bowl', protein_g: 30, calories: 600 },
  'chicken wrap':            { food: 'chicken wrap', protein_g: 25, calories: 450 },
  'turkey wrap':             { food: 'turkey wrap', protein_g: 22, calories: 440 },
  'soup':                    { food: 'soup (1 cup)', protein_g: 6, calories: 180 },
  'chicken soup':            { food: 'chicken soup (1 cup)', protein_g: 8, calories: 150 },
  'chicken noodle soup':     { food: 'chicken noodle soup (1 cup)', protein_g: 7, calories: 150 },
  'tomato soup':             { food: 'tomato soup (1 cup)', protein_g: 4, calories: 160 },

  // Asian / takeout staples
  'sushi':                   { food: 'sushi (6 pieces)', protein_g: 14, calories: 300 },
  '6 pieces of sushi':       { food: 'sushi (6 pieces)', protein_g: 14, calories: 300 },
  'sushi roll':              { food: 'sushi roll', protein_g: 14, calories: 300 },
  'california roll':         { food: 'California roll', protein_g: 9, calories: 250 },
  'stir fry':                { food: 'stir fry', protein_g: 22, calories: 450 },
  'chicken stir fry':        { food: 'chicken stir fry', protein_g: 30, calories: 480 },
  'fried rice':              { food: 'fried rice (1 cup)', protein_g: 8, calories: 280 },
  'lo mein':                 { food: 'lo mein (1 cup)', protein_g: 10, calories: 320 },
  'pad thai':                { food: 'pad thai (1 serving)', protein_g: 16, calories: 500 },
  'pho':                     { food: 'pho (1 bowl)', protein_g: 25, calories: 380 },

  // Other proteins / sides
  'turkey':                  { food: 'turkey (4oz)', protein_g: 28, calories: 175 },
  'ground turkey':           { food: 'ground turkey (4oz)', protein_g: 22, calories: 170 },
  'pork chop':               { food: 'pork chop (5oz)', protein_g: 30, calories: 290 },
  'sweet potato':            { food: 'sweet potato (1 medium)', protein_g: 2, calories: 105 },
  'baked potato':            { food: 'baked potato (1 medium)', protein_g: 5, calories: 165 },
  'mashed potatoes':         { food: 'mashed potatoes (1 cup)', protein_g: 4, calories: 215 },
  'roasted veggies':         { food: 'roasted vegetables (1 cup)', protein_g: 4, calories: 130 },
  'cauliflower':             { food: 'cauliflower (1 cup)', protein_g: 2, calories: 30 },
  'brussels sprouts':        { food: 'Brussels sprouts (1 cup)', protein_g: 4, calories: 55 },
  'green beans':             { food: 'green beans (1 cup)', protein_g: 2, calories: 35 },
  'asparagus':               { food: 'asparagus (1 cup)', protein_g: 3, calories: 30 },
  'kale':                    { food: 'kale (1 cup)', protein_g: 2, calories: 35 },

  // Nuts / seeds
  'walnuts':                 { food: 'walnuts (1 oz)', protein_g: 4, calories: 185 },
  'cashews':                 { food: 'cashews (1 oz)', protein_g: 5, calories: 160 },
  'pistachios':              { food: 'pistachios (1 oz)', protein_g: 6, calories: 160 },
  'pumpkin seeds':           { food: 'pumpkin seeds (1 oz)', protein_g: 9, calories: 150 },
  'chia seeds':              { food: 'chia seeds (1 tbsp)', protein_g: 2, calories: 60 },
  'hemp seeds':              { food: 'hemp seeds (2 tbsp)', protein_g: 6, calories: 110 },
  'flax seeds':              { food: 'flax seeds (1 tbsp)', protein_g: 2, calories: 55 },
  'almond butter':           { food: 'almond butter (2 tbsp)', protein_g: 7, calories: 195 },

  // Fruit (round out the table for common entries)
  'peach':                   { food: 'peach', protein_g: 1, calories: 60 },
  'pear':                    { food: 'pear', protein_g: 1, calories: 100 },
  'grapes':                  { food: 'grapes (1 cup)', protein_g: 1, calories: 105 },
  'watermelon':              { food: 'watermelon (1 cup)', protein_g: 1, calories: 45 },
  'pineapple':               { food: 'pineapple (1 cup)', protein_g: 1, calories: 85 },
  'mango':                   { food: 'mango (1 cup)', protein_g: 1, calories: 100 },
  'avocado':                 { food: 'avocado (1 whole)', protein_g: 4, calories: 240 },

  // Drinks
  'green tea':               { food: 'green tea', protein_g: 0, calories: 0 },
  'iced coffee':             { food: 'iced coffee (black)', protein_g: 0, calories: 5 },
  'americano':               { food: 'americano', protein_g: 0, calories: 10 },
  'cold brew':               { food: 'cold brew (black)', protein_g: 0, calories: 5 },
  'matcha latte':            { food: 'matcha latte', protein_g: 7, calories: 130 },
  'kombucha':                { food: 'kombucha (16oz)', protein_g: 0, calories: 60 },
};

/**
 * Normalize a casual food string for fast-lookup matching:
 *   - lowercase
 *   - strip punctuation
 *   - strip greeting prefixes (already done upstream, but defensive)
 *   - strip "for breakfast/lunch/dinner/snack" suffix
 *   - strip articles + filler words ("just had", "I ate", "a", "the")
 *   - collapse whitespace
 */
/** Light normalization — keeps quantity + serving words intact so entries
 *  like "2 slices of pizza" and "1 chicken breast" match directly. */
function normalizeFoodForLookup(input: string): string {
  return input
    .toLowerCase()
    .replace(/[.!?,]/g, ' ')
    .replace(/^(hey|hi|hello|yo|hiya|good\s+(morning|afternoon|evening|night))\s+/i, '')
    .replace(/\b(for|at|this)\s+(breakfast|lunch|dinner|snack|brunch|today|morning|afternoon|evening|tonight)\b/g, ' ')
    .replace(/\b(i (?:just |already |i'?ve )?(?:had|ate|drank|grabbed|made|cooked|ordered|got|finished|tried|enjoyed))\b/g, ' ')
    .replace(/\b(just|already|i'?ve|i've)\b/g, ' ')
    .replace(/\b(had|ate|drank|grabbed|made|cooked|ordered|got|finished|tried|enjoyed|snacked|munched)\b/g, ' ')
    .replace(/\b(a|an|some|the|my)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Heavy normalization — additionally strips container/serving descriptors
 *  ("cup of", "scoop of", etc.) so multi-word table entries like "chicken
 *  breast with rice" match inputs like "chicken breast with cup of rice".
 *  Used as a SECOND-PASS fallback after the light normalization. */
function normalizeFoodForLookupHeavy(input: string): string {
  return normalizeFoodForLookup(input)
    .replace(/\b(\d+\s+)?(a|an|one|two|three|four|five|six)?\s*(cup|scoop|slice|serving|bowl|plate|piece|portion|stick|bar|handful)s?\s+of\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Look up a food string in the COMMON_FOODS table. Returns null on miss.
 * Tries exact match against the normalized form, then a substring scan
 * (the table key must appear as a whole word in the normalized input).
 */
export function lookupCommonFoodMacros(input: string): FoodEstimate | null {
  const lightNorm = normalizeFoodForLookup(input);
  if (lightNorm.length < 3) return null;

  // Pass 1 — light normalization (keeps "slices of", "cup of", etc.).
  // Catches table entries that include those words like "2 slices of pizza".
  const exactLight = COMMON_FOODS[lightNorm];
  if (exactLight) {
    return { food: exactLight.food, protein_g: exactLight.protein_g, calories: exactLight.calories, confidence: 'high' };
  }

  // Pass 2 — heavy normalization (strips "cup of", "slices of", etc.).
  // Catches "chicken breast with cup of rice" → "chicken breast with rice".
  const heavyNorm = normalizeFoodForLookupHeavy(input);
  const exactHeavy = heavyNorm !== lightNorm ? COMMON_FOODS[heavyNorm] : undefined;
  if (exactHeavy) {
    return { food: exactHeavy.food, protein_g: exactHeavy.protein_g, calories: exactHeavy.calories, confidence: 'high' };
  }

  // Substring containment using BOTH normalizations. We try the heavy one
  // first because it tends to match longer compound keys; if nothing there,
  // try the light one. Coverage gate: a short key (e.g. "lentils") shouldn't
  // match inside a long input (e.g. "vegetarian shepherd pie with lentils").
  const tryMatch = (norm: string): { key: string; macros: CommonMacros } | null => {
    const inputWordCount = norm.split(/\s+/).filter(Boolean).length;
    let best: { key: string; macros: CommonMacros } | null = null;
    for (const [key, macros] of Object.entries(COMMON_FOODS)) {
      const keyRe = new RegExp(`\\b${key.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\b`);
      if (!keyRe.test(norm)) continue;
      const coverage = key.length / norm.length;
      const keyWordCount = key.split(/\s+/).filter(Boolean).length;
      const acceptable =
        coverage >= 0.4 ||
        inputWordCount <= 3 ||
        keyWordCount >= 2;
      if (!acceptable) continue;
      if (!best || key.length > best.key.length) {
        best = { key, macros };
      }
    }
    return best;
  };
  const best = tryMatch(heavyNorm) ?? tryMatch(lightNorm);
  if (best) {
    // 2026-06-04 production failure: user sent "3 eggs with salade, Tuna, Rice"
    // — the matcher found "3 eggs" (key length 6, keyWordCount 2 → acceptable)
    // and returned ONLY eggs. But the message has FOUR foods.
    //
    // Multi-food bail: after a match, check whether there are OTHER food
    // tokens in the input that aren't covered by the matched key. If yes,
    // return null so food-log-fast falls through to the full log_food tool
    // which decomposes via LLM and logs each item separately.
    if (hasOtherFoodTokens(lightNorm, best.key) || hasOtherFoodTokens(heavyNorm, best.key)) {
      return null;
    }
    return {
      food: best.macros.food,
      protein_g: best.macros.protein_g,
      calories: best.macros.calories,
      confidence: 'high',
    };
  }
  return null;
}

// Set of distinctive food tokens harvested from COMMON_FOODS — single words
// that are unambiguously foods. Used by hasOtherFoodTokens to detect when a
// multi-item meal slipped past the substring matcher.
const FOOD_TOKEN_SET: Set<string> = (() => {
  const STOP = new Set([
    'with', 'and', 'of', 'cup', 'cups', 'slice', 'slices', 'piece', 'pieces',
    'serving', 'servings', 'oz', 'g', 'gram', 'grams', 'tbsp', 'tsp',
    'medium', 'large', 'small', 'plain', 'regular', 'whole', 'half',
    'a', 'an', 'the', 'one', 'two', 'three', 'four', 'five', 'six',
    'my', 'some', 'this', 'that',
  ]);
  const set = new Set<string>();
  for (const key of Object.keys(COMMON_FOODS)) {
    for (const tok of key.split(/\s+/)) {
      const t = tok.toLowerCase();
      if (t.length < 3) continue;
      if (STOP.has(t)) continue;
      if (/^\d+$/.test(t)) continue;
      set.add(t);
    }
  }
  // Additional unambiguous food words not in COMMON_FOODS keys.
  for (const t of ['tuna', 'rice', 'salad', 'salade', 'salmon', 'eggs', 'egg',
                   'chicken', 'beef', 'pork', 'fish', 'tofu', 'tempeh',
                   'yogurt', 'cheese', 'milk', 'oats', 'oatmeal',
                   'banana', 'apple', 'berries', 'pasta', 'bread', 'toast',
                   'shake', 'smoothie', 'soup', 'sandwich', 'wrap',
                   'edamame', 'beans', 'lentils', 'chickpea', 'chickpeas',
                   'avocado', 'shrimp', 'turkey', 'bacon', 'sausage',
                   'cottage', 'kefir', 'hummus', 'quinoa']) {
    set.add(t);
  }
  return set;
})();

/**
 * Returns true if the normalized input contains a food token (from the
 * COMMON_FOODS-derived dictionary) that ISN'T part of the matched key.
 * Indicates the user listed multiple foods in one message.
 */
function hasOtherFoodTokens(normalizedInput: string, matchedKey: string): boolean {
  const keyTokens = new Set(matchedKey.toLowerCase().split(/\s+/));
  const inputTokens = normalizedInput.toLowerCase().split(/\s+/);
  let otherCount = 0;
  for (const tok of inputTokens) {
    if (tok.length < 3) continue;
    if (keyTokens.has(tok)) continue;
    if (FOOD_TOKEN_SET.has(tok)) otherCount++;
    if (otherCount >= 1) return true;
  }
  return false;
}

// Test exports — internal helpers exposed for unit tests so we can verify
// the structured-output sum logic without spinning up a real LLM.
export const __testing = {
  parseItemizedEstimate,
  sumItemized,
  FOOD_ITEMS_SCHEMA,
};
