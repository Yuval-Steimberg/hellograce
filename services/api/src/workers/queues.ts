import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';

export interface TurnPersistJob {
  userId: string;
  conversationId: string;
  userText: string;
  assistantText: string;
  toolResults: Array<{
    name: string;
    ok: boolean;
    output?: unknown;
    error?: string;
    latencyMs: number;
  }>;
}

let _turnQueue: Queue<TurnPersistJob> | null = null;

export function getTurnQueue(redis: Redis): Queue<TurnPersistJob> {
  if (!_turnQueue) {
    _turnQueue = new Queue<TurnPersistJob>('turn-persist', {
      connection: redis,
      defaultJobOptions: {
        removeOnComplete: 500,
        removeOnFail: 200,
        attempts: 3,
        backoff: { type: 'exponential', delay: 1_000 },
      },
    });
  }
  return _turnQueue;
}

export async function closeQueues(): Promise<void> {
  if (_turnQueue) {
    await _turnQueue.close();
    _turnQueue = null;
  }
}
