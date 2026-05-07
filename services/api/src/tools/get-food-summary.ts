import type { Tool } from '@grace/ai-core';
import type { UserService } from '../user/user.service.js';

export function makeGetFoodSummaryTool(deps: { users: UserService; userId: string }): Tool {
  return {
    name: 'get_food_summary',
    description: "Retrieve a summary of what the user has eaten today (protein, calories, food items logged).",
    async execute() {
      const summary = await deps.users.getTodaysFoodSummary(deps.userId);
      return {
        protein_g: Math.round(summary.protein_g),
        calories: Math.round(summary.calories),
        items: summary.items,
        protein_goal_met: summary.protein_g >= 80, // rough target for GLP-1 users
        items_count: summary.items.length,
      };
    },
  };
}
