import type { Pool } from 'pg';
import type { Redis } from 'ioredis';
import type { InboundMessage, MessageMedia, Channel } from '@grace/shared';
import { AIService, type AIServiceDeps } from '../services/ai.service.js';
import { MemoryService } from '../memory/memory.service.js';
import { UserService } from '../user/user.service.js';
import { RagService } from '../rag/rag.service.js';
import { UserMemoryService } from '../memory/user-memory.service.js';
import { MemoryMdService } from '../memory/memory-md.service.js';
import { ProductionIssuesService } from '../services/production-issues.service.js';
import type { GeminiEmbedder } from '../rag/gemini-embedder.js';
import { makeDryRunPool, type CapturedWrite } from './dry-run-pool.js';
import { makeDryRunRedis } from './dry-run-redis.js';

/**
 * Live Tester runner (2026-07-18) — the centerpiece of the internal debug
 * platform. Runs the REAL AIService.handleMessage pipeline against REAL user
 * data, but wired to the debug safety layer (DryRunPool + DryRunRedis + no
 * queues) so NOTHING is written, sent, or enqueued. Returns the exact reply plus
 * a full trace (intent, tool calls, latency waterfall, would-be DB writes).
 *
 * It does NOT reimplement any Grace logic — it constructs a second AIService from
 * the SAME deps as production, swapping only the write-side dependencies for
 * capturing equivalents. So its behavior is identical to production by
 * construction.
 */

/** A memory service that records appendTurn (for the latency waterfall) and
 *  never writes. Reads (ensureConversation/getRecentTurns) use the DryRunPool. */
class CapturingMemory extends MemoryService {
  readonly turns: Array<{ role: string; content: string; latencyMs?: number; intent?: string; stageTimings?: Record<string, number> }> = [];
  override async appendTurn(turn: {
    userId: string; role: 'user' | 'assistant'; content: string; conversationId: string;
    latencyMs?: number; intent?: string; stageTimings?: Record<string, number>;
  }): Promise<void> {
    this.turns.push({ role: turn.role, content: turn.content, latencyMs: turn.latencyMs, intent: turn.intent, stageTimings: turn.stageTimings });
  }
}

export interface LiveTestOptions {
  message: string;
  /** Real user phone (E.164). Their real profile/history/logs/memory are read. */
  userId: string;
  channel?: Channel;
  media?: MessageMedia[];
}

export interface LiveTestResult {
  reply: string;
  intent: string;
  confidence: string;
  usedRetrieval: boolean;
  regenerated: boolean;
  usedSafeFallback: boolean;
  critic?: unknown;
  totalLatencyMs: number;
  /** Per-stage timings (from the assistant turn's stage_timings), for the waterfall. */
  stageTimings: Record<string, number>;
  toolCalls: Array<{ name: string; ok: boolean; latencyMs?: number; args?: unknown; output?: unknown; error?: string }>;
  /** Every DB mutation the pipeline WOULD have made (never executed). */
  wouldWrite: CapturedWrite[];
  wouldWriteSummary: Array<{ table: string | null; op: string; count: number }>;
  model: { replyProvider: string; replyModel?: string; geminiModel: string; extractModel?: string };
  activeSystemPromptExcerpt: string | null;
  historyTurnsCaptured: number;
}

/** Building blocks captured from the production graph so the debug graph reuses
 *  the exact same LLM/RAG/prompt logic. */
export interface LiveTestFactoryDeps {
  aiDeps: AIServiceDeps;
  pool: Pool;
  redis: Redis;
  embedder: GeminiEmbedder;
  model: { replyProvider: string; replyModel?: string; geminiModel: string; extractModel?: string };
  loadActivePrompt: () => Promise<string | undefined>;
}

/** Create a runLiveTest closure bound to the production building blocks. */
export function createLiveTestRunner(deps: LiveTestFactoryDeps) {
  return async function runLiveTest(opts: LiveTestOptions): Promise<LiveTestResult> {
    const { pool, captures } = makeDryRunPool(deps.pool);
    const dryRedis = makeDryRunRedis(deps.redis);
    const { logger, llm } = deps.aiDeps;

    const memory = new CapturingMemory(pool);
    const users = new UserService(pool);
    const rag = new RagService(pool, deps.embedder, logger);
    const userMemory = new UserMemoryService(pool, deps.embedder, llm, logger);
    const memoryMd = new MemoryMdService(pool, logger);
    const productionIssues = new ProductionIssuesService(pool, logger);

    // Reuse EVERY production dep, override only the write-side ones + drop queues
    // (so no background job is enqueued) + swap pool/redis for the dry-run layer.
    const debugDeps: AIServiceDeps = {
      ...deps.aiDeps,
      pool,
      redis: dryRedis,
      memory,
      users,
      rag,
      userMemory,
      memoryMd,
      productionIssues,
      turnQueue: undefined,
      factExtractQueue: undefined,
      memoryMdQueue: undefined,
      systemPrompt: (await deps.loadActivePrompt()) ?? deps.aiDeps.systemPrompt,
    };

    const debugAi = new AIService(debugDeps);

    const media = opts.media ?? [];
    const inbound: InboundMessage = {
      userId: opts.userId,
      channel: opts.channel ?? 'imessage',
      text: opts.message,
      type: media.length > 0 ? (media[0]!.kind === 'audio' ? 'audio' : 'image') : 'text',
      media,
      providerMessageId: `debug-livetest-${Date.now()}`,
      receivedAt: new Date(),
    };

    const out = await debugAi.handleMessage(inbound);

    const assistantTurn = [...memory.turns].reverse().find((t) => t.role === 'assistant');
    const stageTimings = assistantTurn?.stageTimings ?? {};

    const wouldWriteSummary = Object.values(
      captures.reduce<Record<string, { table: string | null; op: string; count: number }>>((acc, w) => {
        const key = `${w.op}:${w.table}`;
        acc[key] ??= { table: w.table, op: w.op, count: 0 };
        acc[key]!.count += 1;
        return acc;
      }, {}),
    );

    const activePrompt = debugDeps.systemPrompt ?? null;

    return {
      reply: out.text,
      intent: out.intent,
      confidence: out.confidence,
      usedRetrieval: out.usedRetrieval,
      regenerated: !!out.regenerated,
      usedSafeFallback: !!out.usedSafeFallback,
      critic: out.critic,
      totalLatencyMs: out.latencyMs,
      stageTimings,
      toolCalls: (out.toolResults ?? []).map((t) => ({
        name: t.name,
        ok: t.ok,
        latencyMs: t.latencyMs,
        args: t.args,
        output: t.output,
        error: t.error,
      })),
      wouldWrite: captures,
      wouldWriteSummary,
      model: deps.model,
      activeSystemPromptExcerpt: activePrompt ? activePrompt.slice(0, 1200) : null,
      historyTurnsCaptured: memory.turns.filter((t) => t.role === 'user' || t.role === 'assistant').length,
    };
  };
}

export type LiveTestRunner = ReturnType<typeof createLiveTestRunner>;
