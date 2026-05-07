import type { Pool } from 'pg';
import type { Logger } from 'pino';
import type { Tool } from '@grace/ai-core';

export function makeLogMoodTool(deps: { pool: Pool; logger: Logger; userId: string }): Tool {
  return {
    name: 'log_mood',
    description: "Record the user's mood score 1-10.",
    async execute(args) {
      const scoreRaw = args['score'];
      const score = typeof scoreRaw === 'number' ? scoreRaw : Number(scoreRaw);
      if (!Number.isInteger(score) || score < 1 || score > 10) {
        return { ok: false, error: 'invalid_score' };
      }
      await deps.pool.query(
        `INSERT INTO check_ins (user_id, type, message_sent, mood_score)
         VALUES ($1, 'mood_log', '', $2)`,
        [deps.userId, score],
      );
      deps.logger.info({ userId: deps.userId, score }, 'tool.log_mood.ok');
      return { score };
    },
  };
}
