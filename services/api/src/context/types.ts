/**
 * Typed structured-context contract for Grace's response pipeline.
 *
 * Phase 1 of the 2026-06-04 architecture refactor: instead of building
 * context inline across 300+ lines of ai.service.ts and passing 15+
 * arguments to the orchestrator, every code path produces / consumes a
 * single typed `ResponseContext` value.
 *
 * Benefits:
 *   - Unit-testable: mock the builder, drive the orchestrator
 *   - Discoverable: one type tells you everything Grace knows about a turn
 *   - Maintainable: adding a context dimension (e.g. injection-flow state)
 *     means adding one optional field, not 7 prop drills
 *   - Cheap: structural typing in TS — zero runtime cost
 *
 * This file defines ONLY the contract. The builder lives in
 * `context-builder.ts`; consumers live in `ai.service.ts` (caller) and
 * `@grace/ai-core/orchestrator.ts` (consumer).
 */

import type { ChatTurn, DietaryRestriction } from '@grace/shared';
import type { ConversationSummary } from '../services/conversation-summary.service.js';
import type { ActiveTopic } from '../services/topic-tracker.service.js';
import type { MustAcknowledge } from '@grace/ai-core';

/**
 * The full structured context for ONE response generation turn. All fields
 * are read-only — once built, the context is immutable for the turn.
 */
export interface ResponseContext {
  // ── 1. The inbound turn ────────────────────────────────────────────
  /** The user's message, post-coalesce, post-media-augmentation. */
  readonly userMessage: string;
  /** The raw inbound text BEFORE media analysis substituted in. Kept
   *  separately because some guards (e.g. food-log-preamble-leak) need
   *  the actual user input, not the augmented version. */
  readonly rawUserMessage: string;
  /** Per-user phone in E.164. */
  readonly userId: string;
  /** Stable conversation UUID — used for SSE + memory persistence. */
  readonly conversationId: string;

  // ── 2. Who the user is ──────────────────────────────────────────────
  readonly userProfile: UserProfile;

  // ── 3. Grace's memory of this user ──────────────────────────────────
  readonly memory: MemoryContext;

  // ── 4. Today's logged data ──────────────────────────────────────────
  readonly nutrition: NutritionContext;

  // ── 5. Goals + progress ─────────────────────────────────────────────
  readonly goals: GoalsContext;

  // ── 6. Conversation state ───────────────────────────────────────────
  readonly conversation: ConversationContext;

  // ── 7. Behavioral hints derived from the user message ───────────────
  readonly intent: IntentContext;

  // ── 8. Active reminders / scheduled tasks ───────────────────────────
  readonly schedule: ScheduleContext;
}

/** Snapshot of the user row stripped to what the response pipeline needs. */
export interface UserProfile {
  readonly firstName: string | null;
  readonly age: number | null;
  readonly medication: string | null;
  readonly medicationType: 'weekly_injection' | 'daily_pill' | 'daily_injection' | 'unknown';
  readonly doseMg: number | null;
  readonly injectionDay: string | null;
  readonly glp1StartDate: Date | null;
  readonly weekNumber: number | null; // computed from glp1StartDate
  readonly timezone: string;
  readonly rlhfEnabled: boolean;
  readonly isPaid: boolean;
  readonly isPro: boolean;
  readonly trialDay: number | null; // null if paid or trial expired
  readonly dietaryRestriction: DietaryRestriction | null;
  readonly foodDislikes: ReadonlyArray<string>; // cleaned (no "I don't like" prefix)
  readonly biggestChallenge: string | null;
}

/** Long-term semantic memories + recent turn history. */
export interface MemoryContext {
  /** Top-k semantically retrieved long-term memories (already filtered). */
  readonly relevantMemories: ReadonlyArray<string>;
  /** Last N coalesced turns. Default 6. */
  readonly recentTurns: ReadonlyArray<ChatTurn>;
  /** Known facts extracted by background worker — fact + category + confidence. */
  readonly knownFacts: ReadonlyArray<{ fact: string; category: string; confidence: string }>;
  /** Conversation-level summary (last persisted). Null if conversation is fresh. */
  readonly summary: ConversationSummary | null;
  /** True if this is the user's first ever message (welcome flow). */
  readonly isNewUser: boolean;
  /** Hours since last user reply. Used by FRESH START rule. */
  readonly hoursSinceLastReply: number;
}

/** Today's nutrition state — single source of truth for protein/calorie reasoning. */
export interface NutritionContext {
  /** Today's protein in grams (rounded). */
  readonly proteinG: number;
  /** Today's calories (rounded). */
  readonly calories: number;
  /** Foods logged today, in order. */
  readonly itemsLoggedToday: ReadonlyArray<string>;
  /** Per-item detail when needed (used by "how did I reach Xg?" answers). */
  readonly itemsDetailed: ReadonlyArray<{
    food: string;
    protein_g: number;
    calories: number;
    logged_at: string;
  }>;
}

/** User's goals + their progress against them. */
export interface GoalsContext {
  readonly proteinTargetG: number | null;
  readonly calorieTargetKcal: number | null;
  readonly currentWeightLb: number | null;
  readonly goalWeightLb: number | null;
  readonly primaryGoal: 'fat_loss' | 'recomp' | 'maintenance' | 'muscle_gain' | null;
  /** Lbs from current to goal. Null if either weight is missing. */
  readonly lbsToGo: number | null;
}

/** State about the conversation itself — separate from the turn content. */
export interface ConversationContext {
  /** Active topic tracker output (if available). */
  readonly activeTopic: ActiveTopic | null;
  /** Active reminder / response mode (e.g. "low_mood_mode", "injection_flow"). */
  readonly responseMode: string;
  /** Last assistant message — used for offer-question detection etc. */
  readonly lastAssistantMessage: string | null;
  /** Previous user message (the one BEFORE the current). For prior-message
   *  re-litigation guard. */
  readonly previousUserMessage: string | null;
}

/** Derived behavioral signals about what the user is asking for. */
export interface IntentContext {
  /** Classifier output. Stable taxonomy across all paths. */
  readonly type: string;
  /** 0–1 confidence in the classification. */
  readonly confidence: number;
  /** True if the user just asked a question that demands an answer. */
  readonly isQuestion: boolean;
  /** True if the user's message switches topics from the last turn. */
  readonly isTopicSwitch: boolean;
  /** True if the user packed 2+ asks into one message. */
  readonly isMultiPart: boolean;
  /** True if user is asking "why" / "how did you calculate" after prior data. */
  readonly isReasoningRequest: boolean;
  /** Symptom / correction signal that must be acknowledged FIRST. */
  readonly mustAcknowledge: MustAcknowledge | null;
}

/** Scheduling / proactive-flow state — informs whether a reminder is due,
 *  whether we're in an injection-day flow, etc. */
export interface ScheduleContext {
  /** Number of proactive check-ins already sent today. */
  readonly checkinsSentToday: number;
  /** Configured check-ins per day for this user. */
  readonly checkinsPerDay: number;
  /** Active injection-flow stage if any (e.g. "morning_sent"). */
  readonly injectionFlowStage: string | null;
  /** True if user is in side-effect follow-up window. */
  readonly inSideEffectFlow: boolean;
}
