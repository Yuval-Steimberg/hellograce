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
              'You are a nutrition expert estimating protein and calories from a casual food description. ' +
              'CRITICAL: never ask for grams/ounces/portion sizes — confidently estimate from the description using typical USDA serving sizes. ' +
              'If a TOTAL is already provided in the text, use it directly. ' +
              'For vague descriptions, infer a reasonable serving:\n' +
              '  "eggs" → 2 eggs (12g protein, 140 kcal)\n' +
              '  "a yogurt" → 1 cup Greek yogurt (15g, 100 kcal) unless context says otherwise\n' +
              '  "chicken and rice" → typical lunch portion (30g, 450 kcal)\n' +
              '  "protein shake" → 1 scoop whey (25g, 130 kcal)\n' +
              '  "a burrito" → typical fast-casual burrito (22g, 600 kcal)\n' +
              '  "salmon" → 5oz fillet (28g, 280 kcal)\n' +
              '  "tuna" → 1 can (20g, 110 kcal)\n' +
              '  "cottage cheese" → 1/2 cup (14g, 100 kcal)\n' +
              'Respond ONLY with JSON: {"food": <concise label>, "protein_g": <number>, "calories": <number>, "confidence": "low"|"medium"|"high"}. ' +
              'Confidence: "high" when the user specified quantity/type clearly, "medium" when inferred from common sense, "low" when truly ambiguous. ' +
              'Never use 0 protein or 0 calories for a real food.',
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

      deps.logger.info(
        { userId: deps.userId, food: parsed.food, protein: parsed.protein_g, source },
        'tool.log_food.ok',
      );
      return parsed;
    },
  };
}
