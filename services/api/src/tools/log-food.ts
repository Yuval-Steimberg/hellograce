import { createHash } from 'crypto';
import type { Pool } from 'pg';
import type { Logger } from 'pino';
import type { LLMProvider } from '@grace/shared';
import type { Tool } from '@grace/ai-core';

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
}): Tool {
  return {
    name: 'log_food',
    description: 'Log a food item with estimated protein/calories.',
    async execute(args) {
      const food = typeof args['food'] === 'string' ? (args['food'] as string).trim() : '';
      if (!food) return { ok: false, error: 'no_food_provided' };

      const llmResp = await deps.llm.generate({
        messages: [
          {
            role: 'system',
            content:
              'You estimate protein and calories from a casual food description using USDA FoodData Central reference values. Accuracy matters — these numbers feed daily protein tracking. ' +
              'CRITICAL: never refuse to estimate. Never ask the caller for grams/ounces/portions/macros. Always produce a number using common-sense serving sizes. ' +
              'If a TOTAL is already provided in the text, use it directly. ' +
              '\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━' +
              '\nCOMPOUND MEAL RULE — ALWAYS DECOMPOSE FIRST' +
              '\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━' +
              '\nIf the description has multiple items joined by "and", "with", "plus", or commas, do this in your head:' +
              '\n  1. Split into individual items' +
              '\n  2. Look each up below' +
              '\n  3. SUM the protein and calories' +
              '\n  4. Return the total as one entry' +
              '\nNEVER match the full compound description to a single line in the anchors. ALWAYS break it down.' +
              '\n\nExamples of correct decomposition:' +
              '\n  "salad and an omelet with 2 eggs" → salad (3g) + 2-egg omelet (12g) = 15g, ~280 kcal' +
              '\n  "chicken breast and broccoli" → chicken 4oz (30g) + broccoli (2g) = 32g, ~250 kcal' +
              '\n  "toast and peanut butter and a banana" → toast+PB (8g) + banana (1g) = 9g, ~280 kcal' +
              '\n  "yogurt and granola" → yogurt (17g) + granola (4g) = 21g, ~280 kcal' +
              '\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━' +
              '\nUSDA ANCHOR VALUES (per typical serving)' +
              '\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━' +
              '\nEGGS & DAIRY:\n' +
              '  1 egg · 6g · 70 kcal | 2 eggs / 2-egg omelet · 12g · 140 kcal (omelet plain: 180 kcal)\n' +
              '  3 eggs / 3-egg omelet · 18g · 210 kcal (omelet plain: 270 kcal)\n' +
              '  egg whites (4) · 14g · 70 kcal\n' +
              '  Greek yogurt 1 cup · 17g · 100 kcal | regular yogurt 1 cup · 6g · 150 kcal\n' +
              '  cottage cheese 1/2 cup · 14g · 100 kcal\n' +
              '  cheese 1 slice · 6g · 110 kcal\n' +
              '  milk 1 cup · 8g · 120 kcal\n' +
              'POULTRY & MEAT:\n' +
              '  chicken breast 4oz (cooked) · 30g · 180 kcal\n' +
              '  chicken thigh 4oz · 26g · 220 kcal\n' +
              '  turkey breast 4oz · 28g · 160 kcal\n' +
              '  ground beef 4oz · 22g · 280 kcal | steak 5oz · 35g · 350 kcal\n' +
              '  ground turkey 4oz · 24g · 180 kcal | bacon 2 slices · 6g · 80 kcal\n' +
              'FISH:\n' +
              '  salmon 5oz · 28g · 280 kcal | tuna 1 can · 20g · 110 kcal\n' +
              '  shrimp 4oz · 24g · 100 kcal | white fish 4oz · 22g · 110 kcal\n' +
              'PLANT PROTEIN:\n' +
              '  tofu 4oz · 10g · 80 kcal | tempeh 3oz · 16g · 160 kcal\n' +
              '  black beans 1/2 cup · 8g · 110 kcal | chickpeas 1/2 cup · 7g · 120 kcal\n' +
              '  lentils 1/2 cup · 9g · 115 kcal | edamame 1/2 cup · 9g · 95 kcal\n' +
              '  peanut butter 2 tbsp · 8g · 190 kcal | almonds 1oz · 6g · 165 kcal\n' +
              '  hummus 1/4 cup · 4g · 100 kcal\n' +
              'GRAINS:\n' +
              '  rice 1 cup cooked · 4g · 200 kcal | quinoa 1 cup · 8g · 220 kcal\n' +
              '  oatmeal 1 cup cooked · 6g · 150 kcal\n' +
              '  toast 1 slice · 3g · 80 kcal | bagel 1 · 10g · 280 kcal\n' +
              '  pasta 1 cup plain · 8g · 220 kcal\n' +
              'VEGETABLES (always low protein, count them anyway):\n' +
              '  salad (plain greens, dressing) · 3g · 100 kcal\n' +
              '  big salad (greens + veggies) · 4g · 130 kcal\n' +
              '  broccoli/cauliflower/spinach 1 cup · 2g · 30 kcal\n' +
              '  sweet potato 1 medium · 2g · 100 kcal\n' +
              '  potato 1 medium · 3g · 130 kcal | fries side · 4g · 320 kcal\n' +
              'FRUITS: banana / apple / orange / berries · 1g · ~80 kcal\n' +
              'PREPARED MEALS (one-line shortcuts when description matches exactly):\n' +
              '  "chicken and rice" → 30g · 450 kcal\n' +
              '  "salad with chicken" / "chicken salad" → 25g · 380 kcal\n' +
              '  "protein shake" 1 scoop · 25g · 130 kcal | "smoothie" with protein · 18g · 280 kcal\n' +
              '  "sandwich" deli · 22g · 450 kcal | "wrap" with protein · 25g · 480 kcal\n' +
              '  "pizza" 2 slices · 22g · 540 kcal | "burrito" fast-casual · 22g · 600 kcal\n' +
              '  "sushi roll" 1 · 12g · 250 kcal\n' +
              '  "soup" plain · 8g · 220 kcal | "soup with chicken/beans" · 18g · 320 kcal\n' +
              '  "snack plate" / "cheese and nuts" · 12g · 300 kcal\n' +
              '  coffee/tea 0g, 0-10 kcal\n' +
              '\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━' +
              '\nOUTPUT FORMAT' +
              '\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━' +
              '\nRespond ONLY with JSON: {"food": <concise label of full meal>, "protein_g": <integer>, "calories": <integer>, "confidence": "low"|"medium"|"high"}. ' +
              'Confidence: "high" when quantity/type was specified clearly OR you decomposed cleanly, "medium" for inferred portions, "low" only when truly ambiguous. ' +
              'For real foods, never use 0 protein or 0 calories. Round protein to the nearest gram.',
          },
          { role: 'user', content: food },
        ],
        temperature: 0.1,
        maxOutputTokens: 200,
        responseFormat: 'json',
      });

      let parsed: { food: string; protein_g: number; calories: number; confidence: string };
      try {
        parsed = JSON.parse(llmResp.text);
      } catch {
        return { ok: false, error: 'estimate_parse_failed' };
      }

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
