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
              'You estimate protein and calories from a casual food description like a knowledgeable friend would — quickly, confidently, and approximately. ' +
              'CRITICAL: never refuse to estimate. Never ask the caller for grams/ounces/portions/macros. Always produce a number using common-sense serving sizes. ' +
              'If a TOTAL is already provided in the text, use it directly. ' +
              'Common anchor servings (use these unless the description says otherwise):\n' +
              '  "eggs" → 2 eggs · 12g · 140 kcal\n' +
              '  "scrambled eggs" → 2 eggs · 12g · 180 kcal\n' +
              '  "egg whites" → 4 whites · 14g · 70 kcal\n' +
              '  "a yogurt" → 1 cup Greek · 17g · 100 kcal (regular: 6g · 150 kcal)\n' +
              '  "greek yogurt and fruit" → 1 cup yogurt + berries · 17g · 180 kcal\n' +
              '  "cottage cheese" → 1/2 cup · 14g · 100 kcal\n' +
              '  "chicken and rice" → typical lunch · 30g · 450 kcal\n' +
              '  "chicken salad" → typical bowl with chicken · 28g · 400 kcal\n' +
              '  "salad with chicken" → bowl with grilled chicken · 25g · 380 kcal\n' +
              '  "a burrito" → fast-casual size · 22g · 600 kcal\n' +
              '  "chicken burrito" → 30g · 650 kcal\n' +
              '  "protein shake" → 1 scoop whey + water/milk · 25g · 130 kcal\n' +
              '  "smoothie" → typical fruit + protein · 18g · 280 kcal\n' +
              '  "salmon" → 5oz fillet · 28g · 280 kcal\n' +
              '  "steak" → 5oz · 35g · 350 kcal\n' +
              '  "ground beef" → 4oz · 22g · 280 kcal\n' +
              '  "tuna" → 1 can · 20g · 110 kcal\n' +
              '  "tuna salad" → typical scoop · 18g · 220 kcal\n' +
              '  "sushi" / "a sushi roll" → 1 standard roll · 12g · 250 kcal (for a full meal of 2 rolls: 24g · 500 kcal)\n' +
              '  "pasta" → 1 cup plain · 8g · 220 kcal\n' +
              '  "pasta with meat sauce" → typical plate · 20g · 500 kcal\n' +
              '  "snack plate" / "cheese and nuts" → small board · 12g · 300 kcal\n' +
              '  "oatmeal" → 1 cup cooked · 6g · 150 kcal (with protein powder: 25g · 280 kcal)\n' +
              '  "toast and peanut butter" → 1 slice · 8g · 200 kcal\n' +
              '  "sandwich" → typical deli · 22g · 450 kcal\n' +
              '  "wrap" → typical with protein · 25g · 480 kcal\n' +
              '  "pizza" → 2 slices · 22g · 540 kcal\n' +
              '  "soup" → typical bowl · 8g · 220 kcal (with chicken/beans: 18g · 320 kcal)\n' +
              '  "banana" / "apple" / "orange" → 1g · ~80 kcal\n' +
              '  "coffee" / "tea" → 0g · 0–10 kcal\n' +
              'Respond ONLY with JSON: {"food": <concise label>, "protein_g": <number>, "calories": <number>, "confidence": "low"|"medium"|"high"}. ' +
              'Confidence: "high" when the user specified quantity/type clearly, "medium" when inferred from common sense (default for vague descriptions), "low" only when truly ambiguous. ' +
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
           AND (fl.created_at AT TIME ZONE user_tz.tz)::date
               = (now() AT TIME ZONE user_tz.tz)::date`,
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
