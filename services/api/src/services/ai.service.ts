import type { Logger } from 'pino';
import type { Pool } from 'pg';
import type { Queue } from 'bullmq';
import type { DietaryRestriction, InboundMessage, OrchestratorOutput } from '@grace/shared';
import { AIOrchestrator, ToolRegistry } from '@grace/ai-core';
import type { LLMProvider } from '@grace/shared';
import type { MemoryService } from '../memory/memory.service.js';
import type { RagService } from '../rag/rag.service.js';
import type { UserService } from '../user/user.service.js';
import type { ContentRulesService } from './content-rules.service.js';
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
import { makeSearchFoodIdeasTool } from '../tools/search-food-ideas.js';
import { makeRemoveFoodTool } from '../tools/remove-food.js';
import type { TurnPersistJob, FactExtractJob } from '../workers/queues.js';

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
  factExtractQueue?: Queue<FactExtractJob>;
  systemPrompt?: string;
  contentRulesService?: ContentRulesService;
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

    const [user, conversationId, isNew, history, toolSettings, description, todaysFood, checkinsToday, knownFacts] = await Promise.all([
      users.getById(input.userId).catch(() => null),
      memory.ensureConversation(input.userId),
      users.isNewUser(input.userId).catch(() => false),
      memory.getRecentTurns(input.userId, 12),
      flags.toolsEnabled ? this.loadToolSettings() : Promise.resolve({} as Record<string, boolean>),
      mediaPromise,
      users.getTodaysFoodSummary(input.userId).catch(() => ({ protein_g: 0, calories: 0, items: [] })),
      this.countTodaysCheckIns(input.userId).catch(() => 0),
      users.getKnownFacts(input.userId, 30).catch(() => []),
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
          augmentedText = `${userIntent}The user sent a meal photo. Internal nutrition data for your reference ONLY — never recite this breakdown:\n\n${description}\n\n[REQUIRED:
1. Call log_food with args {"food": ${JSON.stringify(foodArg)}} — pass this string EXACTLY.
2. Reply in 1–2 short sentences using the TOTAL protein number naturally. Example: "That looks like about 30g of protein${confidenceNote}. You're at 55g today."
NEVER ask the user to specify portions, grams, ounces, or what's in the photo — the estimate is already done. NEVER output ITEMS/BREAKDOWN/TOTAL tables. NEVER list per-item macros. Sound like a supportive friend, not a nutrition app. If confidence was low, you may add ONE light human clarifier (e.g. "Was that a snack or a full plate?") — never a quantity question.]`;
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

    // Detect dietary restrictions stated in this conversation OR in stored facts.
    // This drives a hard top-of-prompt banner that the 71k-char system prompt's
    // nested rule can't reliably enforce on its own (Gemini Flash parrots the
    // example templates that include "chicken or tuna at lunch").
    //
    // We also pass the persisted column (users.dietary_pattern) so that even
    // when the BullMQ turn-persist worker is behind and history doesn't yet
    // contain the user's "I'm vegetarian" message, we still fail-safe.
    const dietaryRestriction = detectDietaryRestriction(
      history,
      knownFacts,
      input.text,
      user?.dietary_pattern ?? null,
    );

    // If detection found a restriction AND the user record doesn't already
    // have it persisted, write it now. This is fire-and-forget — we don't
    // need to await it for the current request because we already have
    // `dietaryRestriction` in scope, but writing closes the race for the
    // user's NEXT message.
    if (dietaryRestriction && user?.phone) {
      const newLabel = dietaryRestriction.label.toLowerCase();
      if (user.dietary_pattern !== newLabel) {
        void users
          .setDietaryPattern(user.phone, newLabel)
          .catch((err) => logger.warn({ err, phone: user.phone }, 'dietary_pattern.persist.failed'));
      }
    }

    // Medication type — drives the medication-contradiction guard
    // (so Grace doesn't say "injection day" to a Rybelsus user).
    const medicationType = inferMedicationType(user?.medication ?? null);

    // Response modality — drives modality-specific guards (body-photo
    // medical-leak, etc.). Image type comes from analyzeMedia's classifier.
    let responseMode: 'text' | 'image_food' | 'image_body' | 'voice' = 'text';
    if (input.media.some((m) => m.kind === 'audio')) {
      responseMode = 'voice';
    } else if (input.media.some((m) => m.kind === 'image')) {
      if (description?.includes('IMAGE_TYPE: body')) responseMode = 'image_body';
      else if (description?.includes('IMAGE_TYPE: food')) responseMode = 'image_food';
    }

    // Clean food dislikes for the content checker — strip natural-language
    // prefixes the same way buildPersonalisedPrompt does.
    const cleanFoodDislikes = (user?.food_dislikes ?? [])
      .map((d) => d.replace(/^(i\s+(don'?t|do\s+not|hate|can'?t\s+stand|dislike)\s+(like\s+)?|no\s+|avoid\s+)/i, '').trim())
      .filter(Boolean);

    // Build personalised system prompt with user context.
    const systemPrompt = this.buildPersonalisedPrompt(user, isNew, { todaysFood, checkinsToday, knownFacts, dietaryRestriction });

    // Track which modality drove this request so log_food rows are tagged
    // correctly (text vs image vs voice) — used by analytics + dedup.
    const logFoodSource: 'text' | 'image' | 'voice' =
      input.media.some((m) => m.kind === 'image') ? 'image'
      : input.media.some((m) => m.kind === 'audio') ? 'voice'
      : 'text';

    // Per-request tool registry — tools close over userId.
    const tools = new ToolRegistry();
    if (flags.toolsEnabled) {
      if (toolSettings['log_food'] !== false) {
        tools.register(makeLogFoodTool({ pool: this.deps.pool, llm: this.deps.llm, logger, userId: input.userId, source: logFoodSource }));
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
      if (toolSettings['search_food_ideas'] !== false) {
        tools.register(makeSearchFoodIdeasTool({ llm: this.deps.llm, logger, userId: input.userId }));
      }
      if (toolSettings['remove_food'] !== false) {
        tools.register(makeRemoveFoodTool({ pool: this.deps.pool, logger, userId: input.userId }));
      }
    }
    const orchestrator = new AIOrchestrator({ llm: this.deps.llm, tools });

    // Load DB content rules (60s cache — effectively free after first call).
    const dbRules = this.deps.contentRulesService
      ? await this.deps.contentRulesService.getActive('ai')
      : [];

    const result = await orchestrator.run({
      userId: input.userId,
      text: isNew ? `[FIRST MESSAGE — greet the user warmly] ${augmentedText}` : augmentedText,
      history,
      retrieved,
      toolsEnabled: flags.toolsEnabled,
      systemPrompt,
      ...(dietaryRestriction ? { dietaryRestriction } : {}),
      ...(user?.first_name ? { userFirstName: user.first_name } : {}),
      ...(cleanFoodDislikes.length > 0 ? { foodDislikes: cleanFoodDislikes } : {}),
      medicationType,
      responseMode,
      isFirstMessage: isNew,
      ...(dbRules.length > 0 ? { dbRules } : {}),
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
    }

    // Progressive profiling: extract durable facts from the user's message in
    // the background. Skip empty/very short messages and any media-only turns
    // (the worker also filters but this saves an enqueue + LLM call).
    if (this.deps.factExtractQueue && input.text.trim().length >= 15) {
      void this.deps.factExtractQueue
        .add('extract', { userId: input.userId, userText: input.text })
        .catch((err) => logger.warn({ err }, 'fact-extract-queue.add.failed'));
    }

    if (!this.deps.turnQueue) {
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
    // User's calendar day, not UTC — same fix as getTodaysFoodSummary.
    const { rows } = await this.deps.pool.query<{ count: string }>(
      `WITH user_tz AS (
         SELECT COALESCE(NULLIF(timezone, ''), 'UTC') AS tz
         FROM users WHERE phone = $1
       )
       SELECT count(*)::text FROM check_ins, user_tz
       WHERE user_id = $1
         AND (created_at AT TIME ZONE user_tz.tz)::date
             = (now() AT TIME ZONE user_tz.tz)::date`,
      [userId],
    );
    return Number(rows[0]?.count ?? 0);
  }

  private buildPersonalisedPrompt(
    user: ReturnType<UserService['getById']> extends Promise<infer T> ? T : never,
    isNew: boolean,
    runtime?: {
      todaysFood?: { protein_g: number; calories: number; items: string[] };
      checkinsToday?: number;
      knownFacts?: Array<{ fact: string; category: string; confidence: string }>;
      dietaryRestriction?: DietaryRestriction | null;
    },
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
      lines.push(`Medication type: ${inferMedicationType(user.medication)}`);
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
      if (user.sex) lines.push(`Sex: ${user.sex.replace('_', ' ')}`);
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

      // Schedule context — lets Grace answer "what time is my next reminder?" accurately.
      if (user.wake_time) {
        const [wh, wm] = user.wake_time.split(':').map(Number);
        const morningLabel = formatHour(wh!, wm!);
        let eveningMin = -1;
        let eveningLabel = '';
        if (user.sleep_time) {
          const [sh, sm] = user.sleep_time.split(':').map(Number);
          eveningMin = sh! * 60 + sm! - 90;
          eveningLabel = formatHour(Math.floor(eveningMin / 60), eveningMin % 60);
          lines.push(`Wake time: ${morningLabel} | Sleep time: ${formatHour(sh!, sm!)}`);
          lines.push(`Reminder schedule: morning ~${morningLabel} | midday Mon/Wed/Fri ~11am-2pm | evening Tue/Thu/Sun ~${eveningLabel}`);
        } else {
          lines.push(`Wake time: ${morningLabel}`);
        }
        // Compute next reminder explicitly in code so Grace never has to reason about
        // which window has passed — she just reads the pre-computed label.
        try {
          const tz = user.timezone || 'America/New_York';
          const timeParts = new Intl.DateTimeFormat('en-US', {
            timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
          }).formatToParts(new Date());
          const nowH = parseInt(timeParts.find((p) => p.type === 'hour')?.value ?? '0', 10);
          const nowM = parseInt(timeParts.find((p) => p.type === 'minute')?.value ?? '0', 10);
          const nowMin = nowH * 60 + nowM;
          const wakeMin = wh! * 60 + wm!;

          // On injection day the entire regular schedule (morning/midday/evening)
          // is replaced by the injection flow. Surface this explicitly so Grace
          // gives an accurate answer instead of quoting the regular schedule.
          const WEEK_DAYS_LOCAL = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
          const todayIsInjectionDay = user.injection_day && user.injection_day === WEEK_DAYS_LOCAL[localTodayIdx];
          if (todayIsInjectionDay) {
            const morningPast = nowMin > wakeMin + 60;
            const nextInj = morningPast
              ? `later today or this evening (injection day follow-up)`
              : `this morning around ${morningLabel} (injection day message)`;
            lines.push(`Next scheduled reminder: ${nextInj}`);
            lines.push(`Injection day note: today's regular morning/midday/evening check-ins are REPLACED by injection-specific messages. Do NOT say regular check-ins are coming — they are not.`);
          } else {
            // Evening days: Sun(0), Tue(2), Thu(4). Midday days: Mon(1), Wed(3), Fri(5).
            const isEveningDay = [0, 2, 4].includes(localTodayIdx);
            const isMiddayDay = [1, 3, 5].includes(localTodayIdx);
            // Generous buffer: morning window closes 60 min after wake_time to
            // avoid flip-flopping if the message fires slightly late.
            const morningPast = nowMin > wakeMin + 60;
            const middayPast = nowMin > 14 * 60; // after 2pm, midday window closed
            const eveningPast = eveningMin > 0 && nowMin > eveningMin;
            let nextReminder: string;
            if (!morningPast) {
              nextReminder = `this morning around ${morningLabel}`;
            } else if (isMiddayDay && !middayPast) {
              nextReminder = `today around midday (11am-2pm window)`;
            } else if (isEveningDay && eveningMin > 0 && !eveningPast) {
              nextReminder = `this evening around ${eveningLabel}`;
            } else {
              nextReminder = `tomorrow morning around ${morningLabel}`;
            }
            lines.push(`Next scheduled reminder: ${nextReminder}`);
          }
        } catch {
          // ignore — best-effort
        }
      }

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

    // Progressive profiling: durable facts extracted from past conversations.
    // Grouped by category so Grace can scan them quickly. The master prompt
    // already tells her to use these subtly — never read them back verbatim,
    // never say "according to your profile".
    const factsBlock = runtime?.knownFacts && runtime.knownFacts.length > 0
      ? renderKnownFactsBlock(runtime.knownFacts)
      : '';

    // TOP-OF-PROMPT dietary banner — comes BEFORE the base prompt so the LLM
    // reads it first. The system prompt's nested dietary rule alone isn't
    // enough; this banner is short, explicit, and deterministic.
    const dietBanner = runtime?.dietaryRestriction
      ? buildDietaryBanner(runtime.dietaryRestriction) + '\n\n'
      : '';

    if (lines.length === 0 && !factsBlock) return `${dietBanner}${base ?? ''}`;
    const userCtx = lines.length > 0 ? `\n\n--- User context ---\n${lines.join('\n')}` : '';
    const factsCtx = factsBlock ? `\n\n--- What Grace has naturally learned about this user ---\n${factsBlock}\nUse these subtly. Never read them back mechanically. Never say "according to your profile."` : '';
    return `${dietBanner}${base ?? ''}${userCtx}${factsCtx}`;
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

// Render durable facts as a compact, grouped, scannable block.
// Categories ordered by prompt-relevance: diet/aversion/symptom first, since
// they directly affect food recommendations.
const FACT_LABELS: Record<string, string> = {
  diet: 'Diet',
  aversion: 'Food aversions',
  symptom: 'Symptoms / tolerances',
  preference: 'Food preferences',
  schedule: 'Schedule / routines',
  exercise: 'Exercise',
  social: 'Social / eating habits',
  other: 'Other',
};
const FACT_CATEGORY_ORDER = ['diet', 'aversion', 'symptom', 'preference', 'schedule', 'exercise', 'social', 'other'];

function renderKnownFactsBlock(
  facts: Array<{ fact: string; category: string; confidence: string }>,
): string {
  const byCategory = new Map<string, string[]>();
  for (const f of facts) {
    const cat = FACT_LABELS[f.category] ? f.category : 'other';
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat)!.push(f.fact);
  }
  const out: string[] = [];
  for (const cat of FACT_CATEGORY_ORDER) {
    const items = byCategory.get(cat);
    if (!items || items.length === 0) continue;
    out.push(`${FACT_LABELS[cat]}: ${items.join('; ')}`);
  }
  return out.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Dietary restriction detection
//
// Gemini Flash repeatedly ignores the system prompt's "honor vegetarian"
// rule because the prompt's own food-recommendation EXAMPLES include
// "chicken or tuna at lunch" and the LLM parrots them. The fix is a
// deterministic top-of-prompt banner that lists the exact forbidden foods.
// ─────────────────────────────────────────────────────────────────────────────

const VEGETARIAN_FORBIDDEN = [
  'chicken', 'turkey', 'beef', 'pork', 'lamb', 'veal', 'duck', 'goat',
  'fish', 'tuna', 'salmon', 'cod', 'tilapia', 'sardines', 'anchovies',
  'shrimp', 'prawns', 'crab', 'lobster', 'scallops', 'oysters', 'mussels', 'clams',
  'bacon', 'ham', 'sausage', 'pepperoni', 'salami', 'prosciutto', 'jerky',
  'meat', 'poultry', 'seafood',
  // Eggs are excluded by many vegetarians (lacto-vegetarian, strict/Hindu vegetarian).
  // Safer to omit and let users ask specifically if they eat eggs.
  'eggs',
];
const VEGAN_FORBIDDEN = [
  ...VEGETARIAN_FORBIDDEN,
  'eggs', 'cheese', 'yogurt', 'milk', 'butter', 'cream', 'whey', 'casein',
  'gelatin', 'honey', 'dairy', 'cottage cheese', 'greek yogurt',
];
const PESCATARIAN_FORBIDDEN = [
  'chicken', 'turkey', 'beef', 'pork', 'lamb', 'veal', 'duck', 'goat',
  'bacon', 'ham', 'sausage', 'pepperoni', 'salami', 'prosciutto', 'jerky',
  'meat', 'poultry',
];

const VEGETARIAN_ALLOWED = [
  'Greek yogurt', 'cottage cheese', 'cheese', 'milk', 'edamame',
  'tofu', 'tempeh', 'seitan', 'lentils', 'beans', 'chickpeas',
  'quinoa', 'nuts', 'nut butters', 'protein shake (whey or plant)',
];
const VEGAN_ALLOWED = [
  'tofu', 'tempeh', 'seitan', 'lentils', 'beans', 'chickpeas',
  'edamame', 'quinoa', 'nuts', 'nut butters', 'plant-based protein shake',
  'pea protein', 'soy milk', 'almond milk', 'oat milk',
];
const PESCATARIAN_ALLOWED = [
  'salmon', 'tuna', 'cod', 'shrimp', 'sardines', 'Greek yogurt',
  'cottage cheese', 'eggs', 'tofu', 'lentils', 'beans', 'protein shake',
];

/**
 * Map a medication name (free-text on the user record) to one of the four
 * categories the content-checker recognizes. Single source of truth — used
 * by buildPersonalisedPrompt and the orchestrator call.
 */
function formatHour(h: number, m: number): string {
  const period = h < 12 ? 'am' : 'pm';
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return m === 0 ? `${h12}${period}` : `${h12}:${String(m).padStart(2, '0')}${period}`;
}

export function inferMedicationType(
  medication: string | null,
): 'weekly_injection' | 'daily_pill' | 'daily_injection' | 'unknown' {
  if (!medication) return 'unknown';
  const med = medication.toLowerCase();
  if (/rybelsus/.test(med)) return 'daily_pill';
  if (/saxenda|victoza|liraglutide/.test(med)) return 'daily_injection';
  if (/ozempic|wegovy|mounjaro|zepbound|semaglutide|tirzepatide/.test(med)) {
    return 'weekly_injection';
  }
  return 'unknown';
}

/**
 * Build a DietaryRestriction object from a known label. Used both by the
 * regex-detection path AND the persisted-column path (user.dietary_pattern).
 * Centralizing here means the forbidden/allowed lists stay in sync.
 */
export function buildRestrictionFromLabel(label: string): DietaryRestriction | null {
  switch (label.toLowerCase()) {
    case 'vegan':
      return { label: 'VEGAN', forbidden: VEGAN_FORBIDDEN, allowed: VEGAN_ALLOWED };
    case 'vegetarian':
      return { label: 'VEGETARIAN', forbidden: VEGETARIAN_FORBIDDEN, allowed: VEGETARIAN_ALLOWED };
    case 'pescatarian':
    case 'pescetarian':
      return { label: 'PESCATARIAN', forbidden: PESCATARIAN_FORBIDDEN, allowed: PESCATARIAN_ALLOWED };
    default:
      return null;
  }
}

export function detectDietaryRestriction(
  history: Array<{ role: string; content: string }>,
  knownFacts: Array<{ fact: string; category: string }>,
  currentText: string,
  /** Optional pre-existing pattern stored on the user record. Wins if the
   *  current message doesn't override it. */
  persistedPattern?: string | null,
): DietaryRestriction | null {
  const userTurns = history
    .filter((m) => m.role === 'user')
    .map((m) => m.content);
  const factTexts = knownFacts
    .filter((f) => f.category === 'diet' || f.category === 'aversion')
    .map((f) => f.fact);
  const corpus = [currentText, ...userTurns, ...factTexts].join(' \n ').toLowerCase();

  // Check vegan first (most restrictive). "Plant-based" is treated as vegan
  // for safety — better to recommend a vegan option to a vegetarian than meat
  // to a vegan.
  const veganPattern = /\b(i'?m\s+(a\s+)?vegan|i\s+am\s+vegan|going\s+vegan|i\s+eat\s+vegan|plant[\s-]?based|no\s+animal\s+products|strictly\s+vegan)\b/;
  if (veganPattern.test(corpus)) {
    return { label: 'VEGAN', forbidden: VEGAN_FORBIDDEN, allowed: VEGAN_ALLOWED };
  }

  const vegetarianPattern = /\b(i'?m\s+(a\s+)?vegetarian|i\s+am\s+vegetarian|i\s+don'?t\s+eat\s+meat|i\s+do\s+not\s+eat\s+meat|no\s+meat|meat[\s-]?free|i'?m\s+veggie)\b/;
  if (vegetarianPattern.test(corpus)) {
    return { label: 'VEGETARIAN', forbidden: VEGETARIAN_FORBIDDEN, allowed: VEGETARIAN_ALLOWED };
  }

  const pescatarianPattern = /\b(i'?m\s+(a\s+)?pesc[ae]tarian|i\s+only\s+eat\s+fish|fish\s+only)\b/;
  if (pescatarianPattern.test(corpus)) {
    return { label: 'PESCATARIAN', forbidden: PESCATARIAN_FORBIDDEN, allowed: PESCATARIAN_ALLOWED };
  }

  // Nothing in the current corpus — fall back to the persisted column.
  // This is what closes the BullMQ history-race: once Grace acknowledges
  // "I'm vegetarian" in any prior session, ai.service.ts writes the label
  // to users.dietary_pattern. Subsequent messages will find it here even
  // when conversation history is empty or stale.
  if (persistedPattern) {
    return buildRestrictionFromLabel(persistedPattern);
  }

  return null;
}

export function buildDietaryBanner(r: DietaryRestriction): string {
  return [
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    `⚠️ DIETARY RESTRICTION — ABSOLUTE — READ FIRST`,
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    `This user is ${r.label}. They told you. This applies to every food suggestion you make, today and forever.`,
    '',
    `FORBIDDEN — NEVER suggest, mention, or recommend ANY of these:`,
    r.forbidden.join(', '),
    '',
    `ALLOWED protein options for this user:`,
    r.allowed.join(', '),
    '',
    `If you are about to type any forbidden word — STOP. Replace it with an allowed option.`,
    `If the user asks "what should I eat for lunch?" — answer with allowed foods ONLY.`,
    `Suggesting a forbidden food is a CRITICAL FAILURE. There is no exception. Not "I forgot." Not "just this once." Not "as a small option."`,
    '',
    `Examples of what NOT to do (REAL production bugs):`,
    `✗ User says "I'm vegetarian" → Grace replies "Greek yogurt, cottage cheese, or a chicken salad" — chicken is FORBIDDEN.`,
    `✗ Grace says "good options include chicken, tuna, or eggs" to a vegetarian — chicken and tuna are FORBIDDEN.`,
    '',
    `Correct response when a ${r.label} asks for lunch ideas:`,
    `"${r.allowed.slice(0, 4).join(', ')} are all solid protein options that sit well on GLP-1. These are general suggestions — a registered dietitian can build a full plan if you want."`,
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
  ].join('\n');
}
