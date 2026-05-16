import type { Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Pool } from 'pg';
import type { Logger } from 'pino';
import type { LLMProvider } from '@grace/shared';
import type { MemoryService } from '../memory/memory.service.js';
import { createTurnPersistWorker } from './turn-persist.worker.js';
import { createFactExtractorWorker } from './fact-extractor.worker.js';

let workers: Worker[] = [];

export function startWorkers(deps: {
  redis: Redis;
  pool: Pool;
  memory: MemoryService;
  llm: LLMProvider;
  logger: Logger;
}): void {
  workers = [
    createTurnPersistWorker(deps),
    createFactExtractorWorker({ redis: deps.redis, pool: deps.pool, llm: deps.llm, logger: deps.logger }),
  ];
  deps.logger.info({ count: workers.length }, 'workers.started');
}

export async function stopWorkers(): Promise<void> {
  await Promise.all(workers.map((w) => w.close()));
  workers = [];
}
