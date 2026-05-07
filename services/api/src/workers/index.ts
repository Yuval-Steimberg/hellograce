import type { Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Pool } from 'pg';
import type { Logger } from 'pino';
import type { MemoryService } from '../memory/memory.service.js';
import { createTurnPersistWorker } from './turn-persist.worker.js';

let workers: Worker[] = [];

export function startWorkers(deps: {
  redis: Redis;
  pool: Pool;
  memory: MemoryService;
  logger: Logger;
}): void {
  workers = [createTurnPersistWorker(deps)];
  deps.logger.info({ count: workers.length }, 'workers.started');
}

export async function stopWorkers(): Promise<void> {
  await Promise.all(workers.map((w) => w.close()));
  workers = [];
}
