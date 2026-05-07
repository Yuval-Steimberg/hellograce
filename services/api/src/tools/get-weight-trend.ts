import type { Tool } from '@grace/ai-core';
import type { UserService } from '../user/user.service.js';

export function makeGetWeightTrendTool(deps: { users: UserService; userId: string }): Tool {
  return {
    name: 'get_weight_trend',
    description: "Retrieve the user's recent weight log entries to show progress.",
    async execute() {
      const history = await deps.users.getWeightHistory(deps.userId, 10);
      if (history.length === 0) return { entries: [], summary: 'No weight logs yet.' };

      const latest = history[0]!.weight;
      const oldest = history[history.length - 1]!.weight;
      const change = latest - oldest;

      return {
        entries: history.map((e) => ({
          weight_lbs: e.weight,
          date: e.created_at,
        })),
        latest_lbs: latest,
        change_lbs: Number(change.toFixed(1)),
        trend: change < -0.5 ? 'down' : change > 0.5 ? 'up' : 'stable',
      };
    },
  };
}
