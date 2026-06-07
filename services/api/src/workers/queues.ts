import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import type { ToolResult } from '@grace/shared';

export interface TurnPersistJob {
  userId: string;
  conversationId: string;
  userText: string;
  assistantText: string;
  toolResults: ToolResult[];
  /** Classified message intent — drives /admin/latency per-category breakdowns. */
  intent?: string;
  /** End-to-end latency for the assistant turn (ms). */
  latencyMs?: number;
  /** Per-stage breakdown for slow-request diagnosis. */
  stageTimings?: Record<string, number>;
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

/**
 * Background memory.md update job (Phase D, 2026-06-07). Fires after each
 * assistant turn for users enrolled in the memory.md pilot. The worker
 * loads current memory.md, sends it + the new user/assistant exchange to
 * Gemini, and rewrites the file to reflect any new durable facts /
 * corrections / open threads. Best-effort, fire-and-forget.
 */
export interface MemoryMdUpdateJob {
  userId: string;
  userText: string;
  assistantText: string;
}

let _turnQueue: Queue<TurnPersistJob> | null = null;
let _factQueue: Queue<FactExtractJob> | null = null;
let _memoryMdQueue: Queue<MemoryMdUpdateJob> | null = null;

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

export function getMemoryMdQueue(redis: Redis): Queue<MemoryMdUpdateJob> {
  if (!_memoryMdQueue) {
    _memoryMdQueue = new Queue<MemoryMdUpdateJob>('memory-md-update', {
      connection: redis,
      defaultJobOptions: {
        removeOnComplete: 200,
        removeOnFail: 50,
        // Best-effort — one retry. If the LLM rewrite is flaky for a turn,
        // the next turn will pick up where we left off.
        attempts: 2,
        backoff: { type: 'exponential', delay: 2_000 },
      },
    });
  }
  return _memoryMdQueue;
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
  if (_memoryMdQueue) {
    await _memoryMdQueue.close();
    _memoryMdQueue = null;
  }
}
