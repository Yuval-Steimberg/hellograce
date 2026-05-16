import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import type { ToolResult } from '@grace/shared';

export interface TurnPersistJob {
  userId: string;
  conversationId: string;
  userText: string;
  assistantText: string;
  toolResults: ToolResult[];
}

/**
 * Background fact-extraction job. Runs after each user message to pull
 * durable profile facts ("vegetarian", "night shifts", "protein shakes make
 * me nauseous") into the user_profile_facts table. Cheap, best-effort.
 */
export interface FactExtractJob {
  userId: string;
  userText: string;
  /** Optional: id of the message row this fact came from (for traceability). */
  sourceMessageId?: string;
}

let _turnQueue: Queue<TurnPersistJob> | null = null;
let _factQueue: Queue<FactExtractJob> | null = null;

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

export function getFactExtractQueue(redis: Redis): Queue<FactExtractJob> {
  if (!_factQueue) {
    _factQueue = new Queue<FactExtractJob>('fact-extract', {
      connection: redis,
      defaultJobOptions: {
        removeOnComplete: 200,
        removeOnFail: 50,
        // Best-effort — one retry is enough. The fact will likely appear again.
        attempts: 2,
        backoff: { type: 'exponential', delay: 2_000 },
      },
    });
  }
  return _factQueue;
}

export async function closeQueues(): Promise<void> {
  if (_turnQueue) {
    await _turnQueue.close();
    _turnQueue = null;
  }
  if (_factQueue) {
    await _factQueue.close();
    _factQueue = null;
  }
}
