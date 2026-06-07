/**
 * Structured context assembler for Grace's response pipeline.
 *
 * This is the Phase 1 implementation of the 2026-06-04 architecture
 * refactor. The goal is to replace the inline parallel_io + context-massage
 * block (currently 300+ lines in ai.service.ts) with a single typed call:
 *
 *   const ctx = await contextBuilder.build({ userId, text, media });
 *   const response = await orchestrator.run(ctx);
 *
 * Behavior is identical to what ai.service.ts does today — this is
 * structural cleanup, not new logic. Existing services (UserService,
 * MemoryService, RagService, UserMemoryService, etc.) are injected and
 * called the same way they're called today.
 *
 * The build() method:
 *   1. Fires all independent I/O in parallel (mirrors the existing
 *      Promise.all in ai.service.ts).
 *   2. Computes derived fields (week number, trial day, lbs to go).
 *   3. Runs the deterministic classifier + topic-switch / multi-part
 *      detectors on the user message.
 *   4. Returns a single readonly ResponseContext.
 *
 * Caching: NONE here. The underlying services already cache (userCache,
 * todaysFoodCache, knownFactsCache, etc.). Adding another cache layer
 * would only create staleness bugs. If a caller wants to skip the build
 * entirely, they can pass a pre-computed ResponseContext to the
 * orchestrator directly.
 */

import type { Logger } from 'pino';
import type { ChatTurn, DietaryRestriction } from '@grace/shared';
import {
  classifyMessage,
  detectTopicSwitch,
  detectMultiPartMessage,
  detectReasoningRequest,
  detectMustAcknowledge,
} from '@grace/ai-core';
import type { MemoryService } from '../memory/memory.service.js';
import type { UserMemoryService } from '../memory/user-memory.service.js';
import type { UserService, GraceUser } from '../user/user.service.js';
import type { ConversationSummaryService, ConversationSummary } from '../services/conversation-summary.service.js';
import type { TopicTrackerService, ActiveTopic } from '../services/topic-tracker.service.js';
import { buildRestrictionFromLabel, inferMedicationType } from '../services/ai.service.js';
import type {
  ResponseContext,
  UserProfile,
  MemoryContext,
  NutritionContext,
  GoalsContext,
  ConversationContext,
  IntentContext,
  ScheduleContext,
} from './types.js';

export interface ContextBuilderDeps {
  readonly users: UserService;
  readonly memory: MemoryService;
  readonly userMemory?: UserMemoryService;
  /** Phase D — per-user narrative memory.md layer. Optional; only fires
   *  when the user is enrolled in the pilot (has a row in user_memory_md). */
  readonly memoryMd?: {
    get: (userId: string) => Promise<string | null>;
  };
  readonly conversationSummary?: ConversationSummaryService;
  readonly topicTracker?: TopicTrackerService;
  readonly logger: Logger;
}

export interface ContextBuilderInput {
  readonly userId: string;
  /** The user message AFTER coalesce + media analysis substitution. */
  readonly userMessage: string;
  /** The raw user message BEFORE media substitution. */
  readonly rawUserMessage: string;
  /** Already-resolved response mode (e.g. "low_mood_mode"). */
  readonly responseMode?: string;
  /** How many recent turns to include in `MemoryContext.recentTurns`. Default 6. */
  readonly historyLimit?: number;
  /** How many long-term memories to retrieve. Default 5. */
  readonly memoryLimit?: number;
  /** How many known facts to surface. Default 30. */
  readonly knownFactsLimit?: number;
  /** Pre-counted check-ins (set when caller already has it cached). */
  readonly checkinsSentToday?: number;
}

export class ContextBuilder {
  constructor(private readonly deps: ContextBuilderDeps) {}

  async build(input: ContextBuilderInput): Promise<ResponseContext> {
    const t0 = Date.now();
    const historyLimit = input.historyLimit ?? 6;
    const memoryLimit = input.memoryLimit ?? 5;
    const knownFactsLimit = input.knownFactsLimit ?? 30;

    // ── Stage 1: kick off all independent I/O in parallel ───────────────
    // Mirrors the existing parallel_io block in ai.service.ts.
    const conversationPromise = this.deps.memory
      .ensureConversation(input.userId)
      .catch(() => `fallback-${input.userId}`);

    // Phase4 (summary + topic) chains on conversationId — start as soon as
    // it resolves rather than waiting for the slow tail of other queries.
    const phase4Promise = conversationPromise.then(async (cId) => {
      const [summary, topic] = await Promise.all([
        this.deps.conversationSummary
          ? this.deps.conversationSummary.get(cId).catch(() => null)
          : Promise.resolve(null),
        this.deps.topicTracker
          ? this.deps.topicTracker.get(cId).catch(() => null)
          : Promise.resolve(null),
      ]);
      return { summary, topic };
    });

    // Long-term memory retrieval — only if userMemory service is injected.
    // Embeds the user's message and returns top-k semantically relevant
    // memories. Skipped when no service is provided (e.g. in tests).
    const memoryPromise: Promise<string[]> = this.deps.userMemory
      ? this.deps.userMemory
          .retrieve(input.userId, input.userMessage, memoryLimit)
          .catch(() => [] as string[])
      : Promise.resolve([] as string[]);

    // Phase D: memory.md per-user narrative file. Single indexed lookup
    // (5-min cached) — returns null when user is not in the pilot.
    const memoryMdPromise: Promise<string | null> = this.deps.memoryMd
      ? this.deps.memoryMd.get(input.userId).catch(() => null)
      : Promise.resolve(null);

    const [
      user,
      conversationId,
      isNew,
      history,
      todaysFood,
      knownFacts,
      phase4,
      relevantMemories,
      memoryMd,
    ] = await Promise.all([
      this.deps.users.getById(input.userId).catch(() => null),
      conversationPromise,
      this.deps.users.isNewUser(input.userId).catch(() => false),
      this.deps.memory.getRecentTurns(input.userId, historyLimit).catch(() => [] as ChatTurn[]),
      this.deps.users
        .getTodaysFoodSummary(input.userId)
        .catch(() => ({ protein_g: 0, calories: 0, items: [], items_detailed: [] })),
      this.deps.users.getKnownFacts(input.userId, knownFactsLimit).catch(() => []),
      phase4Promise,
      memoryPromise,
      memoryMdPromise,
    ]);

    // ── Stage 2: compute derived fields ────────────────────────────────
    const userProfile = buildUserProfile(user);
    const memory = buildMemoryContext({
      relevantMemories,
      history,
      knownFacts,
      summary: phase4.summary,
      isNewUser: isNew,
      lastReplyAt: user?.last_reply_at ?? null,
      memoryMd,
    });
    const nutrition = buildNutritionContext(todaysFood);
    const goals = buildGoalsContext(user);
    const conversation = buildConversationContext({
      activeTopic: phase4.topic,
      responseMode: input.responseMode ?? 'normal',
      history,
    });
    const intent = buildIntentContext({
      userMessage: input.userMessage,
      lastAssistantMessage: conversation.lastAssistantMessage,
    });
    const schedule = buildScheduleContext({
      user,
      checkinsSentToday: input.checkinsSentToday ?? 0,
    });

    this.deps.logger.debug(
      {
        userId: input.userId,
        intent: intent.type,
        confidence: intent.confidence,
        weekNumber: userProfile.weekNumber,
        memoryCount: memory.relevantMemories.length,
        historyTurns: memory.recentTurns.length,
        buildMs: Date.now() - t0,
      },
      'context.built',
    );

    return {
      userMessage: input.userMessage,
      rawUserMessage: input.rawUserMessage,
      userId: input.userId,
      conversationId,
      userProfile,
      memory,
      nutrition,
      goals,
      conversation,
      intent,
      schedule,
    };
  }
}

// ── Pure builders — testable in isolation ──────────────────────────────

function buildUserProfile(user: GraceUser | null): UserProfile {
  if (!user) {
    return {
      firstName: null, age: null, medication: null, medicationType: 'unknown',
      doseMg: null, injectionDay: null, glp1StartDate: null, weekNumber: null,
      timezone: 'UTC', rlhfEnabled: false, isPaid: false, isPro: false,
      trialDay: null, dietaryRestriction: null, foodDislikes: [],
      biggestChallenge: null,
    };
  }
  const trialDay = computeTrialDay(user.trial_start, user.is_paid);
  const dietaryRestriction: DietaryRestriction | null = user.dietary_pattern
    ? buildRestrictionFromLabel(user.dietary_pattern)
    : null;
  const cleanedDislikes = (user.food_dislikes ?? [])
    .map((d) =>
      d.replace(
        /^(i\s+(don'?t|do\s+not|hate|can'?t\s+stand|dislike)\s+(like\s+)?|no\s+|avoid\s+)/i,
        '',
      ).trim(),
    )
    .filter(Boolean);
  return {
    firstName: user.first_name,
    age: user.age,
    medication: user.medication,
    medicationType: inferMedicationType(user.medication),
    doseMg: user.dose_mg,
    injectionDay: user.injection_day,
    glp1StartDate: user.glp1_start_date,
    weekNumber: computeWeekNumber(user.glp1_start_date),
    timezone: user.timezone || 'UTC',
    rlhfEnabled: user.rlhf_enabled,
    isPaid: user.is_paid,
    isPro: user.is_pro,
    trialDay,
    dietaryRestriction,
    foodDislikes: cleanedDislikes,
    biggestChallenge: user.biggest_challenge,
  };
}

function buildMemoryContext(args: {
  relevantMemories: string[];
  history: ChatTurn[];
  knownFacts: Array<{ fact: string; category: string; confidence: string }>;
  summary: ConversationSummary | null;
  isNewUser: boolean;
  lastReplyAt: Date | null;
  memoryMd?: string | null;
}): MemoryContext {
  const hoursSinceLastReply = args.lastReplyAt
    ? (Date.now() - new Date(args.lastReplyAt).getTime()) / 3_600_000
    : 0;
  return {
    relevantMemories: args.relevantMemories,
    recentTurns: args.history,
    knownFacts: args.knownFacts,
    summary: args.summary,
    isNewUser: args.isNewUser,
    hoursSinceLastReply,
    memoryMd: args.memoryMd ?? null,
  };
}

function buildNutritionContext(food: {
  protein_g: number;
  calories: number;
  items: string[];
  items_detailed?: Array<{ food: string; protein_g: number; calories: number; logged_at: string }>;
}): NutritionContext {
  return {
    proteinG: Math.round(food.protein_g),
    calories: Math.round(food.calories),
    itemsLoggedToday: food.items,
    itemsDetailed: food.items_detailed ?? [],
  };
}

function buildGoalsContext(user: GraceUser | null): GoalsContext {
  if (!user) {
    return {
      proteinTargetG: null, calorieTargetKcal: null,
      currentWeightLb: null, goalWeightLb: null,
      primaryGoal: null, lbsToGo: null,
    };
  }
  const lbsToGo =
    user.current_weight && user.goal_weight && user.current_weight > user.goal_weight
      ? Math.round((user.current_weight - user.goal_weight) * 10) / 10
      : null;
  return {
    proteinTargetG: user.protein_goal_grams,
    calorieTargetKcal: user.calorie_goal_kcal,
    currentWeightLb: user.current_weight,
    goalWeightLb: user.goal_weight,
    primaryGoal: parsePrimaryGoal(user.primary_goal),
    lbsToGo,
  };
}

function buildConversationContext(args: {
  activeTopic: ActiveTopic | null;
  responseMode: string;
  history: ChatTurn[];
}): ConversationContext {
  const lastAssistant = [...args.history].reverse().find((m) => m.role === 'assistant');
  const userTurns = args.history.filter((m) => m.role === 'user');
  const previousUserMessage = userTurns.length >= 2
    ? userTurns[userTurns.length - 2]!.content
    : null;
  return {
    activeTopic: args.activeTopic,
    responseMode: args.responseMode,
    lastAssistantMessage: lastAssistant?.content ?? null,
    previousUserMessage,
  };
}

function buildIntentContext(args: {
  userMessage: string;
  lastAssistantMessage: string | null;
}): IntentContext {
  const classification = classifyMessage(args.userMessage);
  const isQuestion = /\?/.test(args.userMessage);
  const isTopicSwitch = detectTopicSwitch(args.userMessage, args.lastAssistantMessage ?? undefined);
  const isMultiPart = detectMultiPartMessage(args.userMessage);
  const isReasoningRequest = detectReasoningRequest(args.userMessage, args.lastAssistantMessage ?? undefined);
  const mustAcknowledge = detectMustAcknowledge(args.userMessage);
  return {
    type: classification.type,
    confidence: classification.confidence,
    isQuestion,
    isTopicSwitch,
    isMultiPart,
    isReasoningRequest,
    mustAcknowledge,
  };
}

function buildScheduleContext(args: {
  user: GraceUser | null;
  checkinsSentToday: number;
}): ScheduleContext {
  return {
    checkinsSentToday: args.checkinsSentToday,
    checkinsPerDay: args.user?.checkin_count_per_day ?? 2,
    injectionFlowStage: args.user?.injection_flow_stage ?? null,
    inSideEffectFlow: args.user?.side_effect_flow !== null && args.user?.side_effect_flow !== undefined,
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────

function computeWeekNumber(startDate: Date | null): number | null {
  if (!startDate) return null;
  const start = new Date(startDate);
  const weeks = Math.floor((Date.now() - start.getTime()) / (7 * 24 * 60 * 60 * 1000)) + 1;
  return weeks > 0 ? weeks : null;
}

function computeTrialDay(trialStart: Date | null, isPaid: boolean): number | null {
  if (isPaid || !trialStart) return null;
  const days = Math.floor((Date.now() - new Date(trialStart).getTime()) / (24 * 60 * 60 * 1000)) + 1;
  if (days < 1 || days > 3) return null; // trial ended → handled by gate
  return days;
}

function parsePrimaryGoal(raw: string | null): GoalsContext['primaryGoal'] {
  if (!raw) return null;
  const v = raw.toLowerCase();
  if (v.includes('fat')) return 'fat_loss';
  if (v.includes('recomp')) return 'recomp';
  if (v.includes('maint')) return 'maintenance';
  if (v.includes('muscle') || v.includes('gain')) return 'muscle_gain';
  return null;
}

// Test exports
export const __testing = {
  buildUserProfile,
  buildMemoryContext,
  buildNutritionContext,
  buildGoalsContext,
  buildConversationContext,
  buildIntentContext,
  buildScheduleContext,
  computeWeekNumber,
  computeTrialDay,
  parsePrimaryGoal,
};
