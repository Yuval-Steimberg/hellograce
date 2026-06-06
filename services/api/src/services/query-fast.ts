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
import { normalizeUserText } from '@grace/ai-core';
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
    | 'food_summary_today'
    | 'start_date'
    | 'week_number'
    | 'medication'
    | 'injection_day'
    | 'current_weight'
    | 'starting_weight'
    | 'weight_progress'
    | 'age'
    | 'is_protein_enough'
    | 'is_calorie_enough';
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

// Food summary list — "what I ate today" / "show my food" / "my food today" /
// "what did I have" / "today's log". Production failure 2026-06-05: "What I
// ate today" went through the orchestrator → ship "Tell me a bit more?"
// instead of listing the day's food. Deterministic: list the foods today.
const FOOD_SUMMARY_LIST_RE =
  /^(?:what (?:i|did i) ate(?:\s+today)?|what (?:have )?i (?:had|eaten|logged)(?:\s+today)?|(?:show|list|tell me)(?:\s+me)? my (?:food|meals?|logs?|food log)(?:\s+today)?|(?:today'?s|my today'?s) (?:food|meals?|log|logs?|intake|eating)|food i (?:had|ate|logged) today|my (?:food )?(?:totals?|log)(?:\s+today)?)\s*\??$/i;

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
// 2026-06-04 expansion: added "do you remember when/what date I started"
// and "remind me when" patterns after production failure where Grace
// HALLUCINATED a start date ("January 1st, 2024") instead of looking it up.
const START_DATE_RE =
  /^(?:(?:do you )?remember (?:when|what date) i (?:start(?:ed)?|began)|remind me (?:when|what date) i (?:start(?:ed)?|began)|when did i (?:start(?:ed)?|begin|began)|how long (?:have i been|since i started)|what(?:'?s| is| was)?\s+(?:my\s+)?start date)(?:\s+(?:on|with|using|taking|the))?(?:\s+(?:injections?|ozempic|wegovy|mounjaro|zepbound|semaglutide|tirzepatide|the medication|medication|treatment|glp-?1|glp))?\s*\??$/i;

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

// 2026-06-06: "What's my starting weight?" — added per coverage audit.
// Grace must NEVER fabricate this; read it directly from the column or say
// "I don't have your starting weight on file."
const STARTING_WEIGHT_RE =
  /^(?:what(?:'?s| is)?\s+(?:my\s+)?(?:starting|start|initial|baseline|original)\s+weight|what did i (?:start|begin) (?:at|with))\s*\??$/i;

// "How much have I lost?" / "weight loss so far" / "total loss"
// Requires BOTH starting_weight and current_weight to compute. When either
// is missing, ships an honest "no baseline on file" response — no estimate,
// no fabrication.
const WEIGHT_PROGRESS_RE =
  /^(?:how much (?:weight )?have i lost|how much have i lost|how much weight did i lose|what(?:'?s| is)?\s+my (?:total\s+|overall\s+)?weight loss|weight loss so far|total (?:weight )?loss|how (?:far|much) (?:have i come|down (?:am i|have i (?:come|gotten)))|am i down (?:any|much) (?:weight)?)\s*\??$/i;

// "How old am I" / "what's my age"
const AGE_RE =
  /^(?:how old am i|what(?:'?s| is)?\s+(?:my\s+)?age)\s*\??$/i;

// 2026-06-06 production failure: "Is 80g of protein enough?" routed to
// knowledge_direct → Gemini shipped generic muscle-loss explanation
// instead of comparing 80g to the user's actual 60g target and weight-
// based 1.2-1.6g/kg formula. Deterministic personalized comparison:
//
//   "is 80g of protein enough"  → captures 80
//   "is 80 grams of protein enough" → captures 80
//   "is 80g enough"             → captures 80 (assume protein from context)
//   "is 80g protein too much"   → captures 80
const IS_PROTEIN_ENOUGH_PATTERNS: RegExp[] = [
  /^is\s+(\d+)\s*g(?:rams?)?\s*(?:of\s+)?protein\s+(enough|right|adequate|sufficient|too\s+(?:much|low|little|high)|ok(?:ay)?|fine|on\s+track)\s*\??$/i,
  /^is\s+(\d+)\s+grams?\s+(?:of\s+)?protein\s+(enough|right|adequate|sufficient|too\s+(?:much|low|little|high)|ok(?:ay)?|fine|on\s+track)\s*\??$/i,
  /^is\s+(\d+)\s*g(?:rams?)?\s+(enough|right|adequate|sufficient|too\s+(?:much|low|little|high)|ok(?:ay)?|fine|on\s+track)\s*\??$/i,
];
const IS_CALORIE_ENOUGH_PATTERNS: RegExp[] = [
  /^is\s+(\d+)\s*(?:kcal|cal|calories?)\s+(enough|right|adequate|sufficient|too\s+(?:much|low|little|high)|ok(?:ay)?|fine|on\s+track)\s*\??$/i,
];

function matchProteinEnough(t: string): { proposed: number; verdict: string } | null {
  for (const re of IS_PROTEIN_ENOUGH_PATTERNS) {
    const m = re.exec(t);
    if (m) return { proposed: parseInt(m[1]!, 10), verdict: m[2]!.toLowerCase() };
  }
  return null;
}
function matchCalorieEnough(t: string): { proposed: number; verdict: string } | null {
  for (const re of IS_CALORIE_ENOUGH_PATTERNS) {
    const m = re.exec(t);
    if (m) return { proposed: parseInt(m[1]!, 10), verdict: m[2]!.toLowerCase() };
  }
  return null;
}

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
  // Normalize iOS smart-quote apostrophes (U+2019) → ASCII before regex match.
  // See packages/ai-core/src/text-normalize.ts.
  const t = normalizeUserText(text).trim().replace(/[!.]+$/, '').trim();
  if (t.length === 0 || t.length > 80) return null;

  // Cheap regex tests first — bail before any DB read if no pattern matches.
  const matchedCategory: QueryFastResult['category'] | null =
    PROTEIN_GOAL_RE.test(t) ? 'protein_goal'
    : CALORIE_GOAL_RE.test(t) ? 'calorie_goal'
    : WEIGHT_GOAL_RE.test(t) ? 'weight_goal'
    : PROTEIN_TODAY_RE.test(t) ? 'protein_today'
    : CALORIE_TODAY_RE.test(t) ? 'calorie_today'
    : PROGRESS_TODAY_RE.test(t) ? 'progress_today'
    : FOOD_SUMMARY_LIST_RE.test(t) ? 'food_summary_today'
    : START_DATE_RE.test(t) ? 'start_date'
    : WEEK_NUMBER_RE.test(t) ? 'week_number'
    : MEDICATION_RE.test(t) ? 'medication'
    : INJECTION_DAY_RE.test(t) ? 'injection_day'
    : CURRENT_WEIGHT_RE.test(t) ? 'current_weight'
    : STARTING_WEIGHT_RE.test(t) ? 'starting_weight'
    : WEIGHT_PROGRESS_RE.test(t) ? 'weight_progress'
    : AGE_RE.test(t) ? 'age'
    : matchProteinEnough(t) ? 'is_protein_enough'
    : matchCalorieEnough(t) ? 'is_calorie_enough'
    : null;
  if (!matchedCategory) return null;

  try {
    const user = await deps.users.getById(deps.userId).catch(() => null);
    if (!user) return null;

    switch (matchedCategory) {
      case 'protein_goal': {
        const g = user.protein_goal_grams;
        if (!g || g <= 0) {
          // 2026-06-05 — was returning null → fallback shipped tone-deaf
          // "what kind of meal?" reply. Now ships research-backed default.
          return {
            text: `Your personalized target isn't set yet, but research suggests 1.2-1.6g of protein per kg of body weight daily on GLP-1s. Set your exact target at graceglp.com/settings.`,
            category: 'protein_goal',
          };
        }
        // 2026-06-06: append the walkthrough offer so when the user
        // replies "why" / "how was that calculated" / "is X enough",
        // followup_walkthrough (ai.service.ts) anchors on the offer
        // and ships the deterministic personalized math.
        return {
          text: `Your daily protein target is ${g}g. Want me to walk through the math?`,
          category: 'protein_goal',
        };
      }

      case 'calorie_goal': {
        const k = user.calorie_goal_kcal;
        if (!k || k <= 0) {
          return {
            text: `Your personalized calorie target isn't set yet. You can configure it at graceglp.com/settings.`,
            category: 'calorie_goal',
          };
        }
        return {
          text: `Your daily calorie target is ${k} kcal. Want me to walk through the math?`,
          category: 'calorie_goal',
        };
      }

      case 'weight_goal': {
        const w = user.goal_weight;
        if (!w || w <= 0) {
          return {
            text: `I don't have your goal weight on file yet. You can set it at graceglp.com/settings.`,
            category: 'weight_goal',
          };
        }
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

      case 'food_summary_today': {
        // 2026-06-05 production failure: "What I ate today" → orchestrator
        // shipped "Tell me a bit more?". Now we list the day's items in a
        // single sentence with running totals. Deterministic, ~250ms.
        const summary = await deps.users.getTodaysFoodSummary(deps.userId).catch(() => null);
        if (!summary) return null;
        const proteinTotal = Math.round(summary.protein_g);
        const calTotal = Math.round(summary.calories);
        // 2026-06-06: log_food.sumItemized joins multi-item meals with " + "
        // for a clean internal label, but that label leaks into the user-
        // facing summary as "3 eggs + salad + 1 can tuna + 1 cup rice".
        // Split on " + " so the natural comma-and-"and" list reads cleanly:
        // "3 eggs, salad, 1 can tuna, and 1 cup rice."
        const items = summary.items
          .flatMap((s) => (s ?? '').split(/\s*\+\s*/))
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        if (items.length === 0) {
          return {
            text: `Nothing logged yet today. Send me what you've eaten and I'll track it.`,
            category: 'food_summary_today',
          };
        }
        // Human-friendly comma list with "and" before the last item.
        const displayItems = items.slice(0, 8);
        const moreCount = items.length - displayItems.length;
        const last = displayItems.pop()!;
        const list = displayItems.length === 0
          ? last
          : `${displayItems.join(', ')}, and ${last}`;
        const tailing = moreCount > 0 ? ` and ${moreCount} more` : '';
        const tot = calTotal > 0
          ? `${proteinTotal}g protein, ${calTotal} kcal`
          : `${proteinTotal}g protein`;
        return {
          text: `Today you've had ${list}${tailing}. Running total: ${tot}.`,
          category: 'food_summary_today',
        };
      }

      case 'start_date': {
        const d = user.glp1_start_date;
        if (!d) {
          // 2026-06-05 production failure: returning null let the message fall
          // through to the orchestrator, which produced a generic knowledge
          // fallback ("Muscle loss is common on GLP-1s...") that had NOTHING
          // to do with the start date question. Returning a helpful "I don't
          // have it" message ships in <300ms and tells the user exactly what
          // to do — no guard can produce a worse response.
          return {
            text: `I don't have your GLP-1 start date on file yet. You can set it at graceglp.com/settings.`,
            category: 'start_date',
          };
        }
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
        if (!d) {
          return {
            text: `I don't have your GLP-1 start date on file yet, so I can't pin the week number. Set it at graceglp.com/settings.`,
            category: 'week_number',
          };
        }
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
        if (!med || med.trim().length === 0) {
          return {
            text: `I don't have your medication on file yet. You can set it at graceglp.com/settings.`,
            category: 'medication',
          };
        }
        const dose = user.dose_mg ? ` at ${user.dose_mg} mg` : '';
        return {
          text: `You're on ${med}${dose}.`,
          category: 'medication',
        };
      }

      case 'injection_day': {
        const day = user.injection_day;
        if (!day || day.trim().length === 0) {
          // 2026-06-05 production failure: user asked "What is my injection
          // day", we returned null, orchestrator routed via knowledge match
          // → typed fallback shipped muscle-loss research. Now we ship an
          // honest pointer to settings instead.
          return {
            text: `I don't have your injection day on file yet. You can set it at graceglp.com/settings.`,
            category: 'injection_day',
          };
        }
        return {
          text: `Your injection day is ${day}.`,
          category: 'injection_day',
        };
      }

      case 'current_weight': {
        const w = user.current_weight;
        if (!w || w <= 0) {
          return {
            text: `I don't have a recent weight on file. Send me your current weight in lbs and I'll log it.`,
            category: 'current_weight',
          };
        }
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

      case 'starting_weight': {
        // 2026-06-06: Grace must NEVER fabricate a baseline. If
        // starting_weight isn't on file, say so directly and offer the
        // settings route. No inferring from current_weight, no estimate.
        const sw = user.starting_weight;
        if (!sw || sw <= 0) {
          return {
            text: `I don't have your starting weight on file. You can set it at https://graceglp.com/settings — or send me "set my starting weight to ___ lbs".`,
            category: 'starting_weight',
          };
        }
        return {
          text: `Your starting weight is ${sw} lbs.`,
          category: 'starting_weight',
        };
      }

      case 'weight_progress': {
        // 2026-06-06: total loss = starting_weight - current_weight. When
        // either is missing, honest message — never fabricate progress.
        const sw = user.starting_weight;
        const cw = user.current_weight;
        if (!sw || sw <= 0) {
          return {
            text: `I'd love to tell you, but your starting weight isn't on file yet. Set it at https://graceglp.com/settings and I can calculate your total loss.`,
            category: 'weight_progress',
          };
        }
        if (!cw || cw <= 0) {
          return {
            text: `Your starting weight is ${sw} lbs but I don't have a recent weight on file. Send me your current weight in lbs and I'll calculate the change.`,
            category: 'weight_progress',
          };
        }
        const diff = Math.round((sw - cw) * 10) / 10;
        if (diff > 0) {
          const goal = user.goal_weight;
          if (goal && goal > 0 && cw > goal) {
            const toGo = Math.round((cw - goal) * 10) / 10;
            return {
              text: `You're down ${diff} lbs from ${sw} lbs — you're at ${cw} lbs now, ${toGo} lbs to your ${goal} lbs goal.`,
              category: 'weight_progress',
            };
          }
          return {
            text: `You're down ${diff} lbs from ${sw} lbs — you're at ${cw} lbs now.`,
            category: 'weight_progress',
          };
        }
        if (diff === 0) {
          return {
            text: `You're at ${cw} lbs — same as your starting weight. Tell me what's been hardest and I can help with the next step.`,
            category: 'weight_progress',
          };
        }
        const up = Math.abs(diff);
        return {
          text: `You're at ${cw} lbs, which is ${up} lbs above your ${sw} lbs starting weight. Tell me what's been going on and we can take it step by step.`,
          category: 'weight_progress',
        };
      }

      case 'age': {
        const a = user.age;
        if (!a || a <= 0) {
          return {
            text: `I don't have your age on file. You can set it at graceglp.com/settings.`,
            category: 'age',
          };
        }
        return {
          text: `You're ${a}.`,
          category: 'age',
        };
      }

      case 'is_protein_enough': {
        const match = matchProteinEnough(t);
        if (!match) return null;
        const proposedG = match.proposed;
        const goalG = user.protein_goal_grams;
        const weightLbs = user.current_weight;

        // Build a personalized comparison from whatever data we have.
        const parts: string[] = [];

        // Layer 1: comparison to the user's stored target.
        if (goalG && goalG > 0) {
          if (proposedG >= goalG) {
            const above = proposedG - goalG;
            parts.push(
              above === 0
                ? `${proposedG}g hits your ${goalG}g target exactly`
                : `${proposedG}g is ${above}g above your ${goalG}g target`,
            );
          } else {
            const gap = goalG - proposedG;
            parts.push(`${proposedG}g is ${gap}g below your ${goalG}g target`);
          }
        }

        // Layer 2: comparison to the weight-based 1.2-1.6 g/kg formula.
        if (weightLbs && weightLbs > 0) {
          const kg = weightLbs / 2.205;
          const lowG = Math.round(kg * 1.2);
          const highG = Math.round(kg * 1.6);
          const range = `${lowG}-${highG}g`;
          if (proposedG >= highG) {
            parts.push(`for ${weightLbs} lbs the muscle-preservation range is ${range}, so ${proposedG}g sits above the upper end`);
          } else if (proposedG >= lowG) {
            parts.push(`for ${weightLbs} lbs the muscle-preservation range is ${range}, so ${proposedG}g lands inside it`);
          } else {
            parts.push(`for ${weightLbs} lbs the muscle-preservation range is ${range}, so ${proposedG}g is below the floor`);
          }
        }

        // Layer 3: nothing on file → general formula + ask.
        if (parts.length === 0) {
          return {
            text: `${proposedG}g fits the GLP-1 protein range (1.2-1.6g per kg) when your weight is roughly ${Math.round(proposedG / 1.4 * 2.205)} lbs. Share your weight and I can be precise. Want me to walk through the math?`,
            category: 'is_protein_enough',
          };
        }

        return {
          text: `${parts.join('. ').replace(/(^|\.\s+)([a-z])/g, (_m, p, c) => p + c.toUpperCase())}. Want me to walk through the math?`,
          category: 'is_protein_enough',
        };
      }

      case 'is_calorie_enough': {
        const match = matchCalorieEnough(t);
        if (!match) return null;
        const proposedKcal = match.proposed;
        const goalKcal = user.calorie_goal_kcal;

        const parts: string[] = [];
        if (goalKcal && goalKcal > 0) {
          if (proposedKcal >= goalKcal) {
            const above = proposedKcal - goalKcal;
            parts.push(
              above === 0
                ? `${proposedKcal} kcal hits your ${goalKcal} kcal target exactly`
                : `${proposedKcal} kcal is ${above} kcal above your ${goalKcal} kcal target`,
            );
          } else {
            const gap = goalKcal - proposedKcal;
            parts.push(`${proposedKcal} kcal is ${gap} kcal below your ${goalKcal} kcal target`);
          }
        }
        if (parts.length === 0) {
          return {
            text: `It depends on your weight, goal, and activity level. Set your personalized calorie target at graceglp.com/settings and I can compare. Want me to walk through the math?`,
            category: 'is_calorie_enough',
          };
        }
        return {
          text: `${parts.join('. ').replace(/(^|\.\s+)([a-z])/g, (_m, p, c) => p + c.toUpperCase())}. Want me to walk through the math?`,
          category: 'is_calorie_enough',
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
