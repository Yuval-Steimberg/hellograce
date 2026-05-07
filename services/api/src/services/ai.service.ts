import type { Logger } from 'pino';
import type { Pool } from 'pg';
import type { Queue } from 'bullmq';
import type { InboundMessage, OrchestratorOutput } from '@grace/shared';
import { AIOrchestrator, ToolRegistry } from '@grace/ai-core';
import type { LLMProvider } from '@grace/shared';
import type { MemoryService } from '../memory/memory.service.js';
import type { RagService } from '../rag/rag.service.js';
import type { UserService } from '../user/user.service.js';
import { classifyMessage } from '../safety/guard.js';
import { analyzeMedia } from '../multimodal/analyze.js';
import { makeLogFoodTool } from '../tools/log-food.js';
import { makeLogWeightTool } from '../tools/log-weight.js';
import { makeLogMoodTool } from '../tools/log-mood.js';
import { makeKnowledgeSearchTool } from '../tools/knowledge-search.js';
import { makeGetUserProfileTool } from '../tools/get-user-profile.js';
import { makeGetWeightTrendTool } from '../tools/get-weight-trend.js';
import { makeGetFoodSummaryTool } from '../tools/get-food-summary.js';
import { makeLogSideEffectTool } from '../tools/log-side-effect.js';
import type { TurnPersistJob } from '../workers/queues.js';

const SIDE_EFFECT_KEYWORDS: Record<string, string> = {
  nausea: 'nausea',
  nauseous: 'nausea',
  sick: 'nausea',
  queasy: 'nausea',
  vomit: 'nausea',
  throwing: 'nausea',
  constipat: 'constipation',
  backed: 'constipation',
  bloated: 'constipation',
  fatigue: 'fatigue',
  exhausted: 'fatigue',
  tired: 'fatigue',
  'no energy': 'fatigue',
};

export interface AIServiceDeps {
  pool: Pool;
  llm: LLMProvider;
  memory: MemoryService;
  rag: RagService;
  users: UserService;
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
    const { logger, memory, rag, flags, users } = this.deps;
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

    // Load user profile for personalisation.
    const user = await users.getById(input.userId).catch(() => null);

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
    const isNew = await users.isNewUser(input.userId).catch(() => false);
    const history = await memory.getRecentTurns(input.userId, 12);
    const retrieved = flags.ragEnabled ? await rag.retrieve(augmentedText, { userId: input.userId, topK: 5 }) : [];

    // Detect side effects in the user's message and update their flow.
    if (user) await this.detectAndSetSideEffectFlow(user.phone, augmentedText, user.side_effect_flow);

    // Build personalised system prompt with user context.
    const systemPrompt = this.buildPersonalisedPrompt(user, isNew);

    // Per-request tool registry — tools close over userId.
    const tools = new ToolRegistry();
    if (flags.toolsEnabled) {
      const toolSettings = await this.loadToolSettings();
      if (toolSettings['log_food'] !== false) {
        tools.register(makeLogFoodTool({ pool: this.deps.pool, llm: this.deps.llm, logger, userId: input.userId }));
      }
      if (toolSettings['log_weight'] !== false) {
        tools.register(makeLogWeightTool({ pool: this.deps.pool, logger, userId: input.userId }));
      }
      if (toolSettings['log_mood'] !== false) {
        tools.register(makeLogMoodTool({ pool: this.deps.pool, logger, userId: input.userId }));
      }
      if (toolSettings['knowledge_search'] !== false) {
        tools.register(makeKnowledgeSearchTool({ rag, logger, userId: input.userId }));
      }
      if (toolSettings['get_user_profile'] !== false) {
        tools.register(makeGetUserProfileTool({ users, userId: input.userId }));
      }
      if (toolSettings['get_weight_trend'] !== false) {
        tools.register(makeGetWeightTrendTool({ users, userId: input.userId }));
      }
      if (toolSettings['get_food_summary'] !== false) {
        tools.register(makeGetFoodSummaryTool({ users, userId: input.userId }));
      }
      if (toolSettings['log_side_effect'] !== false) {
        tools.register(makeLogSideEffectTool({ users, userId: input.userId, phone: user?.phone ?? input.userId }));
      }
    }
    const orchestrator = new AIOrchestrator({ llm: this.deps.llm, tools });

    const result = await orchestrator.run({
      userId: input.userId,
      text: isNew ? `[FIRST MESSAGE — greet the user warmly] ${augmentedText}` : augmentedText,
      history,
      retrieved,
      toolsEnabled: flags.toolsEnabled,
      systemPrompt,
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
        isNew,
      },
      'ai.handle.ok',
    );

    return result;
  }

  private buildPersonalisedPrompt(user: ReturnType<UserService['getById']> extends Promise<infer T> ? T : never, isNew: boolean): string {
    const base = this.systemPrompt ?? undefined;

    const lines: string[] = [];
    if (user) {
      if (user.first_name) lines.push(`User's name: ${user.first_name}`);
      if (user.medication) lines.push(`Medication: ${user.medication}`);
      if (user.goals.length > 0) lines.push(`Goals: ${user.goals.join(', ')}`);
      if (user.food_dislikes.length > 0) lines.push(`Food they dislike: ${user.food_dislikes.join(', ')}`);
      if (user.injection_day) lines.push(`Injection day: ${user.injection_day}`);
      if (user.current_weight) lines.push(`Current weight: ${user.current_weight} lbs`);
      if (user.goal_weight) lines.push(`Goal weight: ${user.goal_weight} lbs`);
      if (user.grace_notes) lines.push(`Notes: ${user.grace_notes}`);
      if (user.low_mood_mode) lines.push('User has been in low-mood mode recently — be extra gentle and encouraging.');
      if (user.protein_focus_boost) lines.push('User struggles with protein intake — nudge toward protein-rich options.');
      if (user.hydration_struggle) lines.push('User struggles with hydration — gently remind about water when relevant.');
    }

    if (isNew) lines.push('This is the user\'s FIRST message. Welcome them warmly and personally.');

    if (lines.length === 0) return base ?? '';
    return `${base ?? ''}\n\n--- User context ---\n${lines.join('\n')}`;
  }

  private async loadToolSettings(): Promise<Record<string, boolean>> {
    try {
      const { rows } = await this.deps.pool.query<{ tool_name: string; enabled: boolean }>(
        `SELECT tool_name, enabled FROM tool_settings`,
      );
      return Object.fromEntries(rows.map((r) => [r.tool_name, r.enabled]));
    } catch {
      return {}; // If table doesn't exist yet, all tools enabled
    }
  }

  private async detectAndSetSideEffectFlow(phone: string, text: string, currentFlow: string | null): Promise<void> {
    if (currentFlow) return; // already tracking a flow
    const lower = text.toLowerCase();
    for (const [keyword, flow] of Object.entries(SIDE_EFFECT_KEYWORDS)) {
      if (lower.includes(keyword)) {
        await this.deps.users.update(phone, {
          side_effect_flow: flow,
          side_effect_flow_started_at: new Date(),
          side_effect_followup_sent: false,
        }).catch(() => null);
        return;
      }
    }
  }
}
