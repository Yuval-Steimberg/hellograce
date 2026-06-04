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
    | 'progress_today'
    | 'start_date'
    | 'week_number'
    | 'medication'
    | 'injection_day'
    | 'current_weight'
    | 'age';
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

// ─── Personal-data queries (added 2026-06-04 after production failure) ─────
// User asked "When did I start injections?" and "What's my week number?" —
// both fell into 'general' intent, the LLM produced something that failed
// quality guards, and the user got the "I'm following, keep going" safe
// fallback. These are deterministic computations from the user row.

// "When did I start" / "when did I begin" / "when did I start ozempic/wegovy/
// mounjaro/injections/the medication/glp-1"
const START_DATE_RE =
  /^(?:when did i (?:start(?:ed)?|begin|began)|how long (?:have i been|since i started)|what(?:'?s| is| was)?\s+(?:my\s+)?start date)(?:\s+(?:on|with|using|taking))?(?:\s+(?:injections?|ozempic|wegovy|mounjaro|zepbound|semaglutide|tirzepatide|the medication|medication|treatment|glp-?1|glp))?\s*\??$/i;

// "What's my week number" / "what week am I on" / "how many weeks" / "what week"
const WEEK_NUMBER_RE =
  /^(?:what(?:'?s| is)?\s+(?:my\s+)?(?:current\s+)?week(?:\s+number)?|what week (?:am i (?:on|in)|is it)|how many weeks (?:have i been|am i in|on (?:the medication|ozempic|wegovy|mounjaro|zepbound|glp-?1)))\s*\??$/i;

// "What medication am I on" / "what's my med" / "what drug"
const MEDICATION_RE =
  /^(?:what(?:'?s| is| am)?\s+(?:my\s+)?(?:medication|med|drug|prescription|gl?p-?1)(?:\s+(?:am i (?:on|taking)|do i take|i'?m on))?|what am i (?:taking|on)|which (?:medication|drug|med) (?:am i on|do i take))\s*\??$/i;

// "What's my injection day" / "when do I inject" / "when's my shot day"
const INJECTION_DAY_RE =
  /^(?:what(?:'?s| is)?\s+(?:my\s+)?(?:injection|shot|dose|jab) (?:day|date)|when (?:do i|is my) (?:inject|injection|shot|dose|jab)|which day (?:do i (?:inject|take it)|is (?:my )?(?:shot|injection|dose)))\s*\??$/i;

// "What's my current weight" / "how much do I weigh"
const CURRENT_WEIGHT_RE =
  /^(?:what(?:'?s| is)?\s+(?:my\s+)?(?:current\s+)?weight|how much do i weigh|what do i weigh)\s*\??$/i;

// "How old am I" / "what's my age"
const AGE_RE =
  /^(?:how old am i|what(?:'?s| is)?\s+(?:my\s+)?age)\s*\??$/i;

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
    : START_DATE_RE.test(t) ? 'start_date'
    : WEEK_NUMBER_RE.test(t) ? 'week_number'
    : MEDICATION_RE.test(t) ? 'medication'
    : INJECTION_DAY_RE.test(t) ? 'injection_day'
    : CURRENT_WEIGHT_RE.test(t) ? 'current_weight'
    : AGE_RE.test(t) ? 'age'
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

      case 'start_date': {
        const d = user.glp1_start_date;
        if (!d) return null; // unset → let LLM handle (e.g. "I don't have that on file")
        const start = new Date(d);
        const formatted = start.toLocaleDateString('en-US', {
          year: 'numeric', month: 'long', day: 'numeric',
        });
        const weeks = Math.floor((Date.now() - start.getTime()) / (7 * 24 * 60 * 60 * 1000));
        const ago = weeks <= 0
          ? 'this week'
          : weeks === 1 ? 'about 1 week ago'
          : weeks < 52 ? `about ${weeks} weeks ago`
          : `about ${Math.floor(weeks / 52)} year${Math.floor(weeks / 52) === 1 ? '' : 's'} ago`;
        return {
          text: `You started on ${formatted}, ${ago}.`,
          category: 'start_date',
        };
      }

      case 'week_number': {
        const d = user.glp1_start_date;
        if (!d) return null;
        const start = new Date(d);
        const weekNum = Math.floor((Date.now() - start.getTime()) / (7 * 24 * 60 * 60 * 1000)) + 1;
        if (weekNum <= 0) return null;
        return {
          text: `You're in week ${weekNum} of your GLP-1 journey.`,
          category: 'week_number',
        };
      }

      case 'medication': {
        const med = user.medication;
        if (!med || med.trim().length === 0) return null;
        const dose = user.dose_mg ? ` at ${user.dose_mg} mg` : '';
        return {
          text: `You're on ${med}${dose}.`,
          category: 'medication',
        };
      }

      case 'injection_day': {
        const day = user.injection_day;
        if (!day || day.trim().length === 0) return null;
        return {
          text: `Your injection day is ${day}.`,
          category: 'injection_day',
        };
      }

      case 'current_weight': {
        const w = user.current_weight;
        if (!w || w <= 0) return null;
        const goal = user.goal_weight;
        if (goal && goal > 0 && w > goal) {
          const toGo = Math.round((w - goal) * 10) / 10;
          return {
            text: `You're at ${w} lbs, ${toGo} lbs from your ${goal} lbs goal.`,
            category: 'current_weight',
          };
        }
        return {
          text: `You're at ${w} lbs.`,
          category: 'current_weight',
        };
      }

      case 'age': {
        const a = user.age;
        if (!a || a <= 0) return null;
        return {
          text: `You're ${a}.`,
          category: 'age',
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
  START_DATE_RE,
  WEEK_NUMBER_RE,
  MEDICATION_RE,
  INJECTION_DAY_RE,
  CURRENT_WEIGHT_RE,
  AGE_RE,
};
