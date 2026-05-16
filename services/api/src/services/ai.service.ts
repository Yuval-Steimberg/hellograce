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
  twilioSid?: string;
  twilioToken?: string;
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

    // Fire all independent I/O in parallel: user profile, conversation, history, tool settings,
    // and media analysis. RAG retrieval needs augmentedText so it runs after media completes.
    const twilioAuth = this.deps.twilioSid && this.deps.twilioToken
      ? { sid: this.deps.twilioSid, token: this.deps.twilioToken }
      : undefined;

    const mediaPromise: Promise<string | null> = input.media.length > 0
      ? analyzeMedia(input.media, {
          apiKey: this.deps.geminiApiKey,
          model: this.deps.geminiModel,
          logger,
          twilio: twilioAuth,
        })
      : Promise.resolve(null);

    const [user, conversationId, isNew, history, toolSettings, description, todaysFood, checkinsToday] = await Promise.all([
      users.getById(input.userId).catch(() => null),
      memory.ensureConversation(input.userId),
      users.isNewUser(input.userId).catch(() => false),
      memory.getRecentTurns(input.userId, 12),
      flags.toolsEnabled ? this.loadToolSettings() : Promise.resolve({} as Record<string, boolean>),
      mediaPromise,
      users.getTodaysFoodSummary(input.userId).catch(() => ({ protein_g: 0, calories: 0, items: [] })),
      this.countTodaysCheckIns(input.userId).catch(() => 0),
    ]);

    // Fold media description into the prompt (only after Promise.all resolves).
    let augmentedText = input.text;
    if (description) {
      const kind = input.media[0]?.kind;
      if (kind === 'audio' && !input.text) {
        augmentedText = `[Voice note — auto-transcribed, may have filler words or fragments. Respond naturally.]\n${description}`;
      } else if (kind === 'image') {
        const userIntent = input.text ? `The user said: "${input.text}"\n\n` : '';
        if (description.includes('IMAGE_TYPE: food')) {
          const foodArg = buildFoodLogArg(description);
          const confidence = description.match(/^CONFIDENCE:\s*(\w+)/m)?.[1]?.toLowerCase() ?? 'medium';
          const confidenceNote = confidence === 'low'
            ? ' (rough estimate — photo was unclear)'
            : confidence === 'medium' ? ' (rough estimate)' : '';
          augmentedText = `${userIntent}The user sent a meal photo. Here is the nutrition data for your reference only — do NOT repeat this breakdown to the user:\n\n${description}\n\n[REQUIRED: Call log_food with args {"food": ${JSON.stringify(foodArg)}} — pass this string EXACTLY. Then reply as Grace in 1–2 sentences max, conversational, no lists, no per-item breakdowns. Use the TOTAL protein number naturally. Example style: "That looks like about 30g of protein${confidenceNote}. You're at 55g today." NEVER output ITEMS/BREAKDOWN/TOTAL tables. Sound like a supportive friend, not a nutrition app.]`;
        } else if (description.includes('IMAGE_TYPE: body')) {
          augmentedText = `${userIntent}The user shared a body/progress photo. Analysis:\n\n${description}\n\n[Respond warmly and personally using the observations above. Tie it to their GLP-1 weight-loss journey and encourage them. CRITICAL: Do NOT mention pain, discomfort, injuries, or any medical conditions — this is a progress selfie, not a medical photo. Do NOT invent symptoms or anything not in the analysis above. Do NOT call any logging tools.]`;
        } else {
          augmentedText = `${userIntent}The user sent an image. ${description}`;
        }
      } else {
        augmentedText = `${input.text}\n\n[media: ${description}]`.trim();
      }
    } else if (input.media.length > 0 && !input.text) {
      // Analysis failed (or unsupported format) and user sent no caption — guard against
      // sending an empty string to the LLM which causes a 400 from Gemini.
      const kind = input.media[0]?.kind;
      if (kind === 'image') {
        augmentedText = "[The user sent a photo but the image could not be processed right now. Acknowledge warmly that you received their photo, apologize briefly that you couldn't analyze it today, and ask them to describe what they sent or to try again.]";
      } else if (kind === 'audio') {
        augmentedText = "[The user sent a voice message but it could not be transcribed right now. Acknowledge warmly, apologize briefly, and ask them to type what they were saying.]";
      } else {
        augmentedText = "[The user sent a file or attachment that could not be processed. Acknowledge warmly and ask them to describe what they wanted to share.]";
      }
    }

    // RAG retrieval runs on the augmented text (may include media context).
    const retrieved = flags.ragEnabled ? await rag.retrieve(augmentedText, { userId: input.userId, topK: 5 }) : [];

    // Detect side effects in the user's message and update their flow.
    if (user) await this.detectAndSetSideEffectFlow(user.phone, augmentedText, user.side_effect_flow);

    // Build personalised system prompt with user context.
    const systemPrompt = this.buildPersonalisedPrompt(user, isNew, { todaysFood, checkinsToday });

    // Per-request tool registry — tools close over userId.
    const tools = new ToolRegistry();
    if (flags.toolsEnabled) {
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
            [input.userId, conversationId, tr.name, JSON.stringify(tr.args ?? {}), tr.ok, JSON.stringify(tr.output ?? null), tr.error ?? null, tr.latencyMs],
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

  private async countTodaysCheckIns(userId: string): Promise<number> {
    const { rows } = await this.deps.pool.query<{ count: string }>(
      `SELECT count(*)::text FROM check_ins
       WHERE user_id = $1
         AND created_at::date = (now() AT TIME ZONE 'UTC')::date`,
      [userId],
    );
    return Number(rows[0]?.count ?? 0);
  }

  private buildPersonalisedPrompt(
    user: ReturnType<UserService['getById']> extends Promise<infer T> ? T : never,
    isNew: boolean,
    runtime?: { todaysFood?: { protein_g: number; calories: number; items: string[] }; checkinsToday?: number },
  ): string {
    const base = this.systemPrompt ?? undefined;

    const lines: string[] = [];
    if (user) {
      // Time-of-day and weekday awareness — always in user-local timezone, never UTC.
      const WEEK_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
      let localWeekday = '';
      let localTodayIdx = new Date().getDay(); // fallback: UTC (used only for injection day)
      try {
        const tz = user.timezone || 'America/New_York';
        const parts = new Intl.DateTimeFormat('en-US', {
          timeZone: tz, weekday: 'long', hour: '2-digit', hour12: false,
        }).formatToParts(new Date());
        localWeekday = parts.find((p) => p.type === 'weekday')?.value ?? '';
        const hour = parseInt(parts.find((p) => p.type === 'hour')?.value ?? '0', 10);
        const timeOfDay = hour < 5 ? 'night' : hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : hour < 21 ? 'evening' : 'night';
        if (localWeekday) {
          lines.push(`Today is: ${localWeekday}`);
          // Use the user-local weekday for all day-of-week calculations so that
          // midnight-boundary users (e.g. West Coast at 11pm = UTC next day) see the right day.
          localTodayIdx = WEEK_DAYS.indexOf(localWeekday);
          if (localTodayIdx === -1) localTodayIdx = new Date().getDay();
        }
        lines.push(`Time of day for this user right now: ${timeOfDay}`);
      } catch {
        // Fall back silently if timezone is malformed.
      }
      if (user.first_name) lines.push(`Name: ${user.first_name}`);
      if (user.medication) lines.push(`Medication: ${user.medication}`);
      // Surface medication type so the prompt's "Weekly injection / Daily pill /
      // Daily injection" branching can fire correctly.
      const med = (user.medication || '').toLowerCase();
      let medType = 'unknown';
      if (/rybelsus/.test(med)) medType = 'daily_pill';
      else if (/saxenda|victoza|liraglutide/.test(med)) medType = 'daily_injection';
      else if (/ozempic|wegovy|mounjaro|zepbound|semaglutide|tirzepatide/.test(med)) medType = 'weekly_injection';
      lines.push(`Medication type: ${medType}`);
      if (user.goals.length > 0) lines.push(`Goals: ${user.goals.join(', ')}`);
      if (user.food_dislikes.length > 0) {
        const clean = user.food_dislikes
          .map((d) => d.replace(/^(i\s+(don'?t|do\s+not|hate|can'?t\s+stand|dislike)\s+(like\s+)?|no\s+|avoid\s+)/i, '').trim())
          .filter(Boolean);
        lines.push(`Food dislikes — NEVER suggest these, paraphrase naturally (don't echo verbatim): ${clean.join(', ')}`);
      }
      if (user.injection_day) {
        const injIdx = WEEK_DAYS.indexOf(user.injection_day);
        let injStatus = user.injection_day;
        if (injIdx !== -1) {
          let diff = injIdx - localTodayIdx;
          if (diff < 0) diff += 7;
          if (diff === 0) injStatus = `TODAY (${user.injection_day}) — injection day`;
          else if (diff === 1) injStatus = `TOMORROW (${user.injection_day}) — injection day is tomorrow`;
          else if (diff === 6) injStatus = `YESTERDAY (${user.injection_day}) — injection was yesterday`;
          else injStatus = `in ${diff} days (${user.injection_day})`;
        }
        lines.push(`INJECTION DAY STATUS: ${injStatus}`);
      }
      if (user.current_weight && user.goal_weight) {
        const gap = Math.abs(user.current_weight - user.goal_weight);
        lines.push(`Weight: ${user.current_weight} lbs → goal ${user.goal_weight} lbs (${gap.toFixed(0)} lbs to go)`);
      } else if (user.current_weight) {
        lines.push(`Current weight: ${user.current_weight} lbs`);
      }
      if (user.height_cm) lines.push(`Height: ${user.height_cm} cm`);
      if (user.age) lines.push(`Age: ${user.age}`);
      if (user.primary_goal) lines.push(`Primary goal: ${user.primary_goal.replace('_', ' ')}`);
      if (user.protein_goal_grams) {
        lines.push(`Personal daily protein target: ${user.protein_goal_grams}g — use THIS number, not a generic 80g.`);
      }
      if (user.glp1_start_date) {
        const weeksOn = Math.floor((Date.now() - new Date(user.glp1_start_date).getTime()) / (7 * 24 * 3_600_000));
        if (weeksOn >= 0) lines.push(`GLP-1 week: Week ${weeksOn + 1} (started ${new Date(user.glp1_start_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })})`);
      }
      if (user.grace_notes) lines.push(`Grace's notes about this user: ${user.grace_notes}`);
      if (user.low_mood_mode) lines.push('LOW MOOD MODE: user has been struggling recently — lead with encouragement and warmth, no reflection prompts.');
      if (user.protein_focus_boost) lines.push('User struggles with protein intake — nudge toward protein-rich options when relevant.');
      if (user.hydration_struggle) lines.push('User struggles with hydration — gently mention water when relevant.');

      // Frequency + today's send count — used by the prompt's "HOW GRACE EXPLAINS
      // CHECK-INS" section so Grace can answer "how many today?" with the exact
      // number instead of a vague "a couple."
      if (user.checkin_count_per_day) {
        lines.push(`CHECKIN FREQUENCY: ${user.checkin_count_per_day} scheduled check-in(s) per day`);
      }
      if (runtime?.checkinsToday !== undefined) {
        lines.push(`Scheduled check-ins sent today: ${runtime.checkinsToday}`);
      }
      if (runtime?.todaysFood) {
        const f = runtime.todaysFood;
        lines.push(`Total protein TODAY: ${f.protein_g}g${f.calories ? ` (${f.calories} kcal)` : ''}`);
        if (f.items.length > 0) lines.push(`Foods logged today: ${f.items.slice(0, 8).join('; ')}`);
      }
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

// Build a compact food string from a Gemini food-image analysis block so the
// planner can pass it verbatim as the `food` arg to log_food — guaranteeing
// the pre-calculated TOTAL is used instead of being re-estimated.
function buildFoodLogArg(analysis: string): string {
  const items = analysis.match(/^ITEMS:\s*(.+)$/m)?.[1]?.trim() ?? '';
  const total = analysis.match(/^TOTAL:\s*(.+)$/m)?.[1]?.trim() ?? '';
  if (items && total) return `${items}. ${total}`;
  if (total) return total;
  if (items) return items;
  return analysis.replace(/IMAGE_TYPE: food\n?/i, '').trim().slice(0, 400);
}
