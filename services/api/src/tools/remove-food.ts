import type { Pool } from 'pg';
import type { Logger } from 'pino';
import type { Tool } from '@grace/ai-core';
import { USER_DAY_CTE, isCurrentUserDay } from '../nutrition/logging-window.js';
import { FoodLedgerService, type FoodLedgerCache } from '../services/food-ledger.js';

/**
 * remove_food: delete one of today's food log entries.
 *
 * Grace calls this when the user says a logged item was wrong, from
 * yesterday, or asks to remove something specific. The tool finds the
 * best-matching entry in today's food_logs (by food name, case-insensitive
 * partial match) and deletes it, then returns the updated daily totals.
 *
 * "Today" uses the same per-user logging-day window (wake_time to next
 * wake_time, in the user's timezone — see nutrition/logging-window.ts) as
 * log_food and getTodaysFoodSummary so the deleted entry is always in the
 * correct window.
 */
export function makeRemoveFoodTool(deps: {
  pool: Pool;
  logger: Logger;
  userId: string;
  users?: FoodLedgerCache;
}): Tool {
  return {
    name: 'remove_food',
    description:
      "Remove a food item from today's log when the user says it was logged by mistake, from yesterday, or wants it deleted. Pass the food name to remove.",
    async execute(args) {
      const food = typeof args['food'] === 'string' ? (args['food'] as string).trim() : '';
      if (!food) return { ok: false, error: 'no_food_provided' };

      // Find matching entry first so a not-found reply can show the diary.
      const matchResult = await deps.pool.query<{ id: string; food: string; protein_g: number; calories: number }>(
        `${USER_DAY_CTE}
         SELECT fl.id, fl.food, fl.protein_g, fl.calories
         FROM food_logs fl, user_tz
         WHERE fl.user_id = $1
           AND ${isCurrentUserDay('fl.created_at')}
           AND lower(fl.food) LIKE '%' || lower($2) || '%'
         ORDER BY fl.created_at DESC
         LIMIT 1`,
        [deps.userId, food],
      );

      if (matchResult.rows.length === 0) {
        // Nothing matched — return today's full list so Grace can tell the user
        const listResult = await deps.pool.query<{ food: string }>(
          `${USER_DAY_CTE}
           SELECT food FROM food_logs fl, user_tz
           WHERE fl.user_id = $1
             AND ${isCurrentUserDay('fl.created_at')}
           ORDER BY fl.created_at DESC`,
          [deps.userId],
        );
        return {
          ok: false,
          error: 'not_found',
          today_items: listResult.rows.map((r) => r.food),
        };
      }

      const ledger = new FoodLedgerService(deps.pool, deps.users);
      const mutation = await ledger.removeLatest(deps.userId, food);
      const entry = mutation.removed ?? matchResult.rows[0]!;
      const dailyProteinG = mutation.totals.protein_g;
      const dailyCalories = mutation.totals.calories;

      deps.logger.info(
        { userId: deps.userId, removed: entry.food, removedProtein: entry.protein_g, dailyProteinG },
        'tool.remove_food.ok',
      );

      return {
        ok: true,
        removed_food: entry.food,
        removed_protein_g: entry.protein_g,
        removed_calories: entry.calories,
        daily_protein_g: dailyProteinG,
        daily_calories: dailyCalories,
      };
    },
  };
}
