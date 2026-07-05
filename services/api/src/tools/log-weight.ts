import type { Pool } from 'pg';
import type { Logger } from 'pino';
import type { Tool } from '@grace/ai-core';

export function makeLogWeightTool(deps: { pool: Pool; logger: Logger; userId: string }): Tool {
  return {
    name: 'log_weight',
    description: 'Record the user\'s weight in lbs.',
    async execute(args) {
      const weightRaw = args['weight_lbs'];
      const weight = typeof weightRaw === 'number' ? weightRaw : Number(weightRaw);
      if (!Number.isFinite(weight) || weight < 60 || weight > 700) {
        return { ok: false, error: 'invalid_weight' };
      }
      await deps.pool.query(
        `INSERT INTO weight_logs (user_id, weight) VALUES ($1, $2)`,
        [deps.userId, weight],
      );
      // Remember it in the profile too, so current_weight (which feeds the
      // protein target + progress) isn't left stale. Best-effort.
      await deps.pool
        .query(`UPDATE users SET current_weight = $2 WHERE phone = $1`, [deps.userId, weight])
        .catch(() => undefined);
      deps.logger.info({ userId: deps.userId, weight }, 'tool.log_weight.ok');
      return { weight_lbs: weight };
    },
  };
}
