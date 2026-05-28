import type { Tool } from '@grace/ai-core';
import type { UserService } from '../user/user.service.js';

export function makeGetFoodSummaryTool(deps: { users: UserService; userId: string }): Tool {
  return {
    name: 'get_food_summary',
    description: "Retrieve a summary of what the user has eaten today (protein, calories, food items logged).",
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
