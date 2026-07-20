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
import type { UserService, GraceUser } from '../user/user.service.js';
import { renderDailyFoodSummary } from './food-summary.js';
import { buildStartDateAnswer, isPlausibleStartDate } from './medication-start-date.js';

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
    | 'daily_focus'
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
  /**
   * The already-loaded user, when the caller has one. PREFER passing this.
   * Re-fetching via `getById(userId)` below uses `WHERE id::text=$1 OR phone=$1`,
   * which has NO phone_hash lookup — so under field encryption it reads null and
   * EVERY settings read here (start_date, week_number, medication, injection_day,
   * weights, age) silently fails → the reply falls to a generic/"not on file"
   * answer even though Settings has the value. runUnifiedReply already loads the
   * user via getByPhone (which has the phone_hash path); passing it keeps the
   * settings reads working under encryption. If the key is present with value
   * `null`, we honor it (loaded-but-absent) and do NOT re-fetch.
   */
  user?: GraceUser | null;
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
// 2026-06-11 WhatsApp screenshot: "How much protein I had" got the generic
// 1.2-1.6g/kg target instead of today's logged total. The old pattern only
// accepted "have i had" / "did i have"; real users drop the auxiliary and say
// "protein I had" / "protein I ate". Added those forms.
const PROTEIN_TODAY_RE =
  /^(?:how much\s+protein\s+(?:have i\s+(?:had|eaten|consumed|logged)|did i\s+(?:have|eat)|i\s+(?:had|ate|got|consumed|logged|have had|have eaten|have))|what(?:'?s| is)\s+my\s+protein\s+(?:today|so far)|how much\s+protein\s+(?:today|so far))(?:\s+today)?\??$/i;

const CALORIE_TODAY_RE =
  /^(?:how (?:many|much)\s+(?:calories|cal|kcal)\s+(?:have i\s+(?:had|eaten|consumed|logged)|did i\s+(?:have|eat))|what(?:'?s| is)\s+my\s+(?:calorie|cal|kcal)\s+(?:total\s+)?(?:today|so far)|how (?:many|much)\s+(?:calories|cals?|kcal)\s+(?:today|so far)|(?:calories|cals?|kcal)\s+so far)(?:\s+today)?\??$/i;

// "How many calories do I have left today?" / "calories remaining" / "how much
// protein do I have left". These are the LIVE-total questions the goal/total
// patterns deliberately exclude — but nothing matched them, so they leaked to
// knowledge_direct, which has NO access to today's intake and answered
// generically (2026-06-11 verification finding). The calorie_today /
// protein_today renderers already compute and phrase the remaining amount.
const PROTEIN_LEFT_RE =
  /^(?:how (?:much|many)\s+(?:grams? of\s+)?protein\s+(?:do i have\s+|is\s+|are\s+)?(?:left|remaining)|protein\s+(?:left|remaining)|how (?:much|many) more protein (?:do i need|can i (?:have|eat)))(?:\s+(?:today|for today))?\s*\??$/i;
const CALORIE_LEFT_RE =
  /^(?:how (?:many|much)\s+(?:calories|cals?|kcal)\s+(?:do i have\s+|are\s+|is\s+)?(?:left|remaining)|(?:calories|cals?|kcal)\s+(?:left|remaining)|how (?:many|much) more (?:calories|cals?|kcal) (?:can i (?:have|eat)|do i have))(?:\s+(?:today|for today))?\s*\??$/i;
const CALORIE_OVER_RE =
  /^(?:did i (?:overeat|eat too much|go over)(?:\s+today)?|have i (?:overeaten|eaten too much|gone over)(?:\s+today)?|am i over my (?:calorie|calories|kcal) (?:goal|target|budget)(?:\s+today)?)\s*\??$/i;

// 2026-06-11 WhatsApp screenshot: "What is my target?" (bare, no
// "protein"/"calorie" word) fell through every pattern → orchestrator →
// generic-fallback when Gemini was unavailable. Protein is the metric Grace
// tracks front-and-center on GLP-1, so a bare "what's my target/goal" answers
// with the protein target (the renderer offers the walkthrough + handles a
// missing goal gracefully). Specific patterns above (weight/calorie) win
// because this is checked LAST in the chain.
const BARE_TARGET_RE =
  /^(?:what(?:'?s| is| was)?|tell me|whats|what)\s+(?:my|the)\s+(?:daily\s+)?(?:target|goal)\??$/i;

// Food summary list — "what I ate today" / "show my food" / "my food today" /
// "what did I have" / "today's log". Production failure 2026-06-05: "What I
// ate today" went through the orchestrator → ship "Tell me a bit more?"
// instead of listing the day's food. Deterministic: list the foods today.
// 2026-06-14 expansion: added "so far"/"yet"/"already" suffixes, "did I log
// breakfast?", "what's logged today?", "is there anything I already ate?" —
// all Scenario-A food-history phrasings from the production report. Read-only.
const FOOD_SUMMARY_LIST_RE =
  /^(?:what (?:did i|i)(?:'ve)? (?:eat|ate|eaten|had|logged)(?:\s+(?:today|so far|yet|already))?|what (?:have|'?ve) i (?:had|eaten|logged|ate)(?:\s+(?:today|so far|yet|already))?|what(?:'?s| is| has)(?: been)? logged(?:\s+(?:today|so far))?|what(?:'?s| is) (?:in|on) my (?:food )?log(?:\s+today)?|did i (?:log|eat|have|track)(?: any| anything| something| any food)? (?:breakfast|lunch|dinner|anything|something|food|today)(?:\s+(?:today|yet))?|is there (?:anything|something) (?:i(?:'ve)? )?(?:already )?(?:ate|eaten|had|logged)(?:\s+(?:today|yet))?|(?:show|list|tell me|summari[sz]e)(?:\s+me)? my (?:food|meals?|logs?|food log|day|intake|eating|nutrition|diet)(?:\s+today)?|summari[sz]e (?:my |today'?s )?(?:food|meals?|day|intake|eating|nutrition)|(?:today'?s|my today'?s) (?:food|meals?|log|logs?|intake|eating)|food i (?:had|ate|logged)(?:\s+today)?|my (?:food )?(?:totals?|log)(?:\s+today)?)\s*\??$/i;

// "How am I doing today" / "how am I doing on protein" / "progress check"
const PROGRESS_TODAY_RE =
  /^(?:how am i doing(?:\s+(?:today|on (?:protein|calories)|so far))?|progress (?:check|today|update)|status (?:check|today|update)|where am i (?:at|on (?:protein|calories)))\??$/i;

// ─── Daily planning / focus questions (2026-06-14 production failure) ──────
// "What should I focus on today?" after a symptom turn → Grace CONTINUED the
// symptom discussion instead of answering the planning question. A planning
// question must switch to PLANNING MODE: a data-grounded answer built from the
// user's goals + today's progress, with symptoms as supporting context only —
// never the main answer. Answering it deterministically here (before history /
// the orchestrator) guarantees the previous topic can't anchor the response.
//
// Tolerates an optional leading greeting ("Hi what I should focus today") with
// no delimiter (the compound splitter only splits on punctuation). Ambiguous
// nouns ("goal"/"target") are only treated as planning when "today" is present,
// so a bare "what's my goal" still routes to the protein-goal matcher.
const PLAN_TODAY_RE =
  /^(?:(?:hi|hey|hello|good morning|morning|gm)[\s,]*)?(?:what (?:should i|do i|can i|shall i|i should)\s+(?:focus|work|prioriti[sz]e|concentrate)(?:\s+on)?(?:\s+today)?|what (?:are|should be) my (?:priorit(?:y|ies)|focus(?:es)?)(?:\s+today)?|what(?:'?s| is) my (?:focus|priority|plan)(?:\s+(?:for )?today)?|what(?:'?s| is) my goal (?:for )?today|what should i do today|give me (?:a |my )?(?:plan|game plan|focus)(?:\s+(?:for )?today)?|(?:my )?plan for today|how should i (?:approach|tackle|start|do) (?:my )?(?:day|today)|what(?:'?s| is) the plan(?:\s+(?:for )?today)?)\s*\??$/i;

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
// 2026-07-05 expansion: caught only "when DID i start". Real users write "when I
// started taking the injection" and "when I started with glp" (no "did"), which
// slipped to the injection-timing intercept → "today is your shot day", or to the
// LLM → a FABRICATED date. Now also matches the no-"did" forms + "with glp" +
// "taking the injection", and tolerates a leading connector ("on/with/taking the").
const START_DATE_RE =
  /^(?:(?:do you )?remember (?:when|what date) i (?:start(?:ed)?|began|begin)|remind me (?:when|what date) i (?:start(?:ed)?|began|begin)|when(?: did)? i (?:start(?:ed)?|begin|began)|when did i (?:start|begin|began)|how long (?:have i been|since i (?:started|began))|what(?:'?s| is| was)?\s+(?:my\s+)?(?:glp-?1\s+)?start date)(?:\s+(?:on|with|using|taking|doing))?(?:\s+the)?(?:\s+(?:injections?|shots?|jabs?|ozempic|wegovy|mounjaro|zepbound|saxenda|rybelsus|semaglutide|tirzepatide|the medication|medication|meds?|treatment|glp-?1|glp))?\s*\??$/i;

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
 * Map a single normalized turn to a query-fast category, or null if no pattern
 * matches. Extracted so the compound-message path (a status/greeting preamble
 * followed by a stats/history question) can re-run categorization on a stripped
 * clause. Every category here is a READ — never a write — so re-routing a clause
 * can never drop a food log.
 */
function categorizeQuery(t: string): QueryFastResult['category'] | null {
  return (
    PROTEIN_GOAL_RE.test(t) ? 'protein_goal'
    : CALORIE_GOAL_RE.test(t) ? 'calorie_goal'
    : WEIGHT_GOAL_RE.test(t) ? 'weight_goal'
    : PROTEIN_TODAY_RE.test(t) ? 'protein_today'
    : CALORIE_TODAY_RE.test(t) ? 'calorie_today'
    : PROTEIN_LEFT_RE.test(t) ? 'protein_today'
    : CALORIE_LEFT_RE.test(t) ? 'calorie_today'
    : CALORIE_OVER_RE.test(t) ? 'calorie_today'
    : PROGRESS_TODAY_RE.test(t) ? 'progress_today'
    : PLAN_TODAY_RE.test(t) ? 'daily_focus'
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
    : BARE_TARGET_RE.test(t) ? 'protein_goal'
    : null
  );
}

// A clause that is PURELY a greeting / status update ("feeling good", "hi",
// "doing great", "I'm tired today") — nothing else. Used to strip a status
// preamble off a compound message so the real question still routes. Tight
// whitelist: a food log, a second question, or any substantive content fails
// these, so the compound path can never swallow a log or a real ask.
const GREETING_ONLY_RE =
  /^(?:(?:hi|hey|hello|hiya|yo|sup|gm|morning|good morning|good afternoon|good evening|hey there|hi there)[\s,]*)+$/i;
const STATUS_CLAUSE_RE =
  /^(?:(?:hi|hey|hello|hiya|yo|sup|gm|morning|good morning|good afternoon|good evening|hey there|hi there)[\s,]*)*(?:i'?m|i am|im|i feel|i'?m feeling|im feeling|feeling|feel)?\s*(?:really |pretty |very |so |quite |doing |all )?(?:good|great|fine|ok|okay|well|alright|amazing|wonderful|fantastic|happy|content|grateful|blessed|calm|relaxed|hopeful|better|decent|meh|so-?so|not bad|hanging in(?: there)?|tired|exhausted|sleepy|drained|wiped)(?:\s+(?:today|so far|right now|thanks|thank you|too))*$/i;

function isPureStatusClause(clause: string): boolean {
  const c = clause.trim().toLowerCase().replace(/[.!?,;]+$/, '').trim();
  if (!c || c.length > 30) return false;
  return GREETING_ONLY_RE.test(c) || STATUS_CLAUSE_RE.test(c);
}

/** A short, warm acknowledgment for the status preamble we stripped, so the
 *  reply still responds to the emotional component (multi-intent). Empty for a
 *  bare greeting — the answer itself carries the turn. */
function statusAckFor(preamble: string): string {
  const p = preamble.toLowerCase();
  if (/\b(tired|exhausted|sleepy|drained|wiped|meh|so-?so|not bad)\b/.test(p)) {
    return 'Sorry you’re wiped.';
  }
  if (/\b(good|great|fine|well|amazing|wonderful|fantastic|happy|better|grateful|blessed|content|calm|relaxed|hopeful|decent|alright|ok|okay)\b/.test(p)) {
    return 'Good to hear.';
  }
  return '';
}

/**
 * Compound multi-intent handler. The query-fast patterns are anchored to the
 * WHOLE turn, so a status/greeting preamble ("Feeling good. What I ate today")
 * blocks the real stats/history question. Split on clause boundaries; if every
 * clause but ONE is a pure status/greeting, route on that single remaining
 * clause and carry a short ack for the status.
 *
 * Safety: the surviving clause must itself match a READ-only query-fast
 * category. If two or more clauses are substantive (e.g. a food LOG plus a
 * question), we bail to the orchestrator so nothing is dropped.
 */
function splitCompoundStatusQuery(
  t: string,
): { rest: string; category: QueryFastResult['category']; ack: string } | null {
  const clauses = t.split(/[.!?,;\n]+/).map((c) => c.trim()).filter(Boolean);
  if (clauses.length < 2) return null;
  const statusClauses = clauses.filter(isPureStatusClause);
  const substantive = clauses.filter((c) => !isPureStatusClause(c));
  if (statusClauses.length === 0 || substantive.length !== 1) return null;
  const category = categorizeQuery(substantive[0]!);
  if (!category) return null;
  return { rest: substantive[0]!, category, ack: statusAckFor(statusClauses.join(' ')) };
}

/**
 * Build a data-grounded daily plan/focus answer from the user's goals and
 * today's progress. PLANNING MODE: leads with protein goal + progress (Grace's
 * headline metric), adds a weight-progress clause when available, and frames
 * food choice gently (covers a sore-stomach day without making symptoms the
 * answer). When there's no goal AND nothing logged, gives an honest
 * profile-based default + a nudge to log — never a generic "stay hydrated".
 */
function renderDailyFocus(
  user: {
    protein_goal_grams?: number | null;
    calorie_goal_kcal?: number | null;
    current_weight?: number | null;
    goal_weight?: number | null;
  },
  summary: { protein_g: number; calories: number; items: string[] } | null,
): string {
  const proteinGoal = user.protein_goal_grams ?? 0;
  const proteinToday = summary ? Math.round(summary.protein_g) : 0;
  const loggedAnything = !!summary && summary.items.length > 0;

  if (proteinGoal <= 0 && !loggedAnything) {
    return `I don't have much from today yet. Based on your profile, I'd focus on hitting your protein target and keeping meals consistent and gentle on your stomach. Have you logged anything yet today?`;
  }

  const parts: string[] = [];
  if (proteinGoal > 0) {
    const remaining = Math.max(0, proteinGoal - proteinToday);
    parts.push(
      remaining > 0
        ? `Your protein goal today is ${proteinGoal}g and you've logged ${proteinToday}g so far, so the biggest win is the next ${remaining}g, ideally from foods that sit comfortably`
        : `You've already hit your ${proteinGoal}g protein target (${proteinToday}g so far), so today's focus is staying hydrated and keeping meals gentle`,
    );
  } else {
    parts.push(
      `You've logged ${proteinToday}g protein so far, so front-loading protein at each meal is the most useful focus today, aiming for the GLP-1 range of 1.2-1.6g per kg`,
    );
  }

  const cw = user.current_weight ?? 0;
  const gw = user.goal_weight ?? 0;
  if (cw > 0 && gw > 0 && cw > gw) {
    const toGo = Math.round((cw - gw) * 10) / 10;
    parts.push(`You're ${toGo} lbs from your ${gw} lbs goal, and steady daily logging is what moves that`);
  }

  return parts.join('. ') + '.';
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
  // Keep the leading/internal punctuation (only trim trailing) so the compound
  // splitter below can see clause boundaries ("Feeling good. What I ate today").
  let t = normalizeUserText(text).trim().replace(/[!.]+$/, '').trim();
  if (t.length === 0 || t.length > 80) return null;

  // Cheap regex tests first — bail before any DB read if no pattern matches.
  let matchedCategory = categorizeQuery(t);
  // Compound multi-intent ("Feeling good. What I ate today"): strip a pure
  // status/greeting preamble and route on the surviving question clause.
  let statusAck = '';
  if (!matchedCategory) {
    const compound = splitCompoundStatusQuery(t);
    if (compound) {
      matchedCategory = compound.category;
      t = compound.rest; // the rest of the switch operates on the question clause
      statusAck = compound.ack;
    }
  }
  if (!matchedCategory) return null;

  // Prepend the status ack (if any) to whatever the switch returns, so a
  // compound message responds to BOTH the status and the question.
  const withAck = (r: QueryFastResult | null): QueryFastResult | null =>
    r && statusAck ? { ...r, text: `${statusAck} ${r.text}` } : r;

  try {
    // Prefer the caller-supplied user (works under field encryption); only
    // re-fetch when no `user` key was provided at all.
    const user = 'user' in deps
      ? deps.user
      : await deps.users.getById(deps.userId).catch(() => null);
    if (!user) return null;

    const result: QueryFastResult | null = await (async (): Promise<QueryFastResult | null> => {
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
          const remaining = goal - total;
          if (remaining < 0) {
            return {
              text: `You're at ${total} kcal today — ${Math.abs(remaining)} kcal over your ${goal} kcal target based on what's logged. One day doesn't define your progress.`,
              category: 'calorie_today',
            };
          }
          if (remaining === 0) {
            return {
              text: `You're at ${total} kcal today — you hit your ${goal} kcal target.`,
              category: 'calorie_today',
            };
          }
          return {
            text: `You're at ${total} kcal today — ${remaining} kcal left of your ${goal} kcal target.`,
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

      case 'daily_focus': {
        const summary = await deps.users.getTodaysFoodSummary(deps.userId).catch(() => null);
        return {
          text: renderDailyFocus(user, summary),
          category: 'daily_focus',
        };
      }

      case 'food_summary_today': {
        // 2026-06-05 production failure: "What I ate today" → orchestrator
        // shipped "Tell me a bit more?". 2026-06-11: the replacement dumped a
        // raw, repetitive list ("chicken breast, rice, 2 eggs, 2 eggs, chicken
        // breast, … and 12 more") — a database export, not a summary. Now we
        // AGGREGATE identical foods into "Name × N", separate the food list
        // from the nutrition totals, and never emit a vague "and N more".
        const summary = await deps.users.getTodaysFoodSummary(deps.userId).catch(() => null);
        if (!summary) return null;
        return {
          text: renderDailyFoodSummary(
            summary.items,
            Math.round(summary.protein_g),
            Math.round(summary.calories),
          ),
          category: 'food_summary_today',
        };
      }

      case 'start_date': {
        // NEVER fabricate: buildStartDateAnswer reads the stored value and, if it's
        // missing OR implausible (e.g. a stray "Jan 5, 1999"), ASKS the user to
        // confirm/set it instead of parroting a wrong or invented date.
        const med = user.medication && user.medication.trim() ? user.medication : null;
        return {
          text: buildStartDateAnswer(user.glp1_start_date, med, 'https://graceglp.com/settings'),
          category: 'start_date',
        };
      }

      case 'week_number': {
        const d = user.glp1_start_date;
        if (!d || !isPlausibleStartDate(d)) {
          // No reliable start date → we can't pin a week number without inventing
          // one. Ask the user to set/confirm it rather than guessing.
          return {
            text: d
              ? `The start date I have on file doesn't look right, so I can't pin your week number. When did you actually start? Tell me and I'll fix it, or update it at https://graceglp.com/settings.`
              : `I don't have your GLP-1 start date on file yet, so I can't pin the week number. Tell me when you started, or set it at https://graceglp.com/settings.`,
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
    return null;
    })();
    return withAck(result);
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
  PROTEIN_LEFT_RE,
  CALORIE_LEFT_RE,
  BARE_TARGET_RE,
  PROGRESS_TODAY_RE,
  PLAN_TODAY_RE,
  START_DATE_RE,
  WEEK_NUMBER_RE,
  MEDICATION_RE,
  INJECTION_DAY_RE,
  CURRENT_WEIGHT_RE,
  AGE_RE,
};
