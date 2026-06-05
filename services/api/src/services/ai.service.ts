import type { Logger } from 'pino';
import type { Pool } from 'pg';
import type { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import type { ChatTurn, DietaryRestriction, InboundMessage, OrchestratorOutput } from '@grace/shared';
import {
  AIOrchestrator,
  PlannerAgent,
  ToolRegistry,
  classifyMessage as classifyIntent,
  checkContent,
  enforceFormat,
  detectTopicSwitch,
  detectReasoningRequest,
  FOOD_HISTORY_QUESTION,
  PROTEIN_TARGET_QUESTION,
  FOOD_REMOVAL_QUESTION,
} from '@grace/ai-core';
import { tryFastPath } from './fast-path.js';
import { getCuratedFoodIdeas } from '../tools/curated-meal-ideas.js';

// ─── Direct-path config (2026-06-05 architectural inversion) ─────────────────
// One focused prompt + budget per intent. Each prompt is intentionally short
// (~15-20 lines vs the 2,500-line orchestrator system prompt) so Gemini can
// actually follow every rule. Each bans the specific failure mode observed in
// production for that intent.
const DIRECT_PATH_CONFIGS: Record<string, {
  system: string;
  temperature: number;
  maxTokens: number;
  useSearch: boolean;
  hardCharCap: number;
  maxSentencesOnTrim: number;
}> = {
  knowledge: {
    system: `You are Grace, a warm and direct GLP-1 medication companion. The user is on a GLP-1 (Ozempic, Wegovy, Mounjaro, Zepbound, or similar) and just asked a question.

ANSWER STYLE:
- 2 to 4 sentences total. Never longer.
- Direct factual answer first, brief nuance second.
- Prose only. NO bullet points, NO numbered lists, NO dashes, NO section headers.
- NO colons used to introduce a list ("Here's how:" / "Common causes:" — BANNED).
- Cite research framing where useful ("research shows", "studies suggest").
- If it needs a doctor's input, say so in one sentence and move on.

NEVER:
- Say "I cannot provide personalized medical advice" or any AI-disclaimer phrase.
- Use parenthetical brand-name dumps "(Ozempic, Wegovy, Mounjaro, Saxenda, Victoza)".
- Use markdown asterisks for bold or italic.
- End with a clarifying question.
- Hallucinate doses, percentages, or studies — if unsure, say "around X" or skip the number.

Answer the user's exact question, calmly and human.`,
    temperature: 0.35,
    maxTokens: 350,
    useSearch: true,
    hardCharCap: 800,
    maxSentencesOnTrim: 3,
  },

  emotional: {
    system: `You are Grace, a warm GLP-1 companion. The user just shared something emotional — frustration, fear, sadness, defeat, exhaustion, anxiety, or self-doubt.

ANSWER STYLE:
- 1 to 3 sentences. Often 1 is best.
- Lead with acknowledging the feeling using their words or a close synonym.
- Then ONE small grounding fact, brief reassurance, or quiet support sentence.
- Do NOT pivot to advice, action items, food logging, or questions about meals.
- Do NOT topic-switch ("How's your day?" / "What's on your mind?" — BANNED).
- Prose only. No bullets, no lists, no headers.
- Warm but never gushing. No "Wow!" / "Oh sweetie" / "You poor thing".

NEVER:
- Open with "Great!" / "Wonderful!" / "Amazing!" — they just told you something hard.
- Use the phrase "I hear you" twice in a row in a session.
- Promise things ("It will get better", "You'll be fine") — keep it grounded.
- Cite research unless directly relevant to the feeling.
- End with "tell me more" — they decide if they want to say more.

Acknowledge their feeling honestly and quietly. That's the whole job.`,
    temperature: 0.5,
    maxTokens: 200,
    useSearch: false,
    hardCharCap: 400,
    maxSentencesOnTrim: 2,
  },

  appointment_prep: {
    system: `You are Grace, a GLP-1 companion. The user has a doctor / endocrinologist / provider appointment coming up and wants help preparing.

ANSWER STYLE:
- 3 to 5 SPECIFIC questions or topics they should raise.
- Tied to GLP-1 care: dose right for current weight + side effects, muscle/protein checking, labs (A1C, lipids, kidney), side-effect timing, dose escalation plan.
- Phrased as questions Grace is suggesting they ASK their doctor, not generic advice.
- Prose, comma-separated within one sentence per topic. NO bullets, NO numbered lists.
- Brief context (one phrase) per topic when needed.

NEVER:
- Use "1." / "2." / dashes / asterisks for list formatting.
- Open with "To give you the best questions, I need to know..." — give the questions.
- Ask the user for more info first.
- Be longer than 5 sentences total.

Give them a clear ready-to-go set of questions to bring.`,
    temperature: 0.3,
    maxTokens: 300,
    useSearch: false,
    hardCharCap: 700,
    maxSentencesOnTrim: 5,
  },

  medication_question: {
    system: `You are Grace, a GLP-1 companion. The user just asked a question about their GLP-1 medication — dose timing, storage, switching meds, refills, what to do after missed/late doses, pen handling, travel, injection-site rotation.

ANSWER STYLE:
- 2 to 4 sentences. Direct answer first.
- Anchor to general GLP-1 guidance, not personalized prescribing advice.
- Prose only. NO bullets, NO numbered lists, NO headers.
- If a specific dose decision is needed, end with one short sentence pointing them to their prescriber.

NEVER:
- Give a specific dose or escalation schedule — that's the prescriber's call.
- Say "I cannot provide medical advice" or any AI disclaimer.
- Use parenthetical brand-name dumps.
- Open with "Great question!" / "Excellent question!".

Answer practically with the standard guidance, end with a clear next step if needed.`,
    temperature: 0.3,
    maxTokens: 300,
    useSearch: true,
    hardCharCap: 600,
    maxSentencesOnTrim: 4,
  },

  social_situation: {
    system: `You are Grace, a GLP-1 companion. The user is asking about a social situation involving food — restaurants, weddings, holidays, travel, family events, gatherings, work meals.

ANSWER STYLE:
- 2 to 3 sentences. Practical and warm.
- Concrete strategies: protein first, slow pace, pick foods they actually want, skip pressure foods without guilt.
- No moralizing language ("bad foods", "cheating", "indulgence").
- Prose only. NO bullets, NO numbered lists.

NEVER:
- Lecture about willpower or restriction.
- Make the user feel anxious about the event.
- Open with "Great question!" / "Oh, what an exciting event!".
- End with "Have fun!" or similar generic well-wishing.

Give them a quick practical plan and move on.`,
    temperature: 0.4,
    maxTokens: 200,
    useSearch: false,
    hardCharCap: 500,
    maxSentencesOnTrim: 3,
  },
};

import { tryFoodLogFastResponse } from './food-log-fast.js';
import { tryWeightLogFastResponse } from './weight-log-fast.js';
import { tryQueryFast } from './query-fast.js';
import type { LLMProvider, PlannerDecision } from '@grace/shared';
import type { MemoryService } from '../memory/memory.service.js';
import type { UserMemoryService } from '../memory/user-memory.service.js';
import type { RagService } from '../rag/rag.service.js';
import type { UserService } from '../user/user.service.js';
import type { ContentRulesService } from './content-rules.service.js';
import type { ProductionIssuesService } from './production-issues.service.js';
import type { ResponseFingerprintService } from './response-fingerprint.service.js';
import type { ConversationSummaryService } from './conversation-summary.service.js';
import type { TopicTrackerService } from './topic-tracker.service.js';
import type { UsdaFoodService } from './usda-food.service.js';
import type { BanditService } from './bandit.service.js';
import { classifyMessage } from '../safety/guard.js';
import { detectVagueFood } from '../safety/vague-food.js';
import { LatencyTracker, LATENCY_TARGETS_MS, DEFAULT_LATENCY_TARGET_MS } from './latency-tracker.js';
import type { FaqSemanticCache } from '../cache/faq-semantic-cache.js';
import { analyzeMedia } from '../multimodal/analyze.js';
import { makeLogFoodTool } from '../tools/log-food.js';
import { makeLogWeightTool } from '../tools/log-weight.js';
import { makeLogMoodTool } from '../tools/log-mood.js';
import { makeKnowledgeSearchTool } from '../tools/knowledge-search.js';
import { makeGetUserProfileTool } from '../tools/get-user-profile.js';
import { makeGetWeightTrendTool } from '../tools/get-weight-trend.js';
import { makeGetFoodSummaryTool, makeGetProteinHistoryTool } from '../tools/get-food-summary.js';
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
  /** Optional Redis client — used to cache search_food_ideas results so the
   *  same dietary profile + meal type doesn't re-pay the Google-Search
   *  grounding round-trip on every "what should I eat for lunch" turn. */
  redis?: Redis;
  /** 2026-06-04 TRUST GEMINI flags (passed from env). When trustGemini=true,
   *  behavioral guard / relevance check / quality guard sentence caps are all
   *  bypassed — Gemini's response ships unless safety / harmful-content
   *  checks flag it. Lets us A/B test the lean pipeline without removing
   *  any code. */
  guards?: {
    trustGemini?: boolean;
    behavioralEnabled?: boolean;
    relevanceEnabled?: boolean;
    qualityStrict?: boolean;
  };
  /** Production issue capture — Layer 4 of defense-in-depth. Every regen
   *  fire and safe-fallback fire is captured (fire-and-forget) so we can
   *  review and promote to regression tests. Closes the user feedback loop. */
  productionIssues?: ProductionIssuesService;
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
    const lat = new LatencyTracker();
    const t0 = Date.now();
    lat.mark('safety_check');

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
      lat.mark('fast_path_lookup');
      // 2026-06-04 fix: when Grace's previous message ended with an OFFER
      // question ("want me to walk you through?", "should I add it?",
      // "want a few options?"), the user's "Yes" / "Sure" is a COMMITMENT
      // to that action, not a generic ack. Fast-path would return
      // "Glad that landed well." — wrong. Skip fast-path in this case
      // so the orchestrator can deliver the promised content.
      const recentTurns = await this.deps.memory.getRecentTurns(input.userId, 4).catch(() => [] as ChatTurn[]);
      const lastAssistant = [...recentTurns].reverse().find((t) => t.role === 'assistant')?.content ?? '';
      const lastWasOfferQuestion = /\?\s*$/.test(lastAssistant.trim()) &&
        /\b(want me to|would you (?:like|want)|should i|can i|may i|how about|do you want|interested in|let me know if you'?d like|let me know if you want|i can (?:walk you|show you|share|give|explain|break|go through|run through))\b/i.test(lastAssistant);
      const isAffirmation = /^(?:yes|yep|yeah|yup|sure|ok|okay|sounds good|please do|please|alright|go ahead|do it|let'?s do it|yes please|absolutely)[!.?]?\s*$/i.test(input.text.trim());
      const skipFastPathDueToOffer = lastWasOfferQuestion && isAffirmation;
      if (skipFastPathDueToOffer) {
        this.deps.logger.info(
          { userId: input.userId, last: lastAssistant.slice(0, 80), text: input.text },
          'ai.fast_path.skipped_offer_followthrough',
        );
      }
      const fast = skipFastPathDueToOffer ? null : tryFastPath(input.text, input.userId);
      if (fast) {
        const stageTimings = lat.snapshot();
        const totalMs = Date.now() - t0;
        this.deps.logger.info(
          { userId: input.userId, category: fast.category, latencyMs: totalMs, stageTimings },
          'ai.fast_path.hit',
        );
        // Persist with intent so /admin/latency surfaces fast-path stats.
        this.persistLatency(input.userId, `fast_path_${fast.category}`, totalMs, stageTimings, input.text, fast.text);
        return {
          text: fast.text,
          confidence: 'high',
          intent: `fast_path_${fast.category}`,
          toolResults: [],
          usedRetrieval: false,
          latencyMs: totalMs,
        };
      }

      // Food-log fast-response: when the message is a clear food log AND the
      // fast-lookup table can resolve the macros, skip the orchestrator entirely
      // and respond with a deterministic template. ~2-4s → ~150ms.
      lat.mark('classify');
      const intentClass = classifyIntent(input.text);
      if (intentClass.type === 'food_log') {
        try {
          lat.mark('food_log_fast');
          const user = await this.deps.users.getByPhone(input.userId).catch(() => null);
          const fastFood = await tryFoodLogFastResponse(input.text, {
            pool: this.deps.pool,
            logger: this.deps.logger,
            userId: input.userId,
            intentType: intentClass.type,
            proteinGoalGrams: user?.protein_goal_grams ?? null,
            users: this.deps.users,
          });
          if (fastFood) {
            const stageTimings = lat.snapshot();
            const totalMs = Date.now() - t0;
            this.deps.logger.info(
              { userId: input.userId, food: fastFood.macros.food, latencyMs: totalMs, stageTimings },
              'ai.food_log_fast.served',
            );
            this.persistLatency(input.userId, 'food_log_fast', totalMs, stageTimings, input.text, fastFood.text);
            return {
              text: fastFood.text,
              confidence: 'high',
              intent: 'food_log_fast',
              toolResults: [
                {
                  name: 'log_food',
                  args: { food: input.text },
                  output: {
                    ...fastFood.macros,
                    daily_protein_g: fastFood.dailyProteinG,
                    daily_calories: fastFood.dailyCalories,
                  },
                  latencyMs: 0,
                  ok: true,
                },
              ],
              usedRetrieval: false,
              latencyMs: totalMs,
            };
          }
        } catch (err) {
          this.deps.logger.warn(
            { err: err instanceof Error ? err.message : String(err) },
            'ai.food_log_fast.error',
          );
          // Fall through to the regular orchestrator
        }
      }

      // ── Weight-log fast-path ──────────────────────────────────────────────
      // "I weigh 185 lbs" / "184.6" / "scale says 200". Pure number + unit;
      // no reasoning needed. ~3s → ~200ms.
      if (intentClass.type === 'weight_log') {
        try {
          lat.mark('weight_log_fast');
          const wlf = await tryWeightLogFastResponse(input.text, {
            pool: this.deps.pool,
            logger: this.deps.logger,
            userId: input.userId,
            intentType: intentClass.type,
          });
          if (wlf) {
            const stageTimings = lat.snapshot();
            const totalMs = Date.now() - t0;
            this.deps.logger.info(
              { userId: input.userId, lbs: wlf.weightLbs, latencyMs: totalMs, stageTimings },
              'ai.weight_log_fast.served',
            );
            this.persistLatency(input.userId, 'weight_log_fast', totalMs, stageTimings, input.text, wlf.text);
            return {
              text: wlf.text,
              confidence: 'high',
              intent: 'weight_log_fast',
              toolResults: [
                {
                  name: 'log_weight',
                  args: { weight_lbs: wlf.weightLbs },
                  output: { weight_lbs: wlf.weightLbs, previous_lbs: wlf.previousLbs },
                  latencyMs: 0,
                  ok: true,
                },
              ],
              usedRetrieval: false,
              latencyMs: totalMs,
            };
          }
        } catch (err) {
          this.deps.logger.warn(
            { err: err instanceof Error ? err.message : String(err) },
            'ai.weight_log_fast.error',
          );
        }
      }

      // ── Profile-query fast-path ───────────────────────────────────────────
      // "What's my protein goal?" / "What is my injection day?" /
      // "How am I doing?" — single DB read + template render. ~3s → ~250ms.
      // 2026-06-05: was gated to food_question + general only, but "What is
      // my injection day" classifies as KNOWLEDGE (because "injection day"
      // matches the side-effect keyword), so query_fast never ran and the
      // user got muscle-loss research instead of the helpful default. All
      // query_fast patterns are anchored (^...$) and high-precision, so
      // they're safe to try unconditionally on every message.
      {
        try {
          lat.mark('query_fast');
          const qf = await tryQueryFast(input.text, {
            users: this.deps.users,
            logger: this.deps.logger,
            userId: input.userId,
          });
          if (qf) {
            const stageTimings = lat.snapshot();
            const totalMs = Date.now() - t0;
            this.deps.logger.info(
              { userId: input.userId, category: qf.category, latencyMs: totalMs, stageTimings },
              'ai.query_fast.served',
            );
            this.persistLatency(input.userId, `query_fast_${qf.category}`, totalMs, stageTimings, input.text, qf.text);
            return {
              text: qf.text,
              confidence: 'high',
              intent: `query_fast_${qf.category}`,
              toolResults: [],
              usedRetrieval: false,
              latencyMs: totalMs,
            };
          }
        } catch (err) {
          this.deps.logger.warn(
            { err: err instanceof Error ? err.message : String(err) },
            'ai.query_fast.error',
          );
        }
      }
    }

    // ── Direct paths (2026-06-05 architectural inversion) ─────────────────
    // For 5 high-volume intents (knowledge / emotional / appointment_prep /
    // medication_question / social_situation), skip the heavy orchestrator
    // (2,500-line prompt + planner + tools + 7 guards + regen). The full
    // pipeline has been producing consistently bad responses on these
    // intents in production. A direct Gemini call with a focused 20-line
    // prompt produces clean 2-4 sentence answers in ~1.5-2s vs 15-30s.
    //
    // Each path: focused prompt → Gemini (grounding for knowledge/medication)
    // → format-enforce → content-check → ship. Block/regen violation or
    // empty output → return null → fall through to orchestrator. Net safety
    // unchanged; worst case is the same as today.
    {
      const earlyIntent = classifyIntent(input.text);
      const directIntent = earlyIntent.type;

      // 2026-06-05 production failure: "what should I eat for breakfast
      // tomorrow?" → orchestrator → Gemini refused with AI disclaimer
      // "I cannot provide personalized dietary advice." Route food_question
      // through a dedicated path that hits the curated meal idea bank
      // FIRST (deterministic, no LLM), falls back to a focused Gemini
      // call only when curated returns nothing.
      if (directIntent === 'food_question') {
        try {
          lat.mark('food_question_direct');
          const direct = await this.handleFoodQuestionDirect(input);
          if (direct) {
            const stageTimings = lat.snapshot();
            const totalMs = Date.now() - t0;
            this.deps.logger.info(
              { userId: input.userId, latencyMs: totalMs, stageTimings },
              'ai.food_question_direct.served',
            );
            this.persistLatency(input.userId, 'food_question_direct', totalMs, stageTimings, input.text, direct);
            return {
              text: direct,
              confidence: 'high',
              intent: 'food_question_direct',
              toolResults: [],
              usedRetrieval: false,
              latencyMs: totalMs,
            };
          }
        } catch (err) {
          this.deps.logger.warn(
            { err: err instanceof Error ? err.message : String(err) },
            'ai.food_question_direct.error',
          );
        }
      }

      const wantsDirect =
        directIntent === 'knowledge' ||
        directIntent === 'emotional' ||
        directIntent === 'appointment_prep' ||
        directIntent === 'medication_question' ||
        directIntent === 'social_situation';
      if (wantsDirect) {
        try {
          const stage = `${directIntent}_direct`;
          lat.mark(stage);
          const direct = await this.runDirectPath(directIntent, input.text);
          if (direct) {
            const stageTimings = lat.snapshot();
            const totalMs = Date.now() - t0;
            this.deps.logger.info(
              { userId: input.userId, intent: directIntent, latencyMs: totalMs, stageTimings },
              'ai.direct_path.served',
            );
            this.persistLatency(input.userId, stage, totalMs, stageTimings, input.text, direct);
            return {
              text: direct,
              confidence: 'high',
              intent: stage,
              toolResults: [],
              usedRetrieval: directIntent === 'knowledge' || directIntent === 'medication_question',
              latencyMs: totalMs,
            };
          }
        } catch (err) {
          this.deps.logger.warn(
            { err: err instanceof Error ? err.message : String(err), intent: directIntent },
            'ai.direct_path.error',
          );
        }
      }
    }

    try {
      return await this.handleMessageInner(input, t0, lat);
    } catch (outerErr) {
      // Emergency fallback: fires when the full pipeline throws (DB down, LLM
      // timeout, etc.). Makes one last bare LLM call with no tools/RAG/history.
      //
      // 2026-06-05 production failure: user asked "What should I eat for
      // dinner?" → orchestrator threw → emergency fired with the old 1-line
      // prompt → Gemini produced a ChatGPT-style 350-char "to give you the
      // best recommendation I need 3 things from you" template with bullets
      // → format-enforcer stripped bullets → unreadable grammar shipped to
      // user. Two fixes:
      //   1. Strong HARD RULES in the emergency prompt forbid the failure
      //      modes (bullets, clarifying questions, "I need more info").
      //   2. Emergency output goes through the content-checker before
      //      shipping. If it trips any banned phrase, drop to a final
      //      canned text instead of letting raw Gemini reach the user.
      this.deps.logger.error({ err: outerErr }, 'ai.handle.outer_catch');
      try {
        const emergency = await this.deps.llm.generate({
          messages: [
            {
              role: 'system',
              content:
                "You are Grace, a warm GLP-1 companion. Answer the user's message in ONE OR TWO short sentences. " +
                'HARD RULES — every one is non-negotiable: ' +
                '(1) NEVER say "to give you the best", "I need more information", "tell me about your goals", or ask any clarifying questions. ' +
                '(2) NEVER use bullet points, numbered lists, dashes, or section headers — prose only. ' +
                '(3) If asked for food ideas, name 2-3 specific GLP-1 friendly options in a single sentence (e.g. "Greek yogurt with hemp seeds, two-egg veggie omelet, or oatmeal with berries"). ' +
                "(4) If you genuinely can't answer, say so in one sentence — never deflect with questions. " +
                '(5) NEVER mention being an AI, a system, a chatbot, or that you are processing.',
            },
            { role: 'user', content: input.text },
          ],
          maxOutputTokens: 200,
          temperature: 0.3,
        });
        const rawEmergency = emergency.text?.trim() ?? '';
        if (rawEmergency) {
          // Run through the content-checker so banned phrases never reach
          // the user via the emergency path. If anything trips, ship a
          // safe canned text instead of the raw LLM output.
          const violations = checkContent(rawEmergency, {});
          const safeText =
            violations.some((v) => v.severity !== 'log')
              ? "I'm having trouble pulling that together right now — try again in a moment?"
              : rawEmergency;
          return {
            text: safeText,
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

  /**
   * Direct paths — for 5 intents that produce consistently bad responses
   * through the heavy orchestrator. Skip the 2,500-line system prompt +
   * planner + 7 guards + regen loop. One focused Gemini call → enforce →
   * check → ship.
   *
   * Returns null when: empty Gemini output, block/regen content violation,
   * or network error. Caller falls through to the regular pipeline so net
   * safety is unchanged; worst case is identical to pre-direct behavior.
   *
   * Why per-intent prompts (not a single shared one): the failure modes
   * differ. Knowledge needs grounding + brevity. Emotional needs warmth
   * without sycophancy. Appointment_prep needs concrete questions. The
   * prompts below each address the dominant failure pattern for their intent.
   */
  /**
   * Food-question direct path — 2026-06-05.
   *
   * Routes "what should I eat for X" type questions away from the
   * orchestrator (which has been refusing with AI disclaimers) into the
   * curated meal idea bank first, then a focused Gemini call as backup.
   *
   * Returns null on: curated bank miss + Gemini failure, or block/regen
   * content violation. Caller falls through to the regular pipeline.
   */
  private async handleFoodQuestionDirect(input: InboundMessage): Promise<string | null> {
    const userText = input.text;

    // Extract meal type and try the curated bank deterministically first.
    const lower = userText.toLowerCase();
    const mealType =
      /\bbreakfast\b/.test(lower) ? 'breakfast'
      : /\blunch\b/.test(lower) ? 'lunch'
      : /\bdinner\b|supper/.test(lower) ? 'dinner'
      : /\bsnack/.test(lower) ? 'snack'
      : 'general';

    // Fetch user profile for dietary restriction + dislikes.
    let user;
    try {
      user = await this.deps.users.getById(input.userId);
    } catch {
      user = null;
    }
    const dietaryRestriction = user?.dietary_pattern
      ? buildRestrictionFromLabel(user.dietary_pattern)
      : null;
    const dislikes = (user?.food_dislikes ?? [])
      .map((d) => (d ?? '').trim().replace(/^(i\s+(don'?t|do\s+not|hate|can'?t\s+stand|dislike)\s+(like\s+)?|no\s+|avoid\s+)/i, '').trim())
      .filter((d) => d.length > 0);

    const curated = getCuratedFoodIdeas({
      userId: input.userId,
      query: userText,
      mealType,
      dietaryRestriction,
      foodDislikes: dislikes,
    });
    if (curated && curated.length >= 3) {
      const names = curated.map((c) => c.name).slice(0, 4);
      const last = names.pop()!;
      const list = names.length > 0 ? `${names.join(', ')}, or ${last}` : last;
      const reply = `A few options: ${list}. Anything sound good?`;
      // Run through format-enforce + content-check for consistency.
      const formatted = enforceFormat(reply, { userMessage: userText });
      const violations = checkContent(formatted.text, { userMessage: userText });
      if (violations.some((v) => v.severity === 'block' || v.severity === 'regen')) return null;
      return formatted.text;
    }

    // Curated miss → focused Gemini call with strong refusal-language ban.
    const FOOD_QUESTION_SYSTEM = `You are Grace, a warm GLP-1 companion. The user is asking what to eat or for food recommendations.

ANSWER STYLE:
- 2 to 4 sentences total. Name 3 to 5 SPECIFIC foods.
- Lead with the foods, then one brief reason they work on GLP-1s (small, protein-dense, easy to digest).
- Prose only. NO bullet points, NO numbered lists, NO section headers.
- Be concrete: name actual foods like "Greek yogurt with hemp seeds, a two-egg veggie omelet, smoked salmon on rye", not categories like "high-protein options".

NEVER (any of these mean refusal — banned):
- Say "I cannot provide personalized dietary advice" or any refusal phrase.
- Say "My purpose is to..." or "I am an AI and...".
- Say "consult your doctor / registered dietitian" — that's deflection for a meal question.
- Ask "what kind of meal are you thinking?" — they already told you (or didn't, you suggest anyway).
- Use parenthetical brand-name dumps.

If you don't know specifics, name standard GLP-1 friendly options and move on.`;

    let resp;
    try {
      resp = await this.deps.llm.generate({
        messages: [
          { role: 'system', content: FOOD_QUESTION_SYSTEM },
          { role: 'user', content: userText },
        ],
        temperature: 0.4,
        maxOutputTokens: 300,
        useGoogleSearch: false,
      });
    } catch (err) {
      this.deps.logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'food_question_direct.gemini_failed',
      );
      return null;
    }
    const raw = resp.text?.trim() ?? '';
    if (raw.length === 0) return null;

    const formatted = enforceFormat(raw, { userMessage: userText });
    const violations = checkContent(formatted.text, { userMessage: userText });
    if (violations.some((v) => v.severity === 'block' || v.severity === 'regen')) {
      this.deps.logger.info(
        { codes: violations.map((v) => v.code).slice(0, 5) },
        'food_question_direct.content_violations',
      );
      return null;
    }
    return formatted.text;
  }

  private async runDirectPath(intent: string, userText: string): Promise<string | null> {
    const config = DIRECT_PATH_CONFIGS[intent];
    if (!config) return null;

    let resp;
    try {
      resp = await this.deps.llm.generate({
        messages: [
          { role: 'system', content: config.system },
          { role: 'user', content: userText },
        ],
        temperature: config.temperature,
        maxOutputTokens: config.maxTokens,
        useGoogleSearch: config.useSearch,
      });
    } catch (err) {
      this.deps.logger.warn(
        { err: err instanceof Error ? err.message : String(err), intent },
        'direct_path.gemini_failed',
      );
      return null;
    }
    const raw = resp.text?.trim() ?? '';
    if (raw.length === 0) return null;

    // Format-enforce: strip markdown, em-dashes, label-colons, list intros.
    const formatted = enforceFormat(raw, { userMessage: userText });

    // Content-check: drop on banned-phrase or block violations. Regen-
    // severity → fall through to orchestrator (which has the regen
    // machinery). Clean → ship.
    const violations = checkContent(formatted.text, { userMessage: userText });
    if (violations.some((v) => v.severity === 'block' || v.severity === 'regen')) {
      this.deps.logger.info(
        { codes: violations.map((v) => v.code).slice(0, 5), intent },
        'direct_path.content_violations',
      );
      return null;
    }

    // Final length sanity check — direct replies must be under the intent's
    // hard cap. If still over, trim to the first N sentences.
    if (formatted.text.length > config.hardCharCap) {
      const sentences = formatted.text.split(/(?<=[.!?])\s+/);
      return sentences.slice(0, config.maxSentencesOnTrim).join(' ').trim();
    }
    return formatted.text.trim();
  }

  // Full message processing flow: (1) parallel I/O (user profile, history, media
  // analysis, tool settings), (2) RAG retrieval + planner + user memory in parallel,
  // (3) detect dietary restrictions + side effects, (4) build personalised system
  // prompt with runtime context, (5) register per-request tools, (6) call
  // orchestrator.run(), (7) fire-and-forget persistence + memory extraction.
  private async handleMessageInner(input: InboundMessage, t0: number, lat: LatencyTracker): Promise<OrchestratorOutput> {
    const { logger, memory, rag, flags, users } = this.deps;

    // Fire all independent I/O in parallel: user profile, conversation, history, tool settings,
    // and media analysis. RAG retrieval needs augmentedText so it runs after media completes.
    lat.mark('parallel_io');
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

    // ensureConversation usually resolves in ~50-100ms (single UPSERT with
    // unique-constraint hit on warm DB). conversationSummary + topicTracker
    // depend on conversationId but used to run AFTER all 9 parallel queries
    // completed — pure dead time when ensureConversation finishes fast and
    // other queries lag. Now they're chained off ensureConversation so they
    // start as soon as the conversationId resolves, running IN PARALLEL with
    // the other slower queries. Saves ~150-300ms when ensureConversation
    // beats the slow tail.
    const conversationPromise = memory.ensureConversation(input.userId).catch(() => `fallback-${input.userId}`);
    const phase4Promise = conversationPromise.then(async (cId) => {
      const [summary, topic] = await Promise.all([
        this.deps.conversationSummary ? this.deps.conversationSummary.get(cId).catch(() => null) : Promise.resolve(null),
        this.deps.topicTracker ? this.deps.topicTracker.get(cId).catch(() => null) : Promise.resolve(null),
      ]);
      return { summary, topic };
    });

    const [user, conversationId, isNew, history, toolSettings, description, todaysFood, checkinsToday, knownFacts, phase4] = await Promise.all([
      users.getById(input.userId).catch(() => null),
      conversationPromise,
      users.isNewUser(input.userId).catch(() => false),
      memory.getRecentTurns(input.userId, 6).catch(() => [] as ChatTurn[]),
      flags.toolsEnabled ? this.loadToolSettings() : Promise.resolve({} as Record<string, boolean>),
      mediaPromise,
      users.getTodaysFoodSummary(input.userId).catch(() => ({ protein_g: 0, calories: 0, items: [] })),
      this.countTodaysCheckIns(input.userId).catch(() => 0),
      users.getKnownFacts(input.userId, 30).catch(() => []),
      phase4Promise,
    ]);
    const conversationSummary = phase4.summary;
    const activeTopic = phase4.topic;

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
    lat.mark('classify');
    const intentClass = classifyIntent(augmentedText);
    // Skip the planner LLM call when the classifier is already confident enough
    // that the planner would just confirm "no tools needed, generate prose".
    // RAG retrieval still happens in parallel (see retrieved below) — the
    // knowledge / emotional / appointment_prep responses already have the
    // RAG chunks injected by the orchestrator from input.retrieved, so the
    // knowledge_search tool would just duplicate that work.
    // Saves ~500-600ms per matching message at zero accuracy cost.
    const CLASSIFIER_SKIP_PLANNER = new Set([
      'greeting',
      'gibberish',
      // Safe adds (session-3 latency pass): these intents need NO tool calls,
      // so the planner LLM (~600ms) is pure overhead.
      //   - knowledge: RAG chunks already injected from input.retrieved; the
      //     orchestrator generates from the system prompt + RAG context
      //   - appointment_prep: needs no tools, just generation
      //   - emotional: needs no tools, just generation
      //   - food_log: the shouldForceLogFood block downstream guarantees the
      //     log_food tool fires regardless of planner output
      'knowledge',
      'appointment_prep',
      'emotional',
      'food_log',
      // Phase 1 coverage expansion intents that also need no tools — adding
      // them here saves ~500-600ms per matching message at zero accuracy cost.
      // The planner would have made the same "no tools" decision anyway.
      //   - exercise_log: just an acknowledgment ("Nice — that's a solid one")
      //   - injection_log: just an acknowledgment ("Got it, that's done")
      //   - social_situation: generation-only with the new SOCIAL SITUATIONS
      //                       prompt section providing the strategies
      'exercise_log',
      'injection_log',
      'social_situation',
      // Phase 2 latency pass (2026-06-01): food_question is now safe to skip
      // because EVERY subtype either hits a force-call block downstream OR
      // needs no tool at all:
      //   - FOOD_SUMMARY_QUESTION  → force get_food_summary
      //   - FOOD_HISTORY_QUESTION  → force get_protein_history
      //   - PROTEIN_TARGET_QUESTION → force get_user_profile
      //   - FOOD_REMOVAL_QUESTION  → force remove_food
      //   - FOOD_RECOMMENDATION    → force no-tool path (handled by prompt)
      //   - leftover (e.g. "how much protein in eggs?") → LLM knowledge,
      //     no tool needed; RAG chunks already injected from parallel fetch
      // The planner LLM (~600ms) was pure overhead on every protein follow-
      // up question. Skipping it saves ~500-600ms with zero accuracy cost.
      'food_question',
      // 2026-06-04 latency cut: 'general' is the catch-all for unclassifiable
      // chat — "why?", "ok thanks", short follow-ups. Production telemetry
      // showed the planner LLM burning ~1.4s on every general turn,
      // returning "no tools needed" on the vast majority. The few general
      // turns that DO benefit from a tool (e.g. a misclassified food log)
      // are caught by the force-call blocks downstream (shouldForceLogFood
      // etc.). Skipping the planner here saves ~1.4s on chat follow-ups
      // with zero functional loss.
      'general',
      // INTENTIONALLY NOT INCLUDED (planner needed for correct tool call):
      //   - weight_log: needs log_weight tool, no force block exists
      //   - mood_log: needs log_mood tool, no force block exists
      //   - medication_question: storage/timing answers need knowledge_search;
      //     no force block, so the planner picks the right tool
      //   - pause_request: short-circuits at the webhook layer; never reaches
      //     this code path anyway
    ]);
    const skipPlanner =
      CLASSIFIER_SKIP_PLANNER.has(intentClass.type) || !flags.toolsEnabled;
    const planner = new PlannerAgent(this.deps.llm);

    // RAG skip on log / acknowledgment intents — these confirm or store the
    // user's action; the knowledge corpus adds nothing to a "you logged 25g
    // protein, you're at 50g today" reply. Saves ~300-500ms per matching turn.
    // Production note (2026-06-03): rag.retrieve embeds the user message
    // (~150ms cached / 350ms cold) + pgvector lookup (~50-200ms) → 300-500ms.
    // For the listed intents the cost is pure dead weight.
    const RAG_SKIP_INTENTS = new Set([
      'food_log', 'weight_log', 'mood_log',
      'exercise_log', 'injection_log',
      'greeting', 'gibberish',
      'scheduling', 'pause_request',
      // Food recommendations don't need GLP-1 KB retrieval — the prompt's
      // FOOD RECOMMENDATIONS section + tool calls (get_food_summary,
      // search_food_ideas) already provide everything the response needs.
      // Production telemetry 2026-06-03 showed RAG burning ~750ms here with
      // no measurable impact on response quality.
      'food_question',
      // 2026-06-04: 'general' = catch-all for unclassifiable messages. These
      // are typically chat ("tell me a joke", "ok thanks") or follow-up
      // questions that piggyback on conversation context, not novel knowledge
      // queries. Production telemetry showed RAG burning 1.7s on a
      // misclassified breakfast question that landed in 'general'. Knowledge
      // queries STILL hit RAG because they classify as 'knowledge' / 'medication_question'.
      'general',
    ]);
    const ragSkippedForIntent = RAG_SKIP_INTENTS.has(intentClass.type);

    // User-memory skip on the same intents — long-term memory chunks are about
    // background context (preferences, history) which doesn't change how Grace
    // confirms a log or replies to a greeting. Saves another ~150-300ms.
    const userMemorySkipped = RAG_SKIP_INTENTS.has(intentClass.type);

    lat.mark('rag_planner_memory');
    const [retrieved, userMemories, prePlannedDecisionRaw] = await Promise.all([
      flags.ragEnabled && !ragSkippedForIntent
        ? rag.retrieve(augmentedText, { userId: input.userId, topK: 5 })
        : Promise.resolve([]),
      this.deps.userMemory && !userMemorySkipped
        ? this.deps.userMemory.retrieve(input.userId, augmentedText, 3)
        : Promise.resolve([] as string[]),
      skipPlanner
        ? Promise.resolve<PlannerDecision>({ intent: 'chat', needsTools: false, toolCalls: [], rationale: `classifier_fast_path_${intentClass.type}` })
        : planner.plan(augmentedText).catch((): PlannerDecision => ({ intent: 'chat', needsTools: false, toolCalls: [], rationale: 'planner_error' })),
    ]);
    if (ragSkippedForIntent || userMemorySkipped) {
      logger.info(
        { userId: input.userId, intent: intentClass.type, ragSkipped: ragSkippedForIntent, memSkipped: userMemorySkipped },
        'ai.handle.rag_memory_skipped',
      );
    }

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

    lat.mark('vague_food_check');
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
    // FAQ cache only fires on knowledge-style questions. Skip the lookup for
    // log/acknowledgment/admin intents that can never benefit. Saves ~150-300ms
    // per matching turn (the embedding + pgvector lookup).
    const FAQ_INTENT_BLOCK = new Set([
      'food_log', 'weight_log', 'mood_log',
      'exercise_log', 'injection_log',
      'scheduling', 'pause_request',
      'greeting', 'gibberish',
    ]);
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
      lat.mark('faq_cache_lookup');
      const hit = await this.deps.faqCache.lookup(input.text);
      if (hit) {
        // ── SAFETY: validate cached response against THIS user's context ──
        // The cache stores generic responses, but a user-specific guard must
        // still fire. Without this check, a vegan user asking "best high-
        // protein foods" would get Greek yogurt / eggs / cottage cheese back.
        // Or a Rybelsus (daily pill) user asking "I think I injected too
        // much" would get a response that doesn't apply to their med form.
        //
        // We run the FULL content checker against the cached response with
        // this user's dietary pattern, food dislikes, medication type, and
        // intent. ANY violation → bail out of cache and fall through to the
        // full pipeline so Grace generates a contextually-correct reply.
        const cachedDietary = user?.dietary_pattern
          ? buildRestrictionFromLabel(user.dietary_pattern)
          : null;
        const cachedMedType = inferMedicationType(user?.medication ?? null);
        const cleanedDislikes = (user?.food_dislikes ?? [])
          .map((d) => d.replace(/^(i\s+(don'?t|do\s+not|hate|can'?t\s+stand|dislike)\s+(like\s+)?|no\s+|avoid\s+)/i, '').trim())
          .filter(Boolean);
        const cacheViolations = checkContent(hit.response, {
          ...(cachedDietary ? { dietaryRestriction: cachedDietary } : {}),
          ...(cleanedDislikes.length > 0 ? { foodDislikes: cleanedDislikes } : {}),
          ...(cachedMedType !== 'unknown' ? { medicationType: cachedMedType } : {}),
          userMessage: input.text,
          intentType: intentClass.type,
          // FAQ cache hits are pre-vetted educational responses with
          // intentional citation numbers ("STEP-1: ~40%", "1.2-1.6g/kg")
          // that legitimately aren't in the user message. Skip the
          // stale-context-echo guard for these — keep all other guards.
          skipStaleContextEcho: true,
        });
        const cacheBlocked = cacheViolations.filter(
          (v) => v.severity === 'block' || v.severity === 'regen' || !v.severity,
        );
        if (cacheBlocked.length > 0) {
          this.deps.logger.info(
            {
              userId: input.userId,
              matchedQuery: hit.matchedQuery.slice(0, 60),
              similarity: hit.similarity.toFixed(3),
              violations: cacheBlocked.map((v) => v.code),
            },
            'ai.handle.faq_cache_rejected',
          );
          // Don't return — let the full pipeline produce a contextually-
          // correct response. The cache miss is logged so we can audit.
        } else {
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
        } // end of `else` (cache passes safety check)
      }
    }

    // ── EMOTIONAL DISTRESS TRIAGE FILTER (QA report 2026-06-03, Step 2) ──
    // When a food message is paired with shame / guilt / self-loathing words,
    // FORCE-CALLING log_food makes Grace lead with "Got it, about 88g protein
    // for that" — the exact production failure flagged in the QA audit.
    // Suppress the force-call so the orchestrator answers the FEELING first.
    // A prompt rule alone is not enough — the log_food tool result anchors
    // Grace's reply even when the prompt says "address emotion first."
    //
    // Pattern source: 2026-06-03 production screenshots + EMOTION BEFORE DATA
    // section of prompts.ts. Conservative on shame/binge language; deliberately
    // ignores neutral negatives like "I felt tired" — those don't override
    // the macro acknowledgment.
    const EMOTIONAL_DISTRESS_FOOD_RE = /\b(disgusting|gross\b|awful|ashamed|embarrassed|hate (myself|this body|my body)|feel like (a |such a )?(failure|loser|pig|whale|cow)|feel huge|feel fat\b|can'?t believe (i|myself)|binged|binge\b|blew it|so guilty|i feel guilty|feel terrible (about|after)|i'?m the worst|feeling fat|out of control|spiraled|spiraling|fell off|gave up|ruined (it|today|everything)|messed up (so )?bad)\b/i;
    const hasFoodDistress = EMOTIONAL_DISTRESS_FOOD_RE.test(input.text);
    if (hasFoodDistress) {
      this.deps.logger.info(
        { userId: input.userId, textPreview: input.text.slice(0, 120) },
        'ai.handle.emotional_distress_food_skip_force_log',
      );
    }

    const shouldForceLogFood =
      !hasFoodDistress &&
      flags.toolsEnabled &&
      !prePlannedDecision.toolCalls.some((c) => c.name === 'log_food') &&
      (intentClass.type === 'food_log' || obviousFoodMention);

    if (shouldForceLogFood) {
      // Multi-meal split (production failure 2026-06-01): user sent
      //   "Hey\nFor breakfast i ate 2 eggs.\nFor lunch chicken breast with cup of rice"
      // The whole text was passed to a SINGLE log_food call which couldn't
      // parse it as multiple meals and logged 0g. We now detect multi-meal
      // input and schedule a separate log_food call per meal so each gets
      // its own macro estimate.
      const meals = splitMultiMealText(input.text);
      const toolCalls = meals.length >= 2
        ? meals.map((m) => ({ name: 'log_food', args: { food: m } }))
        : [{ name: 'log_food', args: { food: input.text } }];
      prePlannedDecision = {
        intent: 'log_food',
        needsTools: true,
        toolCalls,
        rationale: meals.length >= 2
          ? 'classifier_forced_log_food_multi_meal'
          : (intentClass.type === 'food_log' ? 'classifier_forced_log_food' : 'food_words_detected'),
      };
      this.deps.logger.info(
        { userId: input.userId, classifierType: intentClass.type, obviousFoodMention, mealCount: meals.length || 1, textPreview: input.text.slice(0, 100) },
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

    // Context isolation flag: when the force-log fired in a fresh context (not
    // a continuation of a Grace food question), prior assistant turns must be
    // stripped from the orchestrator history. Without this, a user saying
    // "I also ate two slices of pizza" after a dinner recommendation thread gets
    // MORE dinner advice instead of a food-log acknowledgment (production failure
    // 2026-06-03). The continuation case is NOT isolated — it needs the prior
    // Grace message to build the combined context.
    const isolateFoodLog = shouldForceLogFood;

    // FORCE the right protein-related tool based on the exact question shape.
    // The classifier (FOOD_SUMMARY / FOOD_HISTORY / PROTEIN_TARGET / FOOD_REMOVAL)
    // all map to `food_question` intent, but each subgroup needs a DIFFERENT
    // tool to answer correctly. Without these force-calls, the planner LLM
    // sometimes picks the wrong tool and Grace falls back to "I'm listening,
    // tell me more" — exact production failure 2026-05-31.

    // 1. Past-day queries → get_protein_history (covers "yesterday's protein",
    //    "last 7 days", "this week's average")
    const isFoodHistoryQuery = intentClass.type === 'food_question' &&
      FOOD_HISTORY_QUESTION.some((re) => re.test(input.text));
    if (
      isFoodHistoryQuery &&
      flags.toolsEnabled &&
      !prePlannedDecision.toolCalls.some((c) => c.name === 'get_protein_history')
    ) {
      // Extract day count if user said "last 7 days" / "past 14 days" — else 7.
      const dayMatch = input.text.match(/\b(last|past|previous)\s+(\d+)\s+days?\b/i);
      const days = dayMatch ? Math.max(1, Math.min(30, parseInt(dayMatch[2]!, 10))) : 7;
      prePlannedDecision = {
        intent: 'get_protein_history',
        needsTools: true,
        toolCalls: [{ name: 'get_protein_history', args: { days } }],
        rationale: 'classifier_forced_get_protein_history',
      };
    }
    // 2. Target/goal explanation queries → get_user_profile (covers
    //    "why is my target 60g", "is 80g enough")
    const isTargetQuery = !isFoodHistoryQuery &&
      intentClass.type === 'food_question' &&
      PROTEIN_TARGET_QUESTION.some((re) => re.test(input.text));
    if (
      isTargetQuery &&
      flags.toolsEnabled &&
      !prePlannedDecision.toolCalls.some((c) => c.name === 'get_user_profile')
    ) {
      prePlannedDecision = {
        intent: 'get_user_profile',
        needsTools: true,
        toolCalls: [{ name: 'get_user_profile', args: {} }],
        rationale: 'classifier_forced_get_user_profile_for_target',
      };
    }
    // 3. Removal / correction queries → remove_food (covers "remove the eggs",
    //    "that's wrong", "I didn't eat that")
    const isRemovalQuery = !isFoodHistoryQuery && !isTargetQuery &&
      intentClass.type === 'food_question' &&
      FOOD_REMOVAL_QUESTION.some((re) => re.test(input.text));
    if (
      isRemovalQuery &&
      flags.toolsEnabled &&
      !prePlannedDecision.toolCalls.some((c) => c.name === 'remove_food')
    ) {
      // Try to extract the food name from the user message (e.g. "remove
      // the eggs" → "eggs"). Fall back to the raw text — the tool's own
      // matcher handles ambiguity.
      const foodMatch = input.text.match(/\b(?:remove|delete|undo|forget|cancel) (?:the |that |my |last )?(.+?)(?:\.|$|\?)/i);
      const foodToRemove = foodMatch?.[1]?.trim() ?? input.text;
      prePlannedDecision = {
        intent: 'remove_food',
        needsTools: true,
        toolCalls: [{ name: 'remove_food', args: { food: foodToRemove } }],
        rationale: 'classifier_forced_remove_food',
      };
    }
    // 4. Today's totals — the original FORCE block (covers "how much left",
    //    "did I overeat", "how did I reach X", "show me what I logged today").
    //
    // 2026-06-04 fix: previous regex was too broad. It matched "eat" alone,
    // so "what should I eat for breakfast?" triggered get_food_summary
    // force-call — wrong tool for a recommendation request. The LLM then
    // tried to generate breakfast suggestions with "you're at 0g protein"
    // as primary context, produced meat for a vegetarian, regen failed,
    // fallback fired with the food-summary template. Three coordinated bugs
    // from one bad gate.
    //
    // Tightened to ONLY fire on phrases that genuinely ask about TODAY'S
    // STATUS, not on any food-related word. Recommendation phrasing
    // ("what should I eat", "what to eat", "ideas", "recommend") is
    // explicitly excluded.
    const looksLikeRecommendation = /\b(should i (?:eat|have|drink|make|cook|order|try)|ideas?|recommend|suggest(?:ion)?s?|what (?:to|can|could) (?:eat|have|drink|make|cook|order)|any (?:food|meal|snack|dinner|lunch|breakfast))\b/i.test(input.text);
    const looksLikeStatusQuery = /\b(how (?:much|many)\s+(?:protein|calorie|kcal|carb|gram)|protein (?:left|remaining|today|so far)|calorie(?:s)? (?:left|remaining|today|so far)|did i (?:over|under)?eat|am i (?:over|under|at|close)|how am i doing|where am i (?:at|on)|breakdown|break ?down|coming from|show me (?:what|all|the foods)|what foods? (?:did i|have i)|how did i (?:reach|reached|get|got))\b/i.test(input.text);
    const isFoodSummaryQuery = !isFoodHistoryQuery && !isTargetQuery && !isRemovalQuery &&
      intentClass.type === 'food_question' &&
      looksLikeStatusQuery &&
      !looksLikeRecommendation;
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
    // 5. Pure food-recommendation requests ("what should I eat for lunch?",
    //    "give me dinner ideas", "what's a good high-protein breakfast?") —
    //    the LLM has the full food-recommendation prompt section + user
    //    dietary context + RAG chunks; no tool call needed for an adequate
    //    answer, and skipping the planner saves ~500-600ms per message.
    //    The classifier's FOOD_QUESTION patterns match these, but they
    //    don't overlap with the FOOD_SUMMARY_QUESTION above (no "protein",
    //    "left", "calorie", etc.) so they fall through to here.
    //    Production failure 2026-06-01: "What should I eat for lunch" took
    //    several seconds because the planner LLM ran even though no tool
    //    fired.
    const isFoodRecommendation = intentClass.type === 'food_question' &&
      !isFoodSummaryQuery && !isFoodHistoryQuery && !isTargetQuery && !isRemovalQuery &&
      /\b(what (should|can|could) i (eat|have|make|cook|order)|(recommend|suggest)(ion)?(s)? for|good (protein|snack|meal|food)|(meal|snack|dinner|lunch|breakfast|brunch) (ideas?|suggestions?|recommendations?)|hungry|what'?s (a |for )?(good|healthy|filling)|what to (eat|have|make))\b/i.test(input.text);
    if (isFoodRecommendation) {
      prePlannedDecision = {
        intent: 'food_recommendation',
        needsTools: false,
        toolCalls: [],
        rationale: 'classifier_forced_no_tool_food_recommendation',
      };
    }

    // Detect side effects in the user's message and update their flow.
    // 2026-06-04: force-call get_user_profile for reasoning requests so the
    // LLM has the user's actual weight/goal/age/sex available when explaining
    // a previous numeric recommendation. Production failure: user asked "Why?"
    // after "Your protein goal is 60g.", Grace gave generic GLP-1 muscle
    // education instead of showing the math (60g ≈ weight_kg × 1.2g/kg).
    // The tool result lands in toolResults; the focus marker's REASONING
    // REQUEST banner explicitly tells the LLM to use those numbers.
    const lastAssistantInHistory = [...history].reverse().find((t) => t.role === 'assistant')?.content;
    const isReasoningRequestHere = detectReasoningRequest(input.text, lastAssistantInHistory);
    if (
      isReasoningRequestHere &&
      flags.toolsEnabled &&
      !prePlannedDecision.toolCalls.some((c) => c.name === 'get_user_profile')
    ) {
      prePlannedDecision = {
        intent: 'get_user_profile',
        needsTools: true,
        toolCalls: [{ name: 'get_user_profile', args: {} }],
        rationale: 'forced_get_user_profile_for_reasoning',
      };
      logger.info({ userId: input.userId, text: input.text.slice(0, 60) }, 'ai.handle.forced_get_user_profile_for_reasoning');
    }

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

    // Topic-switch suppression of stale context (2026-06-03 production fix):
    // activeTopic explicitly tells Grace the previous topic is "still live",
    // and conversationSummary carries durable references to older topics.
    // Both are anchors the orchestrator's history-strip can't reach because
    // they live in the system prompt. When the user has clearly shifted
    // topic, drop both so Grace responds clean to the NEW message.
    const lastAssistantFromHistory = [...history]
      .reverse()
      .find((t) => t.role === 'assistant')?.content;
    const topicSwitchAtAiService = detectTopicSwitch(input.text, lastAssistantFromHistory);
    if (topicSwitchAtAiService) {
      logger.info(
        {
          userId: input.userId,
          activeTopicSuppressed: !!activeTopic,
          conversationSummarySuppressed: !!conversationSummary,
        },
        'ai.handle.topic_switch_context_suppressed',
      );
    }

    // Build personalised system prompt with user context.
    const systemPrompt = this.buildPersonalisedPrompt(user, isNew, {
      todaysFood,
      checkinsToday,
      knownFacts,
      dietaryRestriction,
      currentUserText: input.text,
      ...(!topicSwitchAtAiService && conversationSummary ? { conversationSummary: conversationSummary.summary } : {}),
      ...(!topicSwitchAtAiService && activeTopic ? { activeTopic } : {}),
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
          users: this.deps.users,
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
        // get_protein_history is gated on the same toolSetting flag — past-day
        // queries are a different question shape but the same data source.
        tools.register(makeGetProteinHistoryTool({ users, userId: input.userId }));
      }
      if (toolSettings['log_side_effect'] !== false) {
        tools.register(makeLogSideEffectTool({ users, userId: input.userId, phone: user?.phone ?? input.userId }));
      }
      if (toolSettings['search_food_ideas'] !== false) {
        tools.register(makeSearchFoodIdeasTool({
          llm: this.deps.llm,
          logger,
          userId: input.userId,
          ...(this.deps.redis ? { redis: this.deps.redis } : {}),
          dietaryRestriction,
          foodDislikes: cleanFoodDislikes,
        }));
      }
      if (toolSettings['remove_food'] !== false) {
        tools.register(makeRemoveFoodTool({ pool: this.deps.pool, logger, userId: input.userId }));
      }
    }
    const orchestrator = new AIOrchestrator({
      llm: this.deps.llm,
      tools,
      logger,
      // Pass-through TRUST GEMINI flags. When trustGemini=true, the
      // orchestrator skips behavioral / relevance / quality guards entirely.
      ...(this.deps.guards ? { guards: this.deps.guards } : {}),
    });

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
    if (isolateFoodLog) {
      // Strip all prior Grace replies: the food-log response should NOT be
      // anchored to a prior dinner/recommendation thread. Only user turns are
      // kept so the profile context (dietary, goal) is still visible to the LLM
      // via the system prompt rather than through assistant-turn anchoring.
      effectiveHistory = history.filter((t) => t.role === 'user');
      logger.info(
        { userId: input.userId, textPreview: input.text.slice(0, 60) },
        'ai.handle.food_log_history_isolated',
      );
    } else if (history.length >= 2) {
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

    lat.mark('orchestrator');
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

    // ── Duplicate-response blocking (2026-06-04 production failure) ─────
    // User got the exact same "It's great/smart you're thinking about your
    // full macronutrient picture..." paragraph THREE TIMES to three different
    // questions. The ResponseFingerprintService's recent-list check catches
    // near-realtime duplication BEFORE the message ships.
    //
    // When a duplicate fires, we replace the response with a brief
    // self-aware acknowledgment instead of shipping the dupe (or running
    // another regen, which costs latency the user already paid for).
    if (this.deps.fingerprint && result.text && !result.usedSafeFallback) {
      const dupCheck = await this.deps.fingerprint.checkRecentDuplicate(
        input.userId,
        result.text,
      ).catch(() => null);
      if (dupCheck?.isDuplicate) {
        logger.warn(
          {
            userId: input.userId,
            jaccard: dupCheck.maxJaccard,
            originalLen: result.text.length,
            matchedExcerpt: dupCheck.matchedExcerpt,
          },
          'ai.response_duplicate_blocked',
        );
        if (this.deps.productionIssues) {
          void this.deps.productionIssues.captureFireAndForget({
            userId: input.userId,
            conversationId,
            userMessage: input.text,
            graceResponse: result.text,
            trigger: 'phrase_repetition',
            violationCodes: ['recent_response_duplicate'],
            context: {
              intent: result.intent,
              jaccard: dupCheck.maxJaccard,
              matchedExcerpt: dupCheck.matchedExcerpt,
            },
          });
        }
        // Replace with a brief, self-aware alternative. Different from any
        // typed fallback so it doesn't itself become a repeated pattern.
        // Variant chosen by hash of (userId + day) so it varies per user
        // and across days but is stable for one conversation.
        const variants = [
          "I just said something similar — what specifically did you want me to dig into?",
          "I covered most of that in my last reply. What angle would be useful here?",
          "That overlaps with what I just told you. Anything you want me to go deeper on?",
        ];
        let hash = 0;
        const seed = `${input.userId}|${new Date().toISOString().slice(0, 10)}`;
        for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) | 0;
        const replacement = variants[Math.abs(hash) % variants.length]!;
        result.text = replacement;
      }
      // Always record AFTER any replacement so the next turn's check sees
      // what we actually shipped (replacement OR original).
      void this.deps.fingerprint.recordRecent(input.userId, result.text);
    }

    // ── Production issue capture (Layer 4 of defense-in-depth) ──────────
    // Fire-and-forget: capture every regen/fallback/violation event so we
    // can review and promote to regression tests. NEVER blocks the user.
    if (this.deps.productionIssues) {
      const issueSvc = this.deps.productionIssues;
      if (result.usedSafeFallback) {
        void issueSvc.captureFireAndForget({
          userId: input.userId,
          conversationId,
          userMessage: input.text,
          graceResponse: result.text,
          trigger: 'safe_fallback',
          violationCodes: result.regenTriggerCodes,
          context: {
            intent: result.intent,
            confidence: result.confidence,
            regenerated: result.regenerated,
            // Diagnostic data — see WHY the response was rejected.
            ...(result.regenViolationDetails && result.regenViolationDetails.length > 0
              ? { violation_details: result.regenViolationDetails }
              : {}),
            ...(result.originalAttemptText
              ? { original_attempt_text: result.originalAttemptText.slice(0, 800) }
              : {}),
          },
        });
      } else if (result.regenerated && result.regenTriggerCodes && result.regenTriggerCodes.length > 0) {
        const codes = result.regenTriggerCodes;
        const primary: 'behavioral_violation' | 'topic_drift' | 'phrase_repetition' | 'long_response_chopped' | 'truncation_cascade' =
          codes.includes('behavioral_violation') ? 'behavioral_violation'
          : codes.includes('relevance_check_failed') || codes.includes('topic_drift') ? 'topic_drift'
          : codes.includes('phrase_repetition') ? 'phrase_repetition'
          : (codes.includes('too_long') || codes.includes('too_many_sentences')) ? 'long_response_chopped'
          : 'truncation_cascade';
        void issueSvc.captureFireAndForget({
          userId: input.userId,
          conversationId,
          userMessage: input.text,
          graceResponse: result.text,
          trigger: primary,
          violationCodes: codes,
          context: {
            intent: result.intent,
            confidence: result.confidence,
            ...(result.regenViolationDetails && result.regenViolationDetails.length > 0
              ? { violation_details: result.regenViolationDetails }
              : {}),
            ...(result.originalAttemptText
              ? { original_attempt_text: result.originalAttemptText.slice(0, 800) }
              : {}),
          },
        });
      }
    }

    lat.mark('persist');
    const stageTimings = lat.snapshot();
    // Fold orchestrator-internal timings (generate / guards / regen) into the
    // per-stage breakdown so /admin/latency shows where time goes inside the
    // orchestrator. Without these, the "orchestrator" stage looks like an
    // opaque 20s blob and we can't tell whether to attack the generate call,
    // the parallel guards, or the regen path.
    if (result.internalTimings) {
      const it = result.internalTimings;
      if (typeof it.tools === 'number' && it.tools > 0) {
        stageTimings['orch_tools'] = it.tools;
      }
      if (typeof it.generate === 'number') {
        stageTimings['orch_generate'] = it.generate;
      }
      if (typeof it.postgen === 'number' && it.postgen > 0) {
        stageTimings['orch_postgen'] = it.postgen;
      }
      if (typeof it.guards === 'number') {
        stageTimings['orch_guards'] = it.guards;
      }
      if (typeof it.guardRelevance === 'number' && it.guardRelevance > 0) {
        stageTimings['guard_relevance'] = it.guardRelevance;
      }
      if (typeof it.guardBehavioral === 'number' && it.guardBehavioral > 0) {
        stageTimings['guard_behavioral'] = it.guardBehavioral;
      }
      if (typeof it.guardCritic === 'number' && it.guardCritic > 0) {
        stageTimings['guard_critic'] = it.guardCritic;
      }
      if (typeof it.review === 'number' && it.review > 0) {
        stageTimings['orch_review'] = it.review;
      }
      if (typeof it.regen === 'number' && it.regen > 0) {
        stageTimings['orch_regen'] = it.regen;
      }
    }
    const totalMs = Date.now() - t0;
    // Use the deterministic classifier intent (food_question, weight_log, etc.)
    // rather than the planner's tool/chat intent. Earlier telemetry showed
    // 'get_food_summary' and 'chat' polluting the breakdown — those are tool
    // names and planner outputs, not message categories.
    const intentForLog = intentClass.type ?? 'general';

    // Slow-request alerting — log a structured warning when totalMs exceeds the
    // per-intent target. This is the diagnostic surface that catches latency
    // regressions without re-instrumenting.
    const target = LATENCY_TARGETS_MS[intentForLog] ?? DEFAULT_LATENCY_TARGET_MS;
    if (totalMs > target) {
      logger.warn(
        {
          userId: input.userId,
          intent: intentForLog,
          totalMs,
          targetMs: target,
          overBy: totalMs - target,
          stageTimings,
        },
        'ai.handle.slow_response',
      );
    }

    // Offload persistence to BullMQ (non-blocking) or fall back to fire-and-forget.
    if (this.deps.turnQueue) {
      void this.deps.turnQueue
        .add('persist', {
          userId: input.userId,
          conversationId,
          userText: input.text,
          assistantText: result.text,
          toolResults: result.toolResults,
          intent: intentForLog,
          latencyMs: totalMs,
          stageTimings,
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
        .appendTurn({
          userId: input.userId,
          conversationId,
          role: 'assistant',
          content: result.text,
          latencyMs: totalMs,
          intent: intentForLog,
          stageTimings,
        })
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
        totalMs,
        stageTimings,
        retrievedCount: retrieved.length,
        mediaCount: input.media.length,
        isNew,
      },
      'ai.handle.ok',
    );

    return result;
  }

  /** Persist a fast-path response's intent + latency + stage timings via the
   *  same channel as full-pipeline turns so /admin/latency reflects ALL traffic.
   *  Fire-and-forget; falls back to memory.appendTurn when no turnQueue. */
  private persistLatency(
    userId: string,
    intent: string,
    latencyMs: number,
    stageTimings: Record<string, number>,
    userText: string,
    assistantText: string,
  ): void {
    // 2026-06-04 CRITICAL FIX: previously this used a fake conversation ID
    // ('fastpath-${userId}') which violated the messages.conversation_id
    // foreign key on conversations(id). EVERY fast-path persist (query_fast,
    // food_log_fast, weight_log_fast, fast_path) was SILENTLY FAILING. The
    // result: when a user asked "What's my protein goal?" and got query_fast
    // answer "Your daily protein target is 60g.", that turn never appeared
    // in history. The next message ("why?") couldn't see that prior reply,
    // so detectReasoningRequest returned false (no anchor), reasoning
    // fallback didn't fire, and the user got a generic "What's on your mind?"
    // typed fallback.
    //
    // Fix: always resolve the real conversation ID via ensureConversation
    // (which is cached for 5min so the cost is ~free after the first call).
    // Then write through the normal queue or directly. The fix preserves
    // history continuity across fast-path AND orchestrator turns.
    void (async () => {
      try {
        const conversationId = await this.deps.memory.ensureConversation(userId);
        if (this.deps.turnQueue) {
          await this.deps.turnQueue.add('persist', {
            userId,
            conversationId,
            userText,
            assistantText,
            toolResults: [],
            intent,
            latencyMs,
            stageTimings,
          });
          return;
        }
        await Promise.all([
          this.deps.memory.appendTurn({ userId, conversationId, role: 'user', content: userText }),
          this.deps.memory.appendTurn({
            userId,
            conversationId,
            role: 'assistant',
            content: assistantText,
            latencyMs,
            intent,
            stageTimings,
          }),
        ]);
      } catch (err) {
        this.deps.logger.warn({ err: err instanceof Error ? err.message : String(err), userId, intent }, 'persist_latency.failed');
      }
    })();
  }

  // 60s in-memory cache: check-in count only changes when the scheduler fires
  // a proactive message, which happens at most a few times per day. The
  // user-facing tradeoff is "did I get an extra check-in I shouldn't have?"
  // — 60s of staleness here is unobservable in practice. The query itself
  // (CTE + COUNT with TZ subquery) is the second-most-expensive in
  // parallel_io after getTodaysFoodSummary.
  private checkinsCountCache = new Map<string, { value: number; expiresAt: number }>();
  private readonly CHECKIN_COUNT_TTL_MS = 60_000;

  private async countTodaysCheckIns(userId: string): Promise<number> {
    const cached = this.checkinsCountCache.get(userId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }
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
    const value = Number(rows[0]?.count ?? 0);
    this.checkinsCountCache.set(userId, { value, expiresAt: Date.now() + this.CHECKIN_COUNT_TTL_MS });
    return value;
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
      /** The user's latest message — used to inject turn-specific directives
       *  (e.g. suppress food/protein context dump when the message is about
       *  physical pain or acute symptoms). */
      currentUserText?: string;
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

    // TURN-SPECIFIC DIRECTIVE — detect physical-pain / acute-symptom messages
    // and explicitly suppress the food/protein context dump. Production
    // failure 2026-06-02: user said "Thanks. I slept well, but my stomach is
    // killing me" and Grace opened "You haven't logged any food today, so
    // you're at 0g protein so far…" because the LLM saw the protein totals
    // in context and defaulted to surfacing them. This directive forces the
    // LLM to ignore them this turn.
    const turnDirective = runtime?.currentUserText
      ? buildTurnDirective(runtime.currentUserText)
      : '';

    if (lines.length === 0 && !factsBlock && !turnDirective) return `${dietBanner}${base ?? ''}`;
    const userCtx = lines.length > 0 ? `\n\n--- User context ---\n${lines.join('\n')}` : '';
    const factsCtx = factsBlock ? `\n\n--- What Grace has naturally learned about this user ---\n${factsBlock}\nUse these subtly. Never read them back mechanically. Never say "according to your profile."` : '';
    return `${dietBanner}${base ?? ''}${userCtx}${factsCtx}${turnDirective}`;
  }

  // In-memory tool-settings cache. Admin toggles are rare (minutes to days
  // between flips), so a 60 s TTL eliminates one DB round-trip per turn
  // without making admin changes feel sluggish. Saves ~30-50 ms per request.
  private toolSettingsCache: { value: Record<string, boolean>; expiresAt: number } | null = null;
  private readonly TOOL_SETTINGS_TTL_MS = 60_000;

  private async loadToolSettings(): Promise<Record<string, boolean>> {
    if (this.toolSettingsCache && this.toolSettingsCache.expiresAt > Date.now()) {
      return this.toolSettingsCache.value;
    }
    try {
      const { rows } = await this.deps.pool.query<{ tool_name: string; enabled: boolean }>(
        `SELECT tool_name, enabled FROM tool_settings`,
      );
      const value = Object.fromEntries(rows.map((r) => [r.tool_name, r.enabled]));
      this.toolSettingsCache = { value, expiresAt: Date.now() + this.TOOL_SETTINGS_TTL_MS };
      return value;
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

/**
 * Detect a multi-meal food-log message and split it into separate meal
 * segments so each gets its own log_food call. Returns [] when the input
 * isn't multi-meal (single log_food call is fine).
 *
 * Production failure 2026-06-01: "Hey\nFor breakfast i ate 2 eggs.\nFor
 * lunch chicken breast with cup of rice" → single log_food got the whole
 * blob (including the "Hey" greeting) and logged 0g protein.
 *
 * Strategy: a meal segment is anchored by a meal label (breakfast / lunch /
 * dinner / snack / brunch). We split on those labels and keep each segment
 * with its food description.
 */
export function splitMultiMealText(text: string): string[] {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  // Split on meal-label boundaries: keep the meal label with its segment.
  // Pattern: optional "for " + meal label + everything up to the next meal
  // label or the end of input.
  const mealLabelRe = /\b(?:for\s+)?(breakfast|lunch|dinner|snack|brunch)\b[^.!?]*?(?=\.|!|\?|\bfor\s+(?:breakfast|lunch|dinner|snack|brunch)\b|$)/gi;
  const matches = cleaned.match(mealLabelRe);
  if (!matches || matches.length < 2) return [];
  // Each segment is one meal. Trim, dedupe, drop empties.
  const segments = matches
    .map((s) => s.trim().replace(/[.!?]+$/, '').trim())
    .filter((s) => s.length > 0)
    .filter((s, i, arr) => arr.indexOf(s) === i);
  return segments.length >= 2 ? segments : [];
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
// Turn-specific directive — physical-pain / acute-symptom suppression
//
// When the user's CURRENT message reports physical pain or an acute symptom
// (stomach/head/back hurts, killing me, feel sick, throwing up, etc.), the
// LLM tends to default to surfacing prior turns' food/protein data because
// it's prominently in the system context. The fix is a per-turn directive
// appended AFTER the user-context block that explicitly tells Grace to
// suppress the data dump and respond to the pain only.
//
// We keep the trigger conservative — only the clearest pain anchors. Food
// questions, weight questions, and emotional venting are handled by the
// base prompt rules and other content checks.
// ─────────────────────────────────────────────────────────────────────────────

const TURN_DIRECTIVE_PAIN_RE = /\b(?:(?:my\s+|the\s+)?(?:stomach|belly|head|back|chest|side|leg|arm|neck|shoulder|throat|tooth|tummy|gut|jaw)\s+(?:is|are|'?s|feels?)\s+(?:killing|hurting|aching|throbbing|so\s+sore|really\s+sore|on\s+fire)|(?:my\s+)?(?:stomach|head|back|tooth|throat|jaw|side|leg|arm|chest)\s+hurts?|in\s+(?:so\s+much\s+|a\s+lot\s+of\s+|real\s+|bad\s+)?pain|feel\s+(?:so\s+|really\s+|kind\s+of\s+|sort\s+of\s+|pretty\s+)?(?:sick|nauseous|nauseated|awful|terrible|horrible)|throwing\s+up|vomit(?:ing|ed)|cramping\s+(?:so\s+bad|really\s+bad|hard)?)\b/i;

export function buildTurnDirective(userText: string): string {
  if (!userText) return '';
  const trimmed = userText.trim();
  if (trimmed.length === 0) return '';
  if (TURN_DIRECTIVE_PAIN_RE.test(trimmed)) {
    return [
      '',
      '',
      '--- TURN-SPECIFIC DIRECTIVE (highest priority) ---',
      'The user\'s LATEST message reports PHYSICAL PAIN / ACUTE SYMPTOM.',
      'Apply the MULTI-PART MESSAGE PARSING rule. Parse the user\'s current message into parts (updates / symptoms / questions / emotions) and address EVERY meaningful part — not just the pain.',
      '',
      'For THIS response only:',
      '  1. PARSE the user\'s current message into parts. If they also said "I slept well", "I ate X", "thanks", etc. — acknowledge that part briefly BEFORE addressing the pain.',
      '  2. DO NOT reference today\'s protein/calorie totals, foods logged today, yesterday\'s data, or any food-tracking STATUS that the user did not bring up in the current message. NEVER open with "you haven\'t logged any food today" or "you\'re at Xg protein".',
      '  3. DO NOT surface memory ("you\'ve mentioned this before", "you said earlier", "last time", "this time").',
      '  4. DO NOT reach back into the PRIOR user message to address sub-topics you missed last turn. "Anytime" / "Glad to hear you slept well" are only acceptable when those parts are in the CURRENT message.',
      '  5. DO address the pain seriously. Empathize, then EITHER ask ONE-to-TWO targeted follow-up questions (location, character of pain, any associated symptoms like nausea/fever/bowel changes) OR give ONE actionable next step (e.g. "lower-left abdominal pain on a GLP-1 deserves a quick call to your prescriber today, especially if it\'s sharp or getting worse").',
      '  6. Multi-item symptom screening is ALLOWED when the user reports pain — asking "have you noticed any nausea, fever, or changes in bowel movements?" is appropriate, NOT clinical-intake-form behavior. The friend-vs-form line is: friends ask in plain language and naturally, forms use jargon and list 5 things.',
      '  7. Lower-left or right-side abdominal pain, sharp/worsening pain, or pain plus vomiting/fever ⇒ recommend they call their prescriber TODAY (calm, not alarmist).',
      '',
    ].join('\n');
  }
  return '';
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
