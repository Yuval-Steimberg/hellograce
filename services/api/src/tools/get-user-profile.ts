import type { Tool } from '@grace/ai-core';
import type { UserService } from '../user/user.service.js';

export function makeGetUserProfileTool(deps: { users: UserService; userId: string }): Tool {
  return {
    name: 'get_user_profile',
    description: "Retrieve the user's profile: name, medication, goals, injection day, weight, food preferences.",
    async execute() {
      const user = await deps.users.getById(deps.userId);
      if (!user) return { found: false };
      return {
        found: true,
        first_name: user.first_name,
        medication: user.medication,
        injection_day: user.injection_day,
        goals: user.goals,
        food_dislikes: user.food_dislikes,
        current_weight: user.current_weight,
        goal_weight: user.goal_weight,
        low_mood_mode: user.low_mood_mode,
        protein_focus_boost: user.protein_focus_boost,
      };
    },
  };
}
