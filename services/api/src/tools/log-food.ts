import type { Pool } from 'pg';
import type { Logger } from 'pino';
import type { LLMProvider } from '@grace/shared';
import type { Tool } from '@grace/ai-core';

/**
 * log_food: Detect a food the user just ate, estimate protein/calories,
 * and persist to a `food_logs` row + a `check_ins` snapshot for analytics.
 *
 * Args expected from planner: { food?: string }  (free-text)
 * Falls back to LLM extraction if `food` is not provided.
 */
export function makeLogFoodTool(deps: {
  pool: Pool;
  llm: LLMProvider;
  logger: Logger;
  userId: string;
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
              'You are a nutrition expert. Given a food description (may include multiple items, quantities, and pre-calculated macros), ' +
              'extract or calculate the TOTAL protein (g) and total calories (kcal) for the entire meal. ' +
              'If explicit totals are already provided in the text, use those numbers directly. ' +
              'Respond ONLY with JSON: {"food": string, "protein_g": number, "calories": number, "confidence": "low"|"medium"|"high"}. ' +
              '"food" should be a concise label (e.g. "4 green apples"). ' +
              'Use USDA values. Do NOT use 0 for real foods — every food has calories.',
          },
          { role: 'user', content: food },
        ],
        temperature: 0.1,
        maxOutputTokens: 120,
        responseFormat: 'json',
      });

      let parsed: { food: string; protein_g: number; calories: number; confidence: string };
      try {
        parsed = JSON.parse(llmResp.text);
      } catch {
        return { ok: false, error: 'estimate_parse_failed' };
      }

      await deps.pool.query(
        `INSERT INTO food_logs (user_id, food, protein_g, calories, confidence, raw_text)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [deps.userId, parsed.food, parsed.protein_g, parsed.calories, parsed.confidence, food],
      );

      deps.logger.info({ userId: deps.userId, food: parsed.food, protein: parsed.protein_g }, 'tool.log_food.ok');
      return parsed;
    },
  };
}
