/**
 * Deterministic fast-path for profile-query questions that have a single
 * computable answer.
 *
 * The user's protein goal, calorie goal, weight goal, today's protein/calorie
 * totals, and "how am I doing today?" don't need an LLM to answer — they're
 * pure reads from the user row and the food_logs table. Running them through
 * the full orchestrator (planner → RAG → generate → guards) pays 3-5 seconds
 * for what's structurally a SQL query + string template.
 *
 * This module captures the 5 highest-frequency profile-query intents and
 * answers them in ~150-300ms total (one DB round trip + template render).
 * The full pipeline still handles anything that needs reasoning, comparison,
 * or context — we only short-circuit when the question maps cleanly to a
 * single field or aggregate.
 *
 * Latency budget: <300ms (P95). Verified by latency-tracker stage `query_fast`.
 */

import type { Logger } from 'pino';
import type { UserService } from '../user/user.service.js';

export interface QueryFastResult {
  text: string;
  /** Stable category used by /admin/latency to bucket these wins. */
  category:
    | 'protein_goal'
    | 'calorie_goal'
    | 'weight_goal'
    | 'protein_today'
    | 'calorie_today'
    | 'progress_today';
}

export interface QueryFastDeps {
  users: UserService;
  logger: Logger;
  userId: string;
}

// ─── Pattern matchers ─────────────────────────────────────────────────────────
// Each matcher is anchored to a single answer source. They MUST be high-
// precision: a false positive ships the wrong canned answer and erodes trust.

// "What is my protein goal" / "what's my protein target" / "how much protein
// should I eat per day". Excludes "left" / "remaining" / "today" which mean
// the user wants the LIVE total, not the static target.
const PROTEIN_GOAL_RE =
  /^(?:what(?:'?s| is| was)?|tell me|whats|what)\s+(?:my|the)\s+(?:daily\s+)?protein\s+(?:goal|target|amount|requirement)\??$/i;

const CALORIE_GOAL_RE =
  /^(?:what(?:'?s| is| was)?|tell me|whats|what)\s+(?:my|the)\s+(?:daily\s+)?(?:calorie|cal|kcal)\s+(?:goal|target|amount|requirement|budget|allowance)\??$/i;

// Allows both phrasings: "my weight goal" and "my target weight" (where the
// "weight" comes after the "goal/target" word).
const WEIGHT_GOAL_RE =
  /^(?:what(?:'?s| is| was)?|tell me|whats|what)\s+(?:my|the)\s+(?:(?:weight|target weight)\s+(?:goal|target)|(?:goal|target)\s+weight)\??$/i;

// Today's protein total — "how much protein have I had today" / "what's my
// protein today" / "how am I doing on protein". Anchor on "today" / "so far"
// to avoid matching the GOAL question.
const PROTEIN_TODAY_RE =
  /^(?:how much\s+protein\s+(?:have i\s+(?:had|eaten|consumed|logged)|did i\s+(?:have|eat))|what(?:'?s| is)\s+my\s+protein\s+(?:today|so far))(?:\s+today)?\??$/i;

const CALORIE_TODAY_RE =
  /^(?:how (?:many|much)\s+(?:calories|cal|kcal)\s+(?:have i\s+(?:had|eaten|consumed|logged)|did i\s+(?:have|eat))|what(?:'?s| is)\s+my\s+(?:calorie|cal|kcal)\s+(?:total\s+)?(?:today|so far))(?:\s+today)?\??$/i;

// "How am I doing today" / "how am I doing on protein" / "progress check"
const PROGRESS_TODAY_RE =
  /^(?:how am i doing(?:\s+(?:today|on (?:protein|calories)|so far))?|progress (?:check|today|update)|status (?:check|today|update)|where am i (?:at|on (?:protein|calories)))\??$/i;

/**
 * Attempt to answer the message as a deterministic profile/progress query.
 * Returns null when the message doesn't qualify — caller falls through to the
 * full orchestrator.
 *
 * Hard guards:
 *   - Message must be the WHOLE turn (anchored ^...$). Compound messages
 *     ("what's my protein goal? I also ate eggs") fall through to the
 *     orchestrator so the food-log isn't silently dropped.
 *   - Each pattern requires the data point to be present (we don't fabricate
 *     "no goal set" answers via fast path — those go through normal LLM so
 *     the response can be warm + helpful).
 */
export async function tryQueryFast(
  text: string,
  deps: QueryFastDeps,
): Promise<QueryFastResult | null> {
  const t = text.trim().replace(/[!.]+$/, '').trim();
  if (t.length === 0 || t.length > 80) return null;

  // Cheap regex tests first — bail before any DB read if no pattern matches.
  const matchedCategory: QueryFastResult['category'] | null =
    PROTEIN_GOAL_RE.test(t) ? 'protein_goal'
    : CALORIE_GOAL_RE.test(t) ? 'calorie_goal'
    : WEIGHT_GOAL_RE.test(t) ? 'weight_goal'
    : PROTEIN_TODAY_RE.test(t) ? 'protein_today'
    : CALORIE_TODAY_RE.test(t) ? 'calorie_today'
    : PROGRESS_TODAY_RE.test(t) ? 'progress_today'
    : null;
  if (!matchedCategory) return null;

  try {
    const user = await deps.users.getById(deps.userId).catch(() => null);
    if (!user) return null;

    switch (matchedCategory) {
      case 'protein_goal': {
        const g = user.protein_goal_grams;
        if (!g || g <= 0) return null; // unset → let LLM explain
        return {
          text: `Your daily protein target is ${g}g.`,
          category: 'protein_goal',
        };
      }

      case 'calorie_goal': {
        const k = user.calorie_goal_kcal;
        if (!k || k <= 0) return null;
        return {
          text: `Your daily calorie target is ${k} kcal.`,
          category: 'calorie_goal',
        };
      }

      case 'weight_goal': {
        const w = user.goal_weight;
        if (!w || w <= 0) return null;
        const cw = user.current_weight;
        if (cw && cw > w) {
          const toLose = Math.round((cw - w) * 10) / 10;
          return {
            text: `Your goal weight is ${w} lbs — about ${toLose} lbs to go from ${cw} lbs.`,
            category: 'weight_goal',
          };
        }
        return {
          text: `Your goal weight is ${w} lbs.`,
          category: 'weight_goal',
        };
      }

      case 'protein_today': {
        const summary = await deps.users.getTodaysFoodSummary(deps.userId).catch(() => null);
        if (!summary) return null;
        const total = Math.round(summary.protein_g);
        const goal = user.protein_goal_grams ?? 0;
        if (goal > 0) {
          const left = Math.max(0, goal - total);
          if (left === 0) {
            return {
              text: `You're at ${total}g protein today — you hit your ${goal}g target.`,
              category: 'protein_today',
            };
          }
          return {
            text: `You're at ${total}g protein today — ${left}g left to hit your ${goal}g target.`,
            category: 'protein_today',
          };
        }
        return {
          text: `You're at ${total}g protein today.`,
          category: 'protein_today',
        };
      }

      case 'calorie_today': {
        const summary = await deps.users.getTodaysFoodSummary(deps.userId).catch(() => null);
        if (!summary) return null;
        const total = Math.round(summary.calories);
        const goal = user.calorie_goal_kcal ?? 0;
        if (goal > 0) {
          const left = Math.max(0, goal - total);
          if (left === 0) {
            return {
              text: `You're at ${total} kcal today — you hit your ${goal} kcal target.`,
              category: 'calorie_today',
            };
          }
          return {
            text: `You're at ${total} kcal today — ${left} kcal left of your ${goal} kcal target.`,
            category: 'calorie_today',
          };
        }
        return {
          text: `You're at ${total} kcal today.`,
          category: 'calorie_today',
        };
      }

      case 'progress_today': {
        const summary = await deps.users.getTodaysFoodSummary(deps.userId).catch(() => null);
        if (!summary) return null;
        const proteinTotal = Math.round(summary.protein_g);
        const calTotal = Math.round(summary.calories);
        const pGoal = user.protein_goal_grams ?? 0;
        const cGoal = user.calorie_goal_kcal ?? 0;
        const parts: string[] = [];
        if (pGoal > 0) {
          const left = Math.max(0, pGoal - proteinTotal);
          parts.push(
            left === 0
              ? `${proteinTotal}g protein (target hit)`
              : `${proteinTotal}g protein, ${left}g to go for ${pGoal}g`,
          );
        } else {
          parts.push(`${proteinTotal}g protein`);
        }
        if (cGoal > 0) {
          const left = Math.max(0, cGoal - calTotal);
          parts.push(
            left === 0
              ? `${calTotal} kcal (target hit)`
              : `${calTotal} kcal, ${left} left of ${cGoal}`,
          );
        } else if (calTotal > 0) {
          parts.push(`${calTotal} kcal`);
        }
        if (parts.length === 0) return null;
        return {
          text: `You're at ${parts.join(' and ')} today.`,
          category: 'progress_today',
        };
      }
    }
  } catch (err) {
    deps.logger.warn(
      { err: err instanceof Error ? err.message : String(err), userId: deps.userId },
      'query_fast.error',
    );
    return null;
  }

  return null;
}

// Internal exports for unit tests
export const __testing = {
  PROTEIN_GOAL_RE,
  CALORIE_GOAL_RE,
  WEIGHT_GOAL_RE,
  PROTEIN_TODAY_RE,
  CALORIE_TODAY_RE,
  PROGRESS_TODAY_RE,
};
