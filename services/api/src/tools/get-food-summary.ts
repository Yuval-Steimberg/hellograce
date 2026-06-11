import type { Tool } from '@grace/ai-core';
import type { UserService } from '../user/user.service.js';
import { aggregateFoodItems, formatAggregatedInline } from '../services/food-summary.js';

export function makeGetFoodSummaryTool(deps: { users: UserService; userId: string }): Tool {
  return {
    name: 'get_food_summary',
    description: "Retrieve a summary of what the user has eaten today (protein, calories, food items logged). Returns per-item breakdown so Grace can answer 'How did I reach 40g?' with item-level detail.",
    async execute() {
      const summary = await deps.users.getTodaysFoodSummary(deps.userId);
      const user = await deps.users.getById(deps.userId).catch(() => null);
      const proteinTarget = user?.protein_goal_grams ?? 80;
      const calorieTarget = user?.calorie_goal_kcal ?? null;
      const caloriesToday = Math.round(summary.calories);
      return {
        protein_g: Math.round(summary.protein_g),
        calories: caloriesToday,
        items: summary.items,
        // Deduped, aggregated presentation string — use THIS when listing the
        // day's foods back to the user so the reply never repeats the same food
        // ("Eggs ×6, Chicken breast ×3, Rice ×2"). `items`/`items_detailed`
        // remain raw for item-level questions ("how did I reach 40g?").
        items_aggregated: formatAggregatedInline(aggregateFoodItems(summary.items), 10),
        // Per-item breakdown — use this to explain WHICH foods contributed
        // to today's protein total. Each item carries its own protein_g and
        // calories. Ordered newest-first.
        items_detailed: summary.items_detailed.map((i) => ({
          food: i.food,
          protein_g: Math.round(i.protein_g),
          calories: Math.round(i.calories),
          logged_at: i.logged_at,
        })),
        protein_goal_grams: proteinTarget,
        protein_goal_met: summary.protein_g >= proteinTarget,
        protein_remaining_g: Math.max(0, Math.round(proteinTarget - summary.protein_g)),
        // Calorie fields — parallel to protein. calorie_goal_kcal is null when
        // user hasn't completed onboarding fields for Mifflin-St Jeor calc.
        calorie_goal_kcal: calorieTarget,
        calorie_goal_met: calorieTarget != null && caloriesToday >= calorieTarget,
        calories_remaining: calorieTarget != null ? Math.max(0, calorieTarget - caloriesToday) : null,
        items_count: summary.items.length,
      };
    },
  };
}

export function makeGetProteinHistoryTool(deps: { users: UserService; userId: string }): Tool {
  return {
    name: 'get_protein_history',
    description: "Retrieve daily protein/calorie totals for the last N days (default 7, max 30). Use when the user asks about YESTERDAY's protein, this week's average, or a multi-day pattern. NEVER use for today-only queries (use get_food_summary).",
    async execute(args) {
      const daysArg = typeof args['days'] === 'number'
        ? args['days']
        : typeof args['days'] === 'string'
          ? parseInt(args['days'] as string, 10) || 7
          : 7;
      const days = Math.max(1, Math.min(30, daysArg));
      const history = await deps.users.getDailyProteinHistory(deps.userId, days);
      const user = await deps.users.getById(deps.userId).catch(() => null);
      const proteinTarget = user?.protein_goal_grams ?? 80;
      // Pad days with NO logs as zero-rows so Grace can answer "did I log
      // anything yesterday?" honestly when the user's history has gaps.
      return {
        protein_goal_grams: proteinTarget,
        days_requested: days,
        days_with_data: history.length,
        history,
        // Convenience fields the LLM doesn't have to compute.
        avg_protein_g:
          history.length > 0
            ? Math.round(history.reduce((s, d) => s + d.protein_g, 0) / history.length)
            : 0,
        days_met_target: history.filter((d) => d.protein_g >= proteinTarget).length,
      };
    },
  };
}
