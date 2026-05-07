import type { Logger } from 'pino';
import type { Pool } from 'pg';
import type { Queue } from 'bullmq';
import type { InboundMessage, OrchestratorOutput } from '@grace/shared';
import { AIOrchestrator, ToolRegistry } from '@grace/ai-core';
import type { LLMProvider } from '@grace/shared';
import type { MemoryService } from '../memory/memory.service.js';
import type { RagService } from '../rag/rag.service.js';
import { classifyMessage } from '../safety/guard.js';
import { analyzeMedia } from '../multimodal/analyze.js';
import { makeLogFoodTool } from '../tools/log-food.js';
import { makeLogWeightTool } from '../tools/log-weight.js';
import { makeLogMoodTool } from '../tools/log-mood.js';
import { makeKnowledgeSearchTool } from '../tools/knowledge-search.js';
import type { TurnPersistJob } from '../workers/queues.js';

export interface AIServiceDeps {
  pool: Pool;
  llm: LLMProvider;
  memory: MemoryService;
  rag: RagService;
  logger: Logger;
  flags: { ragEnabled: boolean; toolsEnabled: boolean };
  geminiApiKey: string;
  geminiModel: string;
  turnQueue?: Queue<TurnPersistJob>;
  systemPrompt?: string;
}

export class AIService {
  private systemPrompt: string | undefined;

  constructor(private deps: AIServiceDeps) {
    this.systemPrompt = deps.systemPrompt;
  }

  updateSystemPrompt(prompt: string | undefined): void {
    this.systemPrompt = prompt;
    this.deps.logger.info({ hasPrompt: !!prompt }, 'system_prompt.updated');
  }

  async handleMessage(input: InboundMessage): Promise<OrchestratorOutput> {
    const { logger, memory, rag, flags } = this.deps;
    const t0 = Date.now();

    // Safety pre-check (deterministic, no LLM cost).
    const safety = classifyMessage(input.text);
    if (safety.class !== 'safe') {
      logger.warn({ userId: input.userId, class: safety.class, matched: safety.matched }, 'safety.flagged');
      return {
        text: safety.response!,
        confidence: 'high',
        intent: `safety_${safety.class}`,
        toolResults: [],
        usedRetrieval: false,
        latencyMs: Date.now() - t0,
      };
    }

    // Multimodal: if the message has media, fold a textual description into the prompt.
    let augmentedText = input.text;
    if (input.media.length > 0) {
      const description = await analyzeMedia(input.media, {
        apiKey: this.deps.geminiApiKey,
        model: this.deps.geminiModel,
        logger,
      });
      if (description) augmentedText = `${input.text}\n\n[media: ${description}]`.trim();
    }

    const conversationId = await memory.ensureConversation(input.userId);
    const history = await memory.getRecentTurns(input.userId, 12);
    const retrieved = flags.ragEnabled ? await rag.retrieve(augmentedText, { userId: input.userId, topK: 5 }) : [];

    // Per-request tool registry — tools close over userId.
    const tools = new ToolRegistry();
    if (flags.toolsEnabled) {
      tools.register(makeLogFoodTool({ pool: this.deps.pool, llm: this.deps.llm, logger, userId: input.userId }));
      tools.register(makeLogWeightTool({ pool: this.deps.pool, logger, userId: input.userId }));
      tools.register(makeLogMoodTool({ pool: this.deps.pool, logger, userId: input.userId }));
      tools.register(makeKnowledgeSearchTool({ rag, logger, userId: input.userId }));
    }
    const orchestrator = new AIOrchestrator({ llm: this.deps.llm, tools });

    const result = await orchestrator.run({
      userId: input.userId,
      text: augmentedText,
      history,
      retrieved,
      toolsEnabled: flags.toolsEnabled,
      systemPrompt: this.systemPrompt,
    });

    // Offload persistence to BullMQ (non-blocking) or fall back to fire-and-forget.
    if (this.deps.turnQueue) {
      void this.deps.turnQueue
        .add('persist', {
          userId: input.userId,
          conversationId,
          userText: input.text,
          assistantText: result.text,
          toolResults: result.toolResults,
        })
        .catch((err) => logger.warn({ err }, 'turn-queue.add.failed'));
    } else {
      void memory
        .appendTurn({ userId: input.userId, conversationId, role: 'user', content: input.text })
        .catch((err) => logger.warn({ err }, 'memory.append.user.failed'));
      void memory
        .appendTurn({ userId: input.userId, conversationId, role: 'assistant', content: result.text })
        .catch((err) => logger.warn({ err }, 'memory.append.assistant.failed'));
      for (const tr of result.toolResults) {
        void this.deps.pool
          .query(
            `INSERT INTO tool_logs (user_id, conversation_id, tool_name, args, ok, output, error, latency_ms)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [input.userId, conversationId, tr.name, JSON.stringify({}), tr.ok, JSON.stringify(tr.output ?? null), tr.error ?? null, tr.latencyMs],
          )
          .catch((err) => logger.warn({ err }, 'tool_logs.insert.failed'));
      }
    }

    logger.info(
      {
        userId: input.userId,
        intent: result.intent,
        confidence: result.confidence,
        latencyMs: result.latencyMs,
        totalMs: Date.now() - t0,
        retrievedCount: retrieved.length,
        mediaCount: input.media.length,
      },
      'ai.handle.ok',
    );

    return result;
  }
}
