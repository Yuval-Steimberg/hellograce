import { Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Pool } from 'pg';
import type { Logger } from 'pino';
import type { MemoryService } from '../memory/memory.service.js';
import type { TurnPersistJob } from './queues.js';

export function createTurnPersistWorker(deps: {
  redis: Redis;
  pool: Pool;
  memory: MemoryService;
  logger: Logger;
}): Worker<TurnPersistJob> {
  const worker = new Worker<TurnPersistJob>(
    'turn-persist',
    async (job) => {
      const { userId, conversationId, userText, assistantText, toolResults } = job.data;

      await Promise.all([
        deps.memory.appendTurn({ userId, conversationId, role: 'user', content: userText }),
        deps.memory.appendTurn({ userId, conversationId, role: 'assistant', content: assistantText }),
      ]);

      for (const tr of toolResults) {
        await deps.pool.query(
          `INSERT INTO tool_logs (user_id, conversation_id, tool_name, args, ok, output, error, latency_ms)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [userId, conversationId, tr.name, JSON.stringify(tr.args ?? {}), tr.ok, JSON.stringify(tr.output ?? null), tr.error ?? null, tr.latencyMs],
        );
      }
    },
    {
      connection: deps.redis,
      concurrency: 5,
    },
  );

  worker.on('failed', (job, err) => {
    deps.logger.error({ jobId: job?.id, err }, 'turn-persist.worker.failed');
  });

  return worker;
}
