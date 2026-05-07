import { z } from 'zod';
import type { Tool } from '@grace/ai-core';
import type { UserService } from '../user/user.service.js';

const ArgsSchema = z.object({
  side_effect: z.enum(['nausea', 'fatigue', 'constipation', 'other']),
  severity: z.enum(['mild', 'moderate', 'severe']).optional(),
});

export function makeLogSideEffectTool(deps: { users: UserService; userId: string; phone: string }): Tool {
  return {
    name: 'log_side_effect',
    description: "Log a side effect the user is experiencing (nausea, fatigue, constipation, other). This triggers an automatic follow-up.",
    async execute(args) {
      const parsed = ArgsSchema.safeParse(args);
      if (!parsed.success) return { ok: false, error: 'invalid_args' };
      const { side_effect, severity } = parsed.data;

      const flow = side_effect === 'other' ? null : side_effect;
      if (flow) {
        await deps.users.update(deps.phone, {
          side_effect_flow: flow,
          side_effect_flow_started_at: new Date(),
          side_effect_followup_sent: false,
        });
      }

      return { ok: true, side_effect, severity: severity ?? 'unspecified', follow_up_scheduled: !!flow };
    },
  };
}
