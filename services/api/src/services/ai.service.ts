import type { Logger } from 'pino';
import type { Pool } from 'pg';
import type { Queue } from 'bullmq';
import type { ChatTurn, DietaryRestriction, InboundMessage, OrchestratorOutput } from '@grace/shared';
import { AIOrchestrator, PlannerAgent, ToolRegistry, classifyMessage as classifyIntent } from '@grace/ai-core';
import { tryFastPath } from './fast-path.js';
import type { LLMProvider, PlannerDecision } from '@grace/shared';
import type { MemoryService } from '../memory/memory.service.js';
import type { UserMemoryService } from '../memory/user-memory.service.js';
import type { RagService } from '../rag/rag.service.js';
import type { UserService } from '../user/user.service.js';
import type { ContentRulesService } from './content-rules.service.js';
import type { ResponseFingerprintService } from './response-fingerprint.service.js';
import type { ConversationSummaryService } from './conversation-summary.service.js';
import type { TopicTrackerService } from './topic-tracker.service.js';
import type { UsdaFoodService } from './usda-food.service.js';
import type { BanditService } from './bandit.service.js';
import { classifyMessage } from '../safety/guard.js';
import { detectVagueFood } from '../safety/vague-food.js';
import type { FaqSemanticCache } from '../cache/faq-semantic-cache.js';
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
  userMemory?: UserMemoryService;
  fingerprint?: ResponseFingerprintService;
  conversationSummary?: ConversationSummaryService;
  topicTracker?: TopicTrackerService;
  usda?: UsdaFoodService;
  bandit?: BanditService;
  faqCache?: FaqSemanticCache;
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
    const t0 = Date.now();

    // Safety pre-check (deterministic, no LLM cost).
    const safety = classifyMessage(input.text);
    if (safety.class !== 'safe') {
      this.deps.logger.warn({ userId: input.userId, class: safety.class, matched: safety.matched }, 'safety.flagged');
      return {
        text: safety.response!,
        confidence: 'high',
        intent: `safety_${safety.class}`,
        toolResults: [],
        usedRetrieval: false,
        latencyMs: Date.now() - t0,
      };
    }

    // Fast-path: pure greetings, brief positive feelings, thanks, brief acks
    // get a deterministic warm reply with zero LLM call — ~50-150ms total
    // instead of ~2-4s. Skipped when media is attached (photo/voice always
    // needs analysis). Tool results / RAG / memory are all skipped for these
    // turns because they don't add anything to a "Hi" → "Hey there" exchange.
    if (input.media.length === 0) {
      const fast = tryFastPath(input.text, input.userId);
      if (fast) {
        this.deps.logger.info(
          { userId: input.userId, category: fast.category, latencyMs: Date.now() - t0 },
          'ai.fast_path.hit',
        );
        return {
          text: fast.text,
          confidence: 'high',
          intent: `fast_path_${fast.category}`,
          toolResults: [],
          usedRetrieval: false,
          latencyMs: Date.now() - t0,
        };
      }
    }

    try {
      return await this.handleMessageInner(input, t0);
    } catch (outerErr) {
      // Emergency fallback: fires when the full pipeline throws (DB down, LLM
      // timeout, etc.). Makes one last bare LLM call with no tools/RAG/history.
      this.deps.logger.error({ err: outerErr }, 'ai.handle.outer_catch');
      try {
        const emergency = await this.deps.llm.generate({
          messages: [
            { role: 'system', content: 'You are Grace, a warm companion for people on GLP-1 medications. Answer the user\'s question directly in 2-3 sentences. Be calm, helpful, and human.' },
            { role: 'user', content: input.text },
          ],
          maxOutputTokens: 300,
        });
        if (emergency.text?.trim()) {
          return {
            text: emergency.text.trim(),
            confidence: 'low' as const,
            intent: 'emergency_fallback',
            toolResults: [],
            usedRetrieval: false,
            latencyMs: Date.now() - t0,
          };
        }
      } catch (llmErr) {
        this.deps.logger.error({ err: llmErr }, 'ai.handle.emergency_llm.failed');
      }
      throw outerErr;
    }
  }

  // Full message processing flow: (1) parallel I/O (user profile, history, media
  // analysis, tool settings), (2) RAG retrieval + planner + user memory in parallel,
  // (3) detect dietary restrictions + side effects, (4) build personalised system
  // prompt with runtime context, (5) register per-request tools, (6) call
  // orchestrator.run(), (7) fire-and-forget persistence + memory extraction.
  private async handleMessageInner(input: InboundMessage, t0: number): Promise<OrchestratorOutput> {
    const { logger, memory, rag, flags, users } = this.deps;

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
      memory.ensureConversation(input.userId).catch(() => `fallback-${input.userId}`),
      users.isNewUser(input.userId).catch(() => false),
      memory.getRecentTurns(input.userId, 6).catch(() => [] as ChatTurn[]),
      flags.toolsEnabled ? this.loadToolSettings() : Promise.resolve({} as Record<string, boolean>),
      mediaPromise,
      users.getTodaysFoodSummary(input.userId).catch(() => ({ protein_g: 0, calories: 0, items: [] })),
      this.countTodaysCheckIns(input.userId).catch(() => 0),
      users.getKnownFacts(input.userId, 30).catch(() => []),
    ]);

    // Phase 4 additive context — fetched after conversationId is resolved.
    // Both are optional; if the services aren't injected the values are null
    // and nothing is added to the prompt.
    const [conversationSummary, activeTopic] = await Promise.all([
      this.deps.conversationSummary ? this.deps.conversationSummary.get(conversationId).catch(() => null) : Promise.resolve(null),
      this.deps.topicTracker ? this.deps.topicTracker.get(conversationId).catch(() => null) : Promise.resolve(null),
    ]);

    // Fold media description into the prompt (only after Promise.all resolves).
    let augmentedText = input.text;

    // Pre-compute gap so the inline instruction blocks for voice/image can be
    // gap-aware. Same threshold as buildPersonalisedPrompt: >24h = stale history.
    const hoursSinceLastReply = user?.last_reply_at
      ? (Date.now() - new Date(user.last_reply_at).getTime()) / 3_600_000
      : 0;
    const staleHistoryNote = hoursSinceLastReply > 24
      ? ` CONVERSATION GAP: ${Math.floor(hoursSinceLastReply / 24)} day(s) since last message — do NOT reference any previous conversation topics from history.`
      : '';

    if (description) {
      const kind = input.media[0]?.kind;
      if (kind === 'audio' && !input.text) {
        augmentedText = `[Voice note — auto-transcribed, may have filler words or fragments. Respond naturally.${staleHistoryNote}]\n${description}`;
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
NEVER ask the user to specify portions, grams, ounces, or what's in the photo — the estimate is already done. NEVER output ITEMS/BREAKDOWN/TOTAL tables. NEVER list per-item macros. Sound like a supportive friend, not a nutrition app. If confidence was low, you may add ONE light human clarifier (e.g. "Was that a snack or a full plate?") — never a quantity question.${staleHistoryNote}]`;
        } else if (description.includes('IMAGE_TYPE: body')) {
          augmentedText = `${userIntent}The user shared a body/progress photo. Analysis:\n\n${description}\n\n[Respond warmly and personally using the observations above. Tie it to their GLP-1 weight-loss journey and encourage them. CRITICAL: Do NOT mention pain, discomfort, injuries, or any medical conditions — this is a progress selfie, not a medical photo. Do NOT invent symptoms or anything not in the analysis above. Do NOT call any logging tools.${staleHistoryNote}]`;
        } else {
          augmentedText = `${userIntent}The user sent an image. ${description}${staleHistoryNote ? ' ' + staleHistoryNote.trim() : ''}`;
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

    // Latency optimization: run RAG retrieval, the planner, and long-term
    // memory retrieval in parallel. The planner only needs input.text; RAG
    // needs the augmented text; memory needs the augmented text. None depend
    // on each other, so Promise.all saves ~600–1500ms per message.
    const intentClass = classifyIntent(augmentedText);
    const skipPlanner =
      intentClass.type === 'greeting' || intentClass.type === 'gibberish' || !flags.toolsEnabled;
    const planner = new PlannerAgent(this.deps.llm);

    const [retrieved, userMemories, prePlannedDecisionRaw] = await Promise.all([
      flags.ragEnabled ? rag.retrieve(augmentedText, { userId: input.userId, topK: 5 }) : Promise.resolve([]),
      this.deps.userMemory
        ? this.deps.userMemory.retrieve(input.userId, augmentedText, 3)
        : Promise.resolve([] as string[]),
      skipPlanner
        ? Promise.resolve<PlannerDecision>({ intent: 'chat', needsTools: false, toolCalls: [], rationale: 'classifier_fast_path' })
        : planner.plan(augmentedText).catch((): PlannerDecision => ({ intent: 'chat', needsTools: false, toolCalls: [], rationale: 'planner_error' })),
    ]);

    // FORCE log_food on food_log classification OR when the message contains
    // obvious food words but the classifier missed it. This prevents Grace
    // from asking "what did you eat?" or just chatting back when the user
    // clearly mentioned food.
    let prePlannedDecision = prePlannedDecisionRaw;
    const obviousFoodMention =
      // Has past-tense food verb anywhere
      /\b(ate|had|finished|grabbed|drank|ordered|made|cooked|got|consumed|enjoyed)\b/i.test(augmentedText) &&
      // AND mentions an actual food/drink word
      /\b(banana|apple|orange|berry|berries|chicken|beef|pork|fish|salmon|tuna|tofu|egg|eggs|yogurt|oatmeal|rice|pasta|pizza|salad|sushi|sandwich|burger|burrito|taco|wrap|soup|steak|bagel|toast|cereal|pancake|waffle|fruit|smoothie|shake|coffee|tea|water|coke|soda|juice|beer|wine|big mac|fries|coke|nuts|almonds?|granola|cheese|milk|bread|chocolate|cookie|cake|brownie|donut|ice cream|protein|carrot|broccoli|spinach|lettuce|tomato|potato|avocado)\b/i.test(augmentedText);

    // ── Vague-food guard ────────────────────────────────────────────────────
    // Detect brand/category mentions without portion specifics ("I had KFC",
    // "I ate pizza", "I ate veggie KFC") and return a clarification ask
    // instead of letting the LLM fabricate a protein estimate.
    //
    // Always runs — no continuation gate. detectVagueFood already returns
    // vague=false when the message HAS specificity ("3 tenders", "a chicken
    // sandwich"), so the continuation flow downstream still works when the
    // user gives a real answer. If they reply with another vague mention
    // (e.g. "veggie KFC") we re-ask with the follow-up template variant.
    const lastGraceMessage = [...history].reverse().find((t) => t.role === 'assistant')?.content ?? '';

    if (flags.toolsEnabled) {
      const vague = detectVagueFood(input.text, lastGraceMessage);
      if (vague.vague) {
        this.deps.logger.info(
          { userId: input.userId, matched: vague.matched, plannerPlannedLogFood: prePlannedDecision.toolCalls.some((c) => c.name === 'log_food'), textPreview: input.text.slice(0, 100) },
          'ai.handle.vague_food_clarification',
        );
        // Persist both turns so the next message hits the continuation logic.
        // The "what exactly did you have" wording matches the regex on line
        // ~257 (isFollowupReplyToFoodQuestion) so the user's brief follow-up
        // ("3 tenders", "a chicken sandwich") triggers log_food.
        void this.deps.memory.appendTurn({
          userId: input.userId,
          conversationId,
          role: 'user',
          content: input.text,
        }).catch((err) => this.deps.logger.warn({ err }, 'vague_food.append_user.failed'));
        void this.deps.memory.appendTurn({
          userId: input.userId,
          conversationId,
          role: 'assistant',
          content: vague.response!,
        }).catch((err) => this.deps.logger.warn({ err }, 'vague_food.append_assistant.failed'));

        return {
          text: vague.response!,
          intent: 'vague_food_clarification',
          confidence: 'high' as const,
          toolResults: [],
          usedRetrieval: false,
          latencyMs: Date.now() - t0,
        };
      }
    }

    // ── FAQ semantic cache (2026-05-30 latency optimization #2) ─────────────
    // For fresh / near-fresh conversations whose user message embeds within
    // 0.92 cosine of a pre-seeded educational FAQ, return the canonical
    // response immediately — bypasses planner, RAG, orchestrator, critic.
    // Saves ~1500ms per cache hit.
    //
    // Hard gates (defense-in-depth so we never replace a contextually-aware
    // answer with a generic one):
    //   1. Intent is NOT a food log / weight log / mood log
    //   2. No injection-flow stage active (those need their own state machine)
    //   3. Conversation history is short (< 4 turns) OR the last reply was
    //      more than 2h ago (treat as a fresh topic)
    //   4. The cache must be initialized (initialize() completed at boot)
    const FAQ_INTENT_BLOCK = new Set(['food_log', 'weight_log', 'mood_log']);
    const conversationIsFresh =
      history.length < 4 ||
      (user?.last_reply_at && Date.now() - new Date(user.last_reply_at).getTime() > 2 * 3_600_000);
    if (
      this.deps.faqCache &&
      this.deps.faqCache.isReady() &&
      !FAQ_INTENT_BLOCK.has(intentClass.type) &&
      !user?.injection_flow_stage &&
      conversationIsFresh
    ) {
      const hit = await this.deps.faqCache.lookup(input.text);
      if (hit) {
        this.deps.logger.info(
          {
            userId: input.userId,
            matchedQuery: hit.matchedQuery.slice(0, 60),
            similarity: hit.similarity.toFixed(3),
            category: hit.category,
            ms: Date.now() - t0,
          },
          'ai.handle.faq_cache_hit',
        );
        // Persist both turns so the next message has context.
        void this.deps.memory.appendTurn({
          userId: input.userId,
          conversationId,
          role: 'user',
          content: input.text,
        }).catch((err) => this.deps.logger.warn({ err }, 'faq_cache.append_user.failed'));
        void this.deps.memory.appendTurn({
          userId: input.userId,
          conversationId,
          role: 'assistant',
          content: hit.response,
        }).catch((err) => this.deps.logger.warn({ err }, 'faq_cache.append_assistant.failed'));
        return {
          text: hit.response,
          intent: `faq_cache_${hit.category}`,
          confidence: 'high' as const,
          toolResults: [],
          usedRetrieval: false,
          latencyMs: Date.now() - t0,
        };
      }
    }

    const shouldForceLogFood =
      flags.toolsEnabled &&
      !prePlannedDecision.toolCalls.some((c) => c.name === 'log_food') &&
      (intentClass.type === 'food_log' || obviousFoodMention);

    if (shouldForceLogFood) {
      prePlannedDecision = {
        intent: 'log_food',
        needsTools: true,
        toolCalls: [{ name: 'log_food', args: { food: input.text } }],
        rationale: intentClass.type === 'food_log' ? 'classifier_forced_log_food' : 'food_words_detected',
      };
      this.deps.logger.info(
        { userId: input.userId, classifierType: intentClass.type, obviousFoodMention, textPreview: input.text.slice(0, 100) },
        'ai.handle.forced_log_food',
      );
    }

    // FORCE log_food on CONTINUATION turns — when Grace's previous message
    // was a food-related question and the user replied with a brief detail
    // ("one scoop", "with milk", "Greek yogurt", etc.), the combined context
    // is a food log. Without this, brief replies fall through to safe fallback.
    const lastGraceMsg = [...history].reverse().find((t) => t.role === 'assistant')?.content ?? '';
    const lastWasFoodQuestion = /\b(how much|what|what was|how big|portion|scoop|protein|calories?|carbs?)\b.*\?/i.test(lastGraceMsg);
    const isBriefDetail = input.text.trim().split(/\s+/).length <= 4;
    // Broadened so brief replies after a vague-food clarification ("3 tenders",
    // "a chicken sandwich", "4 wings") trigger continuation log_food.
    const briefDetailMatchesFood = /\b(scoop|scoops|cup|cups|tbsp|tsp|grams?|oz|ounces?|servings?|with|and|small|medium|large|big|tiny|tender|tenders|wing|wings|nugget|nuggets|piece|pieces|slice|slices|sandwich|sandwiches|burger|burgers|taco|tacos|burrito|burritos|wrap|wraps|bowl|bowls|sub|subs|footlong|combo|meal|chicken|beef|fish|salmon|tuna|veggie|cheese)\b/i.test(input.text);
    if (
      !shouldForceLogFood &&
      flags.toolsEnabled &&
      lastWasFoodQuestion &&
      isBriefDetail &&
      briefDetailMatchesFood &&
      !prePlannedDecision.toolCalls.some((c) => c.name === 'log_food')
    ) {
      // Combine the previous food context with the new detail
      const combined = `${lastGraceMsg.slice(0, 200).replace(/\?$/, '')}: ${input.text}`;
      prePlannedDecision = {
        intent: 'log_food',
        needsTools: true,
        toolCalls: [{ name: 'log_food', args: { food: combined } }],
        rationale: 'continuation_of_food_question',
      };
      this.deps.logger.info(
        { userId: input.userId, briefDetail: input.text, lastGraceMsgPreview: lastGraceMsg.slice(0, 80) },
        'ai.handle.forced_log_food_continuation',
      );
    }

    // FORCE get_food_summary when the user asks about today's totals (protein,
    // calories, "how much left", "did I overeat") and the planner missed it.
    // The classifier already detects these via FOOD_SUMMARY_QUESTION regex.
    const isFoodSummaryQuery = intentClass.type === 'food_question' &&
      /\b(protein|calorie|kcal|carb|eat|overeat|left|remaining)\b/i.test(input.text);
    if (
      isFoodSummaryQuery &&
      flags.toolsEnabled &&
      !prePlannedDecision.toolCalls.some((c) => c.name === 'get_food_summary')
    ) {
      prePlannedDecision = {
        intent: 'get_food_summary',
        needsTools: true,
        toolCalls: [{ name: 'get_food_summary', args: {} }],
        rationale: 'classifier_forced_get_food_summary',
      };
    }

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
    const systemPrompt = this.buildPersonalisedPrompt(user, isNew, {
      todaysFood,
      checkinsToday,
      knownFacts,
      dietaryRestriction,
      ...(conversationSummary ? { conversationSummary: conversationSummary.summary } : {}),
      ...(activeTopic ? { activeTopic } : {}),
    });

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
        tools.register(makeLogFoodTool({
          pool: this.deps.pool,
          llm: this.deps.llm,
          logger,
          userId: input.userId,
          source: logFoodSource,
          ...(this.deps.usda ? { usda: this.deps.usda } : {}),
        }));
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

    // Phase 5: bandit-driven response strategy. Soft hint appended to system
    // prompt so it can bias tone/length without overriding hard rules. Skipped
    // for first-message welcomes (no signal to optimize against yet).
    // Note: must pass the user's UUID (user.id) — not the phone (input.userId) —
    // because user_bandit_state.user_id is a UUID FK to users.id, and the
    // webhook's recordReward uses user.id too. Mismatched keys = no learning.
    let banditHint: string | null = null;
    if (this.deps.bandit && !isNew && user?.id) {
      const selection = await this.deps.bandit.selectArm(user.id).catch(() => null);
      if (selection) banditHint = selection.hint;
    }
    const systemPromptWithStrategy = banditHint
      ? `${systemPrompt}\n\n${banditHint}`
      : systemPrompt;

    // Topic-closer detection: brief acknowledgments ("thanks", "ok", "got it")
    // signal the user is done with that topic. Strip history before the closer so
    // the LLM starts fresh and doesn't anchor on the old conversation thread.
    const TOPIC_CLOSERS = /^(thanks|thank you|thx|ty|ok|okay|got it|cool|great|perfect|awesome|nice|good|alright|sounds good|will do|noted|k|kk)\.?!?$/i;
    let effectiveHistory = history;
    if (history.length >= 2) {
      const lastUserTurn = [...history].reverse().find((t) => t.role === 'user');
      if (lastUserTurn && TOPIC_CLOSERS.test(lastUserTurn.content.trim())) {
        const lastUserIdx = history.lastIndexOf(lastUserTurn);
        effectiveHistory = history.slice(Math.max(0, lastUserIdx));
      }
    }

    // Image follow-up context: when the user asks about "the picture/image/photo"
    // in a follow-up turn AND the current turn has no new image, scan recent
    // history for the most recent food/body image Grace analyzed and inject the
    // visual context so the LLM doesn't deny having seen the image.
    const hasNewImage = input.media.some((m) => m.kind === 'image');
    const isImageFollowup = !hasNewImage && /\b(picture|image|photo|pic|the meal|that meal|that dish|that food|in it|see in|in the bowl|in the plate)\b/i.test(input.text);
    let priorImageContext = '';
    if (isImageFollowup && history.length > 0) {
      // Find the most recent Grace message that referenced a food/body image
      // analysis. The food-image reply pattern includes "looks like" + grams,
      // and body replies typically describe physical observations.
      for (let i = history.length - 1; i >= 0; i--) {
        const turn = history[i];
        if (turn?.role !== 'assistant') continue;
        const content = turn.content;
        if (/\b(looks like|that looks|that meal|that dish|that plate|that bowl|protein.*photo|in the photo|in the picture|in the image)\b/i.test(content)
          && /\b\d+\s*g\b|\bgrams?\b|\bprotein\b/i.test(content)) {
          priorImageContext = content;
          break;
        }
      }
    }

    // After a conversation gap (>4h — common after Twilio sandbox reconnect),
    // inject a hard inline instruction so the LLM treats this as a fresh start.
    // History is kept intact so anti-repetition (Jaccard dedup) still works —
    // but the model is explicitly told not to continue old topics.
    const isGreeting = intentClass.type === 'greeting';
    const hasGap = !isNew && hoursSinceLastReply > 4;
    let finalText = isNew ? `[FIRST MESSAGE — greet the user warmly] ${augmentedText}` : augmentedText;
    if (priorImageContext) {
      finalText = `[IMAGE FOLLOW-UP — the user is asking about a photo you ALREADY analyzed earlier in this conversation. Your previous analysis said: "${priorImageContext}". You DO have image capability — you analyzed their photo. NEVER say "I can't see images" or "I'm a text-based AI" or "describe the picture to me". Reference what you saw in the image when answering their question.] ${augmentedText}`;
    }
    if (hasGap) {
      const gapH = Math.floor(hoursSinceLastReply);
      if (isGreeting) {
        finalText = `[FRESH START — ${gapH}h since last message. HARD RULES: 1) Respond with ONE warm sentence ONLY. 2) Do NOT continue or reference ANY topic from conversation history. 3) Do NOT repeat any phrase from your previous messages. 4) Do NOT ask a question.] ${augmentedText}`;
      } else {
        finalText = `[FRESH START — ${gapH}h since last message. HARD RULES: 1) Respond ONLY to what the user just said below. 2) Do NOT continue or reference ANY topic from the conversation history above — the user may have just reconnected. 3) Do NOT repeat or paraphrase any phrase from your previous messages — check the history and say something DIFFERENT. 4) If the user is asking something new, answer it directly.] ${augmentedText}`;
      }
    }

    const result = await orchestrator.run({
      userId: input.userId,
      text: finalText,
      history: effectiveHistory,
      retrieved,
      toolsEnabled: flags.toolsEnabled,
      systemPrompt: systemPromptWithStrategy,
      ...(dietaryRestriction ? { dietaryRestriction } : {}),
      ...(user?.first_name ? { userFirstName: user.first_name } : {}),
      ...(cleanFoodDislikes.length > 0 ? { foodDislikes: cleanFoodDislikes } : {}),
      medicationType,
      responseMode,
      isFirstMessage: isNew,
      ...(dbRules.length > 0 ? { dbRules } : {}),
      prePlannedDecision,
      ...(userMemories.length > 0 ? { userMemories } : {}),
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

    // Long-term semantic memory extraction — runs async after the response
    // is already on its way to the user. Skips trivially short turns to
    // avoid wasting Gemini calls on "ok" / "thanks".
    if (
      this.deps.userMemory &&
      input.text.trim().length >= 20 &&
      result.text.trim().length >= 20 &&
      !result.usedSafeFallback
    ) {
      void this.deps.userMemory
        .extractAndStore(input.userId, input.text, result.text)
        .catch((err) => logger.warn({ err }, 'user_memory.extract.failed'));
    }

    // ─── Phase 4 additive features (Critical phase 3 + Mid-tier gaps) ─────
    // All purely fire-and-forget. None block the response.

    // Response fingerprinting (Critical phase 3). Check overlap with prior
    // Grace messages from this user; log only — no enforcement yet.
    if (this.deps.fingerprint && result.text.trim().length >= 30 && !result.usedSafeFallback) {
      const fp = this.deps.fingerprint;
      void fp
        .checkOverlap(input.userId, result.text)
        .then((overlap) => {
          if (overlap.jaccard > 0.15 || overlap.matchingNgrams >= 5) {
            logger.warn(
              { userId: input.userId, jaccard: overlap.jaccard, matchingNgrams: overlap.matchingNgrams },
              'response_fingerprint.high_overlap',
            );
          }
          // Record the new message into the user's set.
          void fp.record(input.userId, result.text).catch(() => {});
        })
        .catch(() => {});
    }

    // Topic tracker: record the current classified topic on the conversation.
    if (this.deps.topicTracker) {
      const intentTopic = classifyIntent(input.text).type;
      void this.deps.topicTracker.record(conversationId, intentTopic).catch(() => {});
    }

    // Conversation summary: maybe regenerate (every 20 turns).
    if (this.deps.conversationSummary && !result.usedSafeFallback) {
      void this.deps.conversationSummary.maybeSummarize(conversationId).catch(() => {});
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
      /** Phase 4: compressed earlier-conversation context. Null when absent. */
      conversationSummary?: string;
      /** Phase 4: current active topic + age. Null when stale or absent. */
      activeTopic?: { topic: string; ageMinutes: number };
    },
  ): string {
    const base = this.systemPrompt ?? undefined;

    const lines: string[] = [];
    if (user) {
      lines.push('━━━ THIS USER\'S DATA (background only — do NOT dump into responses) ━━━');
      lines.push('RULE: 1) Answer the user\'s CURRENT message FIRST and ONLY. 2) Only reference data below if the user\'s message is specifically about that topic. 3) NEVER volunteer unrelated facts (injection site when they ask about fatigue, protein when they share emotions, weight when they ask about food). 4) If data is missing, do NOT invent it.');
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

      // Conversation-gap signal — prevents Grace from referencing stale topics
      // or repeating old responses after silence or downtime.
      if (user.last_reply_at) {
        const hoursSinceLast = (Date.now() - new Date(user.last_reply_at).getTime()) / 3_600_000;
        if (hoursSinceLast > 4) {
          if (hoursSinceLast > 24) {
            const daysSince = Math.floor(hoursSinceLast / 24);
            lines.push(`CONVERSATION GAP: ${daysSince} day${daysSince !== 1 ? 's' : ''} since the user's last message — FRESH START. Respond only to what they just said. Do NOT reference any previous topic from history. Do NOT repeat anything from your last response.`);
          } else {
            const hoursSince = Math.floor(hoursSinceLast);
            lines.push(`It has been ${hoursSince} hours since this user's last message. Treat this as a new interaction — respond to what they just said. Do NOT continue old topics or repeat previous answers.`);
          }
        }
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
      if (user.age) {
        const decade = Math.floor(user.age / 10) * 10;
        lines.push(`Age range: ${decade}s`);
      }
      if (user.sex) lines.push(`Sex: ${user.sex.replace('_', ' ')}`);
      if (user.height_cm) lines.push(`Height: ${user.height_cm}cm (${Math.floor(user.height_cm / 2.54 / 12)}'${Math.round(user.height_cm / 2.54 % 12)}")`);
      if (user.activity_level) lines.push(`Activity level: ${user.activity_level.replace(/_/g, ' ')}`);
      if (user.primary_goal) lines.push(`Primary goal: ${user.primary_goal.replace('_', ' ')}`);
      if (user.protein_goal_grams) {
        lines.push(`Personal daily protein target: ${user.protein_goal_grams}g — use THIS number, not a generic 80g.`);
      }
      if (user.calorie_goal_kcal) {
        lines.push(`Personal daily calorie target: ${user.calorie_goal_kcal} kcal — use THIS number when the user asks about calories. Express as a range ±100 (e.g. "${user.calorie_goal_kcal - 100}–${user.calorie_goal_kcal + 100} kcal") to avoid false precision.`);
      }
      if (user.glp1_start_date) {
        const weeksOn = Math.floor((Date.now() - new Date(user.glp1_start_date).getTime()) / (7 * 24 * 3_600_000));
        if (weeksOn >= 0) lines.push(`GLP-1 week: Week ${weeksOn + 1} (started ${new Date(user.glp1_start_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })})`);
      }
      if (user.grace_notes) lines.push(`Grace's notes about this user: ${user.grace_notes}`);
      if (user.low_mood_mode) lines.push('LOW MOOD MODE: user has been struggling recently — lead with encouragement and warmth, no reflection prompts.');
      if (user.protein_focus_boost) lines.push('User struggles with protein intake — nudge toward protein-rich options when relevant.');
      if (user.hydration_struggle) lines.push('User struggles with hydration — gently mention water when relevant.');

      // Lifestyle & personalization context — drives goal-aware responses.
      if (user.dose_mg) lines.push(`Current dose: ${user.dose_mg}mg`);
      if (user.dietary_restriction) {
        const dr = user.dietary_restriction.replace(/_/g, ' ');
        lines.push(`Dietary restriction: ${dr} — ALL food suggestions MUST respect this.`);
      }
      if (user.biggest_challenge) {
        const ch = user.biggest_challenge.replace(/_/g, ' ');
        lines.push(`Biggest challenge: ${ch} — focus advice and encouragement on THIS when relevant.`);
      }
      if (user.why_started) {
        const ws = user.why_started.replace(/_/g, ' ');
        lines.push(`Why they started GLP-1: ${ws} — use this to understand their deeper motivation.`);
      }
      if (user.support_style) {
        const styleMap: Record<string, string> = {
          gentle: 'GENTLE — lead with warmth and encouragement, soft suggestions',
          straight_facts: 'STRAIGHT FACTS — be direct, data-driven, skip emotional padding',
          tough_love: 'TOUGH LOVE — hold them accountable, be direct and push them',
          mix: 'ADAPTIVE — read their message tone and match it',
        };
        lines.push(`Support style preference: ${styleMap[user.support_style] ?? user.support_style}`);
      }
      if (user.exercise_habits) {
        const exercises = user.exercise_habits.split(',').map((e) => e.trim().replace(/_/g, ' ')).join(', ');
        lines.push(`Exercise: ${exercises} — tailor muscle/fitness advice to what they actually do.`);
      }

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
        const proteinGoal = user.protein_goal_grams;
        const calorieGoal = user.calorie_goal_kcal;
        const proteinLine = proteinGoal
          ? `Total protein TODAY: ${f.protein_g}g / ${proteinGoal}g target (${Math.max(0, proteinGoal - f.protein_g)}g remaining)`
          : `Total protein TODAY: ${f.protein_g}g`;
        lines.push(proteinLine);
        if (calorieGoal) {
          const remaining = Math.max(0, calorieGoal - (f.calories ?? 0));
          lines.push(`Total calories TODAY: ${f.calories ?? 0} kcal / ${calorieGoal} kcal target (${remaining} kcal remaining)`);
        } else if (f.calories) {
          lines.push(`Total calories TODAY: ${f.calories} kcal (no personal target set yet)`);
        }
        if (f.items.length > 0) lines.push(`Foods logged today: ${f.items.slice(0, 8).join('; ')}`);
      }

      // Phase 4: active conversation topic (decays after 2h silence). When
      // present, tells Grace whether the user is mid-thread on a topic.
      if (runtime?.activeTopic && runtime.activeTopic.topic !== 'greeting') {
        lines.push(
          `Active conversation topic: ${runtime.activeTopic.topic} (last touched ${runtime.activeTopic.ageMinutes} min ago — treat as still live if the user's new message relates to it).`,
        );
      }
      lines.push('━━━ END OF USER DATA ━━━');
    }

    // Phase 4: compressed summary of earlier conversation. Lets Grace recall
    // durable context from messages older than the 12-turn history window.
    if (runtime?.conversationSummary) {
      lines.push('', 'EARLIER CONVERSATION CONTEXT (summary of messages older than recent history):');
      lines.push(runtime.conversationSummary);
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
