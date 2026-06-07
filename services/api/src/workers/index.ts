import type { Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Pool } from 'pg';
import type { Logger } from 'pino';
import type { LLMProvider } from '@grace/shared';
import type { MemoryService } from '../memory/memory.service.js';
import type { MemoryMdService } from '../memory/memory-md.service.js';
import { createTurnPersistWorker } from './turn-persist.worker.js';
import { createFactExtractorWorker } from './fact-extractor.worker.js';
import { createMemoryMdUpdaterWorker } from './memory-md-updater.worker.js';

let workers: Worker[] = [];

export function startWorkers(deps: {
  redis: Redis;
  pool: Pool;
  memory: MemoryService;
  llm: LLMProvider;
  logger: Logger;
  memoryMd?: MemoryMdService;
}): void {
  workers = [
    createTurnPersistWorker(deps),
    createFactExtractorWorker({ redis: deps.redis, pool: deps.pool, llm: deps.llm, logger: deps.logger }),
  ];
  // Phase D — memory.md updater. Only starts when the service is wired.
  if (deps.memoryMd) {
    workers.push(
      createMemoryMdUpdaterWorker({
        redis: deps.redis,
        llm: deps.llm,
        memoryMd: deps.memoryMd,
        logger: deps.logger,
      }),
    );
  }
  deps.logger.info({ count: workers.length }, 'workers.started');
}

export async function stopWorkers(): Promise<void> {
  await Promise.all(workers.map((w) => w.close()));
  workers = [];
}
