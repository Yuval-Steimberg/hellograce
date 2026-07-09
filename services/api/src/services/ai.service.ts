import type { Logger } from 'pino';
import type { Pool } from 'pg';
import type { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import type { ChatTurn, DietaryRestriction, InboundMessage, OrchestratorOutput, ToolResult, DbContentRule } from '@grace/shared';
import {
  AIOrchestrator,
  PlannerAgent,
  ToolRegistry,
  classifyMessage as classifyIntent,
  answerGlp1Topics,
  checkContent,
  enforceFormat,
  checkResponseQuality,
  formatFoodSuggestions,
  endsMidWord,
  trimToLastCompleteSentence,
  detectTopicSwitch,
  detectReasoningRequest,
  normalizeUserText,
  reconstructFollowUp,
  FOOD_HISTORY_QUESTION,
  PROTEIN_TARGET_QUESTION,
  FOOD_REMOVAL_QUESTION,
  GRACE_SYSTEM_PROMPT,
  type MessageContext,
} from '@grace/ai-core';
import { tryFastPath } from './fast-path.js';
import { isAcceptableRephrase, buildRephraseSystem } from './rephrase.js';
import { getCuratedFoodIdeas } from '../tools/curated-meal-ideas.js';
import { estimateMultiItemFood, FOOD_TOKEN_SET } from '../tools/log-food.js';
import {
  aggregateFoodItems,
  formatAggregatedInline,
  renderProteinBreakdown,
  renderCalorieBreakdown,
  renderDailyFoodSummary,
} from './food-summary.js';
import { buildFoodFitAnswer } from '../tools/food-fit.js';
import { createHash } from 'crypto';
import { isEncryptedBlob } from '../crypto/field-encrypt.js';
import type { GraceUser } from '../user/user.service.js';

/**
 * Deterministic protein-target walkthrough. Fires when the user replies
 * "yes" / "please" / "sure" to a Grace offer like "want me to walk you
 * through the numbers?" — ships the clinical math grounded in the user's
 * stored profile (or the general formula when profile is incomplete).
 *
 * Zero LLM call, ~80ms end-to-end vs ~3s for the knowledge_direct path.
 * Returns null when even a generic explanation wouldn't help (no
 * meaningful starting point).
 */
function buildProteinTargetWalkthrough(user: GraceUser | null): string | null {
  if (!user) return null;
  const weightLbs = user.current_weight;
  const goalG = user.protein_goal_grams;
  // We have weight → compute the actual target range from formula.
  if (weightLbs && weightLbs > 0) {
    const kg = weightLbs / 2.205;
    const lowG = Math.round(kg * 1.2);
    const highG = Math.round(kg * 1.6);
    if (goalG && goalG > 0) {
      return `Your ${goalG}g target comes from your current weight (${weightLbs} lbs ≈ ${Math.round(kg)} kg) × 1.2g per kg — the clinical GLP-1 floor. The upper end (1.6g/kg) puts you closer to ${highG}g, which protects muscle better when calorie intake drops. Around ${lowG}-${highG}g daily is the safe range.`;
    }
    return `Quick math: at ${weightLbs} lbs (≈${Math.round(kg)} kg), the GLP-1 protein range is 1.2-1.6g per kg, which works out to ${lowG}-${highG}g per day. The upper end protects muscle better since 25-35% of weight lost on GLP-1 can be lean mass without enough protein.`;
  }
  // No weight on file → ship the general formula + ask for weight.
  if (goalG && goalG > 0) {
    return `Your ${goalG}g target follows the GLP-1 protein guideline of 1.2-1.6g per kg of body weight daily. If you tell me your current weight I can show you exactly where ${goalG}g lands in your personal range.`;
  }
  return `The GLP-1 protein guideline is 1.2-1.6g per kg of body weight daily. For an average adult that's 90-130g a day, with 25-30g front-loaded at breakfast. Share your current weight and I'll calculate your exact target.`;
}

// ─── Direct-path config (2026-06-05 architectural inversion) ─────────────────
// 2026-06-05 v4: when knowledge_direct fails (33% hit rate in prod), we'd
// otherwise spend 15-40s in the orchestrator. For known topics we have
// curated GLP-1-accurate fallbacks ready — ship them immediately instead.
// Mirrors the orchestrator's getToolAwareFallback topic checks but runs
// BEFORE the orchestrator so we save the latency entirely.
// Body-symptom / side-effect signal — used by the resilient fallback so a
// message like "my stomach hurts, I'm hungry" gets an acknowledgement +
// guidance instead of a generic deflection when the LLM is unavailable.
const SYMPTOM_FALLBACK_RE =
  /\b(stomach|tummy|belly|gut)\s+(h[ue]rts?|aches?|ache|cramping|cramp|upset|sore|burning|in pain)\b|\b(nause(?:a|ous)|queasy|sick to my stomach|throwing up|threw up|vomiting|vomited)\b|\b(heartburn|acid reflux|reflux|indigestion)\b|\b(headache|migraine|dizzy|lightheaded|woozy)\b|\b(constipated|constipation|diarrhea|bloated|bloating)\b|\b(fatigued?|exhausted|so tired|no energy|wiped out)\b/i;

// Deterministic stall floor for the direct-reply (lean) path. The Gemini
// provider already hard-caps a single call at 18s, but 18s of silence reads as
// "stuck" — so the reply races this tighter deadline and falls back to the
// deterministic floor when exceeded. Kept under the 30s webhook in-flight TTL.
const DIRECT_REPLY_TIMEOUT_MS = 13_000;

// A complete reply that happens to END on a food name or word (no trailing
// "." — e.g. "Greek yogurt, a veggie omelet, or cottage cheese") is otherwise
// flagged "truncated" by the webhook's sender gate and dropped. Guarantee a
// terminal mark so a complete food answer is never mistaken for a cut-off one.
function ensureTerminalPunctuation(text: string): string {
  const t = text.trim();
  if (!t) return t;
  if (/[.!?…"')\]}]$/.test(t) || /\p{Extended_Pictographic}$/u.test(t)) return t;
  return `${t}.`;
}

// A reply that ends on a dangling connector/preposition (or no terminal
// punctuation after a long clause) was almost certainly cut off — e.g.
// "…Greek yogurt topped with." Shipping that is never acceptable.
const DANGLING_TAIL_RE =
  /\b(with|and|or|to|of|for|the|a|an|plus|like|such as|including|topped|served|paired|alongside|some)\s*[.,…]*\s*$/i;
// When a user declines a gather question ("no preference / none / skip"), fill
// the field with a benign sentinel so it reads as answered and is never asked
// again. Only the food slots have a sensible "none" — others just won't re-ask
// immediately (relevance gate only fires on that question type).
function declineSentinel(slot: string): Record<string, unknown> | null {
  switch (slot) {
    case 'dietary': return { dietary_restriction: 'none' };
    case 'dislikes': return { food_dislikes: ['none'] };
    default: return null;
  }
}

function endsMidSentence(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (DANGLING_TAIL_RE.test(t)) return true;
  // No sentence-ending punctuation at all on a long reply → likely truncated.
  if (t.length > 40 && !/[.!?…]["')\]]?$/.test(t) && !/\p{Extended_Pictographic}$/u.test(t)) return true;
  return false;
}

// The direct path injects internal instructions (logNote) like "[The user just
// logged food and it's been recorded. Acknowledge it warmly…]". Gemini
// occasionally echoes that verbatim into the user-facing reply ("Okay, the user
// just logged food and it's been recorded." — production 2026-06-21). Grace
// always speaks to the user in second person ("you"), never about "the user",
// so any sentence referencing the internal note is a leak — strip it.
const LEAKED_NOTE_RE =
  /\b(?:the user (?:just |has )?(?:logged|shared|said|asked|messaged|mentioned|reported)|(?:it'?s|it has|has) been recorded|logged food and it|acknowledge (?:it|this|that) warmly|no template|never a (?:template|bare)|running total today is about|their running total)\b/i;
function stripLeakedNotes(text: string): string {
  if (!text) return text;
  // Drop any echoed bracketed instruction outright.
  let t = text.replace(/\[[^\]]*\]/g, ' ');
  // Drop whole sentences that reference the internal note.
  const parts = t.split(/(?<=[.!?])\s+/);
  t = parts.filter((s) => !LEAKED_NOTE_RE.test(s)).join(' ');
  return t.replace(/\s{2,}/g, ' ').trim();
}

// Emotional / reflective language — a message dominated by feelings or habits
// ("I feel like I'm snacking all the time", "struggling with the transition")
// is NOT a concrete food log, even if the classifier flagged food words. Used
// to suppress the never-drop force-log so reflection is never logged as a meal.
const REFLECTION_MARKER_RE =
  /\b(i feel|i'?m feeling|feeling|struggl\w*|transition|realiz\w*|honestly|it'?s so much|easier not to|tend to|these days|lately|all the time|i think i|i guess|overwhelm\w*|stress\w*|anxious|lonely|bored|sad|frustrat\w*|adjust\w*|routine)\b/i;

// Deterministic signals that the food EXTRACTION LLM pass could actually do
// something beyond logging a named food: a diary query to answer, or a
// delete/edit to apply. Used (with namesSpecificFood / foodSpanFromConsumption /
// pending) to skip the ~1.5s extraction call on a pure recommendation/planning
// question ("should I eat a big or small dinner?") that has nothing to extract.
// Conservative: if a delete/edit/query is phrased oddly and misses these, the
// call simply still runs on the food_log/food_question intents it always did —
// so the guard can only SKIP a genuine no-op, never drop a real action.
const FOOD_DIARY_QUERY_RE =
  /\b(what (?:did|have) i (?:eat|ate|had|log|logged)|what'?s my (?:protein|calorie|calories)|how (?:much|many) (?:protein|calories?) (?:do i|have i|did i|i have|is|are|left|today|so far|remaining)|my (?:protein|calorie|calories) (?:today|so far|total|count|goal|left|remaining)|(?:food|meal) (?:log|diary|summary))\b/i;
const FOOD_MUTATION_RE =
  /\b(remove|delete|undo|scratch that|take (?:that|it|the)\b|didn'?t (?:actually |really )?(?:eat|have|mean)|make it|change (?:it|that) to|actually (?:it was|that was|only|just)|correct(?:ion)?|not \d)\b/i;

// A QUESTION asking WHAT the user has eaten / their intake so far — must be
// answered from the LOG deterministically, never the LLM reading conversation
// history. Tolerates a leading greeting ("Good morning, …") and BOTH word orders
// ("what have I eaten" / "what I have eaten"). The anchored query-fast summary
// regex misses a greeting prefix + this word order (prod IMG_6710: after a reset,
// "Good morning, what I have eaten today?" was answered by the LLM, which dragged
// the PRE-RESET shake+sandwich back up and offered to re-add them). Nudge answers
// it plainly from the snapshot → "Nothing is logged yet for today."
const FOOD_DIARY_ASK_RE =
  /\bwhat\s+(?:have\s+i|i\s+have|did\s+i|i)\s+(?:eaten|ate|eat|had|logged|consumed)\b|\bwhat(?:'?s| is| has been)\s+(?:logged|(?:in|on)\s+my\s+(?:food\s+)?log)\b|\bhow\s+(?:much|many)\s+(?:protein|calories?|cals?|kcal)\s+(?:have\s+i|i\s+have|did\s+i|i)\s+(?:had|eaten|consumed|logged|eat|ate)\b|\b(?:show|list|summari[sz]e|tell\s+me|recap)\s+(?:me\s+)?(?:my|today'?s)\s+(?:food|meals?|intake|log|eating|diet|day)\b/i;
// If the SAME message also asks for a recommendation / plan, it's not a pure
// diary read → let the full grounded path answer every part (the snapshot rule
// keeps its intake grounded). A greeting alone does NOT disqualify it.
const FOOD_RECO_OR_PLAN_RE =
  /\b(what should i|what can i|any (?:idea|ideas|suggestion|suggestions)|recommend|suggest|plan|for (?:breakfast|lunch|dinner|a snack)|help me|before dinner)\b/i;

/**
 * A warm, day-aware greeting reply — the Nudge model: greet back, reference the
 * user's REAL local weekday/time, and offer a hand. Deterministic + seed-varied
 * (no LLM), so a "Hey" is answered INSTANTLY and never with a dry generic line.
 */
export function buildWarmGreeting(seed: string, timezone: string | null | undefined, now: Date = new Date()): string {
  const t = resolveTemporalContext(timezone, now);
  const pick = <T,>(arr: readonly T[], s: string): T => {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return arr[Math.abs(h) % arr.length]!;
  };
  const opener = pick(['Hey!', 'Hey there 🤍', 'Hi!', 'Hey, good to hear from you.'], seed);
  const ask = pick(
    [`How's your ${t.weekday} going?`, `How's your ${t.timeOfDay} treating you?`, `How's ${t.weekday} shaping up so far?`],
    seed + 'a',
  );
  const offer = pick(
    [
      "I'm here if you want to talk through your day or a meal idea.",
      "I'm around whenever you want to chat or log something.",
      "Just holler if you want to think through food or your day.",
    ],
    seed + 'o',
  );
  return `${opener} ${ask} ${offer}`;
}

/**
 * True when a message is a QUESTION about what the user has eaten / their intake
 * today — answered deterministically from the food log, never the LLM reading
 * conversation history. Covers any phrasing/word order ("what have I eaten",
 * "what I have eaten", "what did I eat", "how much protein have I had",
 * "show my food today") with or without a leading greeting. A message that ALSO
 * asks for a recommendation/plan, or is a mutation (remove/undo), is NOT a pure
 * diary read → false (the grounded path answers it, still snapshot-bound).
 */
export function isFoodDiaryQuery(text: string): boolean {
  const t = text ?? '';
  return FOOD_DIARY_ASK_RE.test(t) && !FOOD_MUTATION_RE.test(t) && !FOOD_RECO_OR_PLAN_RE.test(t);
}

// Split a multi-part question ("can I drink alcohol AND how much protein AND why
// is my weight") into its parts so the reply can be told to answer EVERY one.
// Only fires on a question-shaped message with a conjunction or multiple "?",
// so an emotional "I feel tired and stressed" is left alone. Returns [] when not
// multi-part.
export function splitQuestionParts(text: string): string[] {
  const t = (text || '').trim();
  if (!t) return [];
  const qCount = (t.match(/\?/g) ?? []).length;
  const isQuestionish =
    qCount > 0 ||
    /^(can|could|should|would|is|are|do|does|did|how|why|what|when|where|which|will)\b/i.test(t);
  const hasConj = /\b(and also|and|also|plus)\b/i.test(t);
  if (!(isQuestionish && (hasConj || qCount > 1))) return [];
  const raw = t
    .split(/\?|\b(?:and also|and|also|plus)\b/i)
    .map((s) => s.replace(/^[,\s]+|[,\s]+$/g, ''))
    .filter(Boolean);
  const parts = raw.filter((p) => p.split(/\s+/).filter(Boolean).length >= 2).slice(0, 4);
  return parts.length >= 2 ? parts : [];
}

function pickKnowledgeTopicFallback(userMessage: string): string | null {
  // Comprehensive, typo-tolerant GLP-1 knowledge bank (shared with the
  // orchestrator fallback). Covers ~40 topics and normalizes misspellings, so
  // this is the primary deterministic answer source. The legacy inline checks
  // below remain as a backstop for anything it doesn't cover.
  const kb = answerGlp1Topics(userMessage);
  if (kb) return kb;
  const msg = userMessage.toLowerCase();
  if (/\bwater|hydration|fluid\b/.test(msg) && !/\balcohol|caffeine|coffee\b/.test(msg)) {
    return "Aim for around 64-80 oz of water daily on GLP-1, sipped throughout the day rather than gulped — large amounts at once can amplify nausea.";
  }
  if (/\balcohol\b/.test(msg)) {
    return "Moderation is the general guidance — alcohol can amplify GLP-1 nausea, low blood sugar, and dehydration. A drink or two with food is usually fine for most people, but cut back if you're feeling rough.";
  }
  if (/\bsleep|insomnia\b/.test(msg)) {
    return "GLP-1s can disrupt sleep for some people — common causes are nighttime nausea, blood sugar swings, and vivid dreams. A small protein snack 1-2 hours before bed often helps.";
  }
  if (/\bcoffee|caffeine\b/.test(msg)) {
    return "Coffee is generally fine on GLP-1s but can amplify stomach upset, especially on an empty stomach. Try having it with food, or switch to half-caf for a few days if it's hitting hard.";
  }
  if (/\bexercise|workout|gym|cardio|lift|train\b/.test(msg)) {
    return "Resistance training a few times a week is the strongest protector against muscle loss on GLP-1, alongside hitting your protein target. Start light if appetite is suppressed and build up.";
  }
  // 2026-06-11 WhatsApp: "is hair loose commn on glp?" — "loose"/"losing"/
  // "falling out"/"shedding"/"thinning" must all map here, not to the generic
  // GLP-1 mechanism blurb. Match "hair" near any of those.
  if (/\bhair\b/.test(msg) && /\b(loss|loose|losing|fall|falling|fell|shed|shedding|thin|thinning|coming out|falling out)\b/.test(msg)) {
    return "Hair shedding (telogen effluvium) is common with significant weight loss, including GLP-1 weight loss — it's usually temporary and tied to the rapid loss and lower intake, not the medication directly. Hitting your protein target and checking iron/ferritin with your doctor helps. Have you noticed more shedding lately, or asking generally?";
  }
  if (/\bmuscles?\b/.test(msg) && /\b(affect|impact|lose|losing|loss|protect|maintain|keep|preserve|build|GLP)\b/i.test(userMessage)) {
    // Mechanism + personal action + follow-up (2026-06-11 feedback: "how"
    // questions need the WHY, not just the statistic).
    return "The medication itself doesn't damage muscle — but because it cuts your appetite so much, you eat less protein and fewer calories, and your body can start breaking down muscle along with fat. That's why hitting your protein target every day and doing some resistance work 2-3x a week matters so much. Want me to check how your protein's looking today?";
  }
  if (/\b(protein|grams)\b/.test(msg) && /\b(man|woman|men|women|male|female|guy|girl)\b/.test(msg)) {
    return "On GLP-1 therapy the target is 1.2-1.6g of protein per kg of body weight daily — for an average adult that's roughly 90-130g. Front-load 25-30g at breakfast to protect muscle and reduce muscle loss during weight reduction.";
  }
  if (/\b(how (much|many)\s+(protein|grams of protein)|protein\s+(target|goal|amount|requirement|need))\b/.test(msg)) {
    return "On a GLP-1 the target is 1.2-1.6g of protein per kg of body weight daily — typically 90-130g for an average adult. Front-load 25-30g at breakfast to protect muscle.";
  }
  if (/\b(nausea|side effects?|symptoms?)\b/.test(msg) && /\b(how long|when|going away|stop|end|last|persist)\b/.test(msg)) {
    return "Most GLP-1 side effects peak in the first 4-8 weeks and improve as your body adjusts. If nausea is severe past week 8 or your dose just changed, mention it to your prescriber — they can pause the next escalation.";
  }
  if (/\bplateau|stall|stuck|not losing|stopped losing\b/.test(msg)) {
    return "Plateaus on GLP-1s are common — your body adapts to the calorie deficit. Things that often break a plateau: making sure you're hitting your protein target, adding resistance training, checking your sleep, and giving your body 2-3 weeks at the same calorie level before adjusting.";
  }
  if (/\bconstipation|constipated|bowel|poop\b/.test(msg)) {
    return "Constipation is one of the most common GLP-1 side effects — slowed digestion is the cause. Aim for 25-30g of fiber daily, 64-80 oz of water, and a 10-15 minute walk after meals. Magnesium citrate at night helps if those aren't enough.";
  }
  if (/\bdiarrhea|loose stool|runs\b/.test(msg)) {
    return "Diarrhea on GLP-1s usually shows up in the first few weeks or after a dose escalation. Bland foods (rice, banana, toast), small frequent meals, and electrolytes help. If it lasts more than 48 hours, call your prescriber.";
  }
  if (/\bheartburn|reflux|acid\b/.test(msg)) {
    return "Heartburn is common on GLP-1s because slowed digestion means food sits in the stomach longer. Smaller meals, no eating within 2 hours of bed, and avoiding triggers (alcohol, coffee, spicy food) helps. Mention persistent heartburn to your prescriber.";
  }
  if (/\binjection (site|pain|bruise|swelling|red)/i.test(msg)) {
    return "Mild injection-site soreness, redness, or a small bruise is common and usually resolves in a day or two. Rotate sites (belly, thigh, upper arm) and let the pen warm up for a few minutes before injecting. Persistent swelling or pus warrants a call to your prescriber.";
  }
  return null;
}

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
    system: `You are Grace, a warm and CLINICALLY INFORMED GLP-1 medication companion. The user is on a GLP-1 (Ozempic, Wegovy, Mounjaro, Zepbound, or similar) and asked a clinical question.

CLINICAL ANSWER FRAMEWORK — answer in this order:
1. Lead with the QUANTITATIVE answer. If the question asks for a target, requirement, range, or "how much", the FIRST sentence must contain a specific number, range, or formula.
2. Brief context (one sentence): why that number, weight-based reasoning, GLP-1-specific consideration.
3. Optional personalization offer (one sentence): "If you tell me your weight I can calculate yours" — only when the question implies a personalized answer would help.
4. Practical follow-up (only if directly relevant): food examples, timing tips. Never lead with food examples for a target question.

GLP-1 CLINICAL FACTS (use these exact numbers when relevant):
- Protein target on GLP-1: 1.2-1.6 g per kg of body weight daily (≈90-130g for an average adult). Front-load 25-30g at breakfast.
- Protein for active adults: up to 1.6-2.0 g/kg/day.
- General adult RDA: ~0.8 g/kg/day (NOT what GLP-1 users should target).
- Hydration: 64-80 oz water daily, sipped throughout the day.
- Fiber: 25-30 g daily.
- Side effects peak weeks 1-8, improve with adjustment.
- Muscle loss: 25-35% of weight lost on GLP-1 can be lean mass without adequate protein + resistance training.

QUESTION TYPE — identify FIRST, then answer:
- REQUIREMENT ("how much protein", "what is the recommended protein", "what's my target") → quantitative answer with target range. NEVER list foods.
- FOOD SOURCE ("what foods have protein", "high-protein snacks") → list specific foods.
- MEDICAL ("is heartburn normal", "why does X happen") → brief explanation + when-to-call-doctor line if relevant.
- PROGRESS ("how am I doing", "am I on track") → use the user's data.

ANSWER STYLE:
- 2 to 4 sentences total. Never longer.
- Prose only. NO bullet points, NO numbered lists, NO dashes, NO section headers.
- NO colons used to introduce a list ("Here's how:" / "Common causes:" — BANNED).
- Cite framing like "research suggests" / "clinical guidance is" when stating numbers.
- If it needs a prescriber's input, say so in one sentence and move on.

NEVER:
- Answer a REQUIREMENT question with food examples ("For protein, consider grilled chicken, eggs..." — BANNED on target questions).
- Say "I cannot provide personalized medical advice" or any AI-disclaimer phrase.
- Use parenthetical brand-name dumps "(Ozempic, Wegovy, Mounjaro, Saxenda, Victoza)".
- Use markdown asterisks for bold or italic.
- End with a clarifying question.
- Hallucinate doses or studies — use the GLP-1 CLINICAL FACTS above for confident numbers.

Example — User asks "What is the recommended protein for a man?":
  CORRECT: "Research and clinical guidance for GLP-1 users suggest around 1.2-1.6 grams of protein per kilogram of body weight daily — for a 180 lb (82 kg) man that works out to roughly 100-130g. The target isn't actually different for men vs women — it's based on body weight, not sex. Front-loading 25-30g at breakfast helps protect muscle. If you tell me your weight I can calculate your exact target."
  WRONG: "For protein, consider grilled chicken breast, baked cod, or cottage cheese..."

Answer the user's exact question, calmly and human, with the clinical framework above.`,
    temperature: 0.3,
    maxTokens: 450,
    useSearch: true,
    hardCharCap: 900,
    maxSentencesOnTrim: 4,
  },

  emotional: {
    system: `You are Grace, a warm GLP-1 companion. The user just shared something emotional — frustration, fear, sadness, defeat, exhaustion, anxiety, nervousness, excitement, worry, disappointment, confusion, stress, or self-doubt.

YOUR RESPONSE IS 2 TO 4 SHORT SENTENCES — long enough to actually engage with the feeling, short enough to feel like a friend texting back, not a paragraph.

THE 4-STEP FRAMEWORK (use 2 or 3 of these in the order that fits):

1. RECOGNIZE — Reflect the feeling using their word OR a close synonym, in your own voice.
   ✓ "Nervous makes total sense before a shot."
   ✓ "That sounds heavy."
   ✓ "Frustrated is fair."
   ✗ "I hear you." (alone — too flat, conversational dead-end)
   ✗ "I'm sorry you're feeling that way." (bureaucratic)

2. CONTEXTUAL SUPPORT (optional) — One companion-style line that places their feeling in a real context. Use ONE — never list.
   ✓ "Waiting for the scale to move is one of the hardest parts."
   ✓ "Starting something new brings a lot of uncertainty."
   ✓ "Side effects on top of everything else makes it harder to think clearly."

3. GENTLE OPEN QUESTION — Offer space to elaborate. Pick ONE simple, specific question. Never a list.
   ✓ "What's making it feel most heavy right now?"
   ✓ "Want to share what's underneath that?"
   ✓ "Is there a piece of it you can put words to?"
   ✗ "Tell me more" (lazy)
   ✗ "What's on your mind?" (lazy)
   ✗ "How are you feeling now?" (loops back to the same prompt)

4. PERSONALIZE (when context is present in USER PROFILE block) — Tie the feeling to something concrete from their journey.
   ✓ "You've been pushing hard this week — that exhaustion is data, not a flaw."
   ✓ "Three weeks in is a real adjustment window."

ABSOLUTELY BANNED (still — these stay banned):
- "As an AI…" / "I am programmed to…" / "I'm just a chatbot" — never.
- "Many people experience similar feelings" / "It's completely normal" / "completely understandable" — generic and patronizing.
- "knowing what specifically is causing your anxiety might help me offer more targeted support" — bureaucratic.
- ANY colon used to introduce examples or lists.
- Pushing 988/911 when there's no self-harm signal — that's reserved for the safety guard.
- Asking MORE than one question.
- Listing categories ("are you nervous about: A, B, or C?").
- Sycophantic openers ("Great that you're sharing", "I'm so glad you told me").
- Closing on a one-word ack like "Noted." / "Got it." / "Understood." / "Thanks for sharing." when the user is expressing emotion.

EXAMPLES (this is the new bar):

User: "I'm nervous"
✓ "Nervous makes a lot of sense before a shot — there's real uncertainty in it. What's the part that's weighing most?"
✗ "I hear you." (dead end — banned as a sole reply)

User: "I'm so frustrated"
✓ "Frustrated is fair — especially when you're doing the work and the numbers aren't matching. What's the hardest piece of it today?"

User: "I'm overwhelmed"
✓ "Overwhelmed makes sense. There's a lot to hold — the food, the medication, your own expectations. Where's the heaviest part right now?"

User: "I'm excited!"
✓ "Excited is great to hear. What's lit you up?"

User: "I'm worried about side effects"
✓ "Worry about side effects is real — they're unpredictable, especially early on. Anything specific you're bracing for?"

User: "I just want to give up"
✓ "I hear how heavy this is. Wanting to give up after pushing hard isn't weakness — it's exhaustion. Want to talk through what's piling up?"

End with a gentle open question OR a quiet supportive line — never a one-word stamp.`,
    temperature: 0.55,
    maxTokens: 200,
    useSearch: false,
    hardCharCap: 420,
    maxSentencesOnTrim: 4,
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
import { detectTemporalQuery, buildLocalTimeReply, buildDayResetReply } from './temporal-query.js';
import { classifyIntentLLM } from './intent-llm.js';
import { isWaterQuery, isWaterLog, parseWaterOz, WATER_GOAL_MIN_OZ, WATER_GOAL_MAX_OZ } from '../nutrition/water.js';
import { getTodaysWaterOz, renderWaterTotal, logWater } from './water-log.js';
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
import { detectVagueFood, findVagueAddOnItem, hasExplicitQuantity } from '../safety/vague-food.js';
import { shouldDiscloseEstimate, estimateNote } from '../nutrition/estimate-note.js';
import { calculateProteinTarget } from '../nutrition/protein-target.js';
import { worstConfidence, isRoughConfidence, isMaterialMacro } from '../nutrition/macro-sanity.js';
import {
  calculateCalorieTarget,
  type Sex as CalorieSex,
  type ActivityLevel as CalorieActivity,
} from '../nutrition/calorie-target.js';
import { USER_DAY_CTE, isCurrentUserDay, computeUserLoggingDay } from '../nutrition/logging-window.js';
import {
  looksLikeRecommendation,
  isRecommendationFollowUp,
  isRecipeRequest,
  extractLastRecommendation,
  buildRecommendationAckAdvance,
  extractSelectedFood,
  proteinAddOns,
  buildConsumptionFeedbackReply,
} from './recommendation-context.js';
import {
  detectMealConsumption,
  detectConsumptionFeedback,
  extractFoodMention,
  foodSpanFromConsumption,
  namesSpecificFood,
  firstSpecificFoodNoun,
  isBareConsumptionBackReference,
  mentionsFood,
} from './meal-lifecycle.js';
import {
  setActiveMeal,
  getActiveMeal,
  clearActiveMeal,
} from './meal-recommendation-store.js';
import { analyzeMessage, buildMultiPartNote } from './message-understanding.js';
import { extractFood, formatFoodReply, EMPTY_EXTRACTION, type FoodExtraction, type ExtractedFoodItem } from './food-extract.js';
import { getPendingFood, addPendingFood, resolvePendingFood, clearPendingFood } from './food-pending-store.js';
import { uncoveredAskCount, missingAskTopics } from './multi-ask-coverage.js';
import {
  PROFILE_LEARNING_ENABLED,
  mightStateProfileChange,
  extractProfileUpdates,
  type ProfileSnapshot,
  type ProfileUpdates,
} from './profile-extract.js';
import { GRACE_VOICE_ENABLED, GRACE_VOICE_BRIEF, voiceSuffix } from './voice.js';
import { resolveTemporalContext, buildTemporalContextBlock } from './temporal-context.js';
import { buildNudgeSystemPrompt } from './nudge-prompt.js';
import { isMealAdviceOrPlanningTurn } from './nudge-relevance.js';
import {
  detectInjectionTimingIntent,
  computeInjectionSchedule,
  buildInjectionTimingReply,
  buildScheduleFactLine,
} from './medication-schedule.js';
import {
  parseStartDateStatement,
  buildStartDateCaptureReply,
} from './medication-start-date.js';
import {
  detectReminderIntent,
  buildNextReminderReply,
  buildReminderExplainReply,
  buildReminderChangeReply,
  wasReminderOffer,
  buildReminderKeptReply,
} from './reminder-service.js';
import { detectTrialQuestion, buildTrialReply } from './trial-info.js';
import { detectHealthConcern } from '../safety/health-concern.js';
import { detectCapabilityQuestion, buildCapabilityReply } from './capability.js';
import {
  relevantProfileSlot,
  nextMissingProfileSlot,
  contextualGatherSlot,
  type ProgressiveSlot,
  buildProfileGatherNote,
  buildGatherClarify,
  parseProfileReply,
  getPendingProfileAsk,
  setPendingProfileAsk,
  clearPendingProfileAsk,
  askedProfileRecently,
  setReplayQuery,
  getReplayQuery,
  clearReplayQuery,
  isGatherDecline,
} from '../onboarding/progressive-profile.js';
import { understandSlotWithLlm, type SlotId as OnboardingSlotId } from '../onboarding/onboarding-flow.js';
import { detectHypoglycemiaWarning, mightBeHypoSymptom, isWhatShouldIDo } from '../safety/hypoglycemia-warning.js';
import { detectPeptideSafety } from '../safety/peptide-safety.js';
import { detectHabitCheck, detectSkipFoodLogging, buildHabitCheckReply, buildSkipFoodOffer } from './habit-checklist.js';
import { checkHabits } from './habit-store.js';
import {
  detectSummaryRequest,
  mightBeSummaryRequest,
  gatherWeeklySummary,
  renderWeeklySummary,
  isDoctorQuestionsContext,
  isDoctorQuestionsReply,
  buildDoctorQuestions,
} from './weekly-summary.js';
import { detectFollowUp, wantsMoreDetail } from './follow-up.js';
import {
  classifySymptom,
  analyzeSymptomPattern,
  buildSymptomRecallNote,
  detectRemedyOutcome,
  daysSinceInjection,
  localDayOfWeek,
} from './symptom-intelligence.js';
import { detectDashboardRequest, buildDashboardLinkReply } from './dashboard-link.js';
import { detectFoodReset, buildFoodResetReply } from './food-reset.js';
import { isPortionAffirmation, buildPortionConfirmQuestion, isPortionSensitiveFood, isCompositionAmbiguousFood, isProteinProductAmbiguous, hasPreciseAmount, isObviousSingleServing, servingReflectsUserAmount } from './food-portion.js';
import { weightProgress, loggingStreak, summarizeSymptoms } from './dashboard-data.js';
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
import type { TurnPersistJob, FactExtractJob, MemoryMdUpdateJob } from '../workers/queues.js';
import type { MemoryMdService } from '../memory/memory-md.service.js';

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
  /** Recent conversation turns fed to the orchestrator so a message is never
   *  interpreted in isolation. Default 12 when unset. Tuned via
   *  CONVERSATION_HISTORY_TURNS. */
  historyTurns?: number;
  geminiApiKey: string;
  geminiModel: string;
  /** Known-good model the multimodal path falls back to if geminiModel isn't
   *  available on the key (e.g. a Gemini 3 id not yet enabled). Mirrors the
   *  GeminiProvider fallback so the photo/voice path never silently dies. */
  geminiFallbackModel?: string;
  twilioSid?: string;
  twilioToken?: string;
  turnQueue?: Queue<TurnPersistJob>;
  factExtractQueue?: Queue<FactExtractJob>;
  /** Phase D — pilot memory.md narrative layer. Optional; when absent
   *  (e.g. tests), the memory.md layer is disabled entirely. When present,
   *  only fires for users with a row in `user_memory_md`. */
  memoryMd?: MemoryMdService;
  memoryMdQueue?: Queue<MemoryMdUpdateJob>;
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
    /** GEMINI-FIRST quality mode (2026-06-19). When true, the latency
     *  shortcuts that bypass Gemini with a deterministic template (trivial
     *  fast-path, food-log fast, weight-log fast, FAQ cache, recommendation-ack
     *  advance) are disabled so every normal response is generated by Gemini.
     *  Detection still runs; tools still execute; only the user-facing TEXT
     *  moves to the orchestrator. Defaults to false here so unit tests keep
     *  the deterministic paths; server.ts passes env.GEMINI_FIRST (default
     *  true) for production. */
    geminiFirst?: boolean;
    /** DIRECT REPLY MODE (2026-06-19). When true, the reply is a single Gemini
     *  call on [system + history + user] — no orchestrator/guard cascade. The
     *  full competitor-style generation model. Defaults false here so unit
     *  tests keep the orchestrator path; server.ts passes env.DIRECT_REPLY_MODE
     *  (default true) for production. */
    directReplyMode?: boolean;
    /** LEAN REPLY MODE (2026-07-02). When true, the reply prompt drops the heavy
     *  analytical BACKGROUND blocks — the dashboard PROGRESS SNAPSHOT, learned
     *  SIDE-EFFECT PATTERNS, and the foods-logged-today enumeration — that Gemini
     *  was categorizing into "Here's an analysis of your entries…" replies. Core
     *  persona, safety, medication, and today's totals stay. Default false so
     *  nothing changes until it's flipped via env LEAN_REPLY_MODE. */
    leanReplyMode?: boolean;
    /** COMPACT REPLY MODE (2026-07-02, the "Nudge" model). When true, the reply
     *  uses a TINY system prompt instead of the big personalised one, so Gemini
     *  physically can't produce heading/breakdown/preamble essays — the shape fix
     *  at the source. Crisis safety + food logging + the format floor are
     *  unchanged (they run around it). Default false; flip via COMPACT_REPLY_MODE. */
    compactReplyMode?: boolean;
    /** PROGRESSIVE PROFILING (2026-06-28). When true, after the short onboarding
     *  core Grace gathers the rest of the profile (sex, weight, height, age,
     *  activity, diet) one gentle question at a time, woven into normal chat
     *  (relevance-first). Defaults false here so unit tests are unaffected;
     *  server.ts passes env.PROGRESSIVE_PROFILE_ENABLED (default true). */
    progressiveProfile?: boolean;
    /** UNIFIED_REPLY_PATH (2026-07-03). Consolidation flag — one grounded reply
     *  prompt instead of the compact/lean/personalised split. Default false;
     *  only selects the final prompt (upstream intercepts unaffected). */
    unifiedReplyPath?: boolean;
  };
  /** Production issue capture — Layer 4 of defense-in-depth. Every regen
   *  fire and safe-fallback fire is captured (fire-and-forget) so we can
   *  review and promote to regression tests. Closes the user feedback loop. */
  productionIssues?: ProductionIssuesService;
}

/**
 * Reconstruct a clean food string when the user answers a prior food
 * clarification with a brief detail. We pull the food the clarification was
 * about (e.g. "pizza" from "For the pizza, how many slices…", "chicken" from
 * "How was the chicken prepared…") and join it with the user's answer so the
 * result is a clean loggable phrase ("2 slices of pizza", "grilled chicken")
 * instead of the messy "<entire question>: <answer>" blob — which the LLM
 * turned into a generic non-answer (production bug 2026-06-13).
 *
 * Returns null when the prior message wasn't one of our category/prep
 * clarifications (e.g. a brand "what did you have at KFC?" — the user's reply
 * there is already a specific item and needs no reconstruction).
 */
export function reconstructFoodFromClarification(lastGraceMsg: string, reply: string): string | null {
  const r = reply.trim();
  if (!r) return null;
  let food: string | null = null;
  let m: RegExpExecArray | null;
  if ((m = /\bfor the ([a-z][a-z]*)\b/i.exec(lastGraceMsg))) food = m[1]!;
  else if ((m = /\blog (?:that|the) ([a-z]+)\b/i.exec(lastGraceMsg))) food = m[1]!;
  else if ((m = /\bhow was the ([a-z]+) prepared\b/i.exec(lastGraceMsg))) food = m[1]!;
  else if ((m = /\bwhat was in the ([a-z]+)\b/i.exec(lastGraceMsg))) food = m[1]!; // our contents re-ask
  else if ((m = /\bmore on the ([a-z]+)\b/i.exec(lastGraceMsg))) food = m[1]!;
  if (!food) return null;
  food = food.toLowerCase();
  // Quantity-style answer ("2 slices", "a cup") → join with "of" so it matches
  // the macro table ("2 slices of pizza"). Prep/other answers ("grilled",
  // "cheese") just prefix the food ("grilled chicken", "cheese pizza").
  const isQuantity =
    /^(?:\d+(?:\.\d+)?|a|an|one|two|three|four|five|six|half|couple)\b[\s\S]*\b(slice|slices|cup|cups|piece|pieces|oz|ounces?|gram|grams|serving|servings|bowl|bowls|tbsp|tsp|wing|wings|tender|tenders|nugget|nuggets|handful|scoop|scoops|can|cans)\b/i.test(r);
  return isQuantity ? `${r} of ${food}` : `${r} ${food}`;
}

// Progressive profiling: how long to wait before another *proactive* (non-
// relevance) profile question, so it never feels like a survey.
const PROFILE_GATHER_COOLDOWN_HOURS = 20;
// A proactive gather only piggybacks on a NEUTRAL turn — never a food log,
// weight, symptom, dosing, or emotional message (those carry digits/cue words).
// This also protects the next-turn answer parse: we won't have a stale pending
// ask sitting on a "had 90g chicken" turn that could mis-store as a weight.
const PROFILE_GATHER_UNSAFE_RE =
  /\d|\b(ate|eat|eating|eaten|had|have|drank|drink|log|logged|protein|calorie|calories|weigh|weight|kg|lbs?|pounds?|nause\w*|sick|vomit\w*|dizzy|pain|hurts?|headache|tired|fatigue|shot|inject\w*|dose|sad|depress\w*|anxious|anxiety|crying|hopeless|stop|cancel|unsubscribe)\b/i;
function gatherSafeTurn(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  return !PROFILE_GATHER_UNSAFE_RE.test(t);
}

/** Derived per-user dashboard signals woven into the chat prompt as background,
 *  so replies are grounded in the user's real progress (referenced only when the
 *  user's message is about it). */
interface DashboardSignals {
  weightLost: number | null;
  weightPct: number | null;
  streak: number;
  moodLatest: number | null;
  moodTrend: 'up' | 'down' | 'steady' | null;
  patterns: Array<{ symptom: string; count: number; typicalTiming: string | null; topRemedy: string | null }>;
}

/** The profile/settings fields surfaced to the reply prompt. All optional +
 *  structural so GraceUser (and a test fixture) both satisfy it. */
export interface KnownProfileInput {
  first_name?: string | null;
  medication?: string | null;
  dose_mg?: number | null;
  injection_day?: string | null;
  sex?: string | null;
  age?: number | null;
  height_cm?: number | null;
  current_weight?: number | null;
  goal_weight?: number | null;
  activity_level?: string | null;
  primary_goal?: string | null;
  goals?: string[] | null;
  protein_goal_grams?: number | null;
  calorie_goal_kcal?: number | null;
  exercise_habits?: string | null;
  why_started?: string | null;
  biggest_challenge?: string | null;
  support_style?: string | null;
}

const SUPPORT_STYLE_LABEL: Record<string, string> = {
  gentle: 'gentle, encouraging',
  straight_facts: 'direct, just-the-facts',
  tough_love: 'tough-love, no-nonsense',
  mix: 'balanced',
};

/**
 * Everything Grace KNOWS about this user from their profile/settings, as short
 * background facts. Surfaced in EVERY reply prompt so Grace personalizes from
 * stored data and NEVER asks for something she already has (the user's core ask:
 * "always look in the settings to see if any data can be included"). Stable
 * identity/preference facts only — the recitation-prone injection schedule + food
 * diary stay relevance-gated in the grounded builder.
 */
export function buildKnownProfileFacts(
  user: KnownProfileInput | null | undefined,
  opts: { dietaryRestriction?: DietaryRestriction | null; dislikes?: string[] } = {},
): string[] {
  const facts: string[] = [];
  const name = user?.first_name && !isEncryptedBlob(user.first_name) ? user.first_name.trim() : null;
  if (name) facts.push(`Name: ${name}`);
  const med = user?.medication && !isEncryptedBlob(user.medication) ? user.medication.trim() : null;
  if (med) facts.push(`Medication: ${med}${user?.dose_mg ? ` at ${user.dose_mg}mg` : ''}`);
  if (user?.injection_day) facts.push(`Injection day: ${user.injection_day}`);
  const body: string[] = [];
  if (user?.sex) body.push(String(user.sex));
  if (user?.age) body.push(`${user.age}y`);
  if (user?.height_cm) body.push(`${user.height_cm}cm`);
  if (body.length) facts.push(`Profile: ${body.join(', ')}`);
  if (user?.current_weight != null) {
    facts.push(`Current weight ${user.current_weight} lbs${user?.goal_weight != null ? `, goal ${user.goal_weight} lbs` : ''}`);
  } else if (user?.goal_weight != null) {
    facts.push(`Goal weight: ${user.goal_weight} lbs`);
  }
  if (user?.activity_level) facts.push(`Activity level: ${String(user.activity_level).replace(/_/g, ' ')}`);
  if (user?.primary_goal) facts.push(`Primary goal: ${user.primary_goal}`);
  else if (Array.isArray(user?.goals) && user.goals.length > 0) facts.push(`Wants help with: ${user.goals.join(', ')}`);
  const diet = opts.dietaryRestriction?.label;
  if (diet) facts.push(`Diet: ${diet} — never suggest a food that breaks it`);
  if (opts.dislikes && opts.dislikes.length > 0) facts.push(`Dislikes/avoids (never suggest): ${opts.dislikes.join(', ')}`);
  if (user?.protein_goal_grams) facts.push(`Daily protein target: ${user.protein_goal_grams}g`);
  if (user?.calorie_goal_kcal) facts.push(`Daily calorie target: ${user.calorie_goal_kcal}`);
  if (user?.exercise_habits) facts.push(`Exercise habits: ${user.exercise_habits}`);
  if (user?.why_started) facts.push(`Why they started: ${user.why_started}`);
  if (user?.biggest_challenge) facts.push(`Biggest challenge: ${user.biggest_challenge}`);
  const style = user?.support_style ? SUPPORT_STYLE_LABEL[user.support_style] : null;
  if (style) facts.push(`Prefers a ${style} tone — match it`);
  return facts;
}

export class AIService {
  private systemPrompt: string | undefined;

  constructor(private deps: AIServiceDeps) {
    this.systemPrompt = deps.systemPrompt;
  }

  /** GEMINI-FIRST quality mode — when true, every normal response is generated
   *  by Gemini (the deterministic latency shortcuts are demoted). Defaults to
   *  false so unit tests that construct AIService without guards keep the
   *  deterministic paths; production wires env.GEMINI_FIRST (default true). */
  private get geminiFirst(): boolean {
    return this.deps.guards?.geminiFirst ?? false;
  }

  /** DIRECT REPLY MODE — single Gemini call, no orchestrator. Default false
   *  (unit tests keep the orchestrator); production wires env.DIRECT_REPLY_MODE. */
  private get directReplyMode(): boolean {
    return this.deps.guards?.directReplyMode ?? false;
  }

  /** LEAN REPLY MODE — strips analytical background blocks from the reply prompt
   *  so Gemini stops "analyzing entries". Default false. */
  private get leanReplyMode(): boolean {
    return this.deps.guards?.leanReplyMode ?? false;
  }

  /** COMPACT REPLY MODE — tiny Nudge-style reply prompt (no heading/breakdown
   *  essays possible). Default false. */
  private get compactReplyMode(): boolean {
    return this.deps.guards?.compactReplyMode ?? false;
  }

  /** UNIFIED REPLY PATH — one grounded prompt (compact style + always-present
   *  grounding facts). Default false; consolidation flag. */
  private get unifiedReplyPath(): boolean {
    return this.deps.guards?.unifiedReplyPath ?? false;
  }

  private get progressiveProfile(): boolean {
    return this.deps.guards?.progressiveProfile ?? false;
  }

  /** The underlying LLM provider, exposed for adjacent flows (e.g. SMS
   *  onboarding question generation in the webhook) so they don't have to wire a
   *  separate provider. Read-only. */
  get llmProvider(): LLMProvider {
    return this.deps.llm;
  }

  /**
   * Let Gemini write the words (Nudge-style) for a deterministic intercept while
   * keeping the FACTS and a guaranteed floor: it rewrites `basis` (the
   * grounded template) in Grace's warm voice, and falls back to `fallback` if the
   * model times out, errors, comes back empty, drifts into AI-speak, or denies
   * having the data. All FACTS/numbers/offers in `basis` are preserved — the
   * model only changes the wording, never the data. The result still passes
   * through the outbound sanitizer/format-enforcer on send. Keeps every
   * intercept's short-circuit + side-effects intact (no downstream re-handling).
   */
  private async warmlyRephrase(basis: string, guide: string, fallback: string): Promise<string> {
    const clean = (basis ?? '').trim();
    if (!clean) return fallback;
    try {
      const resp = await Promise.race([
        this.deps.llm.generate({
          messages: [
            { role: 'system', content: buildRephraseSystem(clean, guide) },
            { role: 'user', content: '(rewrite it now)' },
          ],
          temperature: 0.7,
          maxOutputTokens: 500,
          disableThinking: true,
        }),
        new Promise<{ text: string }>((r) => setTimeout(() => r({ text: '' }), 4500)),
      ]);
      const text = (resp.text ?? '').trim().replace(/^["']|["']$/g, '');
      return isAcceptableRephrase(text) ? text : fallback;
    } catch {
      return fallback;
    }
  }

  updateSystemPrompt(prompt: string | undefined): void {
    this.systemPrompt = prompt;
    this.deps.logger.info({ hasPrompt: !!prompt }, 'system_prompt.updated');
  }

  /**
   * Exposed for the webhook layer to check the previous assistant message
   * before treating "yes" / "no" as RLHF feedback. See webhook.ts:182.
   */
  async getRecentTurnsForUser(userId: string, limit: number): Promise<ChatTurn[]> {
    return this.deps.memory.getRecentTurns(userId, limit).catch(() => [] as ChatTurn[]);
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

    // ── Hypoglycemia-warning cluster (2026-06-16) — deterministic + actionable.
    // "I'm shaky, sweaty, and lightheaded" (and its "what should I do?" follow-up)
    // must get a warm, ACTIONABLE, appropriately-hedged answer (quick sugar now +
    // call your doctor; "this could be low blood sugar"), NOT a passive "you might
    // be experiencing symptoms…" with no help — and it must NEVER "stick" with no
    // reply. Runs before the fast-path/orchestrator so it's guaranteed regardless
    // of Gemini's state. Cheap regex gate first; only reads history for the bare
    // "what should I do?" follow-up. SafetyGuard (988/911) already ran above.
    if (mightBeHypoSymptom(input.text) || isWhatShouldIDo(input.text)) {
      let lastGrace: string | undefined;
      let lastUser: string | undefined;
      if (isWhatShouldIDo(input.text)) {
        const recent = await this.deps.memory.getRecentTurns(input.userId, 4).catch(() => [] as ChatTurn[]);
        const rev = [...recent].reverse();
        lastGrace = rev.find((m) => m.role === 'assistant')?.content;
        lastUser = rev.find((m) => m.role === 'user')?.content;
      }
      const hypo = detectHypoglycemiaWarning(input.text, lastGrace, lastUser);
      if (hypo.warning) {
        const totalMs = Date.now() - t0;
        this.deps.logger.info(
          { userId: input.userId, followUp: !!hypo.followUp },
          'ai.hypoglycemia_warning.served',
        );
        this.persistLatency(input.userId, 'safety_hypoglycemia', totalMs, lat.snapshot(), input.text, hypo.response!);
        return {
          text: hypo.response!,
          confidence: 'high',
          intent: 'safety_hypoglycemia',
          toolResults: [],
          usedRetrieval: false,
          latencyMs: totalMs,
        };
      }
    }

    // ── Unsafe DIY-injectable / research-peptide guardrail — deterministic,
    // both flag states. Requests to reconstitute/mix a vial, do dosing/unit math,
    // stack compounds, or source/use research peptides get a warm refusal that
    // still offers the safe in-scope help (track what you take + how you feel +
    // questions for a clinician). Runs before the food/orchestrator paths so it
    // can NEVER be logged or answered by the LLM. Scoped so balanced-plate food
    // talk ("combine protein with carbs") and ordinary dose tracking pass through.
    {
      const peptide = detectPeptideSafety(input.text);
      if (peptide.flagged) {
        const totalMs = Date.now() - t0;
        this.deps.logger.info({ userId: input.userId, matched: peptide.matched }, 'ai.peptide_safety.served');
        this.persistLatency(input.userId, 'safety_peptide', totalMs, lat.snapshot(), input.text, peptide.response!);
        return {
          text: peptide.response!,
          confidence: 'high',
          intent: 'safety_peptide',
          toolResults: [],
          usedRetrieval: false,
          latencyMs: totalMs,
        };
      }
    }

    // ── Quick habit checklist (2026-07-05) — deterministic, both flag states.
    // The low-friction path for users who don't want to log every bite. A message
    // like "I hit protein and water today" or "done with movement" checks the
    // habits off; "I don't want to log food today" offers the checklist instead.
    // Runs before the food paths, but detectHabitCheck bails on anything naming a
    // food or reading as consumption, so it can never hijack a meal log. Cheap
    // regex first; only loads the user (for the local-day key) on a real hit.
    {
      const habitKeys = detectHabitCheck(input.text);
      if (habitKeys.length > 0) {
        const user = await this.deps.users.getByPhone(input.userId).catch(() => null);
        const day = computeUserLoggingDay(user?.timezone, user?.wake_time, new Date());
        await checkHabits(this.deps.pool, input.userId, habitKeys, day, 'chat').catch(() => undefined);
        const reply = buildHabitCheckReply(habitKeys);
        const totalMs = Date.now() - t0;
        this.deps.logger.info({ userId: input.userId, habits: habitKeys }, 'ai.habit_check.served');
        this.persistLatency(input.userId, 'habit_check', totalMs, lat.snapshot(), input.text, reply);
        return { text: reply, confidence: 'high', intent: 'habit_check', toolResults: [], usedRetrieval: false, latencyMs: totalMs };
      }
      if (detectSkipFoodLogging(input.text)) {
        const reply = buildSkipFoodOffer();
        const totalMs = Date.now() - t0;
        this.deps.logger.info({ userId: input.userId }, 'ai.habit_skip_food.served');
        this.persistLatency(input.userId, 'habit_skip_food', totalMs, lat.snapshot(), input.text, reply);
        return { text: reply, confidence: 'high', intent: 'habit_skip_food', toolResults: [], usedRetrieval: false, latencyMs: totalMs };
      }
    }

    // ── Reset today's food log (2026-07-04) — deterministic, both flag states.
    // "reset my food log", "clear today's food", "start over" → delete every
    // food_logs row in the user's current logging day and confirm they're back
    // to 0. Gives the user control when totals are wrong / accumulated (the
    // fix for a ballooned running total). Runs BEFORE the unified branch and
    // the food-logging paths so a reset is never misread as a food log. Scoped
    // so a single-item "remove the pizza" delete never wipes the whole day.
    if (detectFoodReset(input.text)) {
      try {
        const deleted = await this.deps.users.clearTodaysFood(input.userId);
        // Also clear any awaiting-portion items so a reset truly zeroes the day —
        // otherwise a stale pending sandwich/shake could resolve onto a later turn.
        await clearPendingFood(this.deps.redis, input.userId).catch(() => {});
        const reply = buildFoodResetReply(deleted);
        const totalMs = Date.now() - t0;
        this.deps.logger.info({ userId: input.userId, deleted }, 'ai.food_reset.served');
        this.persistLatency(input.userId, 'food_reset', totalMs, lat.snapshot(), input.text, reply);
        return { text: reply, confidence: 'high', intent: 'food_reset', toolResults: [], usedRetrieval: false, latencyMs: totalMs };
      } catch (err) {
        this.deps.logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'ai.food_reset.error');
        // Fall through rather than drop the turn.
      }
    }

    // ── UNIFIED (Nudge) PATH — ONE clean path, gated by UNIFIED_REPLY_PATH ──
    // Safety (crisis 988/911 + hypoglycemia) has run above and always stays. When
    // the flag is on, everything else — the fast-path, the ~20 intercepts, and the
    // 7 overlapping food layers — is BYPASSED in favour of a single clean path:
    // log every eaten food once (never ask, never drop), then ONE grounded Gemini
    // call with all the data + full history. Flag-off (default) keeps the entire
    // existing pipeline byte-identical, so production is untouched until you flip.
    if (this.unifiedReplyPath) {
      try {
        const result = await this.runUnifiedReply(input, t0, lat);
        // LEARN long-term memory from this turn — fire-and-forget AFTER the reply
        // is ready, so it adds zero user-facing latency. Without this the unified
        // path (which returns here) never reached the learning block at the tail
        // of handleMessageInner, so Grace remembered NOTHING new in prod.
        this.learnFromTurnAsync(input, result);
        return result;
      } catch (err) {
        this.deps.logger.error(
          { err: err instanceof Error ? err.message : String(err), userId: input.userId },
          'ai.unified_reply.error',
        );
        // Never drop the turn — fall through to the existing pipeline on any error.
      }
    }

    // Fast-path: pure greetings, brief positive feelings, thanks, brief acks
    // get a deterministic warm reply with zero LLM call — ~50-150ms total
    // instead of ~2-4s. Skipped when media is attached (photo/voice always
    // needs analysis). Tool results / RAG / memory are all skipped for these
    // turns because they don't add anything to a "Hi" → "Hey there" exchange.
    // Reconstruction hint hoisted so the orchestrator fallback path
    // (handleMessageInner) can also receive the standalone meaning.
    let reconHintForInner: string | undefined;
    // DIRECT REPLY MODE: instead of returning canned text, the early intercepts
    // (reminder / water / weekly-summary / meal-preference) compute the real
    // FACTS and stash them here; handleMessageInner injects them into the single
    // Gemini call so EVERY reply is generated by Gemini from the guidance, with
    // accurate data. (Crisis + hypoglycemia stay deterministic — safety floor.)
    let directContextNote = '';
    if (input.media.length === 0) {
      lat.mark('fast_path_lookup');
      // 2026-06-04 fix: when Grace's previous message ended with an OFFER
      // question ("want me to walk you through?", "should I add it?",
      // "want a few options?"), the user's "Yes" / "Sure" is a COMMITMENT
      // to that action, not a generic ack. Fast-path would return
      // "Glad that landed well." — wrong. Skip fast-path in this case
      // so the orchestrator can deliver the promised content.
      //
      // 2026-06-06 v3 latency optimization: the recent-turns DB read was
      // firing on EVERY inbound message (~150-180ms wasted on the ~95% of
      // turns where the message clearly isn't an affirmation). Only fetch
      // recent turns when the text shape actually matches an affirmation.
      const isAffirmation = /^(?:yes|yep|yeah|yup|sure|ok|okay|sounds good|sound good|sounds great|sounds nice|please do|please|alright|go ahead|do it|let'?s do it|yes please|absolutely|great|perfect|love it|nice)[!.?]?\s*$/i.test(input.text.trim());
      // Universal follow-up resolution: short, context-dependent replies
      // ("yes do it specific", "make it specific", "shorter", "no not that")
      // are refinements/confirmations/rejections of the PRIOR turn, not new
      // topics. Classified in isolation they landed in the generic fallback
      // ("I'm with you. What's on your mind?"). detectFollowUp labels them so
      // the active workflow can continue. Cheap regex — gates the recent-turns
      // DB read just like isAffirmation does.
      const followUp = detectFollowUp(input.text);
      let skipFastPathDueToOffer = false;
      if (isAffirmation || followUp) {
        const recentTurns = await this.deps.memory.getRecentTurns(input.userId, 4).catch(() => [] as ChatTurn[]);
        const lastAssistant = [...recentTurns].reverse().find((t) => t.role === 'assistant')?.content ?? '';
        // ── Doctor-questions workflow: confirm / refine / reject ─────────────
        // Covers BOTH sides of the flow: the offer ("Want me to turn this into
        // questions for your doctor?") AND the already-generated questions
        // ("…Want me to adjust these or add anything specific?"). A confirm or
        // refinement EXECUTES/refines the questions deterministically, grounded
        // in the user's data — so the affirmation can never be reinterpreted as
        // a request to expand on numbers in history (production drift
        // 2026-06-18: "Yes" → protein-target math; "Yes do it specific" →
        // generic "What's on your mind?"). Runs before the orchestrator.
        if (followUp && followUp.kind !== 'clarify' && isDoctorQuestionsContext(lastAssistant)) {
          if (followUp.kind === 'reject') {
            const reply = `No worries. Anything else you want to go over before your appointment?`;
            const totalMs = Date.now() - t0;
            this.persistLatency(input.userId, 'appointment_prep', totalMs, lat.snapshot(), input.text, reply);
            return { text: reply, confidence: 'high', intent: 'appointment_prep', toolResults: [], usedRetrieval: false, latencyMs: totalMs };
          }
          // confirm / refine / reference → (re)build the questions. Refining an
          // already-given set, or any "make it specific"/"more detail" request,
          // produces the fuller, more specific version.
          const detailed = isDoctorQuestionsReply(lastAssistant) || wantsMoreDetail(followUp);
          const user = await this.deps.users.getByPhone(input.userId).catch(() => null);
          const data = user ? await gatherWeeklySummary(this.deps.users, user).catch(() => null) : null;
          const grounded = buildDoctorQuestions(data, { detailed });
          const reply = await this.warmlyRephrase(
            grounded,
            'This is a short set of questions to bring to their doctor — keep each one specific and grounded in their real numbers, and keep the closing offer to adjust them.',
            grounded,
          );
          const totalMs = Date.now() - t0;
          this.deps.logger.info({ userId: input.userId, detailed, kind: followUp.kind, modifier: followUp.modifier }, 'ai.doctor_questions.served');
          this.persistLatency(input.userId, 'appointment_prep', totalMs, lat.snapshot(), input.text, reply);
          return {
            text: reply,
            confidence: 'high',
            intent: 'appointment_prep',
            toolResults: [],
            usedRetrieval: false,
            latencyMs: totalMs,
          };
        }
        // ── Reminder offer follow-up ─────────────────────────────────────────
        // Grace's prior turn answered "your next reminder is … Want a different
        // time?". A satisfied/decline reply to THAT ("No that good", "leave it",
        // "no thanks") means the user is HAPPY — warmly confirm we'll keep it,
        // don't restate the reminder line (prod: "No that good" → the exact same
        // time repeated). Guarded so an actual change ("no, make it 8am" / "no,
        // earlier") is left to the reminder/Settings path, not treated as "keep".
        if (
          followUp?.kind === 'reject' &&
          wasReminderOffer(lastAssistant) &&
          !detectReminderIntent(input.text) &&
          !/\d|earlier|later|\bchange\b|different|instead|\bmove\b/i.test(input.text)
        ) {
          const reply = buildReminderKeptReply();
          const totalMs = Date.now() - t0;
          this.deps.logger.info({ userId: input.userId }, 'ai.reminder_kept.served');
          this.persistLatency(input.userId, 'reminder', totalMs, lat.snapshot(), input.text, reply);
          return { text: reply, confidence: 'high', intent: 'reminder', toolResults: [], usedRetrieval: false, latencyMs: totalMs };
        }
        const lastWasOfferQuestion = /\?\s*$/.test(lastAssistant.trim()) &&
          /\b(want me to|would you (?:like|want)|should i|can i|may i|how about|do you want|interested in|let me know if you'?d like|let me know if you want|i can (?:walk you|show you|share|give|explain|break|go through|run through))\b/i.test(lastAssistant);
        // CRITICAL fix (2026-06-14 audit): an "okay" / "sounds good" / "yes"
        // right after a RECOMMENDATION must NOT get a canned "Got it 👍" — that
        // dead-ends the thread AND the canned ack then becomes a topic-closer
        // turn that strips the recommendation from history. Route to the
        // orchestrator so Grace can advance ("want the recipe, or other ideas?").
        const lastWasRecommendation = looksLikeRecommendation(lastAssistant);
        skipFastPathDueToOffer = lastWasOfferQuestion || lastWasRecommendation;
        if (skipFastPathDueToOffer) {
          this.deps.logger.info(
            { userId: input.userId, last: lastAssistant.slice(0, 80), text: input.text, reason: lastWasRecommendation ? 'recommendation' : 'offer' },
            'ai.fast_path.skipped_offer_followthrough',
          );
        }
        // Deterministic advance for an ack right after a recommendation: offer
        // the recipe or more ideas instead of the LLM's generic "Happy to help"
        // (observed in testing). Skip when the prior turn was an OFFER question
        // (those need the promised content, handled downstream). Gated on a
        // bare affirmation — a refinement follow-up ("make it vegetarian") must
        // reach the orchestrator to actually modify the recommendation.
        // GEMINI-FIRST: also demote this deterministic advance so Gemini phrases
        // the next step instead of a canned line.
        if (isAffirmation && lastWasRecommendation && !lastWasOfferQuestion && !this.geminiFirst) {
          const reply = buildRecommendationAckAdvance(`${input.userId}|${input.text}`);
          const totalMs = Date.now() - t0;
          this.deps.logger.info({ userId: input.userId, text: input.text }, 'ai.recommendation_ack.served');
          this.persistLatency(input.userId, 'recommendation_ack', totalMs, lat.snapshot(), input.text, reply);
          return {
            text: reply,
            confidence: 'high',
            intent: 'recommendation_ack',
            toolResults: [],
            usedRetrieval: false,
            latencyMs: totalMs,
          };
        }
      }
      // GEMINI-FIRST: the trivial fast-path ships a deterministic reply (no LLM)
      // for greetings / small talk / acks. Quality mode routes these to the
      // orchestrator so even "hey" gets a contextual, non-repetitive reply.
      const fast = (skipFastPathDueToOffer || this.geminiFirst) ? null : tryFastPath(input.text, input.userId);
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

      // ── Water intercept (2026-06-15) — isolated hydration tracker ─────────
      // Water has its OWN table; a water total query must NEVER return protein
      // (production bug), and a water log must actually persist (not a
      // fabricated "Logged."). Runs BEFORE the food/protein fast paths so
      // hydration can't be misrouted. Cheap gate first to avoid a DB read on
      // non-water messages; "1 cup of rice" is excluded (solid food present).
      {
        const wq = isWaterQuery(input.text);
        const maybeWater = wq
          || /\b(water|hydrate|hydration|h2o)\b/i.test(input.text)
          || (/\b(\d+(?:\.\d+)?|a|an|one|two|three|four|five|six|seven|eight|nine|ten|twelve)\s*(oz|ounces?|ml|cups?|glass(?:es)?|bottles?|l|liters?|litres?)\b/i.test(input.text)
              && !/\b(rice|oats?|oatmeal|yogurt|soup|cereal|pasta|beans|coffee|tea|juice|milk|soda|smoothie|shake|broth|wine|beer|protein)\b/i.test(input.text));
        if (maybeWater) {
          const recent = await this.deps.memory.getRecentTurns(input.userId, 2).catch(() => [] as ChatTurn[]);
          const lastAsst = [...recent].reverse().find((t) => t.role === 'assistant')?.content ?? '';
          // A message STATING an amount is a LOG, even if it also contains a
          // query-ish word ("I had 54 oz water already" — "already" must not
          // route it to the total query). So: LOG when an amount is present,
          // QUERY only when the user is asking (no amount stated).
          const oz = parseWaterOz(input.text);
          const isLog = isWaterLog(input.text, lastAsst);
          if (isLog && oz && oz > 0) {
            const res = await logWater(this.deps.pool, this.deps.logger, input.userId, oz, input.text);
            if (res) {
              if (this.directReplyMode) {
                directContextNote += `\n\n[WATER LOGGED — the user's water intake was just recorded. Acknowledge it warmly in your own voice using these facts: ${res.text}]`;
              } else {
                const totalMs = Date.now() - t0;
                this.persistLatency(input.userId, 'water_log', totalMs, lat.snapshot(), input.text, res.text);
                return { text: res.text, confidence: 'high', intent: 'water_log', toolResults: [], usedRetrieval: false, latencyMs: totalMs };
              }
            }
          }
          // QUERY (asking for the total) — never the protein renderer.
          if (wq && !directContextNote) {
            const totalOz = await getTodaysWaterOz(this.deps.pool, input.userId);
            if (totalOz !== null) {
              const text = renderWaterTotal(totalOz);
              if (this.directReplyMode) {
                directContextNote += `\n\n[WATER FACTS — the user is asking about their water intake. Answer warmly using ONLY this fact: ${text}]`;
                this.deps.logger.info({ userId: input.userId, totalOz }, 'ai.water_query.direct_context');
              } else {
                const totalMs = Date.now() - t0;
                this.persistLatency(input.userId, 'water_query', totalMs, lat.snapshot(), input.text, text);
                this.deps.logger.info({ userId: input.userId, totalOz }, 'ai.water_query.served');
                return { text, confidence: 'high', intent: 'water_query', toolResults: [], usedRetrieval: false, latencyMs: totalMs };
              }
            }
          }
          // Water LOG intent but no parseable amount → ask (no assumptions).
          if (isLog && !directContextNote) {
            const ask = `Got it. How much water, in oz or glasses? (a glass is about 8 oz, aiming for ${WATER_GOAL_MIN_OZ}-${WATER_GOAL_MAX_OZ} oz a day)`;
            if (this.directReplyMode) {
              directContextNote += `\n\n[WATER — the user mentioned water but gave no amount. Ask warmly how much (oz or glasses; a glass ≈ 8 oz, daily goal ${WATER_GOAL_MIN_OZ}-${WATER_GOAL_MAX_OZ} oz).]`;
            } else {
              const totalMs = Date.now() - t0;
              return { text: ask, confidence: 'high', intent: 'water_clarify', toolResults: [], usedRetrieval: false, latencyMs: totalMs };
            }
          }
        }
      }

      // ── Capability / identity question → deterministic Grace answer ──────
      // "What can you do?" / "Who are you?" must ALWAYS be answered as Grace, the
      // GLP-1 companion — short and SMS-friendly. Production failure: a generic
      // assistant answer shipped ("I can write code, explain quantum physics…").
      // Deterministic so it can never drift into a generic-LLM reply.
      if (detectCapabilityQuestion(input.text)) {
        const user = await this.deps.users.getByPhone(input.userId).catch(() => null);
        const reply = buildCapabilityReply(user?.first_name ?? null);
        const totalMs = Date.now() - t0;
        this.deps.logger.info({ userId: input.userId }, 'ai.capability_question.served');
        this.persistLatency(input.userId, 'capability', totalMs, lat.snapshot(), input.text, reply);
        return { text: reply, confidence: 'high', intent: 'capability', toolResults: [], usedRetrieval: false, latencyMs: totalMs };
      }

      // ── Personalization gather gate (2026-06-28) ─────────────────────────
      // Before any substantive answer (food, knowledge, emotional, general…),
      // make sure Grace has the data she needs to be SPECIFIC to THIS user — so
      // every reply feels like she knows them. Two outcomes:
      //   • {reply}: this question needs a missing detail → ask for it first
      //     (one warm question), stash the original question, short-circuit.
      //   • {text}: the user just answered a gather question → persist it and
      //     REPLAY the original question (now personalized) through the pipeline.
      // Relevance-only + throttled, so it never feels like a survey. Skipped
      // entirely during onboarding (the onboarding flow owns data collection).
      // NOTE: intentionally NOT gated on directReplyMode — the gate is reply-path
      // agnostic (ask-first returns a deterministic question; replay just
      // reassigns input.text), so it must work whether prod runs the direct or
      // the orchestrator path. (directReplyMode defaults false, which previously
      // disabled gathering in prod.)
      if (this.progressiveProfile) {
        const gate = await this.progressiveGatherGate(input).catch(() => ({} as { reply?: string; text?: string }));
        if (gate.reply) {
          const totalMs = Date.now() - t0;
          this.deps.logger.info({ userId: input.userId }, 'ai.progressive_gather.ask_first');
          this.persistLatency(input.userId, 'profile_gather', totalMs, lat.snapshot(), input.text, gate.reply);
          return { text: gate.reply, confidence: 'high', intent: 'profile_gather', toolResults: [], usedRetrieval: false, latencyMs: totalMs };
        }
        if (gate.text) {
          input = { ...input, text: gate.text };
        }
      }

      // ── Reminder questions → deterministic answer (2026-06-15) ───────────
      // "When is my next reminder?" / "Would you send a reminder tomorrow
      // morning?" / "Can you remind me at 3pm?" must be answered from the user's
      // ACTUAL reminder config — never the LLM, which (under conflicting prompt
      // rules) leaked capability denials ("I can't send reminders", "I don't
      // have the ability to initiate messages"). Grace is the INTERFACE to the
      // reminder system: she explains the schedule and redirects changes to
      // Settings; she never creates/edits/disables reminders in chat.
      {
        const reminderIntent = detectReminderIntent(input.text);
        if (reminderIntent) {
          try {
            const settingsUrl = 'https://graceglp.com/settings'; // rewritten to the deployment URL by TwilioSender
            let reply: string;
            if (reminderIntent === 'change') {
              reply = buildReminderChangeReply(settingsUrl);
            } else {
              const user = await this.deps.users.getByPhone(input.userId).catch(() => null);
              reply = reminderIntent === 'explain'
                ? buildReminderExplainReply(user ?? {}, settingsUrl)
                : buildNextReminderReply(user ?? {}, settingsUrl);
            }
            // The "next reminder" answer is a precise schedule FACT (a specific
            // day/time computed deterministically). Letting Gemini rephrase it
            // risks it mangling the day — observed in prod: a Saturday-night
            // "tomorrow morning" was reworded to "this coming Wednesday". So we
            // ALWAYS return the exact computed answer for 'next', even in
            // directReplyMode. 'explain'/'change' are general/redirect copy and
            // can still be warmly phrased by Gemini.
            if (this.directReplyMode && reminderIntent !== 'next') {
              // Hand the real reminder facts to Gemini; it phrases the reply.
              directContextNote += `\n\n[REMINDER FACTS — the user is asking about their reminders. Answer their question in your own warm voice using ONLY these facts; do NOT invent times, and NEVER say you can't send reminders (you do send them): ${reply}]`;
              this.deps.logger.info({ userId: input.userId, reminderIntent }, 'ai.reminder_query.direct_context');
              // fall through to the single Gemini call
            } else {
              const totalMs = Date.now() - t0;
              this.deps.logger.info({ userId: input.userId, reminderIntent }, 'ai.reminder_query.served');
              this.persistLatency(input.userId, `reminder_${reminderIntent}`, totalMs, lat.snapshot(), input.text, reply);
              return {
                text: reply,
                confidence: 'high',
                intent: `reminder_${reminderIntent}`,
                toolResults: [],
                usedRetrieval: false,
                latencyMs: totalMs,
              };
            }
          } catch (err) {
            this.deps.logger.warn(
              { err: err instanceof Error ? err.message : String(err) },
              'ai.reminder_query.error',
            );
            // Fall through to the normal pipeline rather than drop the turn.
          }
        }
      }

      // ── Trial length / billing timing → deterministic answer ──────────────
      // "How long is my trial?", "when does it end?", "how many days left?",
      // "when do I get charged?" — answered from trial_start + TRIAL_DAYS, never
      // an LLM guess. Fixes the prod churn where a user was told "7 days" but was
      // cut off at 3 (a broken promise, not a price objection). The trial length
      // is correctness-critical, so — like the "next reminder" fact — we ALWAYS
      // return the exact deterministic answer, even in directReplyMode.
      {
        const trialIntent = detectTrialQuestion(input.text);
        if (trialIntent) {
          try {
            const user = await this.deps.users.getByPhone(input.userId).catch(() => null);
            const reply = buildTrialReply(user ?? {}, trialIntent);
            const totalMs = Date.now() - t0;
            this.deps.logger.info({ userId: input.userId, trialIntent }, 'ai.trial_query.served');
            this.persistLatency(input.userId, `trial_${trialIntent}`, totalMs, lat.snapshot(), input.text, reply);
            return {
              text: reply,
              confidence: 'high',
              intent: `trial_${trialIntent}`,
              toolResults: [],
              usedRetrieval: false,
              latencyMs: totalMs,
            };
          } catch (err) {
            this.deps.logger.warn(
              { err: err instanceof Error ? err.message : String(err) },
              'ai.trial_query.error',
            );
            // Fall through to the normal pipeline rather than drop the turn.
          }
        }
      }

      // ── Injection / dose timing → deterministic answer (2026-07-03) ──────
      // "When is my next injection/dose/shot?", "when was my last shot?", "is
      // today my shot day?", "how many days until my dose?" — one deterministic,
      // cadence-aware answer from injection_day + medication, computed with the
      // user's real timezone. Fixes the prod failure where the SAME fact hit three
      // paths: a right answer ("in 4 days"), a wrong explanation (weight math), and
      // a flat denial ("I can't tell you when your next injection is"). Never
      // denies; if the day is unknown it ASKS. Placed alongside the reminder
      // intercept so all timing questions resolve deterministically.

      // ── GLP-1 start-date CAPTURE ────────────────────────────────────────
      // The user stating when they started ("I started Ozempic 6 weeks ago")
      // logs accurately to glp1_start_date. Deterministic parse (never stores an
      // implausible date). Runs before injection-timing so onset isn't misread.
      {
        const parsedStart = parseStartDateStatement(input.text, new Date());
        if (parsedStart) {
          try {
            const user = await this.deps.users.getByPhone(input.userId).catch(() => null);
            const medName = user?.medication && !isEncryptedBlob(user.medication) ? user.medication : null;
            await this.deps.users.update(input.userId, { glp1_start_date: parsedStart.date }).catch(() => {});
            const reply = buildStartDateCaptureReply(parsedStart.date, medName, new Date());
            const totalMs = Date.now() - t0;
            this.deps.logger.info({ userId: input.userId, iso: parsedStart.iso }, 'ai.start_date.captured');
            this.persistLatency(input.userId, 'start_date_capture', totalMs, lat.snapshot(), input.text, reply);
            return { text: reply, confidence: 'high', intent: 'start_date_capture', toolResults: [], usedRetrieval: false, latencyMs: totalMs };
          } catch (err) {
            this.deps.logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'ai.start_date_capture.error');
          }
        }
      }

      {
        const injIntent = detectInjectionTimingIntent(input.text);
        if (injIntent) {
          try {
            const user = await this.deps.users.getByPhone(input.userId).catch(() => null);
            const medName = user?.medication && !isEncryptedBlob(user.medication) ? user.medication : null;
            const sched = computeInjectionSchedule({
              medicationType: inferMedicationType(medName),
              medicationName: medName,
              injectionDay: user?.injection_day ?? null,
              timezone: user?.timezone ?? null,
            });
            const settingsUrl = 'https://graceglp.com/settings'; // rewritten by TwilioSender
            const reply = buildInjectionTimingReply(injIntent, sched, medName, settingsUrl);
            const totalMs = Date.now() - t0;
            this.deps.logger.info({ userId: input.userId, injIntent, knowsSchedule: sched.knowsSchedule }, 'ai.injection_timing.served');
            this.persistLatency(input.userId, `injection_${injIntent}`, totalMs, lat.snapshot(), input.text, reply);
            return { text: reply, confidence: 'high', intent: `injection_${injIntent}`, toolResults: [], usedRetrieval: false, latencyMs: totalMs };
          } catch (err) {
            this.deps.logger.warn(
              { err: err instanceof Error ? err.message : String(err) },
              'ai.injection_timing.error',
            );
            // Fall through to the normal pipeline rather than drop the turn.
          }
        }
      }

      // ── Dashboard link: "show me my progress / charts / the app" (2026-07-02)
      // Grace hands the user the link to their web dashboard (the real app behind
      // the messages). Deterministic so the link is always right and Grace never
      // implies there's no app. Short-circuits before the food/logging paths so a
      // "see my progress" request is never misread as a food log or summary.
      if (detectDashboardRequest(input.text)) {
        const reply = buildDashboardLinkReply(); // host rewritten by TwilioSender
        const totalMs = Date.now() - t0;
        this.deps.logger.info({ userId: input.userId }, 'ai.dashboard_link.served');
        this.persistLatency(input.userId, 'dashboard_link', totalMs, lat.snapshot(), input.text, reply);
        return { text: reply, confidence: 'high', intent: 'dashboard_link', toolResults: [], usedRetrieval: false, latencyMs: totalMs };
      }

      // ── Symptom intelligence: personal side-effect pattern memory (2026-07-01)
      // Grace's signature differentiator. When the user reports a GLP-1 side
      // effect, record it with how many days since their injection + the dose at
      // the time, and — if we've seen it before — inject a PERSONAL pattern note
      // so Gemini can recall "this usually hits you the day after your shot, and
      // ginger tea helped last time." When the user later says a remedy WORKED,
      // attribute it to their last open episode so the memory compounds. This is
      // the one thing a generic tracker or a 15-minute clinic visit structurally
      // can't do — and it's a switching-cost moat (you can't export what Grace
      // learned about YOUR body). Note-only + best-effort: never short-circuits
      // (safety handlers below stay in control) and never blocks a reply on error.
      if (input.text.trim()) {
        try {
          const symptom = classifySymptom(input.text);
          if (symptom) {
            const user = await this.deps.users.getByPhone(input.userId).catch(() => null);
            if (user) {
              const prior = await this.deps.users.getSymptomEpisodes(input.userId, symptom).catch(() => []);
              const pattern = analyzeSymptomPattern(symptom, prior);
              const dow = localDayOfWeek(user.timezone);
              const dsi = daysSinceInjection(user.injection_day, dow);
              // Record THIS episode BEFORE building the note so the pattern is
              // based on prior history only (this episode compounds next time).
              await this.deps.users.recordSymptomEpisode(input.userId, {
                symptom,
                days_since_injection: dsi,
                dose_mg: user.dose_mg ?? null,
              }).catch(() => {});
              const note = buildSymptomRecallNote(pattern);
              if (note) {
                directContextNote += note;
                this.deps.logger.info(
                  { userId: input.userId, symptom, priorCount: pattern?.count ?? 0 },
                  'ai.symptom_memory.recall',
                );
              }
            }
          } else {
            // Remedy outcome ("the ginger tea helped") → attribute a NAMED remedy
            // to the user's most recent still-open episode, so next time Grace
            // knows what settled it. Only record a concrete remedy (never "that"),
            // so topRemedy stays meaningful.
            const outcome = detectRemedyOutcome(input.text);
            if (outcome?.remedy) {
              const recent = await this.deps.users.getRecentSymptomEpisodes(input.userId, 20).catch(() => []);
              const open = recent.find((e) => e.remedy_helped == null);
              if (open) {
                await this.deps.users.setLastEpisodeRemedy(input.userId, open.symptom, outcome.remedy).catch(() => {});
                this.deps.logger.info(
                  { userId: input.userId, symptom: open.symptom, remedy: outcome.remedy },
                  'ai.symptom_memory.remedy_attributed',
                );
              }
            }
          }
        } catch (err) {
          this.deps.logger.warn(
            { err: err instanceof Error ? err.message : String(err) },
            'ai.symptom_memory.error',
          );
        }
      }

      // ── Weekly / recent-history summary → grounded in REAL data (2026-06-18)
      // "Give me a summary of how my last week was" / "recap my week for my
      // doctor" / "add all the data you have to make it comprehensive" must be
      // answered from the user's ACTUAL last-7-days logs — NOT a single-day
      // "you've had 12g of protein today" answer, and NEVER the generic
      // "Tell me more whenever you're ready" fallback (which misread an
      // instruction-to-compile-data as the user offering more). Runs BEFORE the
      // food-logging paths so the food words in a recap request can't be logged.
      // Cheap regex pre-gate first; only reads history to confirm weak
      // continuation phrases ("more detail", "expand on that").
      if (mightBeSummaryRequest(input.text)) {
        let recentContext: string | undefined;
        // Only pay for a history read when the phrasing is a weak continuation
        // that needs an active summary/appointment context to qualify.
        if (!detectSummaryRequest(input.text)) {
          const recent = await this.deps.memory.getRecentTurns(input.userId, 6).catch(() => [] as ChatTurn[]);
          recentContext = recent.map((m) => m.content).join(' • ');
        }
        if (detectSummaryRequest(input.text, recentContext)) {
          try {
            const user = await this.deps.users.getByPhone(input.userId).catch(() => null);
            if (user) {
              const data = await gatherWeeklySummary(this.deps.users, user);
              // The outbound pipeline caps EVERY message at ~420 chars (the sender
              // re-runs the length enforcer), so a long "Hi Doctor" letter gets
              // guillotined mid-sentence and only a preamble ships (prod screenshot).
              // So: build the CONCISE, complete, enforcer-safe summary
              // deterministically (it already covers every data point and fits the
              // cap), then let Gemini warm the WORDING — same facts, same length —
              // so it reads natural but always DELIVERS in full. Falls back to the
              // grounded text on any LLM failure/denial (never-deny preserved).
              const grounded = renderWeeklySummary(data);
              const warmed = await this.warmlyRephrase(
                grounded,
                "This is a recap of the user's week to share with their doctor. Keep it CONCISE — about the same length, a few short sentences that must stay well under 400 characters so it's never cut off. Do NOT open with a preamble ('Okay, here's...'), a title/header, or a 'Hi Doctor' letter format — just give the recap directly in warm prose. Keep the closing offer to turn it into questions for the doctor.",
                grounded,
              );
              // Never let a long rephrase get guillotined by the sender's ~420-char
              // cap — if Gemini ran long, ship the concise grounded summary instead.
              const reply = warmed.length > 415 ? grounded : warmed;
              const totalMs = Date.now() - t0;
              this.deps.logger.info(
                { userId: input.userId, daysLogged: data.daysLogged, hasWeight: data.weightLatest != null, direct: this.directReplyMode },
                'ai.weekly_summary.served',
              );
              this.persistLatency(input.userId, 'weekly_summary', totalMs, lat.snapshot(), input.text, reply);
              return {
                text: reply,
                confidence: 'high',
                intent: 'weekly_summary',
                toolResults: [],
                usedRetrieval: false,
                latencyMs: totalMs,
              };
            }
          } catch (err) {
            this.deps.logger.warn(
              { err: err instanceof Error ? err.message : String(err) },
              'ai.weekly_summary.error',
            );
            // Fall through to the normal pipeline rather than drop the turn.
          }
        }
      }

      // ── Meal lifecycle: preference ≠ consumption (2026-06-15) ────────────
      // "Halloumi and roasted vegetable plate sounds good" / "maybe the dal" /
      // "I'll have the omelet" express INTEREST, not eating. They must NEVER
      // update protein/calorie totals. Only an explicit consumption signal
      // ("I ate / had it", "log it", "ended up having it") logs. Runs BEFORE
      // every logging path so preference language can't reach the fast-log,
      // the force-log, or the orchestrator's log_food tool.
      {
        const mealState = detectMealConsumption(input.text);
        const wordCount = input.text.trim().split(/\s+/).filter(Boolean).length;
        if (mealState === 'preference' && !input.text.includes('?') && wordCount <= 12) {
          // Only treat preference language as a MEAL preference when there's
          // real food context: the message names a food ("the omelet sounds
          // good"), OR Grace's last turn was a food recommendation. Without
          // this, a bare "that sounds good" / "that works" reply to a non-food
          // offer ("want me to walk you through the numbers?") would be hijacked.
          let mealContext = mentionsFood(input.text);
          if (!mealContext) {
            const recent = await this.deps.memory.getRecentTurns(input.userId, 4).catch(() => [] as ChatTurn[]);
            const lastAsst = [...recent].reverse().find((t) => t.role === 'assistant')?.content ?? '';
            mealContext = looksLikeRecommendation(lastAsst) && mentionsFood(lastAsst);
          }
          if (mealContext) {
            if (this.directReplyMode) {
              // INTEREST, not consumption — tell Gemini to acknowledge warmly
              // and NOT log it (runDirectReply only auto-logs a food_log intent,
              // so this stays unlogged). Offer to log once they've eaten it.
              directContextNote += `\n\n[MEAL INTEREST — the user is expressing interest in a meal ("${input.text.slice(0, 80)}"), NOT saying they ate it. Do NOT log it or add to their totals. Acknowledge warmly, maybe note it's a solid pick, and let them know you'll log it once they've actually had it.]`;
              void setActiveMeal(this.deps.redis, input.userId, input.text).catch(() => {});
              this.deps.logger.info({ userId: input.userId, text: input.text.slice(0, 80) }, 'ai.meal_suggested.direct_context');
            } else {
              try {
                const grounded = await this.buildMealSuggestionReply(input.userId, input.text);
                const reply = await this.warmlyRephrase(
                  grounded,
                  "The user is INTERESTED in a meal but has NOT eaten it yet — keep it a brief, warm acknowledgement, do NOT say it's logged or add any macros, and keep the offer to log it once they've had it.",
                  grounded,
                );
                const totalMs = Date.now() - t0;
                this.deps.logger.info({ userId: input.userId, text: input.text.slice(0, 80) }, 'ai.meal_suggested.served');
                this.persistLatency(input.userId, 'meal_suggested', totalMs, lat.snapshot(), input.text, reply);
                return {
                  text: reply,
                  confidence: 'high',
                  intent: 'meal_suggested',
                  toolResults: [],
                  usedRetrieval: false,
                  latencyMs: totalMs,
                };
              } catch (err) {
                this.deps.logger.warn(
                  { err: err instanceof Error ? err.message : String(err) },
                  'ai.meal_suggested.error',
                );
                // Fall through — better to answer than to drop the turn.
              }
            }
          }
        }
        // CONSUMPTION FEEDBACK (the 4th lifecycle signal): the user is reporting
        // how a prior suggestion went ("Thanks I feel good after drinking the
        // smoothie", "the omelet was great", "that worked", "the one you
        // suggested"). This is a FOLLOW-UP — NOT a new recommendation request.
        // Runs BEFORE classify/the recommendation path so Grace never restarts
        // the flow or re-asks preferences. Acknowledge + OFFER to log (never
        // force, never assume macros). Gated on real food context: a food named
        // in the message OR Grace's last turn was a food recommendation — so a
        // bare "that worked" to a non-food offer isn't hijacked. A bare
        // consumption back-reference ("I had it") is left to the 'consumed'
        // branch below, which logs the known stored meal.
        if (
          mealState !== 'consumed' &&
          detectConsumptionFeedback(input.text) &&
          !input.text.includes('?') &&
          wordCount <= 18
        ) {
          let mealContext = mentionsFood(input.text);
          let lastRecFood = '';
          if (!mealContext) {
            const recent = await this.deps.memory.getRecentTurns(input.userId, 4).catch(() => [] as ChatTurn[]);
            const lastAsst = [...recent].reverse().find((t) => t.role === 'assistant')?.content ?? '';
            if (looksLikeRecommendation(lastAsst) && mentionsFood(lastAsst)) {
              mealContext = true;
              lastRecFood = lastAsst;
            }
          }
          if (mealContext) {
            const named =
              extractFoodMention(input.text) ??
              (await getActiveMeal(this.deps.redis, input.userId).catch(() => null))?.meal ??
              (lastRecFood ? extractFoodMention(lastRecFood) : null);
            // Keep the dish as the active meal so a later "log it" / "I had it"
            // resolves it. extractAndStore (post-turn) remembers that it sat well.
            if (named) void setActiveMeal(this.deps.redis, input.userId, named, this.deps.logger).catch(() => {});
            const grounded = buildConsumptionFeedbackReply(named);
            const reply = await this.warmlyRephrase(
              grounded,
              "The user is giving feedback on a meal they tried — acknowledge it warmly and connect to it, keep the OFFER to log it (never assume macros or say it's already logged), and don't restart any recommendation or re-ask their preferences.",
              grounded,
            );
            const totalMs = Date.now() - t0;
            this.deps.logger.info(
              { userId: input.userId, text: input.text.slice(0, 80), named: named ?? null },
              'ai.consumption_feedback.served',
            );
            this.persistLatency(input.userId, 'consumption_feedback', totalMs, lat.snapshot(), input.text, reply);
            return {
              text: reply,
              confidence: 'high',
              intent: 'consumption_feedback',
              toolResults: [],
              usedRetrieval: false,
              latencyMs: totalMs,
            };
          }
        }
        // Consumption confirmed. If it's a bare back-reference ("I ended up
        // making it", "had it") with no named food, resolve the meal from the
        // stored active recommendation and log THAT, so the user needn't repeat
        // the dish. A consumption message that DOES name the food falls through
        // to the normal food-log paths (and we clear the stale suggestion).
        if (mealState === 'consumed') {
          const resolved = await this.tryLogStoredMeal(input.userId, input.text, t0, lat).catch(() => null);
          if (resolved) return resolved;
          void clearActiveMeal(this.deps.redis, input.userId).catch(() => {});
        }
      }

      // Food-log fast-response: when the message is a clear food log AND the
      // fast-lookup table can resolve the macros, skip the orchestrator entirely
      // and respond with a deterministic template. ~2-4s → ~150ms.
      lat.mark('classify');
      const intentClass = classifyIntent(input.text);
      // GEMINI-FIRST: the food-log fast template ships the generic
      // "Logged X, ~22g. Total: …" without an LLM. Quality mode skips it so
      // Gemini phrases a natural, context-aware confirmation — the log itself
      // still happens via the orchestrator's log_food tool.
      if (intentClass.type === 'food_log' && !this.geminiFirst) {
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
      // GEMINI-FIRST: skip the template so Gemini phrases the confirmation
      // (e.g. acknowledges the trend) — log_weight still persists downstream.
      if (intentClass.type === 'weight_log' && !this.geminiFirst) {
        try {
          lat.mark('weight_log_fast');
          const wlf = await tryWeightLogFastResponse(input.text, {
            pool: this.deps.pool,
            logger: this.deps.logger,
            userId: input.userId,
            intentType: intentClass.type,
          });
          if (wlf) {
            // Remember the weight in the PROFILE, not just weight_logs — syncs
            // current_weight, invalidates the cache, and fills a personalized
            // target if we didn't have one (best-effort, fire-and-forget).
            void this.deps.users.syncCurrentWeight(input.userId, wlf.weightLbs).catch(() => undefined);
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

      // ── Personal-stats fast answer (compound-tolerant) ──────────────────
      // Catches "what's my target? how much I had?" and similar personal
      // questions the anchored query-fast skips. Deterministic DB read, zero
      // LLM — immune to Gemini outages. High-precision, returns null otherwise.
      {
        try {
          lat.mark('personal_stats');
          const psRaw = await this.tryPersonalStats(input);
          if (psRaw) {
            const ps = await this.warmlyRephrase(
              psRaw,
              'This is the answer to a question about their own numbers (protein, calories, target, weight). Keep every number EXACTLY as given — these are their real totals — just say it warmly and naturally.',
              psRaw,
            );
            const stageTimings = lat.snapshot();
            const totalMs = Date.now() - t0;
            this.deps.logger.info(
              { userId: input.userId, latencyMs: totalMs, stageTimings, intent: 'personal_stats' },
              'ai.personal_stats.served',
            );
            this.persistLatency(input.userId, 'personal_stats', totalMs, stageTimings, input.text, ps);
            return {
              text: ps,
              confidence: 'high',
              intent: 'personal_stats',
              toolResults: [],
              usedRetrieval: false,
              latencyMs: totalMs,
            };
          }
        } catch (err) {
          this.deps.logger.warn(
            { err: err instanceof Error ? err.message : String(err) },
            'ai.personal_stats.error',
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
      // ── Follow-up reconstruction (2026-06-11) ───────────────────────────
      // A short context-dependent fragment ("on glp?", "why 12?") is
      // meaningless alone. Merge it with the prior turn deterministically so
      // routing classifies the FULL meaning and Gemini gets the standalone
      // question. Only fetch turns when the message is a short fragment.
      const fragText = input.text.trim();
      const fragmentCandidate = fragText.length <= 40 && fragText.split(/\s+/).filter(Boolean).length <= 7;
      let fragmentTurns: ChatTurn[] = [];
      if (fragmentCandidate) {
        fragmentTurns = await this.deps.memory.getRecentTurns(input.userId, 4).catch(() => [] as ChatTurn[]);
      }
      const reversedFrag = [...fragmentTurns].reverse();
      const prevUserMsg = reversedFrag.find((t) => t.role === 'user')?.content ?? null;
      const lastAsstMsg = reversedFrag.find((t) => t.role === 'assistant')?.content ?? null;
      const recon = reconstructFollowUp(input.text, { previousUserMessage: prevUserMsg, lastAssistantMessage: lastAsstMsg });
      if (recon.isFollowUp) {
        this.deps.logger.info(
          { userId: input.userId, kind: recon.kind, reconstructed: recon.reconstructed.slice(0, 120) },
          'ai.reconstruct.applied',
        );
      }
      // Route continuations on the merged question; reasoning keeps its own
      // routing (the walkthrough/followup logic below) but supplies the hint.
      const routingText = recon.kind === 'continuation' ? recon.reconstructed : input.text;
      const reconHint = recon.isFollowUp ? recon.reconstructed : undefined;
      reconHintForInner = reconHint;

      const earlyIntent = classifyIntent(routingText);
      let directIntent = earlyIntent.type;

      // Gemini semantic-intent fallback (2026-06-15): when the deterministic
      // classifier can't place the message (lands on 'general'), ask Gemini to
      // read the MEANING and route by intent instead of exact words. This is
      // where unusual phrasings fail ("What I should do for dinner" → symptom
      // blurb). Only runs for 'general' (clear messages keep the ~150ms path),
      // skips trivial fragments, and fails safe (keeps 'general' on any error).
      if (
        directIntent === 'general' &&
        this.deps.flags.toolsEnabled &&
        input.media.length === 0 &&
        routingText.trim().split(/\s+/).filter(Boolean).length >= 2 &&
        routingText.trim().length <= 200
      ) {
        try {
          lat.mark('intent_llm');
          const recent = await this.deps.memory.getRecentTurns(input.userId, 2).catch(() => [] as ChatTurn[]);
          const lastAsst = [...recent].reverse().find((t) => t.role === 'assistant')?.content;
          const llmIntent = await classifyIntentLLM(this.deps.llm, this.deps.logger, routingText, lastAsst);
          if (llmIntent?.mappedType && llmIntent.confidence >= 0.6) {
            this.deps.logger.info(
              { userId: input.userId, from: 'general', to: llmIntent.mappedType, primary: llmIntent.primary_intent },
              'ai.intent_llm.reroute',
            );
            directIntent = llmIntent.mappedType as typeof directIntent;
          }
        } catch { /* keep 'general' */ }
      }

      // MULTI-TOPIC GUARD (2026-07-02): when the message bundles ≥2 meaningful
      // parts (e.g. "I feel good after the meal. What should I make Friday
      // night?" = an emotional note + a food-idea request), a SINGLE-intent
      // direct path (food_question / emotional / knowledge) would answer only
      // ONE part and drop the rest. Route these through the full direct-reply
      // path instead, where buildMultiPartNote forces Gemini to address EVERY
      // part accurately. Cheap pure regex; media/audio handled downstream.
      const isMultiTopic =
        input.media.length === 0 && analyzeMessage(input.text).hasMultiple;

      // 2026-06-06 production failure: user "Yes" after Grace asked "want
      // me to walk you through the numbers?" → got "Tell me a bit more?".
      // "Yes" classifies as 'general' so it doesn't hit any direct path,
      // and the orchestrator without history doesn't know what "Yes"
      // refers to. Route short follow-ups (yes/why/more/no/sure/please)
      // through knowledge_direct which has the followUpContext injection
      // that uses the previous Grace message.
      const trimmedLower = input.text.trim().toLowerCase();
      const isShortFollowUp = trimmedLower.length <= 25 &&
        /^(?:yes|yep|yeah|yup|sure|ok|okay|please|please do|go ahead|do it|alright|absolutely|no|nope|why|why\??|how come|how so|more|more please|tell me more|continue|go on|really\??|what do you mean|like what)$/i.test(trimmedLower);
      // 2026-06-07 latency optimization (Phase A3): the recent-turns DB read
      // here was firing on EVERY inbound message (~150ms wasted on the ~95%
      // of turns where the message isn't a short follow-up). Only fetch
      // recent turns when the shape gate (isShortFollowUp) actually matches.
      // When isShortFollowUp is false, none of the downstream branches
      // (shouldWalkthrough, isAffirmative+offer, isCuriosityFollowUp) can
      // fire, so the followupTurns result would have been unused.
      let followupLastAssistant = '';
      let lastLower = '';
      let prevStatedNumericTarget = false;
      let isAffirmative = false;
      let isCuriosityFollowUp = false;
      let offeredWalkthrough = false;
      let shouldWalkthrough = false;
      if (isShortFollowUp) {
        // Reuse the turns already fetched for reconstruction when available;
        // only hit the DB again if this short follow-up slipped the gate.
        const followupTurns = fragmentTurns.length > 0
          ? fragmentTurns
          : await this.deps.memory.getRecentTurns(input.userId, 2).catch(() => [] as ChatTurn[]);
        followupLastAssistant = [...followupTurns].reverse().find((t) => t.role === 'assistant')?.content ?? '';
        // 2026-06-06 v2 production failure: "What's my protein goal?" →
        // "Your daily protein target is 60g." (ends with '.', not '?') →
        // user "why" → previously skipped this whole block, fell through to
        // orchestrator → generic muscle/satiety paragraph. Now we ALSO fire
        // on curiosity follow-ups ("why" / "how come" / "where did that
        // come from" / "explain") when the previous Grace message stated a
        // numeric target — even when it ended with '.'.
        lastLower = followupLastAssistant.toLowerCase();
        prevStatedNumericTarget = /\b\d+\s*g\b|\b\d+\s*kcal\b/.test(followupLastAssistant);
        isAffirmative = /^(?:yes|yep|yeah|yup|sure|ok|okay|please|please do|go ahead|do it|alright|absolutely)$/i.test(trimmedLower);
        isCuriosityFollowUp = /^(?:why|why\??|how(?:\s+come|\s+so)?|how\s+is\s+that\s+(?:calculated|computed|figured)|how\s+was\s+that\s+(?:calculated|computed|figured)|how\s+did\s+you\s+(?:get|figure|calculate|compute)\s+that|where(?:\s+did\s+that|\s+does\s+it|\s+does\s+that|'?s\s+that)\s+(?:come\s+)?from|explain\s+that|explain|tell\s+me\s+more|how\s+do\s+you\s+know)\s*\??$/i.test(trimmedLower);
        offeredWalkthrough = /\b(walk you through|walk through (?:the|that)|break it down|break that down|break the (?:numbers?|math|math down)|show you the math|show the math|run you through|run the (?:numbers?|math)|do the math|want me to (?:explain|show|calculate))\b/.test(lastLower);
        shouldWalkthrough =
          (isAffirmative && (offeredWalkthrough || prevStatedNumericTarget)) ||
          (isCuriosityFollowUp && prevStatedNumericTarget);
      }
      if (isShortFollowUp && (shouldWalkthrough || /\?\s*$/.test(followupLastAssistant.trim()))) {
        // Deterministic walkthrough only fires when (a) the user signaled
        // they want the math AND (b) the previous Grace turn anchored on
        // a target number. Otherwise we fall through to runDirectPath
        // (knowledge_direct) for the LLM-handled follow-up.
        if (shouldWalkthrough) {
          const u = await this.deps.users.getById(input.userId).catch(() => null);
          const walkthrough = buildProteinTargetWalkthrough(u);
          if (walkthrough) {
            lat.mark('followup_walkthrough');
            const totalMs = Date.now() - t0;
            const stageTimings = lat.snapshot();
            this.deps.logger.info(
              { userId: input.userId, latencyMs: totalMs, stageTimings, intent: 'followup_walkthrough' },
              'ai.followup_walkthrough.served',
            );
            this.persistLatency(input.userId, 'followup_walkthrough', totalMs, stageTimings, input.text, walkthrough);
            return {
              text: walkthrough,
              confidence: 'high',
              intent: 'followup_walkthrough',
              toolResults: [],
              usedRetrieval: false,
              latencyMs: totalMs,
            };
          }
        }
        try {
          lat.mark('followup_direct');
          const direct = await this.runDirectPath('knowledge', input.text, input.userId, reconHint);
          if (direct) {
            const stageTimings = lat.snapshot();
            const totalMs = Date.now() - t0;
            this.deps.logger.info(
              { userId: input.userId, latencyMs: totalMs, stageTimings, intent: 'followup_direct' },
              'ai.followup_direct.served',
            );
            this.persistLatency(input.userId, 'followup_direct', totalMs, stageTimings, input.text, direct);
            return {
              text: direct,
              confidence: 'high',
              intent: 'followup_direct',
              toolResults: [],
              usedRetrieval: false,
              latencyMs: totalMs,
            };
          }
        } catch (err) {
          this.deps.logger.warn(
            { err: err instanceof Error ? err.message : String(err) },
            'ai.followup_direct.error',
          );
        }
      }

      // ── Recommendation follow-up (2026-06-14 audit fix) ──────────────────
      // "recipe?" / "how do I make it?" / "any other ideas?" / "how much
      // protein was in that?" / "the first one" all depend on a PRIOR
      // recommendation. Route them through knowledge_direct — which injects the
      // user's dietary restriction + dislikes AND runs a post-gen forbidden-food
      // filter — with the earlier recommendation re-injected, so the thread
      // EVOLVES with full context (recipe, alternatives, macros) instead of
      // restarting or listing generic foods. Fires only when a prior
      // recommendation actually exists in recent history (extended 16-turn
      // window so it survives the "10 messages later" case).
      if (isRecommendationFollowUp(input.text)) {
        try {
          const recTurns = await this.deps.memory.getRecentTurns(input.userId, 16).catch(() => [] as ChatTurn[]);
          const lastRec = extractLastRecommendation(recTurns);
          if (lastRec) {
            const mode = isRecipeRequest(input.text)
              ? 'They want a recipe: give simple ingredients and 3-5 short steps for that dish.'
              : 'If they want other ideas, suggest DIFFERENT options than before (never repeat the same ones). If they ask about portions, protein, or calories, answer for that specific food.';
            const enriched = `${input.text}\n\n[CONTEXT — earlier you recommended: "${lastRec.slice(0, 300)}". The user is following up on THAT. ${mode} Keep every suggestion within their dietary preferences and dislikes. Stay on this food; do not switch topics.]`;
            lat.mark('recommendation_followup');
            const direct = await this.runDirectPath('knowledge', enriched, input.userId, reconHint);
            if (direct) {
              const stageTimings = lat.snapshot();
              const totalMs = Date.now() - t0;
              this.deps.logger.info(
                { userId: input.userId, latencyMs: totalMs, recipe: isRecipeRequest(input.text) },
                'ai.recommendation_followup.served',
              );
              this.persistLatency(input.userId, 'recommendation_followup', totalMs, stageTimings, input.text, direct);
              return {
                text: direct,
                confidence: 'high',
                intent: 'recommendation_followup',
                toolResults: [],
                usedRetrieval: true,
                latencyMs: totalMs,
              };
            }
          }
        } catch (err) {
          this.deps.logger.warn(
            { err: err instanceof Error ? err.message : String(err) },
            'ai.recommendation_followup.error',
          );
        }
      }

      // Meal selection ("lentil dal sounds good" / "I'll go with the omelet")
      // is handled by the meal-lifecycle preference guard earlier in this
      // method — it never reaches here (it short-circuits with a non-logging
      // "meal_suggested" reply). See detectMealConsumption() above.

      // 2026-06-05 production failure: "what should I eat for breakfast
      // tomorrow?" → orchestrator → Gemini refused with AI disclaimer
      // "I cannot provide personalized dietary advice." Route food_question
      // through a dedicated path that hits the curated meal idea bank
      // FIRST (deterministic, no LLM), falls back to a focused Gemini
      // call only when curated returns nothing.
      if (directIntent === 'food_question' && !isMultiTopic) {
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
        !isMultiTopic && (
          directIntent === 'knowledge' ||
          directIntent === 'emotional' ||
          directIntent === 'appointment_prep' ||
          directIntent === 'medication_question' ||
          directIntent === 'social_situation'
        );
      if (wantsDirect) {
        try {
          const stage = `${directIntent}_direct`;
          lat.mark(stage);
          const direct = await this.runDirectPath(directIntent, input.text, input.userId, reconHint);
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

        // 2026-06-05 v4 architectural fix: when knowledge_direct fails
        // and we have a topic-aware fallback ready, ship the fallback
        // IMMEDIATELY instead of running the orchestrator. Production
        // data showed knowledge_direct hit rate at 33%; when it fails,
        // the orchestrator path adds 15-40 seconds. For known topics
        // (water, alcohol, muscle, protein, sleep, coffee, exercise,
        // hair loss, side effects, plateau) the fallback IS the best
        // answer Grace can ship.
        if (directIntent === 'knowledge') {
          // Use the reconstructed question ("on glp?" → "is hair loss common
          // on glp?") so the topic fallback matches the real subject even when
          // Gemini is unavailable.
          const topicFallback = pickKnowledgeTopicFallback(routingText);
          if (topicFallback) {
            const stageTimings = lat.snapshot();
            const totalMs = Date.now() - t0;
            this.deps.logger.info(
              { userId: input.userId, latencyMs: totalMs, stageTimings, intent: 'knowledge_topic_fallback' },
              'ai.knowledge_topic_fallback.served',
            );
            this.persistLatency(input.userId, 'knowledge_topic_fallback', totalMs, stageTimings, input.text, topicFallback);
            return {
              text: topicFallback,
              confidence: 'medium',
              intent: 'knowledge_topic_fallback',
              toolResults: [],
              usedRetrieval: false,
              latencyMs: totalMs,
            };
          }
        }

        // 2026-06-06 v4 — production latency audit:
        // emotional / social_situation / appointment_prep direct paths were
        // falling through to the orchestrator at high rates (Gemini emits
        // a one-line ack → content guard rejects → runDirectPath returns
        // null). The orchestrator then ran the full pipeline (3-5s of
        // generate + guards + regen) and shipped the typed fallback
        // ANYWAY because regen also produced a flagged response.
        //
        // The TYPED_FALLBACKS for these intents are the rich 4-step
        // framework replies shipped in d3998fa — they're the SAME shape
        // the orchestrator usually ends up at. Skip the 3-5s detour.
        //
        // Knowledge / medication_question are intentionally excluded —
        // they CAN benefit from the orchestrator's KB retrieval + critic
        // grounding pass on factual content.
        if (
          directIntent === 'emotional' ||
          directIntent === 'social_situation' ||
          directIntent === 'appointment_prep'
        ) {
          const { getToolAwareFallback } = await import('@grace/ai-core');
          // dietaryRestriction + foodDislikes are not yet computed at this
          // point in the flow (they're built later in handleMessageInner).
          // The Level 2 ladder + dead-end-aware typed fallbacks don't need
          // them — they only care about userMessage.
          const fallback = getToolAwareFallback(
            directIntent === 'social_situation' ? 'social_situation' :
            directIntent === 'appointment_prep' ? 'appointment_prep' : 'emotional',
            [],
            { userMessage: input.text },
          );
          const stageTimings = lat.snapshot();
          const totalMs = Date.now() - t0;
          const stageName = `${directIntent}_typed_fallback`;
          this.deps.logger.info(
            { userId: input.userId, latencyMs: totalMs, stageTimings, intent: stageName },
            'ai.direct_path.typed_fallback',
          );
          this.persistLatency(input.userId, stageName, totalMs, stageTimings, input.text, fallback);
          return {
            text: fallback,
            confidence: 'medium',
            intent: stageName,
            toolResults: [],
            usedRetrieval: false,
            latencyMs: totalMs,
          };
        }
      }
    }

    // Progressive profiling — gather the rest of the profile "along the way".
    // (1) persist an answer to a question we asked last turn, (2) maybe weave ONE
    // gentle question into this reply. Best-effort; never blocks the reply.
    if (this.progressiveProfile && this.directReplyMode) {
      try {
        directContextNote = await this.applyProgressiveProfiling(input, directContextNote);
      } catch (err) {
        this.deps.logger.warn({ err: (err as Error).message, userId: input.userId }, 'progressive_profile.error');
      }
    }

    try {
      return await this.handleMessageInner(input, t0, lat, reconHintForInner, directContextNote || undefined);
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
          // the user via the emergency path. If anything trips, ship the
          // deterministic resilient fallback (intent-aware) instead of the
          // raw LLM output. DB rules included — dose-safety block rules
          // exist only in the DB.
          const emergencyDbRules = await this.getDbRules();
          const violations = checkContent(rawEmergency, emergencyDbRules.length > 0 ? { dbRules: emergencyDbRules } : {});
          if (!violations.some((v) => v.severity !== 'log')) {
            return {
              text: rawEmergency,
              confidence: 'low' as const,
              intent: 'emergency_fallback',
              toolResults: [],
              usedRetrieval: false,
              latencyMs: Date.now() - t0,
            };
          }
        }
      } catch (llmErr) {
        this.deps.logger.error({ err: llmErr }, 'ai.handle.emergency_llm.failed');
      }

      // 2026-06-11: BOTH the full pipeline and the emergency Gemini call have
      // failed (almost always an intermittent Gemini outage / rate-limit).
      // Previously we rethrew → the webhook catch shipped a generic
      // "I'm here, what's on your mind?" — reproduced from production
      // WhatsApp screenshots. Instead, ship a deterministic, INTENT-AWARE
      // reply built from the user's DB data + curated banks. handleMessage
      // now NEVER throws, so the generic webhook-catch fallback is dead code.
      try {
        const resilient = await this.buildResilientFallback(input);
        this.deps.logger.warn(
          { userId: input.userId, intent: classifyIntent(input.text).type },
          'ai.handle.resilient_fallback',
        );
        return {
          text: resilient,
          confidence: 'low' as const,
          intent: 'resilient_fallback',
          toolResults: [],
          usedRetrieval: false,
          latencyMs: Date.now() - t0,
        };
      } catch (fallbackErr) {
        this.deps.logger.error({ err: fallbackErr }, 'ai.handle.resilient_fallback.failed');
        throw outerErr;
      }
    }
  }

  // ── Personal-stats deterministic answer (2026-06-11) ───────────────────────
  // Answers "what's my (protein/calorie) target?" and "how much (protein) have
  // I had today?" — including COMPOUND phrasings ("what's my target? how much I
  // had?") that the anchored query-fast deliberately skips — straight from the
  // DB. Zero LLM, so it's immune to Gemini outages. High-precision gates: must
  // reference a personal target/goal OR an intake-today question. Returns null
  // when neither applies (caller continues to the normal pipeline).
  //
  // Runs BEFORE the direct paths so a personal question never gets a generic
  // clinical range (production WhatsApp screenshot: "what's my protein target?
  // how much I had?" → "On a GLP-1 the target is 1.2-1.6g/kg..." instead of the
  // user's own 60g / today's 15g).
  private async tryPersonalStats(input: InboundMessage): Promise<string | null> {
    const lower = normalizeUserText(input.text).toLowerCase();
    if (lower.length > 120) return null; // compound is fine; essays are not
    const wantsTarget =
      /\b(?:my|what'?s|whats|what is|tell me)\b[^?]{0,30}\b(?:protein|calorie)\s+(?:target|goal)\b/.test(lower) ||
      /\b(?:protein|calorie)\s+(?:target|goal)\b/.test(lower) && /\b(my|what|whats|what'?s|tell)\b/.test(lower);
    // Which target(s) the question is about — a "calorie goal" ask must not be
    // answered with the protein number, and vice versa.
    const targetIsCalorie = wantsTarget && /\b(?:calorie|calories|cal|kcal)\b/.test(lower);
    const targetIsProtein = wantsTarget && (/\bprotein\b/.test(lower) || !targetIsCalorie);
    const wantsHad =
      /\bhow (?:much|many)\b[^?]{0,40}\b(?:protein|calorie|cal|kcal)?\b[^?]{0,20}\b(had|today|so far|eaten|consumed|left|remaining)\b/.test(lower) ||
      /\b(?:protein|calorie|cal|kcal)\b[^?]{0,15}\b(today|so far|left|remaining)\b/.test(lower) ||
      /\bhow am i doing\b/.test(lower);
    if (!wantsTarget && !wantsHad) return null;

    const user = await this.deps.users.getById(input.userId).catch(() => null);
    if (!user) return null;
    const parts: string[] = [];
    // SETTINGS ARE THE SINGLE SOURCE OF TRUTH — Grace never WRITES a settings
    // number from chat (2026-07-07, user directive). If a target is already SET
    // (the user configured it in Settings), read it back. If it's NOT set, we
    // never derive+store it silently — we SUGGEST a number, explain WHY, and ask
    // them to put it in Settings themselves. Same flow for every settings datum.
    const settingsUrl = 'https://graceglp.com/settings'; // rewritten by TwilioSender
    if (targetIsProtein && user.protein_goal_grams && user.protein_goal_grams > 0) {
      parts.push(`your daily protein target is ${user.protein_goal_grams}g`);
    } else if (targetIsProtein) {
      // No stored target → suggest (never save), with the reasoning + a clear
      // "set it in Settings yourself" so Grace isn't the source of truth.
      const anchorLbs = user.current_weight ?? user.goal_weight ?? null;
      if (anchorLbs != null) {
        const suggested = calculateProteinTarget({
          weightLbs: anchorLbs,
          heightCm: user.height_cm ?? null,
          age: user.age ?? null,
          goal: user.primary_goal ?? null,
        });
        parts.push(`you haven't set a protein target yet. Based on your weight, a good daily goal is about ${suggested}g — on a GLP-1 that's roughly the protein that protects your muscle while you lose. I can't save it from here, so pop that number into Settings (${settingsUrl}) and I'll track every meal against it`);
      } else {
        parts.push(`you haven't set a protein target yet, and I don't have your weight to suggest a precise one — for most people on a GLP-1, 100-120g a day is a solid goal to protect muscle. Add your weight and set your number in Settings (${settingsUrl}) and I'll track against it`);
      }
    }
    // CALORIE target — same suggest-not-store flow (user directive 2026-07-07:
    // "not only the protein. Every data in the settings, this is the flow").
    if (targetIsCalorie && user.calorie_goal_kcal && user.calorie_goal_kcal > 0) {
      parts.push(`your daily calorie target is about ${user.calorie_goal_kcal} kcal`);
    } else if (targetIsCalorie) {
      const suggested = calculateCalorieTarget({
        weightLbs: user.current_weight ?? user.goal_weight ?? null,
        heightCm: user.height_cm ?? null,
        age: user.age ?? null,
        sex: (user.sex as CalorieSex | null) ?? null,
        activityLevel: (user.activity_level as CalorieActivity | null) ?? null,
        goal: user.primary_goal ?? null,
      });
      if (suggested != null) {
        parts.push(`you haven't set a calorie target yet. Based on your weight, height, and activity, a good daily goal is about ${suggested} kcal — a gentle deficit that protects muscle on a GLP-1. I can't save it from here, so set that number in Settings (${settingsUrl}) and I'll track against it`);
      } else {
        parts.push(`you haven't set a calorie target yet, and I'm missing a couple of details (weight, height, age, or activity) to suggest a precise one. Fill those in and set your number in Settings (${settingsUrl}) and I'll track against it`);
      }
    }
    if (wantsHad) {
      const summary = await this.deps.users.getTodaysFoodSummary(input.userId).catch(() => null);
      if (summary) {
        const total = Math.round(summary.protein_g);
        const goal = user.protein_goal_grams ?? 0;
        if (goal > 0 && !wantsTarget) {
          const left = Math.max(0, goal - total);
          parts.push(left === 0 ? `you're at ${total}g protein today — you hit your ${goal}g target` : `you're at ${total}g protein today, ${left}g left of your ${goal}g target`);
        } else {
          parts.push(`you're at ${total}g protein today`);
        }
      }
    }
    if (parts.length === 0) return null;
    const joined = parts.join(', and ');
    return joined.charAt(0).toUpperCase() + joined.slice(1) + '.';
  }

  // ── Meal lifecycle (2026-06-15) ──────────────────────────────────────────
  // The user is EXPLORING / SELECTING a recommended meal ("X sounds good",
  // "I'll have the omelet", "maybe the dal"). This is NOT consumption — it must
  // never log. Build a concise, goal-aware confirmation that keeps the meal in
  // the "suggested" state and offers to log it once they've actually eaten.
  // Also stores the meal as the active recommendation so a later bare "I ended
  // up making it" can be resolved without the user repeating the dish name.
  private async buildMealSuggestionReply(userId: string, text: string): Promise<string> {
    const recTurns = await this.deps.memory.getRecentTurns(userId, 8).catch(() => [] as ChatTurn[]);
    const selected = extractSelectedFood(text);
    const lastRec = extractLastRecommendation(recTurns);
    // Only keep the extracted text when it actually names a food — extraction
    // of "I might make that" yields "might make", which is not a dish.
    const food = selected.length >= 3 && mentionsFood(selected) ? selected : '';

    // Remember the named dish (status: suggested) for later logging. No-ops
    // when the message named no concrete food (setActiveMeal ignores < 3 chars).
    void setActiveMeal(this.deps.redis, userId, food, this.deps.logger).catch(() => {});

    if (!food && !lastRec) {
      // No identifiable dish — acknowledge interest, defer logging, don't ask
      // twice. Keeps it short.
      return "Sounds like a good option. Let me know once you've actually had it and I'll log it for you.";
    }

    const [user, summary] = await Promise.all([
      this.deps.users.getByPhone(userId).catch(() => null),
      this.deps.users.getTodaysFoodSummary(userId).catch(() => null),
    ]);
    const est = food ? estimateMultiItemFood(food) : null;
    const proteinEst = est && est.protein_g > 0 ? est.protein_g : 0;
    const goal = user?.protein_goal_grams ?? 0;
    const today = Math.round(summary?.protein_g ?? 0);
    const dietLabel = user?.dietary_pattern ?? user?.dietary_restriction ?? null;

    const dishName = food || 'That';
    const cap = dishName.charAt(0).toUpperCase() + dishName.slice(1);
    let reply = food ? `${cap} is a solid pick` : 'Good choice';
    if (proteinEst > 0) {
      reply += `, roughly ${proteinEst}g protein${est && est.calories > 0 ? ` and about ${est.calories} calories` : ''}.`;
    } else {
      reply += '.';
    }
    if (goal > 0 && proteinEst > 0) {
      const afterMeal = today + proteinEst;
      const remainingAfter = goal - afterMeal;
      reply += ` That'd put you near ${afterMeal}g of your ${goal}g protein target`;
      reply += remainingAfter > 20 ? `, so add ${proteinAddOns(dietLabel)} to close the gap.` : '.';
    } else if (goal > 0 && goal - today > 20) {
      reply += ` You're at ${today}g of your ${goal}g protein target, so pair it with ${proteinAddOns(dietLabel)}.`;
    }
    // Make the lifecycle explicit: this is a suggestion, not a log.
    reply += " Let me know once you've had it and I'll log it.";
    return reply;
  }

  // Consumption back-reference resolver: when the user confirms eating WITHOUT
  // naming the dish ("I ended up making it", "had it"), pull the meal from the
  // stored active recommendation, log it deterministically, and clear the
  // suggestion. Returns null when there's no active meal to resolve (caller
  // falls through to the normal pipeline, which will ask what they had).
  private async tryLogStoredMeal(
    userId: string,
    text: string,
    t0: number,
    lat: LatencyTracker,
  ): Promise<OrchestratorOutput | null> {
    if (!isBareConsumptionBackReference(text)) return null;
    const active = await getActiveMeal(this.deps.redis, userId, this.deps.logger).catch(() => null);
    if (!active || active.meal.length < 3) return null;
    const est = estimateMultiItemFood(active.meal);
    if (!est || est.items.length === 0) return null;
    const totals = await this.persistEstimatedFood(userId, est, active.meal).catch(() => null);
    void clearActiveMeal(this.deps.redis, userId).catch(() => {});
    const cap = active.meal.charAt(0).toUpperCase() + active.meal.slice(1);
    const macros = est.calories > 0
      ? `about ${est.protein_g}g protein and ${est.calories} calories`
      : `about ${est.protein_g}g protein`;
    const totalsClause = totals && totals.goal > 0 ? ` You're at ${totals.dailyProtein}g/${totals.goal}g today.` : '';
    const reply = `Logged the ${cap} — roughly ${macros}.${totalsClause}`;
    this.deps.logger.info({ userId, meal: active.meal }, 'ai.meal_backref_logged.served');
    this.persistLatency(userId, 'food_log_backref', Date.now() - t0, lat.snapshot(), text, reply);
    return {
      text: reply,
      confidence: 'high',
      intent: 'food_log',
      toolResults: [
        {
          name: 'log_food',
          args: { food: active.meal },
          output: { food: active.meal, protein_g: est.protein_g, calories: est.calories },
          latencyMs: 0,
          ok: true,
        },
      ],
      usedRetrieval: false,
      latencyMs: Date.now() - t0,
    };
  }

  // Persist a deterministically-estimated multi-item meal as a single
  // food_logs row (dedupe-keyed like food-log-fast) and return today's totals.
  // Used by the resilient fallback so food logging works with the LLM down.
  private async persistEstimatedFood(
    userId: string,
    est: { items: Array<{ food: string }>; protein_g: number; calories: number },
    rawText: string,
  ): Promise<{ dailyProtein: number; goal: number } | null> {
    // The main pipeline logs food deterministically (lookupCommonFoodMacros)
    // even when Gemini is down — only the REPLY generation failed and dropped
    // us here. So if anything was already logged for this user in the last 2
    // minutes, do NOT insert again (that would double-count). Only insert when
    // nothing was logged this turn.
    const recent = await this.deps.pool.query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM food_logs WHERE user_id = $1 AND created_at > now() - interval '2 minutes'`,
      [userId],
    );
    const alreadyLogged = Number(recent.rows[0]?.n ?? 0) > 0;
    if (!alreadyLogged) {
      const foodLabel = est.items.map((i) => i.food).join(' + ').slice(0, 200);
      const minuteBucket = Math.floor(Date.now() / 60_000);
      const dedupeKey = createHash('sha256')
        .update(`${userId}|${rawText.toLowerCase().replace(/\s+/g, ' ')}|${minuteBucket}`)
        .digest('hex')
        .slice(0, 32);
      try {
        await this.deps.pool.query(
          `INSERT INTO food_logs (user_id, food, protein_g, calories, confidence, raw_text, source, dedupe_key)
           VALUES ($1, $2, $3, $4, 'medium', $5, 'text', $6)
           ON CONFLICT (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`,
          [userId, foodLabel, est.protein_g, est.calories, rawText, dedupeKey],
        );
      } catch (err) {
        // Loud on a real write failure (this path is otherwise swallowed by the
        // caller's .catch). Re-throws — behavior unchanged, just not silent.
        this.deps.logger.error(
          { userId, food: foodLabel, err: err instanceof Error ? err.message : String(err) },
          'ai.persist_estimated_food.insert_failed',
        );
        throw err;
      }
      this.deps.users.invalidateTodaysFoodCache?.(userId);
    }
    const [summary, user] = await Promise.all([
      this.deps.users.getTodaysFoodSummary(userId).catch(() => null),
      this.deps.users.getById(userId).catch(() => null),
    ]);
    return {
      dailyProtein: Math.round(summary?.protein_g ?? est.protein_g),
      goal: user?.protein_goal_grams ?? 0,
    };
  }

  // ── Resilient deterministic fallback (2026-06-11) ──────────────────────────
  // Last-resort reply when the entire pipeline AND the emergency Gemini call
  // have failed. Produces an INTENT-AWARE, useful answer from deterministic
  // data + the shared curated banks — NEVER a generic "what's on your mind".
  // This is the floor that keeps Grace helpful when the LLM is unavailable.
  private async buildResilientFallback(input: InboundMessage): Promise<string> {
    const text = input.text;
    const lower = text.toLowerCase();
    const intent = classifyIntent(text).type;
    const { getToolAwareFallback } = await import('@grace/ai-core');

    // 1. Personal protein/calorie target or today's intake — straight from DB.
    const personal = await this.tryPersonalStats(input).catch(() => null);
    if (personal) return personal;

    // 2. Symptom / side effect — acknowledge + practical guidance, never a
    //    generic deflection.
    if (SYMPTOM_FALLBACK_RE.test(lower)) {
      return pickKnowledgeTopicFallback(text)
        ?? "That sounds uncomfortable. Sip water, keep food light and protein-first for now, and if it gets worse or lingers more than a day or two, check in with your prescriber.";
    }

    // 3. Intent-typed deterministic reply via the shared ai-core banks.
    try {
      if (intent === 'knowledge' || intent === 'medication_question') {
        return pickKnowledgeTopicFallback(text) ?? getToolAwareFallback('knowledge', [], { userMessage: text });
      }
      if (intent === 'food_question') {
        const user = await this.deps.users.getById(input.userId).catch(() => null);
        const fit = buildFoodFitAnswer(text, { dietLabel: user?.dietary_pattern ?? user?.dietary_restriction ?? null });
        if (fit) return fit;
        const dietaryRestriction = effectiveDietaryRestriction(user);
        const dislikes = (user?.food_dislikes ?? [])
          .map((d) => (d ?? '').trim().replace(/^(i\s+(don'?t|do\s+not|hate|can'?t\s+stand|dislike)\s+(like\s+)?|no\s+|avoid\s+)/i, '').trim())
          .filter((d) => d.length > 0);
        return getToolAwareFallback('food_question', [], {
          userMessage: text,
          ...(dietaryRestriction ? { dietaryRestriction } : {}),
          ...(dislikes.length > 0 ? { foodDislikes: dislikes } : {}),
        });
      }
      if (intent === 'emotional') return getToolAwareFallback('emotional', [], { userMessage: text });
      if (intent === 'appointment_prep') return getToolAwareFallback('appointment_prep', [], { userMessage: text });
      if (intent === 'social_situation') return getToolAwareFallback('social_situation', [], { userMessage: text });
      if (intent === 'weight_log') return getToolAwareFallback('weight_log', [], { userMessage: text });
      if (intent === 'mood_log') return getToolAwareFallback('mood_log', [], { userMessage: text });
      if (intent === 'greeting') return getToolAwareFallback('greeting', [], { userMessage: text });
      if (intent === 'food_log') {
        // Deterministic multi-item estimate from the macro table — keeps food
        // logging working (and LOGGED) even with the LLM down. Never expose an
        // internal "hiccup": if nothing resolves, ask a useful portion question.
        const est = estimateMultiItemFood(text);
        if (est && est.items.length > 0) {
          const totals = await this.persistEstimatedFood(input.userId, est, text).catch(() => null);
          const names = est.items.map((i) => i.food);
          const last = names.pop()!;
          const list = names.length > 0 ? `${names.join(', ')}, and ${last}` : last;
          // Informative confirmation: enumerate every item we recognized + the
          // rough total, so the user can see the WHOLE meal was understood (not
          // just the first food). Calories included when we have them.
          const macros = est.calories > 0
            ? `about ${est.protein_g}g protein and ${est.calories} calories`
            : `about ${est.protein_g}g protein`;
          // Completeness: if the message ALSO named a vague snack/bite/treat
          // that didn't resolve to a logged item, ask what it was instead of
          // dropping it silently (production failure 2026-06-14).
          const addOn = findVagueAddOnItem(text);
          const addOnAsk = addOn && !est.items.some((i) => i.food.toLowerCase().includes(addOn))
            ? ` What was the ${addOn}, so I can log that too?`
            : '';
          // Medium-confidence estimate disclosure (no add-on ask + no explicit
          // portion given) — invite a correction instead of presenting a guess.
          const estTail = !addOnAsk && shouldDiscloseEstimate(text) ? ` ${estimateNote(input.userId)}` : '';
          if (totals && totals.goal > 0) {
            return `Got it — ${list}. Roughly ${macros}. You're at ${totals.dailyProtein}g/${totals.goal}g today.${addOnAsk}${estTail}`;
          }
          return `Got it — ${list}. Roughly ${macros}${totals ? `, ${totals.dailyProtein}g protein today so far` : ''}.${addOnAsk}${estTail}`;
        }
        return "Got it. Roughly how much was it — small, medium, or large portions? I'll total up the protein for you.";
      }
    } catch { /* fall through to warm floor */ }

    // 4. Final floor — warm, forward-moving, references their message. NEVER
    //    a generic "what's on your mind" deflection.
    return getToolAwareFallback('general', [], { userMessage: text });
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
    const dbRules = await this.getDbRules();

    // Extract meal type and try the curated bank deterministically first.
    const lower = userText.toLowerCase();
    const explicitMeal =
      /\bbreakfast\b/.test(lower) ? 'breakfast'
      : /\blunch\b/.test(lower) ? 'lunch'
      : /\bdinner\b|supper/.test(lower) ? 'dinner'
      : /\bsnack/.test(lower) ? 'snack'
      : null;

    // Fetch user profile for dietary restriction + dislikes.
    let user;
    try {
      user = await this.deps.users.getById(input.userId);
    } catch {
      user = null;
    }

    // Time-of-day scoping (2026-07-02): when the user names NO meal and isn't
    // asking for a whole-day plan, answer for the meal that fits their LOCAL
    // clock right now (evening → dinner, morning → breakfast) instead of a
    // generic breakfast-lunch-dinner rundown. Falls back to 'general' when the
    // timezone is unknown.
    const localHour = localHourForTimezone(user?.timezone);
    const fullDay = wantsFullDayPlan(lower);
    let mealType: 'breakfast' | 'lunch' | 'dinner' | 'snack' | 'general';
    let timeScopeNote = '';
    if (explicitMeal) {
      mealType = explicitMeal;
    } else if (!fullDay && localHour != null) {
      mealType = mealForLocalHour(localHour);
      const clock = `${((localHour + 11) % 12) + 1}${localHour < 12 ? 'am' : 'pm'}`;
      timeScopeNote = `\n\nTIME CONTEXT — it's about ${clock} for the user right now, so suggest ${mealType} options for THIS moment. Do NOT lay out a full breakfast-lunch-dinner day plan unless they explicitly ask for the whole day.`;
    } else {
      mealType = 'general';
    }
    const dietaryRestriction = effectiveDietaryRestriction(user);
    const dislikes = (user?.food_dislikes ?? [])
      .map((d) => (d ?? '').trim().replace(/^(i\s+(don'?t|do\s+not|hate|can'?t\s+stand|dislike)\s+(like\s+)?|no\s+|avoid\s+)/i, '').trim())
      .filter((d) => d.length > 0);

    // Intent hierarchy (2026-06-11): a question about a SPECIFIC food ("how
    // about burger for dinner?") gets a direct fit answer for THAT food —
    // general recommendations must never override a direct question.
    // Dietary/dislike context for the content checker — without it, a food-fit
    // or curated answer naming a forbidden/disliked food was NOT caught
    // (2026-06-14 audit). Shared across all three checks below.
    const dietCheckOpts = {
      ...(dietaryRestriction ? { dietaryRestriction } : {}),
      ...(dislikes.length > 0 ? { foodDislikes: dislikes } : {}),
    };
    const fit = buildFoodFitAnswer(userText, { dietLabel: user?.dietary_pattern ?? user?.dietary_restriction ?? null });
    if (fit) {
      const fitViolations = checkContent(fit, { userMessage: userText, ...dietCheckOpts, ...(dbRules.length > 0 ? { dbRules } : {}) });
      if (!fitViolations.some((v) => !v.severity || v.severity === 'block' || v.severity === 'regen')) {
        this.deps.logger.info({ userId: input.userId }, 'ai.food_fit.served');
        return ensureTerminalPunctuation(fit);
      }
    }

    const curated = getCuratedFoodIdeas({
      userId: input.userId,
      query: userText,
      mealType,
      dietaryRestriction,
      foodDislikes: dislikes,
    });
    if (curated && curated.length >= 3) {
      const names = curated.map((c) => c.name).slice(0, 4);
      const reply = formatFoodSuggestions(names, {
        seed: `${input.userId}:${userText}:${names.join('|')}`,
      });
      // Run through format-enforce + content-check for consistency.
      const formatted = enforceFormat(reply, { userMessage: userText });
      const violations = checkContent(formatted.text, { userMessage: userText, ...dietCheckOpts, ...(dbRules.length > 0 ? { dbRules } : {}) });
      // No severity = code-level banned phrase = regen (see runDirectPath note).
      if (violations.some((v) => !v.severity || v.severity === 'block' || v.severity === 'regen')) return null;
      return ensureTerminalPunctuation(formatted.text);
    }

    // 2026-06-06: Build a DIETARY CONTEXT block from the user's profile so
    // Gemini can never recommend a forbidden food. Allergies live in
    // food_dislikes (Grace stores "allergic to fish" / "no shellfish" there
    // alongside taste dislikes), so the same field covers both.
    const dietLabel = dietaryRestriction?.label?.toLowerCase() ?? null;
    const forbiddenWords = [
      ...(dietaryRestriction?.forbidden ?? []),
      ...dislikes,
    ].map((w) => w.trim()).filter(Boolean);
    const dietaryContextBlock = (dietLabel || forbiddenWords.length > 0)
      ? `\n\nDIETARY CONTEXT — apply to every suggestion:
${dietLabel ? `- The user follows a ${dietLabel} diet. Never suggest a food that contains a non-${dietLabel} ingredient.` : ''}
${forbiddenWords.length > 0 ? `- The user dislikes or is allergic to: ${forbiddenWords.join(', ')}. Never suggest a dish that contains any of these.` : ''}
- If a dish has both safe and forbidden versions (e.g. "yogurt" with dairy vs coconut), name the safe variant explicitly.
- If you can't think of 3 safe options, ask the user what usually sits well — don't risk suggesting a forbidden food.`
      : '';

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

If you don't know specifics, name standard GLP-1 friendly options and move on.${dietaryContextBlock}${timeScopeNote}

CRITICAL CONTEXT RULES — apply on every turn:
- You ALWAYS have the user's recent conversation history above. Use it to remember context, preferences, prior side effects, weight changes, mood, what they ate, and what you've discussed.
- You NEVER repeat yourself. Don't restate, quote, or paraphrase any of your previous messages. Don't open with "As I mentioned" or summarize what you just said. If you already answered something, don't answer it again.
- You ALWAYS answer ONLY the user's MOST RECENT message. Earlier questions in the history have already been answered. Do not re-answer them. Do not include them in your reply. Just respond to the current one, using prior context only as silent background knowledge.`;

    // 2026-06-05 v2 revert: history was causing content bleed across turns.
    // Food questions are self-contained — answer without history.
    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
      { role: 'system', content: FOOD_QUESTION_SYSTEM },
      { role: 'user', content: userText },
    ];

    let resp;
    try {
      resp = await this.deps.llm.generate({
        messages,
        temperature: 0.4,
        // disableThinking: gemini-2.5-flash spends "thinking" tokens FROM the
        // output budget, which truncated food replies mid-sentence in prod
        // ("…Greek yogurt topped with."). Off here + a roomier budget so the
        // full 3–5 food answer always lands complete.
        maxOutputTokens: 500,
        disableThinking: true,
        useGoogleSearch: false,
      });
    } catch (err) {
      this.deps.logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'food_question_direct.gemini_failed',
      );
      return null;
    }
    let raw = resp.text?.trim() ?? '';
    if (raw.length === 0) return null;
    // Never ship a mid-sentence reply. If the model was cut off (finishReason
    // 'length') or the text ends on a dangling connector, trim back to the last
    // COMPLETE sentence; bail to the fallback if nothing complete remains.
    if (resp.finishReason === 'length' || endsMidSentence(raw)) {
      const { trimmed } = trimToLastCompleteSentence(raw);
      if (!trimmed || trimmed.length < 24) return null; // too little left — let the fallback answer
      this.deps.logger.info({ userId: input.userId }, 'food_question_direct.truncation_trimmed');
      raw = trimmed;
    }

    // Pass lastAssistantMessage so the format-enforcer can strip any
    // verbatim-repeat prefix from previous responses.
    let lastAssistantMessage: string | undefined;
    try {
      const recentTurns = await this.deps.memory.getRecentTurns(input.userId, 4);
      const lastAsst = [...recentTurns].reverse().find((t) => t.role === 'assistant');
      if (lastAsst?.content) lastAssistantMessage = lastAsst.content;
    } catch { /* non-fatal */ }
    const formatted = enforceFormat(raw, {
      userMessage: userText,
      ...(lastAssistantMessage ? { lastAssistantMessage } : {}),
    });
    const violations = checkContent(formatted.text, { userMessage: userText, ...dietCheckOpts, ...(dbRules.length > 0 ? { dbRules } : {}) });
    // No severity = code-level banned phrase = regen (see runDirectPath note).
    if (violations.some((v) => !v.severity || v.severity === 'block' || v.severity === 'regen')) {
      this.deps.logger.info(
        { codes: violations.map((v) => v.code).slice(0, 5) },
        'food_question_direct.content_violations',
      );
      return null;
    }
    // 2026-06-06: post-generation diet/allergy filter. Belt-and-suspenders
    // against Gemini ignoring the DIETARY CONTEXT block. If the response
    // mentions a forbidden food word, drop to null so the orchestrator's
    // diet-aware fallback runs.
    if (forbiddenWords.length > 0 || dietaryRestriction) {
      const responseLower = formatted.text.toLowerCase();
      const tripped: string[] = [];
      const checkWord = (word: string) => {
        const w = word.toLowerCase().trim();
        if (w.length < 3) return;
        // Whole-word match — \b on either side.
        const re = new RegExp(`\\b${w.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}s?\\b`, 'i');
        if (re.test(responseLower)) tripped.push(w);
      };
      for (const w of dietaryRestriction?.forbidden ?? []) checkWord(w);
      for (const raw of dislikes) {
        // Allergies stored as dislikes — strip qualifier prefix.
        const cleaned = raw
          .replace(/^(?:i'?m\s+)?allergic\s+to\s+/i, '')
          .replace(/^(?:i\s+(?:don'?t|do\s+not|hate|can'?t\s+stand|dislike)\s+(?:like\s+)?|no\s+|avoid\s+)/i, '')
          .trim();
        for (const tok of cleaned.split(/[\s,]+/).filter(Boolean)) checkWord(tok);
      }
      if (tripped.length > 0) {
        this.deps.logger.warn(
          { tripped, userId: input.userId },
          'food_question_direct.forbidden_food_leak',
        );
        return null;
      }
    }
    return ensureTerminalPunctuation(formatted.text);
  }

  private async runDirectPath(intent: string, userText: string, userId?: string, reconHint?: string): Promise<string | null> {
    const config = DIRECT_PATH_CONFIGS[intent];
    if (!config) return null;

    // 2026-06-05 user feedback: "why is my protein goal X" should use the
    // user's actual numbers (current weight, goal weight, GLP-1 week, etc.)
    // not a generic 1.2-1.6g/kg explanation. Fetch the user's profile +
    // today's totals and inject as a YOUR USER block so Gemini can be
    // specific. Memory miss is non-fatal.
    let userContextBlock = '';
    let directDietaryRestriction: DietaryRestriction | null = null;
    let directDislikes: string[] = [];
    if (userId) {
      try {
        // Known facts fetched in parallel with the profile (both cached:
        // 5-min facts cache + profile cache). Without them, the direct
        // paths — the PRIMARY route for knowledge/emotional intents —
        // answered memory-dependent messages blind: "remember I work night
        // shifts" never reached these prompts (2026-06-11 verification
        // finding; reproduced via prompt inspection in the harness).
        const [u, knownFacts] = await Promise.all([
          this.deps.users.getById(userId),
          this.deps.users.getKnownFacts(userId, 8).catch(() => [] as Array<{ fact: string }>),
        ]);
        if (u) {
          const lines: string[] = [];
          if (u.starting_weight) lines.push(`Starting weight: ${u.starting_weight} lbs`);
          if (u.current_weight) lines.push(`Current weight: ${u.current_weight} lbs`);
          if (u.goal_weight) lines.push(`Goal weight: ${u.goal_weight} lbs`);
          if (u.protein_goal_grams) lines.push(`Daily protein target: ${u.protein_goal_grams}g`);
          if (u.calorie_goal_kcal) lines.push(`Daily calorie target: ${u.calorie_goal_kcal} kcal`);
          if (u.medication) lines.push(`Medication: ${u.medication}${u.dose_mg ? ` ${u.dose_mg} mg` : ''}`);
          if (u.injection_day) lines.push(`Injection day: ${u.injection_day}`);
          if (u.glp1_start_date) {
            const weeks = Math.floor((Date.now() - new Date(u.glp1_start_date).getTime()) / (7 * 24 * 60 * 60 * 1000)) + 1;
            if (weeks > 0) lines.push(`GLP-1 week: ${weeks}`);
          }
          // 2026-06-06: diet + allergies/dislikes injected verbatim so Gemini
          // can never recommend a forbidden food on a knowledge / medication
          // / appointment-prep question. Same post-gen filter as
          // handleFoodQuestionDirect catches any model leak.
          // Read dietary_pattern AND the signup dietary_restriction free-text.
          const effLabel = u.dietary_pattern ?? u.dietary_restriction ?? null;
          if (effLabel) {
            lines.push(`Dietary pattern: ${effLabel} — ALL food suggestions MUST respect this.`);
            directDietaryRestriction = effectiveDietaryRestriction(u);
          }
          directDislikes = (u.food_dislikes ?? [])
            .map((d) =>
              (d ?? '')
                .trim()
                .replace(/^(?:i'?m\s+)?allergic\s+to\s+/i, '')
                .replace(/^(i\s+(don'?t|do\s+not|hate|can'?t\s+stand|dislike)\s+(like\s+)?|no\s+|avoid\s+)/i, '')
                .trim(),
            )
            .filter((d) => d.length > 0);
          if (directDislikes.length > 0) {
            lines.push(`Avoid / disliked / allergic to: ${directDislikes.join(', ')}`);
          }
          if (knownFacts.length > 0) {
            lines.push(`Known about this user: ${knownFacts.map((f) => f.fact).join('; ')}`);
          }
          if (lines.length > 0) {
            userContextBlock = `\n\nUSER PROFILE (use for specifics, don't restate verbatim):\n${lines.join('\n')}\n`;
          }
        }
      } catch { /* non-fatal */ }
    }

    // 2026-06-05 v2 revert: passing FULL conversation history caused Gemini
    // to BLEED previous responses into the new one. "Can drink alcohol?"
    // opened with "It's understandable to feel nervous when starting
    // something new" — copied directly from the prior "I'm nervous" reply.
    // History made every response worse, not better.
    //
    // New approach: NO history by default. Pass a minimal "follow-up context"
    // line ONLY when the user message is a short ambiguous follow-up
    // ("why", "yes", "more", "tell me more", "really?"). For everything
    // else, the question is self-contained — answer it without history.
    let lastAssistantMessage: string | undefined;
    let followUpContext = '';
    if (userId) {
      try {
        const recentTurns = await this.deps.memory.getRecentTurns(userId, 2);
        const lastAsst = [...recentTurns].reverse().find((t) => t.role === 'assistant');
        if (lastAsst?.content) lastAssistantMessage = lastAsst.content;
        if (reconHint) {
          // Deterministic reconstruction already merged the fragment with the
          // prior turn — give Gemini the standalone meaning directly instead
          // of the verbatim-prior-turn dump. (2026-06-11)
          followUpContext = `\n\nFOLLOW-UP CONTEXT — in the full conversation, the user is really asking: "${reconHint}". Answer THAT directly and specifically. Do not restate earlier text.\n`;
        } else if (lastAsst?.content) {
          const isShortFollowUp =
            userText.trim().length <= 25 &&
            /^(?:why|why\??|yes|yeah|sure|ok|okay|please|go on|tell me more|more|more please|continue|and\??|so\??|really\??|how\s+so\??|how\s+come\??|what do you mean\??|like what\??)$/i.test(userText.trim());
          if (isShortFollowUp) {
            const prevShort = lastAsst.content.length > 300
              ? lastAsst.content.slice(0, 300) + '...'
              : lastAsst.content;
            followUpContext = `\n\nPREVIOUS CONTEXT — the user is asking a short follow-up to your previous response. That response was:\n"${prevShort}"\nAnswer their follow-up directly, with specifics. NEVER restate the previous response. Just answer the follow-up.\n`;
          }
        }
      } catch { /* non-fatal */ }
    }

    const CONTEXT_RULES_SUFFIX = `

CRITICAL RULES:
- Answer ONLY the user's current message. Do not restate, paraphrase, or quote any earlier topic.
- NEVER use Title-Case headers ("Muscle Preservation:", "Hunger Control:", "Key Points:") — banned.
- NEVER ask multiple clarifying questions. If you must ask, one short question only.
- End with terminal punctuation (.!?).`;
    // Append Grace's voice (warm/human/varied) so even the scoped intent prompts
    // sound like a friend, not a script — with an anti-repetition hint built from
    // the last reply so back-to-back answers don't open the same way.
    const voice = voiceSuffix(lastAssistantMessage ? [{ role: 'assistant', content: lastAssistantMessage }] : []);
    const systemWithRule = config.system + userContextBlock + followUpContext + CONTEXT_RULES_SUFFIX + voice;

    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
      { role: 'system', content: systemWithRule },
      { role: 'user', content: userText },
    ];

    let resp;
    try {
      resp = await this.deps.llm.generate({
        messages,
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

    // Format-enforce: strip markdown, em-dashes, label-colons, list intros,
    // AND duplicate previous-message prefix.
    const formatted = enforceFormat(raw, {
      userMessage: userText,
      ...(lastAssistantMessage ? { lastAssistantMessage } : {}),
    });

    // Content-check: drop on banned-phrase or block violations. Regen-
    // severity → fall through to orchestrator (which has the regen
    // machinery). Clean → ship. DB rules included — the dose-safety
    // block rules ("take an extra dose", "double your dose") exist ONLY
    // in content_rules; without them this path would ship such advice.
    const directDbRules = await this.getDbRules();
    const violations = checkContent(formatted.text, { userMessage: userText, ...(directDbRules.length > 0 ? { dbRules: directDbRules } : {}) });
    // Code-level banned-phrase violations carry NO severity field (only DB
    // rules set one) — same semantics as the orchestrator (line ~1464) and
    // the FAQ-cache gate: undefined severity means regen. Checking only
    // severity === 'block' | 'regen' let every code-level banned phrase
    // ship through this path (2026-06-11 verification finding).
    if (violations.some((v) => !v.severity || v.severity === 'block' || v.severity === 'regen')) {
      this.deps.logger.info(
        { codes: violations.map((v) => v.code).slice(0, 5), intent },
        'direct_path.content_violations',
      );
      return null;
    }

    // 2026-06-06: forbidden-food post-gen filter for diet + allergies.
    // Gemini sometimes lists a meat/dairy example even after the USER
    // PROFILE block says "Dietary pattern: vegan". Belt-and-suspenders
    // drop to null so the orchestrator's diet-aware fallback runs.
    if (directDietaryRestriction || directDislikes.length > 0) {
      const responseLower = formatted.text.toLowerCase();
      const tripped: string[] = [];
      const checkWord = (word: string) => {
        const w = word.toLowerCase().trim();
        if (w.length < 3) return;
        const re = new RegExp(`\\b${w.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}s?\\b`, 'i');
        if (re.test(responseLower)) tripped.push(w);
      };
      for (const w of directDietaryRestriction?.forbidden ?? []) checkWord(w);
      for (const raw of directDislikes) {
        for (const tok of raw.split(/[\s,]+/).filter(Boolean)) checkWord(tok);
      }
      if (tripped.length > 0) {
        this.deps.logger.warn(
          { tripped, intent, userId },
          'direct_path.forbidden_food_leak',
        );
        return null;
      }
    }

    // 2026-06-05 production failure: knowledge_direct shipped truncated
    // text "GLP-1 medications, while effective for weight loss, can " when
    // Gemini hit maxOutputTokens mid-sentence. The text then concatenated
    // with the RLHF appendage producing "...can 👍 👎 to rate..." mid-word
    // garbage. Defense: if the response ends mid-word, iteratively trim
    // back to a complete sentence boundary; if no usable complete sentence
    // remains, fall through to orchestrator instead of shipping garbage.
    let candidate = formatted.text;
    if (endsMidWord(candidate)) {
      let cleaned = false;
      for (let i = 0; i < 6; i++) {
        const { trimmed, wasTrimmed } = trimToLastCompleteSentence(candidate);
        if (!wasTrimmed || trimmed.length < 40) break;
        candidate = trimmed;
        if (!endsMidWord(candidate)) {
          cleaned = true;
          break;
        }
      }
      if (!cleaned) {
        this.deps.logger.info(
          { intent, originalLength: formatted.text.length },
          'direct_path.unrecoverable_truncation',
        );
        return null;
      }
    }

    // Final length sanity check — direct replies must be under the intent's
    // hard cap. If still over, trim to the first N sentences.
    if (candidate.length > config.hardCharCap) {
      const sentences = candidate.split(/(?<=[.!?])\s+/);
      return sentences.slice(0, config.maxSentencesOnTrim).join(' ').trim();
    }
    return candidate.trim();
  }

  // ── UNIFIED (Nudge) PATH ─────────────────────────────────────────────────
  /**
   * The single clean reply path (gated by UNIFIED_REPLY_PATH). Logs any eaten
   * food ONCE via logFoodUnified (never asks, never drops), then makes ONE
   * grounded Gemini call with all the data + full history. No intercepts, no
   * overlapping food layers. Media turns delegate to the existing pipeline.
   */
  private async runUnifiedReply(input: InboundMessage, t0: number, lat: LatencyTracker): Promise<OrchestratorOutput> {
    const userId = input.userId;
    // Images / voice keep the existing media pipeline for now.
    if (input.media.length > 0) return this.handleMessageInner(input, t0, lat);

    const [user, todaysFoodPre, knownFacts, memoryMd, history, conversationId] = await Promise.all([
      this.deps.users.getByPhone(userId).catch(() => null),
      this.deps.users.getTodaysFoodSummary(userId).catch(() => ({ protein_g: 0, calories: 0, items: [] as string[] })),
      this.deps.users.getKnownFacts(userId, 8).catch(() => [] as Array<{ fact: string }>),
      this.deps.memoryMd ? this.deps.memoryMd.get(userId).catch(() => null) : Promise.resolve(null),
      this.deps.memory.getRecentTurns(userId, this.deps.historyTurns ?? 12).catch(() => [] as ChatTurn[]),
      this.deps.memory.ensureConversation(userId).catch(() => `fallback-${userId}`),
    ]);
    // Episodic recall (recency-weighted user_memories) is consumed ONLY on the
    // grounded reply path. Kick it off here so it overlaps the deterministic
    // intercepts + the food step below, but AWAIT it lazily at buildGroundedPrompt
    // — a food log / reminder / diary / settings intercept returns before then and
    // never pays the query-embedding round-trip (was in the awaited Promise.all, so
    // every unified turn ate it). Errors are swallowed → always resolves to [].
    const recalledPromise: Promise<string[]> = this.deps.userMemory
      ? this.deps.userMemory.retrieve(userId, input.text, 3).catch(() => [] as string[])
      : Promise.resolve([] as string[]);

    // ── Trivial-message fast-path (instant, warm, NO LLM) ──────────────────
    // The unified path otherwise sends even "Hey" through the grounded Gemini
    // call — slow, and drier than a snappy greeting. Greetings / thanks / brief
    // rapport get a deterministic reply immediately. Safety (crisis/hypo) already
    // ran before runUnifiedReply, and media never reaches here. A pure greeting
    // gets a warm, day-aware reply built from the user's real local weekday/time
    // (the Nudge model); other trivial categories use the fast-path text.
    const fp = tryFastPath(input.text, userId);
    if (fp) {
      const reply = fp.category === 'greeting'
        ? buildWarmGreeting(`${userId}|${input.text}`, user?.timezone ?? null)
        : fp.text;
      void this.deps.memory.appendTurn({ userId, conversationId, role: 'user', content: input.text }).catch(() => {});
      void this.deps.memory.appendTurn({ userId, conversationId, role: 'assistant', content: reply }).catch(() => {});
      const totalMs = Date.now() - t0;
      this.deps.logger.info({ userId, category: fp.category, latencyMs: totalMs }, 'ai.unified.fast_path');
      this.persistLatency(userId, 'unified_fast', totalMs, lat.snapshot(), input.text, reply);
      return { text: reply, confidence: 'high', intent: 'fast_path', toolResults: [], usedRetrieval: false, latencyMs: totalMs };
    }

    // ── Progressive gather gate (2026-06-28) ───────────────────────────────
    // Keep learning the user so every reply is specific to them. Ask-first
    // returns ONE warm question (short-circuit); a gather answer rewrites
    // input.text to the replayed original question so the rest of this path
    // answers it, now personalized. Reply-path agnostic — must run here too.
    if (this.progressiveProfile) {
      const gate = await this.progressiveGatherGate(input).catch(() => ({} as { reply?: string; text?: string }));
      if (gate.reply) {
        void this.deps.memory.appendTurn({ userId, conversationId, role: 'user', content: input.text }).catch(() => {});
        void this.deps.memory.appendTurn({ userId, conversationId, role: 'assistant', content: gate.reply }).catch(() => {});
        const totalMs = Date.now() - t0;
        this.deps.logger.info({ userId }, 'ai.unified.progressive_gather.ask_first');
        this.persistLatency(userId, 'profile_gather', totalMs, lat.snapshot(), input.text, gate.reply);
        return { text: gate.reply, confidence: 'high', intent: 'profile_gather', toolResults: [], usedRetrieval: false, latencyMs: totalMs };
      }
      if (gate.text) input = { ...input, text: gate.text };
    }

    // ── Reminder questions → deterministic answer (2026-06-15) ──────────────
    // "When is my next reminder?" / "remind me at 3pm?" answered from the
    // user's ACTUAL reminder config — never the LLM (which leaked capability
    // denials). Grace explains the schedule + redirects changes to Settings;
    // she never denies sending reminders. Returned deterministically (the
    // "next" answer is a precise schedule fact Gemini must not reword).
    {
      const reminderIntent = detectReminderIntent(input.text);
      if (reminderIntent) {
        try {
          const settingsUrl = 'https://graceglp.com/settings'; // rewritten by TwilioSender
          const reply = reminderIntent === 'change'
            ? buildReminderChangeReply(settingsUrl)
            : reminderIntent === 'explain'
              ? buildReminderExplainReply(user ?? {}, settingsUrl)
              : buildNextReminderReply(user ?? {}, settingsUrl);
          void this.deps.memory.appendTurn({ userId, conversationId, role: 'user', content: input.text }).catch(() => {});
          void this.deps.memory.appendTurn({ userId, conversationId, role: 'assistant', content: reply }).catch(() => {});
          const totalMs = Date.now() - t0;
          this.deps.logger.info({ userId, reminderIntent }, 'ai.unified.reminder_query.served');
          this.persistLatency(userId, `reminder_${reminderIntent}`, totalMs, lat.snapshot(), input.text, reply);
          return { text: reply, confidence: 'high', intent: `reminder_${reminderIntent}`, toolResults: [], usedRetrieval: false, latencyMs: totalMs };
        } catch (err) {
          this.deps.logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'ai.unified.reminder_query.error');
        }
      }
    }

    // ── DETERMINISTIC GROUNDING (correctness) ──────────────────────────────
    // The unified path trusts the model for date + injection timing, but flash
    // DENIES them even when the facts are in the prompt ("I don't have access to
    // the current date", "I cannot provide medical advice… I am an AI" — both
    // seen in prod). These are facts we compute exactly, so answer them
    // deterministically and never let the model deny a capability.
    const medNow = user?.medication && !isEncryptedBlob(user.medication) ? user.medication.trim() : null;

    // ── GLP-1 start-date CAPTURE (2026-07-05) ──────────────────────────────
    // The user STATING when they started ("I started Ozempic in May", "began the
    // shots 6 weeks ago") must be logged accurately to glp1_start_date — the
    // Settings field. Deterministic parse (never stores an implausible date), then
    // confirm. Runs before injection-timing so an onset statement is never misread.
    if (user) {
      const parsedStart = parseStartDateStatement(input.text, new Date());
      if (parsedStart) {
        try {
          await this.deps.users.update(input.userId, { glp1_start_date: parsedStart.date });
        } catch (err) {
          this.deps.logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'ai.unified.start_date_capture.error');
        }
        const reply = buildStartDateCaptureReply(parsedStart.date, medNow, new Date());
        void this.deps.memory.appendTurn({ userId, conversationId, role: 'user', content: input.text }).catch(() => {});
        void this.deps.memory.appendTurn({ userId, conversationId, role: 'assistant', content: reply }).catch(() => {});
        const totalMs = Date.now() - t0;
        this.deps.logger.info({ userId, iso: parsedStart.iso }, 'ai.unified.start_date.captured');
        this.persistLatency(userId, 'start_date_capture', totalMs, lat.snapshot(), input.text, reply);
        return { text: reply, confidence: 'high', intent: 'start_date_capture', toolResults: [], usedRetrieval: false, latencyMs: totalMs };
      }
    }

    const injIntent = detectInjectionTimingIntent(input.text);
    if (injIntent && user) {
      const sched = computeInjectionSchedule(
        { medicationType: inferMedicationType(medNow), medicationName: medNow, injectionDay: user.injection_day ?? null, timezone: user.timezone ?? null },
        new Date(),
      );
      const dj = buildInjectionTimingReply(injIntent, sched, medNow, 'https://graceglp.com/settings');
      const rep = enforceFormat(dj, { userMessage: input.text }).text.trim() || dj;
      void this.deps.memory.appendTurn({ userId, conversationId, role: 'user', content: input.text }).catch(() => {});
      void this.deps.memory.appendTurn({ userId, conversationId, role: 'assistant', content: rep }).catch(() => {});
      this.deps.logger.info({ userId, injIntent }, 'ai.unified.injection_timing');
      return { text: rep, confidence: 'high', intent: 'reminder', toolResults: [], usedRetrieval: false, latencyMs: Date.now() - t0 };
    }
    const dateReply = answerDateQuestion(input.text, user?.timezone ?? null);
    if (dateReply) {
      void this.deps.memory.appendTurn({ userId, conversationId, role: 'user', content: input.text }).catch(() => {});
      void this.deps.memory.appendTurn({ userId, conversationId, role: 'assistant', content: dateReply }).catch(() => {});
      this.deps.logger.info({ userId }, 'ai.unified.date_answer');
      return { text: dateReply, confidence: 'high', intent: 'chat', toolResults: [], usedRetrieval: false, latencyMs: Date.now() - t0 };
    }

    // ── Dashboard link (2026-07-02) ────────────────────────────────────────
    // "Show me my progress / charts / the app" → hand the user their web
    // dashboard link. Deterministic so Grace never implies there's no app and
    // a "see my progress" request is never misread as a food log or summary.
    if (detectDashboardRequest(input.text)) {
      const reply = buildDashboardLinkReply(); // host rewritten by TwilioSender
      void this.deps.memory.appendTurn({ userId, conversationId, role: 'user', content: input.text }).catch(() => {});
      void this.deps.memory.appendTurn({ userId, conversationId, role: 'assistant', content: reply }).catch(() => {});
      const totalMs = Date.now() - t0;
      this.deps.logger.info({ userId }, 'ai.unified.dashboard_link.served');
      this.persistLatency(userId, 'dashboard_link', totalMs, lat.snapshot(), input.text, reply);
      return { text: reply, confidence: 'high', intent: 'dashboard_link', toolResults: [], usedRetrieval: false, latencyMs: totalMs };
    }

    // ── Weekly / recent-history summary → grounded in REAL data (2026-06-18)
    // "Summarize my last week" / "recap my week for my doctor" answered from
    // the user's ACTUAL last-7-days logs, never a single-day total or a generic
    // fallback. Runs BEFORE the food step so food words in a recap can't log.
    if (mightBeSummaryRequest(input.text)) {
      let recentContext: string | undefined;
      if (!detectSummaryRequest(input.text)) {
        recentContext = history.slice(-6).map((m) => m.content).join(' • ');
      }
      if (detectSummaryRequest(input.text, recentContext) && user) {
        try {
          const data = await gatherWeeklySummary(this.deps.users, user);
          const grounded = renderWeeklySummary(data);
          const warmed = await this.warmlyRephrase(
            grounded,
            "This is a recap of the user's week to share with their doctor. Keep it CONCISE — about the same length, a few short sentences that must stay well under 400 characters so it's never cut off. Do NOT open with a preamble ('Okay, here's...'), a title/header, or a 'Hi Doctor' letter format — just give the recap directly in warm prose. Keep the closing offer to turn it into questions for the doctor.",
            grounded,
          );
          const reply = warmed.length > 415 ? grounded : warmed;
          void this.deps.memory.appendTurn({ userId, conversationId, role: 'user', content: input.text }).catch(() => {});
          void this.deps.memory.appendTurn({ userId, conversationId, role: 'assistant', content: reply }).catch(() => {});
          const totalMs = Date.now() - t0;
          this.deps.logger.info({ userId, daysLogged: data.daysLogged }, 'ai.unified.weekly_summary.served');
          this.persistLatency(userId, 'weekly_summary', totalMs, lat.snapshot(), input.text, reply);
          return { text: reply, confidence: 'high', intent: 'weekly_summary', toolResults: [], usedRetrieval: false, latencyMs: totalMs };
        } catch (err) {
          this.deps.logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'ai.unified.weekly_summary.error');
        }
      }
    }

    // ── Doctor-questions follow-up (2026-07-05, ported into the unified path) ─
    // After the weekly recap offers "turn this into questions for your doctor?",
    // a "Yes please" must run the DETERMINISTIC, grounded question builder — not
    // the grounded LLM prompt below, which produced a report-shaped, TRUNCATED
    // "Questions for your Doctor:" list in prod. Mirrors the compact-path
    // intercept in handleMessageInner so both paths behave identically. Only
    // fires when the prior assistant turn actually offered/gave doctor questions,
    // so a plain "yes"/"great" elsewhere is never captured.
    {
      const trimmed = input.text.trim();
      const isAffirmation = /^(?:yes|yep|yeah|yup|sure|ok|okay|sounds good|sound good|sounds great|sounds nice|please do|please|alright|go ahead|do it|let'?s do it|yes please|absolutely|great|perfect|love it|nice)[!.?]?\s*$/i.test(trimmed);
      const followUp = detectFollowUp(trimmed);
      if ((isAffirmation || followUp) && followUp?.kind !== 'clarify') {
        const lastAssistant = [...history].reverse().find((t) => t.role === 'assistant')?.content ?? '';
        if (isDoctorQuestionsContext(lastAssistant)) {
          const appendAndReturn = (reply: string): OrchestratorOutput => {
            void this.deps.memory.appendTurn({ userId, conversationId, role: 'user', content: input.text }).catch(() => {});
            void this.deps.memory.appendTurn({ userId, conversationId, role: 'assistant', content: reply }).catch(() => {});
            const totalMs = Date.now() - t0;
            this.persistLatency(userId, 'appointment_prep', totalMs, lat.snapshot(), input.text, reply);
            return { text: reply, confidence: 'high', intent: 'appointment_prep', toolResults: [], usedRetrieval: false, latencyMs: totalMs };
          };
          if (followUp?.kind === 'reject') {
            this.deps.logger.info({ userId }, 'ai.unified.doctor_questions.declined');
            return appendAndReturn('No worries. Anything else you want to go over before your appointment?');
          }
          const detailed = isDoctorQuestionsReply(lastAssistant) || wantsMoreDetail(followUp);
          const data = user ? await gatherWeeklySummary(this.deps.users, user).catch(() => null) : null;
          const grounded = buildDoctorQuestions(data, { detailed });
          const warmed = await this.warmlyRephrase(
            grounded,
            'This is a short set of questions to bring to their doctor — keep each one specific and grounded in their real numbers, plain iMessage prose with NO headings, NO numbered/bulleted list, and keep the closing offer to adjust them.',
            grounded,
          );
          const reply = warmed.length > 415 ? grounded : warmed;
          this.deps.logger.info({ userId, detailed, kind: followUp?.kind }, 'ai.unified.doctor_questions.served');
          return appendAndReturn(reply);
        }
      }
    }

    // ── Personal-stats questions → deterministic (2026-07-05, ported) ───────
    // "What is my protein goal?" / "how much protein have I had?" must answer
    // from the user's STORED target (protein_goal_grams) and today's real total
    // — never the grounded LLM, which invented a generic "100-120g" range that
    // contradicted the 140g the weekly summary + food-logging renderers use (all
    // three now read the same stored number, so the target is consistent). Runs
    // before the food step so a "goal" query is never mistaken for a food log.
    {
      const psRaw = await this.tryPersonalStats(input).catch(() => null);
      if (psRaw) {
        const reply = await this.warmlyRephrase(
          psRaw,
          'This is the answer to a question about their own numbers (protein, calories, target, weight). Keep every number EXACTLY as given — these are their real totals — just say it warmly and naturally in one short sentence, no lists.',
          psRaw,
        );
        void this.deps.memory.appendTurn({ userId, conversationId, role: 'user', content: input.text }).catch(() => {});
        void this.deps.memory.appendTurn({ userId, conversationId, role: 'assistant', content: reply }).catch(() => {});
        const totalMs = Date.now() - t0;
        this.deps.logger.info({ userId }, 'ai.unified.personal_stats.served');
        this.persistLatency(userId, 'personal_stats', totalMs, lat.snapshot(), input.text, reply);
        return { text: reply, confidence: 'high', intent: 'personal_stats', toolResults: [], usedRetrieval: false, latencyMs: totalMs };
      }
    }

    // ── SETTINGS-FIELD READS → deterministic, NEVER fabricated (2026-07-05) ──
    // The governing rule: Grace must never invent a settings datum. The unified
    // path previously skipped query-fast entirely, so "when did I start", "what's
    // my week number / injection day / medication / dose / weight / age" fell to
    // the LLM → fabrication (a made-up start date + week count in prod). tryQueryFast
    // answers each from the STORED value, and when a field is missing it asks the
    // user / points to Settings — it never guesses. Placed AFTER the deliberate
    // unified intercepts (personal-stats owns protein/calorie; this owns the rest)
    // and before the food step; anchored READ-only patterns can't hijack a log.
    try {
      const qf = await tryQueryFast(input.text, { users: this.deps.users, logger: this.deps.logger, userId });
      if (qf) {
        void this.deps.memory.appendTurn({ userId, conversationId, role: 'user', content: input.text }).catch(() => {});
        void this.deps.memory.appendTurn({ userId, conversationId, role: 'assistant', content: qf.text }).catch(() => {});
        const totalMs = Date.now() - t0;
        this.deps.logger.info({ userId, category: qf.category }, 'ai.unified.query_fast.served');
        this.persistLatency(userId, `query_fast_${qf.category}`, totalMs, lat.snapshot(), input.text, qf.text);
        return { text: qf.text, confidence: 'high', intent: `query_fast_${qf.category}`, toolResults: [], usedRetrieval: false, latencyMs: totalMs };
      }
    } catch (err) {
      this.deps.logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'ai.unified.query_fast.error');
    }

    // ── FOOD-DIARY QUERY → answered from the LOG, never conversation history ──
    // "what have I eaten today?" (any phrasing/word order, with or without a
    // greeting) is answered DETERMINISTICALLY from the authoritative day total —
    // the same per-local-day window everything else uses. After a reset / on a new
    // day the log is 0g → a clean "Nothing logged yet today", NEVER a
    // reconstruction of pre-reset mentions or an offer to re-add them (prod
    // IMG_6710). A message that ALSO asks for a recommendation/plan falls through
    // to the grounded path (which answers every part, intake still snapshot-bound).
    if (isFoodDiaryQuery(input.text) && input.media.length === 0) {
      const s = todaysFoodPre;
      let reply = renderDailyFoodSummary(s.items, Math.round(s.protein_g), Math.round(s.calories));
      // If foods are still awaiting a clarification (pending), acknowledge them so
      // the user isn't told "nothing" about something they just reported (prod: a
      // pending shake + sandwich were invisible to "what have I eaten today").
      const pendingItems = await getPendingFood(this.deps.redis, userId).catch(
        () => [] as Awaited<ReturnType<typeof getPendingFood>>,
      );
      const pendingNames = pendingItems.map((p) => p.item.trim()).filter(Boolean);
      if (pendingNames.length > 0) {
        const list = pendingNames.length === 1
          ? pendingNames[0]
          : pendingNames.length === 2
            ? `${pendingNames[0]} and ${pendingNames[1]}`
            : `${pendingNames.slice(0, -1).join(', ')}, and ${pendingNames[pendingNames.length - 1]}`;
        reply += ` I'm also still waiting on the details for ${list} before I can log ${pendingNames.length === 1 ? 'it' : 'them'}.`;
      }
      void this.deps.memory.appendTurn({ userId, conversationId, role: 'user', content: input.text }).catch(() => {});
      void this.deps.memory.appendTurn({ userId, conversationId, role: 'assistant', content: reply }).catch(() => {});
      const totalMs = Date.now() - t0;
      this.deps.logger.info({ userId }, 'ai.unified.food_diary.served');
      this.persistLatency(userId, 'food_diary_today', totalMs, lat.snapshot(), input.text, reply);
      return { text: reply, confidence: 'high', intent: 'food_diary_today', toolResults: [], usedRetrieval: false, latencyMs: totalMs };
    }

    // ── LOCAL TIME / DAY-RESET → deterministic, from the real timezone ──────────
    // "what is my local time?" / "when does my diary reset?" are FACTS Grace knows
    // (the user's timezone, corrected from their phone number, drives the local
    // clock). Prod IMG_6720/6721: the LLM hedged ("I don't have access to your
    // device's clock") AND gave New York time for an Israeli number. Answer from
    // the temporal context, never a model guess.
    if (input.media.length === 0) {
      const tq = detectTemporalQuery(input.text);
      if (tq) {
        const reply = tq === 'local_time'
          ? buildLocalTimeReply(user?.timezone ?? null)
          : buildDayResetReply(user?.timezone ?? null);
        void this.deps.memory.appendTurn({ userId, conversationId, role: 'user', content: input.text }).catch(() => {});
        void this.deps.memory.appendTurn({ userId, conversationId, role: 'assistant', content: reply }).catch(() => {});
        const totalMs = Date.now() - t0;
        this.deps.logger.info({ userId, tq }, 'ai.unified.temporal_query.served');
        this.persistLatency(userId, `temporal_${tq}`, totalMs, lat.snapshot(), input.text, reply);
        return { text: reply, confidence: 'high', intent: `temporal_${tq}`, toolResults: [], usedRetrieval: false, latencyMs: totalMs };
      }
    }

    // Nudge food step (extractFoodItems + planning guard): a specific meal logs
    // with an estimate; a hedged/generic mention comes back pending → we ask ONE
    // portion question via the CLARIFY note; advice/planning never logs.
    const food = await this.foodStepUnified(input, history).catch(() => null);
    const todaysFood = food && food.logged.length > 0
      ? await this.deps.users.getTodaysFoodSummary(userId).catch(() => todaysFoodPre)
      : todaysFoodPre;

    const dietaryRestriction = effectiveDietaryRestriction(user);
    const dislikes = (user?.food_dislikes ?? [])
      .map((d) => d.replace(/^(i\s+(don'?t|do\s+not|hate|can'?t\s+stand|dislike)\s+(like\s+)?|no\s+|avoid\s+)/i, '').trim())
      .filter(Boolean);

    const isFoodTurn = !!food && (food.logged.length > 0 || food.pending.length > 0 || !!food.removed);

    // Is this a message that says SEVERAL things at once (a planning/emotional
    // question that merely MENTIONS food), rather than a pure food log? The
    // deterministic food confirmation below is capped at 1–2 sentences and would
    // drop the rest of a multi-part message (prod: "help me plan dinner… + how do
    // I handle dessert without feeling guilty?" got only a terse "you're at 65g,
    // try Greek yogurt"). When multi-topic we STILL log the food (side-effect,
    // already done by foodStepUnified) but fall through to the full grounded path
    // so EVERY part gets answered — Nudge-style — with the total kept grounded.
    const understanding = analyzeMessage(input.text);
    const isMultiTopic = input.media.length === 0 && understanding.hasMultiple;

    // ── DETERMINISTIC FOOD CONFIRMATION (the #1 complaint fix) ─────────────
    // The food confirmation is built by code, NOT the LLM: the exact protein
    // number comes from the authoritative day total, and "logged" is only
    // claimed for items actually logged (pending items get a portion question,
    // never a number). This kills the prod bug where the model HALLUCINATED a
    // running total ("...along with your 669g of protein") and falsely claimed
    // a pending item was logged. The LLM is used ONLY to answer a genuine side
    // question ("...any snack idea?"), and even then it's forbidden to mention
    // logging, grams, or totals — so it can never invent a number.
    if (isFoodTurn && food && !isMultiTopic) {
      const seed = `${userId}|${input.text}`;
      // ── DETERMINISTIC SAFE REPLY (the fallback) ──────────────────────────
      // Exact numbers, honest logged/pending claim. This is what ships if the
      // warm LLM phrasing below can't be trusted.
      const parts: string[] = [];
      if (food.removed) parts.push(`Done — took ${food.removed} off today's log.`);
      if (food.logged.length > 0) {
        const confirm = formatFoodReply({
          loggedItems: food.logged,
          loggedProtein: todaysFood.protein_g,
          loggedCalories: todaysFood.calories,
          pendingFoods: [],
          seed,
          rough: food.rough,
        });
        if (confirm) parts.push(confirm);
      }
      if (food.pending.length > 0) {
        parts.push(food.clarify || formatFoodReply({ loggedItems: [], pendingFoods: food.pending, seed }));
      }
      // The food confirmation ships DETERMINISTICALLY (formatFoodReply): it states
      // exactly what was logged + the REAL running total, and its openers already
      // vary by seed ("Got it — logged…", "Logged…", "Done…", "Nice —…"). We do
      // NOT run an LLM re-phrase here: with the thin context of a food/portion turn
      // ("One cup") the model invented food that was never eaten (prod IMG_6717:
      // "nothing beats a classic black coffee") and opened every reply with "Yum".
      // The number guard couldn't catch a hallucinated FOOD NAME. Nudge-base rule:
      // the reply reads the accurate snapshot, it never free-writes a food turn.
      const reply = parts.join(' ').trim() || 'Got it.';

      void this.deps.memory.appendTurn({ userId, conversationId, role: 'user', content: input.text }).catch(() => {});
      void this.deps.memory.appendTurn({ userId, conversationId, role: 'assistant', content: reply }).catch(() => {});
      const totalMs = Date.now() - t0;
      const didLog = food.logged.length > 0 || !!food.removed;
      this.deps.logger.info({ userId, logged: food.logged.length, pending: food.pending.length, removed: !!food.removed }, 'ai.unified.food_deterministic');
      this.persistLatency(userId, didLog ? 'unified_food' : 'unified', totalMs, lat.snapshot(), input.text, reply);
      return { text: reply, confidence: 'high', intent: didLog ? 'food_log' : 'chat', toolResults: [], usedRetrieval: false, latencyMs: totalMs };
    }

    // Non-food chat — OR a multi-topic message that merely mentioned food —
    // uses the full Nudge grounded prompt so EVERY part gets answered (not the
    // terse food-confirmation, which drops the rest of a multi-part message).
    const recalled = await recalledPromise;
    let systemPrompt = this.buildGroundedPrompt(user, { todaysFood, dietaryRestriction, dislikes, knownFacts, memoryMd, recalled, userText: input.text });

    // If this multi-topic turn ALSO logged/mentioned food, weave that in — but
    // never let the model invent a total. The running total is the authoritative
    // getTodaysFoodSummary number and is the ONLY running total it may state.
    if (isFoodTurn && food) {
      const notes: string[] = [];
      if (food.removed) notes.push(`You just removed "${food.removed}" from today's log — confirm that in one casual clause.`);
      if (food.logged.length > 0) notes.push(`You just logged ${food.logged.join(', ')} for them. Their running protein total for TODAY is ${Math.round(todaysFood.protein_g)}g — you may mention it in ONE short clause, and it is the ONLY running-total protein number you may state (general advice like "aim for ~30g at dinner" is fine).`);
      if (food.pending.length > 0) {
        const ask = food.clarify
          ? ` You MUST ask them about it before you can log it — weave THIS question in naturally (early, right after the warm opener): "${food.clarify.replace(/"/g, "'")}"`
          : ' You MUST briefly ask what you need to log it (how much; for a sandwich/wrap what was in it; for a protein shake how many scoops or what brand).';
        notes.push(`They mentioned ${food.pending.join(', ')} but you can't log it accurately yet — never assume its protein.${ask} Do NOT claim it's logged and do NOT state or assume a protein number for it.`);
      }
      systemPrompt += `\n\nFOOD JUST HANDLED (weave in naturally, do NOT lead with it):\n- ${notes.join('\n- ')}`;
    }

    // Prime the FIRST generation to not estimate an ambiguous eaten food, even
    // when foodStepUnified dropped it (the deterministic number guard below is
    // the guarantee; this just reduces regens). Derived straight from the message.
    const primeAmbig = isMultiTopic && !(isFoodTurn && food && food.pending.length > 0)
      ? ambiguousEatenFoods(input.text)
      : null;
    if (primeAmbig) {
      systemPrompt += `\n\nFOOD NOT LOGGABLE YET: they mentioned eating ${primeAmbig.items.join(' and ')}, but you can't know the protein (unknown scoops / what's in it). Do NOT estimate or count it, do NOT do protein math, state NO protein gram number except their goal. Ask what you need — weave in: "${primeAmbig.clarify.replace(/"/g, "'")}" — then answer their planning warmly.`;
    }

    // Multi-part guidance so Grace answers EVERY part + leads with the feeling.
    if (isMultiTopic) systemPrompt += buildMultiPartNote(understanding);

    // Non-food chat keeps history for continuity.
    const effHistory = history;
    const baseMessages = (sys: string): Array<{ role: 'system' | 'user' | 'assistant'; content: string }> => [
      { role: 'system', content: sys },
      ...effHistory.map((h) => ({ role: h.role, content: h.content })),
      { role: 'user', content: input.text },
    ];

    this.deps.logger.info({ userId, path: 'unified', prompt: 'grounded' }, 'ai.reply.path');

    // Every unified LLM call is timeout-BOUNDED. Without this a slow/retrying
    // turn ran 15-30s, blew past the webhook in-flight lock's wait budget, and
    // the lock "proceeded without it" → two pipelines for the same user collided
    // → replies got mismatched to the wrong message and double-sent (the exact
    // chaos in the 2026-07-04 PM screenshots). temp 0.8 / 500 / thinking off.
    const gen = async (sys: string): Promise<string> => {
      const r = await Promise.race([
        // skipContextCache: the grounded prompt is rebuilt every message (current
        // time + per-user profile + recalled memories), so a cachedContents object
        // could never be reused — attempting it only wastes a round-trip and evicts
        // the extractor's reusable cache. Identical systemInstruction reaches the
        // model, so this is latency/cost-only, no output change.
        this.deps.llm.generate({ messages: baseMessages(sys), temperature: 0.8, maxOutputTokens: 500, skipCache: true, skipContextCache: true, disableThinking: true }),
        new Promise<{ text: string } | null>((res) => setTimeout(() => res(null), UNIFIED_GEN_TIMEOUT_MS)),
      ]).catch(() => null);
      // A multi-part answer keeps its paragraph breaks (one short section per
      // part) — clearer + ensures every part is visibly covered. A single-topic
      // reply stays one paragraph (default collapse).
      return r ? enforceFormat(r.text ?? '', { userMessage: input.text, preserveParagraphs: isMultiTopic }).text.trim() : '';
    };

    let reply = await gen(systemPrompt);

    // ── ONE PASS + DETERMINISTIC FLOORS ──────────────────────────────────────
    // The reply is a SINGLE Gemini call (above). The guarantees below are enforced
    // by CODE, not by re-prompting Gemini — the old cascade fired up to ~6 extra
    // LLM calls per turn (relevance judge + 5 regens), which multiplied latency
    // and still failed. This is the Nudge model: one accurate call, then a fast
    // deterministic safety net. The ONLY LLM "extra" kept is a rare denial retry.

    // Capability-denial is the one failure worth a retry (shipping "I'm an AI /
    // I can't" is bad and can't be fixed deterministically). Rare — the date /
    // injection / reminder intercepts above already answer capability questions.
    if (reply && UNIFIED_DENIAL_RE.test(reply)) {
      this.deps.logger.info({ userId }, 'ai.unified.denial_regen');
      const retry2 = await gen(systemPrompt +
        `\n\nHARD OVERRIDE: never say "as an AI", "I don't have access", "I can't provide medical advice", or "check your device". You are Grace and you HAVE their date, schedule, and profile in the facts above. Answer warmly and directly using those facts.`);
      if (retry2 && !UNIFIED_DENIAL_RE.test(retry2)) reply = retry2;
    }
    // Completeness: an ENUMERATED multi-ask ("plan what to eat before dinner,
    // what to choose at the meal, and how to handle dessert…") occasionally gets
    // ONE part dropped (prod: only the before-dinner tip landed). When the reply
    // misses an ask, regen ONCE asking for the missing parts — and adopt the retry
    // ONLY if it covers strictly more, so a false positive can never ship a worse
    // reply (worst case is one wasted call, and only on enumerated multi-asks).
    if (isMultiTopic && reply) {
      const uncovered = uncoveredAskCount(input.text, reply);
      if (uncovered > 0) {
        const topics = missingAskTopics(input.text, reply);
        this.deps.logger.info({ userId, uncovered, topics }, 'ai.unified.completeness_regen');
        const retry = await gen(systemPrompt +
          `\n\nIMPORTANT: your draft skipped part of what they asked. In the SAME short, warm message, also directly answer: ${topics.join('; ')}. Cover EVERY part they asked about — plain prose, no lists.`);
        if (retry && uncoveredAskCount(input.text, retry) < uncovered) reply = retry;
      }
    }
    if (!reply) reply = 'I’m here — tell me a little more?';

    // Report shape ("here's the game plan: 1. … 2. …") → strip to warm prose,
    // deterministically (no regen). A numbered plan can never reach the user.
    if (UNIFIED_BREAKDOWN_RE.test(reply)) {
      const stripped = stripReportShape(reply);
      if (stripped.length >= 40) {
        reply = stripped;
        this.deps.logger.info({ userId }, 'ai.unified.breakdown_stripped');
      }
    }

    // Ambiguous/pending food → the reply may state NO protein number other than
    // the real logged total + the goal (any other is an assumption), and it MUST
    // ask about each pending item. Both enforced deterministically: strip a
    // disallowed number, append the clarify if the ask is missing. No LLM regen.
    const eatenAmbig = isMultiTopic ? ambiguousEatenFoods(input.text) : null;
    const pendItems: string[] = (food && food.pending.length > 0 ? food.pending : eatenAmbig?.items) ?? [];
    const pendClarify: string | null = (food && food.clarify) || eatenAmbig?.clarify || null;
    if (pendItems.length > 0) {
      const realTotal = Math.round(todaysFood.protein_g);
      const goal = user?.protein_goal_grams ?? null;
      const allowed = [realTotal, ...(goal ? [goal] : [])];
      if (hasDisallowedProteinNumber(reply, allowed)) {
        reply = stripAssumedProteinSentences(reply, allowed) || reply;
        this.deps.logger.info({ userId }, 'ai.unified.assumed_protein_stripped');
      }
      if (pendClarify) {
        const keyword = (item: string): string =>
          (item.trim().split(/\s+/).pop() || item).toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const asksEach = reply.includes('?') && pendItems.every((p) => new RegExp(`\\b${keyword(p)}`, 'i').test(reply));
        if (!asksEach) reply = `${reply} ${pendClarify}`.trim();
      }
    }

    void this.deps.memory.appendTurn({ userId, conversationId, role: 'user', content: input.text }).catch(() => {});
    void this.deps.memory.appendTurn({ userId, conversationId, role: 'assistant', content: reply }).catch(() => {});
    const totalMs = Date.now() - t0;
    this.persistLatency(userId, 'unified', totalMs, lat.snapshot(), input.text, reply);
    return { text: reply, confidence: 'high', intent: 'chat', toolResults: [], usedRetrieval: false, latencyMs: totalMs, ...(isMultiTopic ? { preserveParagraphs: true } : {}) };
  }

  /**
   * The food step for the unified path — Nudge's handler food flow
   * (extractFoodItems V2 + advice/planning guard + apply). A specific meal is
   * logged with an estimate; a hedged/generic mention (no amount) comes back
   * PENDING so the reply asks the one portion question (stored so the next-turn
   * answer resolves it, no loop); a delete removes; advice/planning/question/
   * non-food returns null (the reply answers from the snapshot). Mirrors
   * Nudge's isMealAdviceOrPlanningTurn strip + applyFoodExtract.
   *
   * Returns { logged, pending, removed } or null.
   */
  private async foodStepUnified(
    input: InboundMessage,
    history: ChatTurn[],
  ): Promise<{ logged: string[]; pending: string[]; removed: string | null; clarify?: string | null; rough?: boolean } | null> {
    const text = input.text.trim();
    if (!text) return null;
    // Nudge's advice/planning guard: "what should I eat" / a bare "salmon" after
    // Grace asked what she has in mind is discussion, never a log.
    if (isMealAdviceOrPlanningTurn(text, history)) return null;

    const pending = await getPendingFood(this.deps.redis, input.userId).catch(
      () => [] as Awaited<ReturnType<typeof getPendingFood>>,
    );
    const foodish = namesSpecificFood(text) || !!foodSpanFromConsumption(text) || FOOD_MUTATION_RE.test(text) || FOOD_DIARY_QUERY_RE.test(text);
    if (!foodish && pending.length === 0) return null;

    // PRECISION: only an EXPLICIT amount/portion/size (a number, a unit, a
    // single-serving article, or a size word) is precise enough to log. Without
    // one we ASK (stating the usual serving) and log only after the user answers
    // — never a silent default-serving estimate (the product ask 2026-07-04).
    const quantified = hasExplicitQuantity(text);

    const logFood = makeLogFoodTool({
      pool: this.deps.pool,
      llm: this.deps.llm,
      logger: this.deps.logger,
      userId: input.userId,
      source: 'text',
      ...(this.deps.usda ? { usda: this.deps.usda } : {}),
      users: this.deps.users,
    });

    // AFFIRMATION of a proposed standard portion ("yes", "that's about right")
    // when we're awaiting one → log the pending item(s) at the standard estimate.
    if (pending.length > 0 && isPortionAffirmation(text)) {
      const logged: string[] = [];
      for (const p of pending) {
        const r = (await logFood.execute({ food: p.item }).catch(() => null)) as Record<string, unknown> | null;
        if (r && r.ok !== false) logged.push(p.item);
      }
      await clearPendingFood(this.deps.redis, input.userId).catch(() => {});
      if (logged.length === 0) return null;
      this.deps.logger.info({ userId: input.userId, logged: logged.length }, 'ai.unified_food.affirm_logged');
      return { logged, pending: [], removed: null };
    }

    // PORTION ANSWER to a pending clarification ("One cup", "6 oz", "two cups",
    // "a handful") → resolve the pending item(s) DETERMINISTICALLY by logging each
    // with the stated amount. This must NOT depend on the extractor (which returns
    // `none` for a bare amount) and must NEVER fall through to the grounded path —
    // otherwise the portion turn re-opens earlier planning history and leaks it
    // (prod IMG_6713: "One cup" produced a parents-dinner game plan instead of a
    // log confirmation). Scoped tight: a SHORT amount-only reply that names no new
    // food, so "a cup of rice too" (names a food) still goes through extraction.
    if (
      pending.length > 0 &&
      hasExplicitQuantity(text) &&
      !namesSpecificFood(text) &&
      !FOOD_MUTATION_RE.test(text) &&
      text.split(/\s+/).length <= 6
    ) {
      const amount = text.trim();
      const logged: string[] = [];
      for (const p of pending) {
        const food = `${amount} ${p.item}`.replace(/\s+/g, ' ').trim();
        const r = (await logFood.execute({ food }).catch(() => null)) as Record<string, unknown> | null;
        if (r && r.ok !== false) logged.push(p.item);
      }
      await clearPendingFood(this.deps.redis, input.userId).catch(() => {});
      if (logged.length > 0) {
        this.deps.logger.info({ userId: input.userId, logged: logged.length }, 'ai.unified_food.portion_resolved');
        return { logged, pending: [], removed: null };
      }
    }

    // COMPOSITION ANSWER to a "what was in the X?" clarification: a short bare
    // FILLING word ("Cheese", "turkey", "chicken") resolves a pending COMPOSITION-
    // ambiguous item (a bare salad/sandwich/wrap) → log it as "<filling> <food>"
    // ("cheese salad") DETERMINISTICALLY, so it never falls to the grounded path
    // (prod: "Cheese" answering the salad question produced an LLM reply that
    // computed a total but logged nothing). Scoped tight like the portion branch:
    // a short reply that names a food, has NO amount, is NOT a consumption
    // statement ("I ate cheese" = a new log, handled by the extractor), and only
    // when a composition-ambiguous item is actually pending.
    const compositionPending = pending.filter((p) => isCompositionAmbiguousFood(p.item));
    if (
      compositionPending.length > 0 &&
      !hasExplicitQuantity(text) &&
      namesSpecificFood(text) &&
      !FOOD_MUTATION_RE.test(text) &&
      !foodSpanFromConsumption(text) &&
      text.split(/\s+/).length <= 3
    ) {
      const filling = text.trim().replace(/[.!?,]+$/, '');
      const logged: string[] = [];
      for (const p of compositionPending) {
        const food = `${filling} ${p.item}`.replace(/\s+/g, ' ').trim(); // "cheese salad"
        const r = (await logFood.execute({ food }).catch(() => null)) as Record<string, unknown> | null;
        if (r && r.ok !== false) logged.push(p.item);
      }
      for (const it of logged) await resolvePendingFood(this.deps.redis, input.userId, it).catch(() => {});
      if (logged.length > 0) {
        this.deps.logger.info({ userId: input.userId, logged: logged.length }, 'ai.unified_food.composition_resolved');
        // The user-facing item names describe what was actually logged.
        return { logged: logged.map((it) => `${filling} ${it}`.replace(/\s+/g, ' ').trim()), pending: [], removed: null };
      }
    }

    // PENDING DETAIL RESOLUTION — the answer names the pending food(s) WITH the
    // detail needed to log them (a filling AND/OR an amount), e.g. "Cheese
    // sandwich and one scoop protein shake" resolving pending [sandwich, protein
    // shake]. This is the case BETWEEN the amount-only (portion) and filling-only
    // (composition) branches above — it has both, for possibly several items —
    // and prod (IMG_6733/6735) showed it silently fell to the grounded path,
    // which HALLUCINATED a total and logged nothing. Split the reply into
    // segments and log the one that describes each pending item; a pending item
    // the reply doesn't mention stays pending. A segment must actually contain a
    // pending item's word, so a fresh/unrelated food is never hijacked. Scoped
    // like the branches above: names a food, not a mutation, not a consumption
    // statement ("I ate X" = a new log → extractor), short.
    // A genuine detail ANSWER, not a QUESTION about the pending food ("is the
    // sandwich healthy?", "why did you ask about the sandwich") and not a fresh
    // food log — either of those must never be logged as food. A leading
    // interrogative / any "?" disqualifies the whole turn (it's a question →
    // let the grounded path answer it, pending stays intact).
    const looksLikeQuestion =
      /\?/.test(text) ||
      /^\s*(is|are|was|were|do|does|did|can|could|should|would|will|why|what|how|when|where|which|who|whose)\b/i.test(text);
    if (
      pending.length > 0 &&
      !looksLikeQuestion &&
      namesSpecificFood(text) &&
      !FOOD_MUTATION_RE.test(text) &&
      !foodSpanFromConsumption(text) &&
      text.split(/\s+/).length <= 12
    ) {
      const segments = text.split(/\s+and\s+|,|;/i).map((s) => s.trim().replace(/[.!?]+$/, '')).filter(Boolean);
      // Match each pending item to a DISTINCT segment (a segment is consumed
      // once), so two pending items that share a trailing word ("chicken
      // sandwich" / "turkey sandwich") don't both collapse onto the first match.
      const usedSeg = new Set<number>();
      const matched: string[] = [];
      const unresolved: typeof pending = [];
      for (const p of pending) {
        const key = (p.item.toLowerCase().split(/\s+/).pop() || p.item.toLowerCase())
          .replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const idx = key
          ? segments.findIndex((s, i) => !usedSeg.has(i) && new RegExp(`\\b${key}\\b`, 'i').test(s))
          : -1;
        if (idx >= 0) { usedSeg.add(idx); matched.push(segments[idx]!); } else unresolved.push(p);
      }
      // A segment that names a real food but matched NO pending item is a FRESH
      // food (prod-safe: "chicken and rice" while only rice is pending). Do NOT
      // short-circuit — fall through to the extractor so the new food is logged,
      // never silently dropped.
      const hasFreshFood = segments.some((s, i) => !usedSeg.has(i) && namesSpecificFood(s));
      if (matched.length > 0 && !hasFreshFood) {
        const logged: string[] = [];
        for (const seg of matched) {
          const r = (await logFood.execute({ food: seg }).catch(() => null)) as Record<string, unknown> | null;
          if (r && r.ok !== false) logged.push(seg);
        }
        if (logged.length > 0) {
          await clearPendingFood(this.deps.redis, input.userId).catch(() => {});
          if (unresolved.length > 0) {
            await addPendingFood(this.deps.redis, input.userId, unresolved.map((p) => ({ item: p.item, clarify_question: null }))).catch(() => {});
          }
          const clarify = unresolved.length > 0
            ? buildPortionConfirmQuestion(unresolved.map((p) => ({ item: p.item, protein_g: null })))
            : null;
          this.deps.logger.info({ userId: input.userId, logged: logged.length, unresolved: unresolved.length }, 'ai.unified_food.detail_resolved');
          return { logged, pending: unresolved.map((p) => p.item), removed: null, clarify };
        }
      }
    }

    let extraction = await extractFood(
      this.deps.llm,
      this.deps.logger,
      text,
      pending.map((p) => ({ item: p.item })),
      // STRONG model for the unified path (Nudge runs its extractor on a full
      // flash model, not lite) — flash-lite mislabels reported meals as `none`.
      'gemini-2.5-flash',
    ).catch(() => ({ ...EMPTY_EXTRACTION }));

    if (extraction.intent === 'delete' && extraction.edit_ref) {
      try {
        const rm = makeRemoveFoodTool({ pool: this.deps.pool, logger: this.deps.logger, userId: input.userId });
        await rm.execute({ food: extraction.edit_ref });
      } catch { /* best-effort */ }
      await resolvePendingFood(this.deps.redis, input.userId, extraction.edit_ref).catch(() => {});
      return { logged: [], pending: [], removed: extraction.edit_ref };
    }

    // ── GENERAL FOOD RECOVERY (never-drop, works for ANY complex message) ─────
    // A message that mixes eaten food with planning / emotion / questions ("…
    // there'll be pasta Friday… today I ate a shake and a sandwich… help me plan
    // dinner?") makes the first extraction pass mislabel the WHOLE thing 'query'
    // or 'none' and drop the intake. The deterministic consumption span is the
    // source of truth for what was EATEN: whenever it fires we RE-EXTRACT on just
    // that span — clean, with no planning/question/future-food noise — so we
    // always recover proper items to log/ask, regardless of how the overall
    // message was classified. A pure query/none (no consumption span) falls
    // through to the grounded path so a real question is answered, not logged.
    if (extraction.intent === 'query' || extraction.intent === 'none') {
      const span = foodSpanFromConsumption(text);
      if (!span) return null;
      const spanEx = await extractFood(this.deps.llm, this.deps.logger, span, [], 'gemini-2.5-flash').catch(
        () => ({ ...EMPTY_EXTRACTION }),
      );
      if (spanEx.items.length > 0) {
        // Recovered clean per-food items → run them through the SAME ambiguity
        // gate below (log clear ones, ask about ambiguous ones per food).
        extraction = { ...spanEx, intent: 'log' as const };
      } else {
        // The extractor couldn't itemize the span (e.g. a Gemini timeout). If the
        // span names a SPECIFIC ambiguous food (a bare sandwich/salad/shake), pend
        // those CLEAN names and ask about each — NEVER the raw span, which would
        // echo the whole message into the question (prod IMG_6709). If we can't
        // name a clean ambiguous food, log the span (never-drop) rather than emit a
        // garbled portion question.
        const names = ambiguousFoodNames(span, text);
        if (names.length > 0) {
          await addPendingFood(this.deps.redis, input.userId, names.map((n) => ({ item: n, clarify_question: null }))).catch(() => {});
          const clarify = buildPortionConfirmQuestion(names.map((n) => ({ item: n, protein_g: null })));
          this.deps.logger.info({ userId: input.userId, span, names }, 'ai.unified_food.backstop_needs_portion');
          return { logged: [], pending: names, removed: null, clarify };
        }
        const r = (await logFood.execute({ food: span }).catch(() => null)) as Record<string, unknown> | null;
        if (!r || r.ok === false) return null;
        this.deps.logger.info({ userId: input.userId, span }, 'ai.unified_food.backstop_logged');
        return { logged: [span], pending: [], removed: null };
      }
    }

    const confirmed = extraction.items.filter((i) => i.status === 'confirmed');
    const extractorPending = extraction.items.filter((i) => i.status === 'pending_portion');

    // PRECISION GATE (accuracy-first — user directive 2026-07-08: ask about
    // "almost every food with real macros"). A confirmed item is logged straight
    // through ONLY when its portion is precisely anchored (extractor confidence
    // high/exact — a stated amount/label) or it carries near-zero macros (water,
    // black coffee — no point asking). Otherwise Grace confirms the portion first:
    //   • COMPOSITION-AMBIGUOUS assembled food (a bare sandwich/wrap — protein set
    //     by an UNKNOWN filling) → ask what's in it, even with an article present.
    //   • PROTEIN PRODUCT with no scoop/brand → ask scoops/brand.
    //   • PORTION-SENSITIVE food with no message-level amount → ask how much.
    //   • ANY rough-estimate (medium/low confidence) material-macro food whose
    //     portion wasn't stated → ask, so the number reflects what they ate, not a
    //     typical-serving guess. A precisely-stated portion (high/exact, or a
    //     recorded serving_size) logs as normal.
    //
    // This applies to a MULTI-TOPIC message too (user directive after seeing prod:
    // "where are the clarification questions?"). It does NOT disrupt the multi-part
    // answer: a downgraded food becomes PENDING, and the multi-topic grounded path
    // ALREADY weaves the portion question into the full reply (see the "FOOD JUST
    // HANDLED … weave THIS question in" note) while still answering every part via
    // buildMultiPartNote — the Nudge model (IMG_6737). It's per-item, so the word
    // "small" elsewhere in the message no longer suppresses asking about "crackers".
    const askAggressively = input.media.length === 0;
    const logged: string[] = [];
    let anyRough = false;
    const downgraded: Array<{ item: string; protein_g: number | null }> = [];
    const logConfirmed = async (it: ExtractedFoodItem): Promise<void> => {
      const args: Record<string, unknown> = { food: it.item };
      if (it.protein_g != null && it.calories != null) { args.protein_g = it.protein_g; args.calories = it.calories; }
      // Carry the extractor's confidence + portion phrase to the log (food_tracker
      // idea). The tool's macro-sanity guard may still downgrade a bad estimate.
      if (it.confidence) args.confidence = it.confidence;
      if (it.serving_size) args.serving_size = it.serving_size;
      const r = (await logFood.execute(args).catch(() => null)) as Record<string, unknown> | null;
      if (r && r.ok !== false) {
        logged.push(it.item);
        if (isRoughConfidence(it.confidence)) anyRough = true;
      }
    };
    for (const it of confirmed) {
      // A food with real macros that has NO precise amount is a typical-serving
      // GUESS — the exact class the user wants confirmed ("small yogurt", "some
      // crackers") rather than silently logged. DETERMINISTIC (not the extractor's
      // confidence, which unreliably marked "small yogurt" high → logged): ask
      // unless the item carries a real number/unit (its label OR serving_size), is
      // a nutrition-label exact value, or is an obvious single-serving food (a
      // fruit, a bar). Per-item, so "small" on the yogurt no longer silences the
      // crackers; fires in multi-topic too (the grounded path weaves the question
      // in without dropping any part of the answer).
      const needsPortion =
        askAggressively &&
        isMaterialMacro(it.protein_g, it.calories) &&
        it.confidence !== 'exact' &&
        // Precise only when the amount is in the item label OR the extractor's
        // serving_size is one the USER actually stated (not an invented "1 cup").
        !(hasPreciseAmount(it.item) || servingReflectsUserAmount(it.serving_size, text)) &&
        !isObviousSingleServing(it.item);
      if (
        isCompositionAmbiguousFood(it.item) ||
        isProteinProductAmbiguous(it.item, text) ||
        (!quantified && isPortionSensitiveFood(it.item)) ||
        needsPortion
      ) {
        downgraded.push({ item: it.item, protein_g: it.protein_g ?? null });
      } else {
        await logConfirmed(it);
      }
    }

    if (extraction.intent === 'edit' && logged.length > 0) {
      await clearPendingFood(this.deps.redis, input.userId).catch(() => {});
    } else {
      for (const it of logged) await resolvePendingFood(this.deps.redis, input.userId, it).catch(() => {});
    }

    // Everything awaiting a portion: the extractor's own pending items PLUS the
    // confirmed items we downgraded for lacking an explicit amount.
    const pendingItems = [
      ...downgraded.map((d) => ({ item: d.item, clarify_question: null as string | null })),
      ...extractorPending.map((i) => ({ item: i.item, clarify_question: i.clarify_question })),
    ];
    if (pendingItems.length > 0) {
      await addPendingFood(this.deps.redis, input.userId, pendingItems).catch(() => {});
    }

    if (logged.length === 0 && pendingItems.length === 0) return null;

    // Build the ONE portion question (usual amount + confirm/correct) for the
    // items awaiting a portion — used verbatim by runUnifiedReply so the number
    // is never invented.
    const clarify = pendingItems.length > 0
      ? buildPortionConfirmQuestion([
          ...downgraded,
          ...extractorPending.map((i) => ({ item: i.item, protein_g: i.protein_g ?? null })),
        ])
      : null;

    this.deps.logger.info(
      { userId: input.userId, logged: logged.length, pending: pendingItems.length, downgraded: downgraded.length, rough: anyRough },
      'ai.unified_food.step',
    );
    return { logged, pending: pendingItems.map((i) => i.item), removed: null, clarify, rough: anyRough };
  }

  /**
   * Learn long-term memory from a completed turn — fire-and-forget, runs AFTER
   * the reply is on its way so it never adds user-facing latency. Two stores,
   * both best-effort:
   *   - user_memories (all users): semantic extraction of durable facts the user
   *     stated ("my daughter's wedding is in August", "cardio makes me nauseous")
   *     → recalled on later turns via `retrieve` in the grounded prompt.
   *   - memory.md (pilot users only): narrative file, enqueued for the worker.
   * Skips trivial turns and pure food/water logs (nothing memorable, and the
   * highest-volume turns — no point spending a Gemini extraction on "2 eggs").
   * This runs for the UNIFIED path; the compact path has its own equivalent at
   * the tail of handleMessageInner, and the two paths are mutually exclusive.
   */
  private learnFromTurnAsync(input: InboundMessage, result: OrchestratorOutput): void {
    const uLen = input.text.trim().length;
    const aLen = result.text.trim().length;
    const noLearnIntent = result.intent === 'food_log' || result.intent === 'water_log';

    // Semantic memory (all users) — extraction decides what (if anything) is worth
    // storing; a turn with no durable fact simply stores nothing.
    if (this.deps.userMemory && !noLearnIntent && uLen >= 20 && aLen >= 20) {
      void this.deps.userMemory
        .extractAndStore(input.userId, input.text, result.text)
        .catch((err) => this.deps.logger.warn({ err }, 'user_memory.extract.failed'));
    }

    // memory.md narrative (pilot users only — gated by enrolment).
    if (this.deps.memoryMdQueue && !noLearnIntent && uLen + aLen >= 30) {
      void (async () => {
        const enrolled = this.deps.memoryMd
          ? await this.deps.memoryMd.isEnrolled(input.userId).catch(() => false)
          : false;
        if (!enrolled) return;
        await this.deps.memoryMdQueue!.add('update', {
          userId: input.userId,
          userText: input.text,
          assistantText: result.text,
        });
      })().catch((err) => this.deps.logger.warn({ err }, 'memory-md-queue.add.failed'));
    }
  }

  /**
   * Nudge-style food handler for the ORCHESTRATOR path. Runs a structured
   * extraction, logs CONFIRMED items, asks AT MOST ONE combined portion question
   * for vague items (tracked as pending so a portion answer resolves them — no
   * loop), and replies with a SHORT, warm, deterministic confirmation/question
   * (never an LLM ramble). Returns null — falling through to the orchestrator —
   * for queries, planning/advice, non-food, extractor failure, or nothing
   * logged, so it can NEVER do worse than yesterday's path.
   */
  private async tryNudgeFoodHandler(
    input: InboundMessage,
    intent: string,
    conversationId: string,
    t0: number,
  ): Promise<OrchestratorOutput | null> {
    if (!this.deps.flags.toolsEnabled) return null;
    const foodIntent = intent === 'food_log' || intent === 'food_question';
    const pending = await getPendingFood(this.deps.redis, input.userId).catch(() => [] as Awaited<ReturnType<typeof getPendingFood>>);
    if (!foodIntent && pending.length === 0) return null;

    const extraction = await Promise.race<FoodExtraction>([
      extractFood(this.deps.llm, this.deps.logger, input.text, pending.map((p) => ({ item: p.item }))),
      new Promise<FoodExtraction>((r) => setTimeout(() => r({ ...EMPTY_EXTRACTION }), 9000)),
    ]);

    // Only HANDLE clear food actions here. Queries / planning / advice / non-food
    // fall through to the orchestrator (get_food_summary, food ideas, etc.).
    if (extraction.intent === 'none' || extraction.intent === 'query') return null;

    const logFood = makeLogFoodTool({
      pool: this.deps.pool,
      llm: this.deps.llm,
      logger: this.deps.logger,
      userId: input.userId,
      source: 'text',
      ...(this.deps.usda ? { usda: this.deps.usda } : {}),
      users: this.deps.users,
    });
    const toolResults: ToolResult[] = [];
    let reply = '';

    if (extraction.intent === 'delete' && extraction.edit_ref) {
      try {
        const rm = makeRemoveFoodTool({ pool: this.deps.pool, logger: this.deps.logger, userId: input.userId });
        const r = await rm.execute({ food: extraction.edit_ref });
        if (r && (r as { ok?: boolean }).ok !== false) toolResults.push({ name: 'remove_food', args: { food: extraction.edit_ref }, ok: true, output: r, latencyMs: 0 });
      } catch { /* best-effort */ }
      await resolvePendingFood(this.deps.redis, input.userId, extraction.edit_ref).catch(() => {});
      reply = `Done — took ${extraction.edit_ref} off today's log.`;
    } else {
      const confirmed = extraction.items.filter((i) => i.status === 'confirmed');
      const newPending = extraction.items.filter((i) => i.status === 'pending_portion');
      const loggedItems: string[] = [];
      let dailyProtein: number | undefined;
      let dailyCal: number | undefined;
      for (const it of confirmed) {
        const args: Record<string, unknown> = { food: it.item };
        if (it.protein_g != null && it.calories != null) { args.protein_g = it.protein_g; args.calories = it.calories; }
        const r = (await logFood.execute(args).catch(() => null)) as Record<string, unknown> | null;
        if (r && r.ok !== false) {
          toolResults.push({ name: 'log_food', args, ok: true, output: r, latencyMs: 0 });
          dailyProtein = (r.daily_protein_g as number | undefined) ?? dailyProtein;
          dailyCal = (r.daily_calories as number | undefined) ?? dailyCal;
          loggedItems.push(it.item);
        }
      }
      if (extraction.intent === 'edit') {
        await clearPendingFood(this.deps.redis, input.userId).catch(() => {});
      } else {
        for (const it of confirmed) await resolvePendingFood(this.deps.redis, input.userId, it.item).catch(() => {});
      }
      if (newPending.length > 0) {
        await addPendingFood(this.deps.redis, input.userId, newPending.map((i) => ({ item: i.item, clarify_question: i.clarify_question }))).catch(() => {});
      }
      // Nothing usable to log or ask → let the orchestrator handle it.
      if (loggedItems.length === 0 && newPending.length === 0) return null;
      reply = formatFoodReply({
        loggedItems,
        ...(dailyProtein != null ? { loggedProtein: dailyProtein } : {}),
        ...(dailyCal != null ? { loggedCalories: dailyCal } : {}),
        pendingFoods: newPending.map((i) => i.item),
        seed: `${input.userId}|${input.text}`,
      });
    }

    if (!reply) return null;
    void this.deps.memory.appendTurn({ userId: input.userId, conversationId, role: 'user', content: input.text }).catch(() => {});
    void this.deps.memory.appendTurn({ userId: input.userId, conversationId, role: 'assistant', content: reply }).catch(() => {});
    this.deps.logger.info({ userId: input.userId, intent: extraction.intent, logged: toolResults.length }, 'ai.nudge_food.served');
    return { text: reply, intent: `food_${extraction.intent}`, confidence: 'high', toolResults, usedRetrieval: false, latencyMs: Date.now() - t0 };
  }

  /**
   * DIRECT REPLY (competitor-style generation) — a SINGLE Gemini call on
   * [system prompt + recent history + user message]. No orchestrator, planner,
   * per-intent directive wrapping, or guard/regen cascade — that cascade is what
   * made replies feel dry and robotic. The system prompt still carries the
   * user's personalization (today's totals, medication, week number), so replies
   * are warm AND personal. Food/weight still persist deterministically (totals
   * stay accurate); the reply text is whatever Gemini writes. Only a dose-safety
   * BLOCK check gates the final text — the one genuinely dangerous class.
   */
  private async runDirectReply(params: {
    systemPrompt: string;
    history: ChatTurn[];
    userText: string;
    rawUserText: string;
    intent: string;
    userId: string;
    tools: ToolRegistry;
    toolsEnabled: boolean;
    dbRules: DbContentRule[];
    dietaryRestriction?: DietaryRestriction;
    medicationType?: 'unknown' | 'weekly_injection' | 'daily_pill' | 'daily_injection';
    foodDislikes: string[];
    mediaPresent?: boolean;
    logger: Logger;
  }): Promise<OrchestratorOutput> {
    const t0 = Date.now();
    const toolResults: ToolResult[] = [];
    let logNote = '';
    // Deterministic food reply used as the guaranteed floor if the reply LLM
    // call returns empty/fails — a food message must NEVER go silent.
    let foodFallback = '';
    // A food-diary QUERY ("what have I eaten today") is answered deterministically
    // with the short aggregated summary (correct totals, one line) — not a
    // free-form LLM ramble. Set here, returned before the reply call.
    let earlyReply = '';
    // Per-stage latency (ms) — surfaced via internalTimings → messages.stage_timings
    // so /admin/latency can break down a direct/multi-part reply into extract vs
    // reply vs shape-regen. Measurement only; 0 means the stage didn't run.
    let extractMs = 0, replyMs = 0, regenMs = 0;

    // 1) Logging side-effect — the reply stays pure Gemini, but food/weight is
    //    persisted so totals are correct. Food uses the Nudge-style structured
    //    extraction: it splits items, logs confirmed ones, asks AT MOST ONE
    //    clarify for a genuinely-vague item (tracked as pending so a portion
    //    answer RESOLVES it instead of looping), and treats planning/queries as
    //    no-log.
    if (params.toolsEnabled && params.intent === 'weight_log') {
      const wlf = await tryWeightLogFastResponse(params.rawUserText, {
        pool: this.deps.pool,
        logger: params.logger,
        userId: params.userId,
        intentType: 'weight_log',
      }).catch(() => null);
      if (wlf) {
        // Remember it in the profile (current_weight + target), not just the log.
        void this.deps.users.syncCurrentWeight(params.userId, wlf.weightLbs).catch(() => undefined);
        toolResults.push({ name: 'log_weight', args: { weight_lbs: wlf.weightLbs }, ok: true, output: { weight_lbs: wlf.weightLbs, previous_lbs: wlf.previousLbs }, latencyMs: 0 });
        logNote = `\n\n[The user just shared their weight (${wlf.weightLbs} lbs) and it's been recorded. Acknowledge warmly, no judgment, no template.]`;
      }
    } else if (params.toolsEnabled && params.tools.has('log_food')) {
      // Food path: run the structured extraction when the message is food-shaped
      // OR there's a pending item awaiting a portion (a continuation like
      // "cup of spaghetti" classifies as general but must resolve the pending).
      const pending = await getPendingFood(this.deps.redis, params.userId).catch(() => []);
      // A food photo is already logged (or deferred to a pending question) in the
      // media branch, so skip text extraction here to avoid double-logging.
      // A clear "I ate X" also forces the food path even when the classifier
      // tagged the whole message something else (e.g. it leads with a question),
      // so a real consumption is never skipped before the extractor/backstop run.
      const consumptionSpanPre = foodSpanFromConsumption(params.rawUserText);
      // LATENCY: only pay for the (LLM) extraction pass when it could actually DO
      // something — a specific food to log, a consumption to log, a pending item
      // to resolve, a diary query to answer, or a delete/edit to apply. A pure
      // recommendation/planning question ("should I eat a big or small dinner?")
      // has nothing to extract, so skip the ~1.5s call and let the reply answer
      // directly. Guards are deterministic, so a delete/edit/query is never
      // skipped just because it names no food.
      const foodActionable =
        namesSpecificFood(params.rawUserText)
        || consumptionSpanPre != null
        || pending.length > 0
        || FOOD_DIARY_QUERY_RE.test(params.rawUserText)
        || FOOD_MUTATION_RE.test(params.rawUserText);
      const foodish = !params.mediaPresent
        && (params.intent === 'food_log' || params.intent === 'food_question'
            || pending.length > 0 || consumptionSpanPre != null)
        && foodActionable;
      if (foodish) {
        // Cap the extraction so a slow call can't stack onto the reply call and
        // make the turn look "stuck". On timeout we fall through to the
        // never-drop logger (a confident food_log still persists). 5s is ample
        // for the flash-lite JSON pass (typically ~1-2s); a slow tail degrades
        // to the deterministic backstop rather than blocking the reply.
        const extractStart = Date.now();
        const extraction = await Promise.race<FoodExtraction>([
          extractFood(this.deps.llm, params.logger, params.rawUserText, pending.map((p) => ({ item: p.item }))),
          new Promise<FoodExtraction>((resolve) => setTimeout(() => {
            params.logger.warn({ userId: params.userId }, 'food_extract.timeout');
            resolve({ ...EMPTY_EXTRACTION });
          }, 5000)),
        ]);
        extractMs = Date.now() - extractStart;

        if (extraction.intent === 'delete' && extraction.edit_ref && params.tools.has('remove_food')) {
          const r = await params.tools.execute({ name: 'remove_food', args: { food: extraction.edit_ref } }).catch(() => null);
          if (r?.ok) toolResults.push(r);
          await resolvePendingFood(this.deps.redis, params.userId, extraction.edit_ref).catch(() => {});
          logNote += `\n\n[The user asked to remove "${extraction.edit_ref}" from today's log — it's done. Confirm warmly and briefly.]`;
        } else if (extraction.intent === 'log' || extraction.intent === 'edit') {
          // Drop any "item" that is only a meal-TIME / container word with no
          // named dish ("breakfast", "a big lunch") — we don't know WHAT was
          // eaten, so it must never be logged or clarified as if it were a food
          // (prod: "I had breakfast late, skipped lunch…" → "Glad that's logged").
          // A definite CONSUMPTION ("I ate yogurt with berries") is already eaten,
          // so it must be LOGGED with a standard-portion estimate — never held as
          // pending_portion waiting for a "how much?" that makes no sense for a
          // finished meal. Production 2026-07-04: "I ate yogurt with berries …
          // any snack idea?" → the extractor marked BOTH items pending, the
          // multi-part reply answered the snack question, and the yogurt was
          // silently never logged (dashboard stayed empty). When the message is a
          // definite consumption, promote every specific item to confirmed.
          const isDefiniteConsumption = consumptionSpanPre != null;
          const specificItems = extraction.items.filter((i) => namesSpecificFood(i.item));
          let confirmed = isDefiniteConsumption
            ? specificItems
            : specificItems.filter((i) => i.status === 'confirmed');
          const newPending = isDefiniteConsumption
            ? []
            : specificItems.filter((i) => i.status === 'pending_portion');
          // A single stated meal ("yogurt with berries") is ONE meal, not one row
          // per ingredient — collapse its items into a single log entry so the
          // dashboard shows one meal with combined macros (prod 2026-07-04: yogurt
          // + berries showed as 2 separate meals). Guarded to a SINGLE-meal message
          // (splitMultiMealText ≤ 1) so a genuine multi-meal log ("eggs for
          // breakfast, chicken for lunch") still logs each meal separately.
          if (isDefiniteConsumption && confirmed.length > 1 && splitMultiMealText(params.rawUserText).length <= 1) {
            const allP = confirmed.every((i) => i.protein_g != null);
            const allC = confirmed.every((i) => i.calories != null);
            confirmed = [{
              item: confirmed.map((i) => i.item).join(', '),
              protein_g: allP ? confirmed.reduce((s, i) => s + (i.protein_g ?? 0), 0) : null,
              calories: allC ? confirmed.reduce((s, i) => s + (i.calories ?? 0), 0) : null,
              status: 'confirmed',
              clarify_question: null,
              // Combined meal: the least-confident part sets the meal's confidence;
              // no single serving_size for a collapsed multi-item meal.
              confidence: worstConfidence(confirmed.map((i) => i.confidence)),
              serving_size: null,
            }];
          }
          const loggedSummaries: string[] = [];
          let dailyProtein: number | undefined;
          let dailyCal: number | undefined;
          for (const it of confirmed) {
            // Pass the extraction's macros so log_food skips its own LLM
            // estimate (one fewer round-trip → faster, no "stuck" stacking).
            const logArgs: Record<string, unknown> = { food: it.item };
            if (it.protein_g != null && it.calories != null) {
              logArgs.protein_g = it.protein_g;
              logArgs.calories = it.calories;
            }
            const r = await params.tools.execute({ name: 'log_food', args: logArgs }).catch(() => null);
            if (r?.ok) {
              toolResults.push(r);
              const out = (r.output ?? {}) as Record<string, unknown>;
              const p = out.protein_g as number | undefined;
              const c = out.calories as number | undefined;
              dailyProtein = (out.daily_protein_g as number | undefined) ?? dailyProtein;
              dailyCal = (out.daily_calories as number | undefined) ?? dailyCal;
              loggedSummaries.push(`${it.item}${p != null ? ` (~${p}g protein${c != null ? `, ${c} cal` : ''})` : ''}`);
            }
          }
          // Clear resolved pending items. An "edit" IS the answer to a
          // clarification, so clear ALL pending (the portion may be phrased
          // differently than the pending item — "spaghetti" answering pending
          // "pasta"). A plain "log" only resolves pending items a confirmed
          // item clearly matches, so an unrelated pending stays.
          if (extraction.intent === 'edit') {
            await clearPendingFood(this.deps.redis, params.userId).catch(() => {});
          } else {
            for (const it of confirmed) {
              await resolvePendingFood(this.deps.redis, params.userId, it.item).catch(() => {});
            }
          }
          if (newPending.length > 0) {
            await addPendingFood(
              this.deps.redis,
              params.userId,
              newPending.map((i) => ({ item: i.item, clarify_question: i.clarify_question })),
            ).catch(() => {});
          }
          const parts: string[] = [];
          if (loggedSummaries.length > 0) {
            parts.push(`You just logged: ${loggedSummaries.join('; ')}.${dailyProtein != null ? ` Their running total today is about ${dailyProtein}g protein${dailyCal != null ? ` and ${dailyCal} calories` : ''}.` : ''} Acknowledge it warmly and naturally — never a template or a bare "Logged."`);
          }
          if (newPending.length > 0) {
            // Combine ALL vague foods into ONE friendly portion question (like the
            // competitor: "how much chicken, and how much pasta — maybe a cup?").
            const foods = newPending.map((i) => i.item).join(' and ');
            const hints = newPending.map((i) => i.clarify_question).filter((q): q is string => !!q);
            parts.push(`Before you can log ${loggedSummaries.length > 0 ? 'the rest' : 'it'}, ${foods} still ${newPending.length === 1 ? 'needs' : 'need'} a rough portion. Ask ONE short, warm question covering ${newPending.length === 1 ? 'it' : 'them all together'}, and suggest an easy ballpark so it's effortless to answer (e.g. "a cup or so", "a palm-sized piece").${hints.length > 0 ? ` For reference, the gist is: ${hints.join(' / ')}.` : ''} Do NOT log ${foods} yet, ask only this one question, and never re-ask on a later turn.`);
            // Deterministic floor if the reply LLM call fails.
            foodFallback = loggedSummaries.length > 0
              ? `Got that down. For the ${foods}, roughly how much of each — a cup, a handful, a couple? A ballpark and I'll log it accurately.`
              : `Got it, ${foods}. Roughly how much of each — a cup, a handful, a couple? A rough amount lets me log it accurately.`;
          } else if (loggedSummaries.length > 0) {
            const total = dailyProtein != null ? ` You're at about ${dailyProtein}g protein${dailyCal != null ? ` and ${dailyCal} calories` : ''} today.` : '';
            foodFallback = `Logged ${confirmed.map((i) => i.item).join(', ')}.${total}`;
          }
          if (parts.length > 0) logNote += `\n\n[FOOD — ${parts.join(' ')}]`;
        } else {
          // The extractor didn't return a structured log/edit/delete. Two
          // deterministic NEVER-DROP backstops before falling through, so real
          // intake is never silently lost:
          //   (a) mixed "I ate X … <question>": a consumption statement the
          //       single-intent extractor misread as query/none because the same
          //       message also asks something (prod: "I had salmon with potatoes
          //       and salad. How much protein is that, and what should I eat
          //       later?" → answered but never logged). foodSpanFromConsumption
          //       returns just the eaten-food span (question sliced off).
          //   (b) classic never-drop: the classifier is confident this is a
          //       food_log but the extractor whiffed — log the raw text via
          //       log_food's own estimator.
          // Never fire on an emotional / reflective paragraph (prod 2026-06-21:
          // a snacking-habits vent got force-logged) — the consumption span is a
          // targeted food phrase so it only needs the reflection-marker guard;
          // the raw-text never-drop also guards on length.
          const consumptionSpan = foodSpanFromConsumption(params.rawUserText);
          // Only never-drop a food_log-classified message that actually names a
          // specific food — never a bare "I had breakfast late" (no dish).
          const neverDrop = params.intent === 'food_log' && namesSpecificFood(params.rawUserText);
          const wordCount = params.rawUserText.trim().split(/\s+/).filter(Boolean).length;
          const looksReflective = REFLECTION_MARKER_RE.test(params.rawUserText)
            || (!consumptionSpan && wordCount > 22);
          const foodToLog = looksReflective ? null : (consumptionSpan ?? (neverDrop ? params.rawUserText : null));
          const r = foodToLog
            ? await params.tools.execute({ name: 'log_food', args: { food: foodToLog } }).catch(() => null)
            : null;
          if (looksReflective && (neverDrop || consumptionSpan)) {
            params.logger.info({ userId: params.userId }, 'ai.direct.never_drop_suppressed_reflection');
          }
          if (r?.ok) {
            toolResults.push(r);
            const out = (r.output ?? {}) as Record<string, unknown>;
            const protein = (out.daily_protein_g ?? out.protein_g) as number | undefined;
            const cal = (out.daily_calories ?? out.calories) as number | undefined;
            logNote += `\n\n[The user just logged food and it's been recorded.${protein != null ? ` Their running total today is about ${protein}g protein${cal != null ? ` and ${cal} calories` : ''}.` : ''} Acknowledge it warmly and naturally — no template, no bare "Logged." Then still answer any question they asked in the same message.]`;
            foodFallback = `Logged that for you.${protein != null ? ` You're at about ${protein}g protein${cal != null ? ` and ${cal} calories` : ''} today.` : ''}`;
            if (consumptionSpan) params.logger.info({ userId: params.userId }, 'ai.direct.consumption_backstop_logged');
          } else if (extraction.intent === 'query' && !consumptionSpan) {
            // "What have I eaten today" / "how much protein" → short, correct,
            // deterministic summary (the way it worked before direct mode).
            try {
              const summary = await this.deps.users.getTodaysFoodSummary(params.userId);
              earlyReply = renderDailyFoodSummary(summary.items, Math.round(summary.protein_g), Math.round(summary.calories));
            } catch { /* fall through to the normal reply */ }
          }
          // intent 'none' with no consumption span → no logging; reply answers normally.
        }
      }
    }

    // Deterministic food-query answer — short + correct, skip the LLM ramble.
    if (earlyReply) {
      return {
        text: earlyReply,
        confidence: 'high',
        intent: 'food_query',
        toolResults,
        usedRetrieval: false,
        latencyMs: Date.now() - t0,
        internalTimings: { directExtract: extractMs, directReply: 0, directRegen: 0 },
      };
    }

    // 2) The single Gemini call — system + history + user message. This IS the
    //    reply. temperature 0.8 / 500 tokens mirrors the competitor recipe.
    //    FOCUS DIRECTIVE: a hard guard against the model summarizing the whole
    //    conversation or stitching past topics (reminders + appointment + every
    //    past meal) into one mega-reply — reply ONLY to the latest message.
    // Multi-topic turns (feeling + food question, log + snack question, …) get
    // the plain-prose multi-part note in systemPrompt already. For those, the
    // enumerated "The parts: (1)… (2)…" directive below must NOT fire — quoting
    // the user's own sentences back as a numbered list is what pushed Gemini
    // into "Let's break down your questions…" meta-analysis (prod 2026-07-02).
    const isMultiTopicMsg = analyzeMessage(params.rawUserText).hasMultiple;
    const multiParts = splitQuestionParts(params.rawUserText);
    const focusDirective = isMultiTopicMsg
      ? '' // the multi-part note (plain prose, no enumeration) already covers it
      : multiParts.length >= 2
      ? `\n\n[REPLY FOCUS — the user asked SEVERAL things in ONE message. You MUST answer EVERY part, briefly, in the order asked — never stop after the first. The parts: ${multiParts.map((p, i) => `(${i + 1}) ${p}`).join(' ')}. Give a direct answer to each (one short sentence per part is fine), plain prose only — NO headers, NO bullet points, NO "Label:" lists. Cover them all even if the reply runs a few sentences.]`
      : `\n\n[REPLY FOCUS — non-negotiable: Respond ONLY to the user's most recent message below. LEAD WITH THE ANSWER — do NOT open by narrating what you'll do ("let's break down", "let's discuss", "here's how", "estimating X from…") and do NOT hedge ("it's tough to give an exact number"); just give the answer (for a food, commit to a rough number or range and say it's approximate). Keep it to 1–2 short sentences, plain prose — NO headers, NO "Label:" lists, NO bullet points. Do NOT summarize the conversation or list past meals/reminders/appointments. Do NOT give unsolicited nutrition facts or education (no "high in protein", "supports muscle growth", "low in calories", etc.) unless they explicitly ask. If it's a food log, ONLY warmly confirm what was logged OR ask the one portion question — nothing else.]`;
    // For a food/log turn, send NO chat history — the logNote already carries
    // exactly what to say (confirm the log, or ask the portion), and the pending
    // store carries portion-resolution context. Without this, the model reacts
    // to the PILE of past food fragments in history ("pasta and chicken", "cup
    // of spaghetti", repeated "eggs and cottage cheese") and tries to "rephrase
    // for clarity" or summarize instead of handling the current message.
    //
    // EXCEPT multi-topic turns: the bare log micro-prompt forbids answering
    // anything beyond the confirmation, which silently DROPPED the rest of the
    // message ("I ate yogurt… any snack idea?" → only "logged", no snack answer
    // — prod 2026-07-02). Those route through the full prompt with the logNote
    // appended, so the log is confirmed AND every other part gets answered.
    const isLogTurn = logNote.length > 0 && !isMultiTopicMsg;
    let messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
    if (isLogTurn) {
      // A log reply does NOT use the big personalized prompt — that prompt keeps
      // steering the model into nutrition essays / lists. A tiny scoped prompt +
      // the log note guarantees a short, warm, focused confirmation or the one
      // portion question. Still Gemini-generated, so it's warm and varied.
      const logSystem =
        `You are Grace, a warm and concise GLP-1 text companion replying over WhatsApp. The user just messaged you and an action was taken — see the note.${logNote}\n\nReply in ONE short, warm sentence (two at the very most), like a quick text from a friend. HARD RULES: plain conversational text ONLY — no headers, no "Label:" lists, no bullet points, no nutrition facts or education (do NOT explain that a food is "high in protein" / "supports muscle" / "low in calories"), and no extra questions beyond the single one in the note. Just confirm warmly, or ask only that one portion question.${GRACE_VOICE_ENABLED ? GRACE_VOICE_BRIEF : ''}`;
      messages = [
        { role: 'system', content: logSystem },
        { role: 'user', content: params.userText },
      ];
    } else {
      // logNote is '' on non-log turns; on a multi-topic log turn it carries the
      // "[just logged … running total …]" facts so the reply can confirm the log
      // while ALSO answering the message's other parts.
      messages = [
        { role: 'system', content: params.systemPrompt + logNote + focusDirective + voiceSuffix(params.history) },
        ...params.history.map((t) => ({ role: t.role, content: t.content })),
        { role: 'user', content: params.userText },
      ];
    }
    let text = '';
    try {
      // disableThinking: gemini-2.5-flash spends "thinking" tokens FROM the
      // maxOutputTokens budget — with thinking on, a 500-token cap can come back
      // truncated or empty. The competitor's base model doesn't reason, so we
      // match it: thinking off → the full budget goes to the reply, fast.
      //
      // STALL FLOOR: the provider already hard-caps a single call at 18s, but
      // 18s of silence FEELS stuck (the symptom that got this mode rolled back).
      // Race the reply against a tighter deterministic deadline so the floor
      // (foodFallback or a warm generic) fires fast instead of the user waiting
      // out the full upstream ceiling. Fail-open: a slow-but-fine answer is
      // traded for a fast safe one, never silence.
      const replyStart = Date.now();
      const resp = await Promise.race([
        this.deps.llm.generate({ messages, temperature: 0.8, maxOutputTokens: isLogTurn ? 200 : 500, disableThinking: true, skipCache: true }),
        new Promise<{ text: string } | null>((resolve) => setTimeout(() => {
          params.logger.warn({ userId: params.userId, intent: params.intent }, 'ai.direct.generate.timeout');
          resolve(null);
        }, DIRECT_REPLY_TIMEOUT_MS)),
      ]);
      replyMs = Date.now() - replyStart;
      text = (resp?.text ?? '').trim();
    } catch (err) {
      params.logger.error({ err: err instanceof Error ? err.message : String(err) }, 'ai.direct.generate.error');
    }

    // Format-enforce (as the orchestrator path does): strip headers / bullets /
    // "Label:" lists / em-dashes and cap length per intent. Without this the
    // direct reply ships the model's raw essay ("High in Protein: …") — the
    // WhatsApp-unfriendly verbose format the user flagged.
    if (text) {
      try {
        const formatted = enforceFormat(text, {
          messageContext: params.intent as MessageContext,
          userMessage: params.rawUserText,
        });
        if (formatted.text && formatted.text.trim().length > 0) text = formatted.text.trim();
      } catch { /* never block the reply on a formatter error */ }

      // Quality telemetry (length / multi-question). enforceFormat already
      // truncates + collapses questions deterministically, so this rarely needs
      // to act — it logs any residual verbosity so the lean path can be MEASURED
      // against the orchestrator during an A/B before it's made the default
      // (verbose essays were a documented reason this mode was rolled back).
      try {
        const issue = checkResponseQuality(text, params.intent as Parameters<typeof checkResponseQuality>[1]);
        if (issue) {
          params.logger.warn(
            { userId: params.userId, intent: params.intent, code: issue.code, replyLen: text.length },
            'ai.direct.quality_issue',
          );
        }
      } catch { /* telemetry only — never block the reply */ }

      // Deleak: strip any echoed internal note ("the user just logged food and
      // it's been recorded", stray "[...]" instructions) before it reaches the
      // user. Grace speaks in second person; "the user" / "been recorded" is
      // always an internal-instruction leak (production 2026-06-21).
      const deleaked = stripLeakedNotes(text);
      if (deleaked !== text) {
        params.logger.warn({ userId: params.userId, intent: params.intent }, 'ai.direct.note_leak_stripped');
        text = deleaked;
      }

      // ── GENERAL REPLY-SHAPE GUARD (2026-07-02) ────────────────────────────
      // The real fix, not another per-phrase strip: if the reply has ANY
      // structured shape — ≥2 "Label:" breakdowns, a heading, or a list —
      // regardless of the exact words, regenerate it ONCE as a plain text with a
      // hard minimal prompt. It validates STRUCTURE, so it catches every wording
      // and variation, not a specific message kind. Skips log turns (already
      // scoped) and only adopts the rewrite if it's actually cleaner.
      if (!isLogTurn && looksStructured(text)) {
        params.logger.warn(
          { userId: params.userId, intent: params.intent, preview: text.slice(0, 80) },
          'ai.direct.structured_regen',
        );
        try {
          const hardSystem =
            `You are Grace, a warm GLP-1 text companion. Reply to the user's message as ONE natural iMessage: 1 to 3 short sentences of plain prose, like texting a friend. ABSOLUTELY FORBIDDEN: headings, titles, "Label:" breakdowns, bullet points, numbered lists, "Option 1/2", and ANY preamble ("here's", "let's break down", "estimating…", "that sounds like…"). Answer EVERY part of their message directly; for a food give a quick number or range and what to have next if they asked. Just talk to them.`;
          const regenStart = Date.now();
          const regen = await Promise.race([
            this.deps.llm.generate({
              messages: [
                { role: 'system', content: hardSystem },
                { role: 'user', content: params.userText },
              ],
              temperature: 0.6,
              maxOutputTokens: 320,
              disableThinking: true,
            }),
            new Promise<{ text: string } | null>((resolve) => setTimeout(() => resolve(null), DIRECT_REPLY_TIMEOUT_MS)),
          ]);
          regenMs = Date.now() - regenStart;
          let regenText = (regen?.text ?? '').trim();
          if (regenText) {
            try {
              const rf = enforceFormat(regenText, { messageContext: params.intent as MessageContext, userMessage: params.rawUserText });
              if (rf.text && rf.text.trim().length > 0) regenText = rf.text.trim();
            } catch { /* keep regenText */ }
            regenText = stripLeakedNotes(regenText);
            // Only adopt it if the rewrite is actually clean (not still structured).
            if (regenText.length > 0 && !looksStructured(regenText)) {
              text = regenText;
              params.logger.info({ userId: params.userId, intent: params.intent }, 'ai.direct.structured_regen.applied');
            }
          }
        } catch (err) {
          params.logger.warn(
            { err: err instanceof Error ? err.message : String(err) },
            'ai.direct.structured_regen.error',
          );
        }
      }
    }

    let usedSafeFallback = false;
    if (!text) {
      // Food messages get a food-aware deterministic floor (confirm the log or
      // ask the portion) so they NEVER go silent, even if Gemini is down.
      text = foodFallback || 'I’m right here with you. Tell me a little more and I’ll help however I can.';
      usedSafeFallback = true;
    }

    // 3) Dose-safety BLOCK check ONLY — the genuinely dangerous class (advising
    //    an extra/double dose, prescribing). Everything else ships as written.
    try {
      const violations = checkContent(text, {
        ...(params.dbRules.length > 0 ? { dbRules: params.dbRules } : {}),
        ...(params.dietaryRestriction ? { dietaryRestriction: params.dietaryRestriction } : {}),
        ...(params.foodDislikes.length > 0 ? { foodDislikes: params.foodDislikes } : {}),
        ...(params.medicationType && params.medicationType !== 'unknown' ? { medicationType: params.medicationType } : {}),
        userMessage: params.rawUserText,
        intentType: params.intent,
        trustGemini: true,
      });
      const block = violations.filter((v) => v.severity === 'block');
      if (block.length > 0) {
        params.logger.warn({ userId: params.userId, block: block.map((b) => b.message) }, 'ai.direct.block_violation');
        text = 'That’s one to run by your prescriber — they know your dose and history and can give you the safe answer. Want help thinking through what to ask them?';
        usedSafeFallback = true;
      }
    } catch { /* never block the reply on a checker error */ }

    params.logger.info(
      { userId: params.userId, intent: params.intent, latencyMs: Date.now() - t0, extractMs, replyMs, regenMs, replyLen: text.length, logged: toolResults.length > 0 },
      'ai.direct.reply',
    );

    return {
      text,
      confidence: 'high',
      intent: params.intent,
      toolResults,
      usedRetrieval: false,
      latencyMs: Date.now() - t0,
      usedSafeFallback,
      internalTimings: { directExtract: extractMs, directReply: replyMs, directRegen: regenMs },
    };
  }

  /**
   * Personalization gather GATE — runs EARLY, before every answer path (food,
   * knowledge, emotional, general…), so Grace gathers the data she needs to be
   * specific to THIS user, on any kind of question — "knows them well".
   *
   * Two outcomes:
   *   - { reply }: this question needs a missing detail to be specific, so ask
   *     for it first (warm, one question) and stash the original question. We
   *     short-circuit and send `reply`.
   *   - { text }: the user just answered a gather question — we persist it and
   *     REPLAY the original question (returned as `text`) so the rest of the
   *     pipeline answers it, now personalized.
   *   - {}: nothing to do — answer the message normally.
   *
   * Relevance-only (it never interrupts a non-personalization message), and the
   * 20h throttle on the *next* ask keeps it from feeling like a survey. Flag-
   * gated (progressiveProfile) + best-effort (never blocks the reply).
   */
  private async progressiveGatherGate(input: InboundMessage): Promise<{ reply?: string; text?: string }> {
    const redis = this.deps.redis;
    const phone = input.userId;
    const nowMs = Date.now();

    if (input.media.length > 0 || !input.text.trim()) return {};
    // Never interrupt a multi-topic message with a data-collection question —
    // the user asked for several things; answer them, don't interrogate. The
    // multi-part handler covers these, and asking "what's your activity level?"
    // in the middle of a real question is exactly the "out of nowhere" behavior
    // to avoid (2026-07-02).
    if (analyzeMessage(input.text).hasMultiple) return {};
    const user = await this.deps.users.getById(phone).catch(() => null);
    if (!user) return {};
    // The onboarding flow owns data collection — never ask-first mid-signup.
    if (user.onboarding_state === 'in_progress') return {};

    // 1. Pending answer from a gather question we asked last turn?
    const pending = await getPendingProfileAsk(redis, phone);
    if (pending) {
      let captureFields = parseProfileReply(pending, input.text).fields;
      let captured = !!captureFields && Object.keys(captureFields).length > 0;
      let llmDeclined = false;
      // LLM-normalize fallback (parity with onboarding): when the deterministic
      // parser misses a reasonable answer — a bare "Move", a typo, slang, an
      // abbreviation — recover it via the LLM (re-validated through the strict
      // parser), so a field the user DID answer is captured the FIRST time and
      // never re-asked. Returns null on a topic-change, so it can't mis-capture.
      // Only pays for the call on the miss path, and never for an obvious decline.
      if (!captured && !isGatherDecline(input.text)) {
        const recovered = await understandSlotWithLlm(
          pending as unknown as OnboardingSlotId,
          input.text,
          this.deps.llm,
          { logger: this.deps.logger },
        ).catch(() => null);
        if (recovered?.ok && recovered.fields && Object.keys(recovered.fields).length > 0) {
          captureFields = recovered.fields as typeof captureFields;
          captured = true;
        } else if (recovered?.ok && recovered.skipped) {
          llmDeclined = true; // LLM read it as "don't know / skip"
        }
      }
      if (captured) {
        // Persist the RAW datum the user gave (weight/height/etc.) — that's their
        // input, not a Grace-invented number. We deliberately do NOT derive+store
        // a protein/calorie TARGET here anymore: settings numbers are the user's
        // to set. The replayed question answers by SUGGESTING a target (with the
        // why) and pointing to Settings — Grace never writes the target itself.
        await this.deps.users.update(phone, captureFields!).catch(() => {});
        this.deps.logger.info({ userId: phone, slot: pending, captured: Object.keys(captureFields!) }, 'progressive_profile.captured');
      }
      const declined = !captured && (llmDeclined || isGatherDecline(input.text));
      if (captured || declined) {
        // On decline, persist a "no restriction" sentinel so the field reads as
        // FILLED and we never re-ask it (no sticky timer needed — the data is
        // the source of truth). Then REPLAY the original question.
        if (declined) {
          const sentinel = declineSentinel(pending);
          if (sentinel) await this.deps.users.update(phone, sentinel).catch(() => {});
          this.deps.logger.info({ userId: phone, slot: pending }, 'progressive_profile.declined');
        }
        await clearPendingProfileAsk(redis, phone);
        const replay = await getReplayQuery(redis, phone);
        await clearReplayQuery(redis, phone);
        if (replay) {
          this.deps.logger.info({ userId: phone, slot: pending, captured }, 'progressive_profile.replay');
          return { text: replay };
        }
        return {};
      }
      // The reply was neither an answer nor a skip — the user moved on. Drop the
      // stale pending and treat THIS message as fresh (fall through to step 2).
      await clearPendingProfileAsk(redis, phone);
      await clearReplayQuery(redis, phone);
    }

    // 2. Relevance-first: this question needs a missing field to be specific —
    //    ask for it first. The ONLY guard is whether the field is actually
    //    filled (handled by relevantProfileSlot) — no time-based marker, which
    //    previously got stuck in Redis across re-onboards and silently
    //    suppressed every clarification (prod 2026-06-28).
    const slot = relevantProfileSlot(user, input.text);
    if (!slot) return {};
    await setPendingProfileAsk(redis, phone, slot, nowMs);
    await setReplayQuery(redis, phone, input.text);
    this.deps.logger.info({ userId: phone, slot }, 'progressive_profile.gather_first');
    return { reply: buildGatherClarify(slot) };
  }

  /**
   * Progressive profiling — the PROACTIVE half (the gather GATE above handles
   * relevance + pending answers). On an ordinary neutral turn, maybe weave ONE
   * gentle question into the reply to fill the next missing field, throttled so
   * it never feels like a survey. Returns the (possibly augmented) directContextNote.
   */
  private async applyProgressiveProfiling(input: InboundMessage, directContextNote: string): Promise<string> {
    const redis = this.deps.redis;
    const phone = input.userId;

    // Pending answers + relevance-first gathering are handled EARLIER by
    // progressiveGatherGate (so they apply to every answer path). Here we only
    // do the throttled PROACTIVE ask: weave ONE gentle question to fill a missing
    // field, preferring one RELEVANT to what the user is talking about. Never
    // stacks onto another intercept's note, a media turn, or an empty message.
    if (directContextNote || input.media.length > 0 || !input.text.trim()) return directContextNote;
    // Never tack a gather question onto a MULTI-TOPIC message — the user asked
    // for several things; answering all of them is the whole job, and the
    // multi-part note owns that turn. Mirrors the same guard in the ask-first
    // progressiveGatherGate (2026-07-02) so gathering never disrupts multi-part.
    if (analyzeMessage(input.text).hasMultiple) return directContextNote;

    const nowMs = Date.now();
    // Throttle to at most ONE proactive gather per cooldown window so it never
    // feels like a survey (applies to both contextual and blind asks).
    if (await askedProfileRecently(redis, phone, PROFILE_GATHER_COOLDOWN_HOURS, nowMs)) return directContextNote;
    const user = await this.deps.users.getById(phone).catch(() => null);
    if (!user) return directContextNote;

    // Prefer a slot relevant to THIS turn's topic (medication talk → injection
    // day, exercise → activity, progress → goal weight, food → dislikes) so the
    // follow-up reads like a friend's natural curiosity, not a blind next-field
    // ask. A contextual slot whose next-turn answer has a STRICT parser (weekday
    // / activity level / wake+sleep times — none can be mis-read as a weight or
    // number) may weave even on a topical turn; every other slot (incl. the blind
    // next-missing fallback) only weaves on a NEUTRAL turn to protect the parse
    // and avoid asking mid-log.
    const safeTurn = gatherSafeTurn(input.text);
    const ctx = contextualGatherSlot(user, input.text);
    const CONTEXTUAL_ANY_TURN = new Set<ProgressiveSlot>(['injection_day', 'activity', 'wake_sleep']);
    let slot: ProgressiveSlot | null = null;
    if (ctx && (safeTurn || CONTEXTUAL_ANY_TURN.has(ctx))) slot = ctx;
    else if (safeTurn) slot = nextMissingProfileSlot(user);
    if (!slot) return directContextNote;

    await setPendingProfileAsk(redis, phone, slot, nowMs);
    this.deps.logger.info(
      { userId: phone, slot, trigger: ctx === slot ? 'contextual' : 'proactive' },
      'progressive_profile.ask',
    );
    return directContextNote + buildProfileGatherNote(slot);
  }

  // Full message processing flow: (1) parallel I/O (user profile, history, media
  // analysis, tool settings), (2) RAG retrieval + planner + user memory in parallel,
  // (3) detect dietary restrictions + side effects, (4) build personalised system
  // prompt with runtime context, (5) register per-request tools, (6) call
  // orchestrator.run(), (7) fire-and-forget persistence + memory extraction.
  private async handleMessageInner(input: InboundMessage, t0: number, lat: LatencyTracker, reconHint?: string, directContextNote?: string): Promise<OrchestratorOutput> {
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
          fallbackModel: this.deps.geminiFallbackModel,
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

    // Phase D — memory.md fetch in parallel with the rest of parallel_io.
    // Returns null when the user is not enrolled in the pilot (no row in
    // user_memory_md). The 5-min in-memory cache catches repeat reads.
    const memoryMdPromise: Promise<string | null> = this.deps.memoryMd
      ? this.deps.memoryMd.get(input.userId).catch(() => null)
      : Promise.resolve(null);

    const [userLoaded, conversationId, isNew, history, toolSettings, description, todaysFood, checkinsToday, knownFacts, phase4, memoryMd] = await Promise.all([
      users.getById(input.userId).catch(() => null),
      conversationPromise,
      users.isNewUser(input.userId).catch(() => false),
      memory.getRecentTurns(input.userId, this.deps.historyTurns ?? 12).catch(() => [] as ChatTurn[]),
      flags.toolsEnabled ? this.loadToolSettings() : Promise.resolve({} as Record<string, boolean>),
      mediaPromise,
      users.getTodaysFoodSummary(input.userId).catch(() => ({ protein_g: 0, calories: 0, items: [] })),
      this.countTodaysCheckIns(input.userId).catch(() => 0),
      users.getKnownFacts(input.userId, 30).catch(() => []),
      phase4Promise,
      memoryMdPromise,
    ]);
    const conversationSummary = phase4.summary;
    const activeTopic = phase4.topic;

    // Learn durable profile changes the user just stated ("switched to Mounjaro",
    // "my goal is 160 now", "I inject on Fridays"). Returns the same object when
    // nothing was learned; otherwise a merged copy so THIS turn's prompt — and,
    // via the persisted column, every future turn — uses the fresh value. The
    // structured profile is the highest-precedence context layer, so this is how
    // a recent correction wins over stale onboarding/memory.
    const user = await this.tryLearnProfile(input, userLoaded, logger);

    // Fold media description into the prompt (only after Promise.all resolves).
    let augmentedText = input.text;
    // True once a food photo has been logged deterministically in this block,
    // so the downstream text force-log paths don't double-count it.
    let imageFoodAutoLogged = false;

    // Pre-compute gap so the inline instruction blocks for voice/image can be
    // gap-aware. Same threshold as buildPersonalisedPrompt: >24h = stale history.
    const hoursSinceLastReply = user?.last_reply_at
      ? (Date.now() - new Date(user.last_reply_at).getTime()) / 3_600_000
      : 0;
    const staleHistoryNote = hoursSinceLastReply > 24
      ? ` CONVERSATION GAP: ${Math.floor(hoursSinceLastReply / 24)} day(s) since last message — do NOT reference any previous conversation topics from history.`
      : '';

    // analyzeMedia resolves the TRUE media type (it sniffs the bytes); an image
    // analysis always carries an "IMAGE_TYPE:" marker. The inbound media kind can
    // be 'other' when the iMessage relay gives an extensionless URL, so trust the
    // analysis marker over the URL-derived kind for ALL image routing + guards.
    const analyzedAsImage = !!description && /IMAGE_TYPE:/i.test(description);
    const hasImageMedia = input.media.some((m) => m.kind === 'image') || analyzedAsImage;

    if (description) {
      const kind = analyzedAsImage ? 'image' : input.media[0]?.kind;
      if (kind === 'audio' && !input.text) {
        augmentedText = `[Voice note — auto-transcribed, may have filler words or fragments. Respond naturally.${staleHistoryNote}]\n${description}`;
      } else if (kind === 'image') {
        const userIntent = input.text ? `The user said: "${input.text}"\n\n` : '';
        if (description.includes('IMAGE_TYPE: food')) {
          // Nudge-style flow: only auto-log when it's clearly an EATEN meal we're
          // confident about. Ambiguous photos (a fruit bowl, groceries, unclear
          // portion) get described + a single confirm question — never silently
          // logged with a fabricated number (the "basket of bananas → 22g logged"
          // production bug).
          const { mealStatus, confidence, items: itemsText, proteinTotal, caloriesTotal, ask, autoLog } =
            parseFoodImageAnalysis(description);

          if (autoLog) {
            // Confident eaten meal → log deterministically (works in both direct
            // and orchestrator mode), then let Gemini phrase a NATURAL confirmation
            // with the real running total.
            const est = {
              items: itemsText.split(',').map((s) => ({ food: s.trim() })).filter((i) => i.food.length > 0),
              protein_g: proteinTotal as number,
              calories: caloriesTotal,
            };
            const totals = await this.persistEstimatedFood(input.userId, est, `photo: ${itemsText}`).catch(() => null);
            imageFoodAutoLogged = true;
            logger.info({ userId: input.userId, protein: proteinTotal, confidence, items: itemsText.slice(0, 80) }, 'ai.image_food.auto_logged');
            const totalsClause = totals && totals.goal > 0
              ? ` They're now at ${totals.dailyProtein}g of ${totals.goal}g protein today — weave that in naturally if it fits.`
              : '';
            const confNote = confidence === 'medium' ? ' Treat the number as a rough estimate.' : '';
            augmentedText = `${userIntent}The user sent a photo of a meal they're eating. You identified: ${itemsText} (~${proteinTotal}g protein${caloriesTotal ? `, ~${caloriesTotal} cal` : ''}). It's already logged.${totalsClause}${confNote}\n\n[Reply like a warm friend in 1–2 short sentences: briefly name what you see, give the ~protein number, and confirm it's logged. NEVER recite a per-item breakdown or macro table. NEVER ask for portions, grams, or ounces.${staleHistoryNote}]`;
          } else {
            // Ambiguous (fruit bowl, groceries, unclear portion, or low confidence)
            // → DON'T log. Describe what you see + ask ONE quick question, and stash
            // a pending item so the user's portion answer logs it next turn (the
            // existing text food-extract pending path resolves it).
            const pendingItem = (itemsText || 'the food in the photo').slice(0, 120);
            const question = ask || 'Did you eat some, and roughly how much?';
            await addPendingFood(this.deps.redis, input.userId, [{ item: pendingItem, clarify_question: question }]).catch(() => {});
            logger.info({ userId: input.userId, mealStatus, confidence, items: itemsText.slice(0, 80) }, 'ai.image_food.ambiguous_ask');
            augmentedText = `${userIntent}The user sent a food photo, but it isn't clearly a meal they're eating right now — it looks like ${itemsText || 'food'} (could be sitting out, groceries, or an unclear portion), so nothing has been logged yet.\n\n[Reply like a warm friend in 1–2 short sentences: briefly say what you see, then ask "${question}" so you can log it accurately. Do NOT claim you logged anything. Do NOT state a protein number.${staleHistoryNote}]`;
          }
        } else if (description.includes('IMAGE_TYPE: body')) {
          augmentedText = `${userIntent}The user shared a body/progress photo. Analysis:\n\n${description}\n\n[Respond warmly and personally using the observations above. Tie it to their GLP-1 weight-loss journey and encourage them. CRITICAL: Do NOT mention pain, discomfort, injuries, or any medical conditions — this is a progress selfie, not a medical photo. Do NOT invent symptoms or anything not in the analysis above. Do NOT call any logging tools.${staleHistoryNote}]`;
        } else {
          augmentedText = `${userIntent}The user sent an image. ${description}${staleHistoryNote ? ' ' + staleHistoryNote.trim() : ''}`;
        }
      } else {
        augmentedText = `${input.text}\n\n[media: ${description}]`.trim();
      }
    } else if (input.media.length > 0) {
      // Media WAS attached but analysis returned nothing (a transient media-fetch
      // or Gemini failure, or an unsupported format). This fires whether or not
      // the user added a caption — previously it only handled the no-caption case,
      // so a photo sent WITH text (the common case) fell through with no media
      // note, and the model free-formed "I'm not seeing the images" (the exact
      // production MMS failure). NEVER let the model deny it can see/receive
      // images — that contradicts a real capability and confuses the user. Always
      // acknowledge the attachment arrived and ask them to resend.
      const kind = input.media[0]?.kind;
      const caption = input.text.trim() ? ` They also wrote: "${input.text.trim()}".` : '';
      if (kind === 'image') {
        augmentedText = `[The user sent you a PHOTO, but it didn't come through clearly on this turn (it couldn't be opened).${caption} Warmly acknowledge you received their photo, say it didn't load properly THIS time, and ask them to send it once more (or describe what's in it). NEVER say you can't see, receive, or view images — you can; this one just didn't load.]`;
      } else if (kind === 'audio') {
        augmentedText = `[The user sent a voice message but it couldn't be transcribed on this turn.${caption} Warmly acknowledge it, say it didn't come through this time, and ask them to resend it or type what they were saying. NEVER say you can't receive voice messages — you can; this one just didn't load.]`;
      } else {
        augmentedText = `[The user sent an attachment that couldn't be opened on this turn.${caption} Warmly acknowledge it and ask them to resend it or describe what they wanted to share.]`;
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
      // 2026-06-06 v3 — production latency audit:
      //   - emotional: P95 12s, with rag_planner_memory burning 500-700ms
      //     per message. The emotional direct-path system prompt is a
      //     focused 4-step framework with worked examples — it never
      //     reads input.retrieved. RAG was pure dead weight on this
      //     intent. The orchestrator-fallthrough case is also fine
      //     because the emotional typed fallbacks + Level 2 ladder
      //     pattern don't reference KB content either.
      //   - appointment_prep: response is 3-5 prescriber questions
      //     tied to the user's medication/dose/journey. The direct-path
      //     prompt provides the structure; KB chunks aren't used.
      //   - social_situation: same — template-style advice driven by
      //     prompt rules, not KB facts.
      // medication_question and knowledge remain RAG-eligible — they
      // can genuinely benefit from KB chunks.
      'emotional',
      'appointment_prep',
      'social_situation',
    ]);
    const ragSkippedForIntent = RAG_SKIP_INTENTS.has(intentClass.type);

    // User-memory skip on the same intents — long-term memory chunks are about
    // background context (preferences, history) which doesn't change how Grace
    // confirms a log or replies to a greeting. Saves another ~150-300ms.
    const userMemorySkipped = RAG_SKIP_INTENTS.has(intentClass.type);

    lat.mark('rag_planner_memory');
    const [retrieved, userMemories, prePlannedDecisionRaw, dashboardSignals] = await Promise.all([
      flags.ragEnabled && !ragSkippedForIntent
        ? rag.retrieve(augmentedText, { userId: input.userId, topK: 5 })
        : Promise.resolve([]),
      this.deps.userMemory && !userMemorySkipped
        ? this.deps.userMemory.retrieve(input.userId, augmentedText, 3)
        : Promise.resolve([] as string[]),
      skipPlanner
        ? Promise.resolve<PlannerDecision>({ intent: 'chat', needsTools: false, toolCalls: [], rationale: `classifier_fast_path_${intentClass.type}` })
        : planner.plan(augmentedText).catch((): PlannerDecision => ({ intent: 'chat', needsTools: false, toolCalls: [], rationale: 'planner_error' })),
      // Derived dashboard signals (weight/streak/mood/symptom patterns) — grounds
      // the reply in the user's real progress. Best-effort, cached 60s.
      this.gatherDashboardSignals(input.userId, user).catch(() => null),
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

    // ── Nudge-style food handling (orchestrator path) ────────────────────────
    // Structured extraction → log confirmed items, ask AT MOST ONE combined
    // portion question for vague ones (pending-tracked so a portion answer
    // resolves it, never loops), short warm deterministic reply. Falls through
    // to the legacy vague-food gate + orchestrator on query/planning/non-food/
    // extractor-failure, so it can never regress below the previous behavior.
    if (!this.directReplyMode) {
      lat.mark('nudge_food');
      const nudgeFood = await this.tryNudgeFoodHandler(input, intentClass.type, conversationId, t0).catch((err) => {
        this.deps.logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'ai.nudge_food.error');
        return null;
      });
      if (nudgeFood) {
        this.persistLatency(input.userId, nudgeFood.intent, Date.now() - t0, lat.snapshot(), input.text, nudgeFood.text);
        return nudgeFood;
      }
    }

    lat.mark('vague_food_check');
    // DIRECT REPLY MODE: do NOT run the deterministic vague-food clarification
    // loop — it was asking repeatedly ("what kind?" → "sauce?" → "how much?")
    // and frustrating users. In direct mode the food is logged immediately via
    // log_food (which produces a reasonable estimate) and Gemini confirms warmly,
    // matching the competitor. Gemini can still invite a portion correction in
    // its own words, but it never loops.
    if (flags.toolsEnabled && !this.directReplyMode) {
      // requireQuantity only when this is actually a food LOG — so the bare-food
      // "how much?" ask never fires on a food question / casual mention.
      const vague = detectVagueFood(input.text, lastGraceMessage, {
        requireQuantity: intentClass.type === 'food_log',
      });
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

    // ── Health-concern guard ────────────────────────────────────────────────
    // A personal concern / guidance request about an out-of-scope vital (blood
    // pressure, heart rate, palpitations, cholesterol) must NOT be force-logged
    // or answered with generic education. Respond supportively: acknowledge,
    // ask focused clarifying questions, and point to their clinician — calm and
    // within scope. Runs BEFORE the FAQ cache and the force-log so a health
    // concern can never become "Logged." (production failure 2026-06-13).
    // Crisis/emergency wording is handled earlier by the SafetyGuard.
    if (flags.toolsEnabled) {
      const health = detectHealthConcern(input.text, lastGraceMessage);
      if (health.concern) {
        this.deps.logger.info(
          { userId: input.userId, vital: health.vital, textPreview: input.text.slice(0, 100) },
          'ai.handle.health_concern',
        );
        void this.deps.memory.appendTurn({ userId: input.userId, conversationId, role: 'user', content: input.text })
          .catch((err) => this.deps.logger.warn({ err }, 'health_concern.append_user.failed'));
        void this.deps.memory.appendTurn({ userId: input.userId, conversationId, role: 'assistant', content: health.response! })
          .catch((err) => this.deps.logger.warn({ err }, 'health_concern.append_assistant.failed'));
        return {
          text: health.response!,
          intent: 'health_concern',
          confidence: 'high' as const,
          toolResults: [],
          usedRetrieval: false,
          latencyMs: Date.now() - t0,
        };
      }
    }

    // ── Reasoning-request intercept ("How 88g" / "why" about a number) ───────
    // When the user challenges a number Grace JUST gave ("How 88g", "how 88 g
    // of protein", "why 32"), explain that number deterministically — never
    // switch topics or let Gemini ramble. detectReasoningRequest is gated on
    // the prior Grace turn actually containing a number/target, so it only
    // fires when there IS something to explain. Production failure 2026-06-13:
    // "How 88g" → generic GLP-1 fallback; "How 88 g of protein" → a confused
    // re-ask of what they ate (which they'd already told Grace).
    if (flags.toolsEnabled && detectReasoningRequest(input.text, lastGraceMessage)) {
      // First try a REAL per-item breakdown from today's logged rows. When the
      // number being challenged is a protein/calorie total ("How 88g", "how 88
      // g of protein"), walk the user through the actual foods that summed to
      // it — "Your 88g adds up from Eggs ~12g, Pizza ~44g, Salmon ~22g, Rice
      // ~4g." This is the accurate, itemized answer; the generic explanation
      // below is the fallback when nothing's logged or the number isn't a
      // food total. items_detailed always sums to the stored total, so the
      // breakdown can never contradict the number Grace already gave.
      let explanation: string | null = null;
      const lastMsgLower = (lastGraceMessage ?? '').toLowerCase();
      const isCalorieReasoning = /\b[\d,]+\s*(cal|calorie|kcal)/i.test(lastMsgLower) && !/\d+\s*g\b/i.test(lastMsgLower);
      const isProteinReasoning = /\d+\s*g\b|protein/i.test(lastMsgLower);
      if (isCalorieReasoning || isProteinReasoning) {
        const todays = await this.deps.users.getTodaysFoodSummary(input.userId).catch(() => null);
        if (todays && todays.items_detailed.length > 0) {
          explanation = isCalorieReasoning
            ? renderCalorieBreakdown(todays.items_detailed, todays.calories)
            : renderProteinBreakdown(todays.items_detailed, todays.protein_g);
        }
      }
      if (!explanation) {
        const { getToolAwareFallback } = await import('@grace/ai-core');
        explanation = getToolAwareFallback(intentClass.type, [], {
          isReasoningRequest: true,
          lastAssistantMessage: lastGraceMessage,
          userMessage: input.text,
        });
      }
      this.deps.logger.info({ userId: input.userId, textPreview: input.text.slice(0, 60) }, 'ai.handle.reasoning_explanation');
      void this.deps.memory.appendTurn({ userId: input.userId, conversationId, role: 'user', content: input.text })
        .catch((err) => this.deps.logger.warn({ err }, 'reasoning.append_user.failed'));
      void this.deps.memory.appendTurn({ userId: input.userId, conversationId, role: 'assistant', content: explanation })
        .catch((err) => this.deps.logger.warn({ err }, 'reasoning.append_assistant.failed'));
      return {
        text: explanation,
        intent: 'reasoning_explanation',
        confidence: 'high' as const,
        toolResults: [],
        usedRetrieval: false,
        latencyMs: Date.now() - t0,
      };
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
      // GEMINI-FIRST: the FAQ cache ships a canned educational answer. Quality
      // mode skips it so the orchestrator generates a contextual reply that
      // weaves in this user's medication, week number, and recent logs.
      !this.geminiFirst &&
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
        const cachedDietary = effectiveDietaryRestriction(user);
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
          // DB rules included so admin-managed bans apply to cached
          // responses too (dose-safety block rules live only in the DB).
          ...(await this.getDbRules().then((r) => (r.length > 0 ? { dbRules: r } : {}))),
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

    // Meal-lifecycle guard (2026-06-15): preference / planning language
    // ("X sounds good", "I'll have the dal", "maybe the omelet") is NOT
    // consumption and must never be force-logged. The early preference guard in
    // handleMessage already short-circuits these, but this is defense-in-depth
    // so a reorder can't silently start logging un-eaten meals again.
    const isMealPreference = detectMealConsumption(input.text) === 'preference';
    const shouldForceLogFood =
      input.media.length === 0 && // image food is logged in the media branch above
      !imageFoodAutoLogged &&
      !hasFoodDistress &&
      !isMealPreference &&
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
      // 2026-06-14: when a multi-meal message mixes a CLEAR meal with a purely
      // VAGUE one ("Had two eggs for breakfast. Now having a small snack"), log
      // the clear meal(s) deterministically and ASK about the vague one — never
      // fabricate a macro estimate for "a small snack" (the production bug:
      // eggs were dropped and the snack was logged as a guessed "snack plate").
      if (meals.length >= 2) {
        // A meal is "vague" (worth asking about) ONLY when it names NO specific
        // food ("a small snack", "some food"). A meal that names real food — even
        // without a quantity ("chicken and rice") — is CLEAR and gets logged with
        // a standard estimate, never dropped or turned into a phantom "snack"
        // question (prod 2026-07-04: "2 eggs for breakfast. For lunch chicken and
        // rice" logged only the eggs and asked "what was the snack?"). Every named
        // meal is logged deterministically here and we RETURN, so nothing depends
        // on a downstream path that may not re-log it under directReplyMode.
        const clearMeals = meals.filter((m) => namesSpecificFood(m));
        const vagueMeals = meals.filter((m) => !namesSpecificFood(m));
        if (clearMeals.length >= 1) {
          const clearText = clearMeals.join('. ');
          const est = estimateMultiItemFood(clearText);
          if (est && est.items.length > 0) {
            const totals = await this.persistEstimatedFood(input.userId, est, clearText).catch(() => null);
            const names = est.items.map((i) => i.food);
            const last = names.pop()!;
            const list = names.length > 0 ? `${names.join(', ')}, and ${last}` : last;
            const macros = est.calories > 0
              ? `about ${est.protein_g}g protein and ${est.calories} calories`
              : `about ${est.protein_g}g protein`;
            const totalsClause = totals && totals.goal > 0 ? ` You're at ${totals.dailyProtein}g/${totals.goal}g today.` : '';
            // Only ask when a meal genuinely named no food.
            const reply = vagueMeals.length >= 1
              ? `Got it — ${list}. Roughly ${macros}.${totalsClause} What was the ${findVagueAddOnItem(input.text) ?? 'other one'}, so I can log that too?`
              : `Got it — ${list}. Roughly ${macros}.${totalsClause}`.trim();
            this.deps.logger.info(
              { userId: input.userId, clearMeals: clearMeals.length, vagueMeals: vagueMeals.length },
              'ai.handle.multi_meal_logged',
            );
            void this.deps.memory.appendTurn({ userId: input.userId, conversationId, role: 'user', content: input.text })
              .catch((err) => this.deps.logger.warn({ err }, 'multi_meal.append_user.failed'));
            void this.deps.memory.appendTurn({ userId: input.userId, conversationId, role: 'assistant', content: reply })
              .catch((err) => this.deps.logger.warn({ err }, 'multi_meal.append_assistant.failed'));
            return {
              text: reply,
              intent: 'food_log',
              confidence: 'high' as const,
              toolResults: [],
              usedRetrieval: false,
              latencyMs: Date.now() - t0,
            };
          }
        }
      }
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
    // A clarification ANSWER can be longer than 4 words ("cup of spaghetti with
    // meat sauce"). When Grace just asked a food question, treat a reasonable-
    // length reply as the answer so it doesn't fall to the LLM, which over-asks.
    const isClarificationAnswer = lastWasFoodQuestion && input.text.trim().split(/\s+/).length <= 14;
    // Broadened so brief replies after a vague-food clarification ("3 tenders",
    // "a chicken sandwich", "4 wings") trigger continuation log_food.
    const briefDetailMatchesFood = /\b(scoop|scoops|cup|cups|tbsp|tsp|grams?|oz|ounces?|servings?|with|and|small|medium|large|big|tiny|tender|tenders|wing|wings|nugget|nuggets|piece|pieces|slice|slices|sandwich|sandwiches|burger|burgers|taco|tacos|burrito|burritos|wrap|wraps|bowl|bowls|sub|subs|footlong|combo|meal|chicken|beef|fish|salmon|tuna|veggie|veggies|cheese|grilled|fried|baked|roasted|boiled|steamed|poached|sauteed|seared|smoked|breaded|crispy|mashed|sauce|gravy|oil|dressing|lettuce|cucumber|tomato|tomatoes|spinach|kale|avocado|egg|eggs|nuts|almonds|quinoa|rice|beans|plain|none|nothing|without|vinaigrette|ranch|caesar|vinegar|lemon|olive|just)\b/i.test(input.text)
      // Negative answers to a yes/no clarification ("no dressing", "no sauce", "nope").
      || /^(no|nope|none|nothing|without)\b/i.test(input.text.trim());
    if (
      !shouldForceLogFood &&
      flags.toolsEnabled &&
      lastWasFoodQuestion &&
      (isBriefDetail || isClarificationAnswer) &&
      briefDetailMatchesFood &&
      !prePlannedDecision.toolCalls.some((c) => c.name === 'log_food')
    ) {
      // Reconstruct a CLEAN food phrase from the prior question + this answer
      // ("2 slices of pizza", "grilled chicken"). Falls back to the old blob
      // only when reconstruction can't identify the food (e.g. brand replies).
      const reconstructed =
        reconstructFoodFromClarification(lastGraceMsg, input.text) ??
        `${input.text} ${lastGraceMsg.slice(0, 120).replace(/\?$/, '')}`;
      // If the reply ALREADY names a food ("cup of spaghetti with meat sauce"),
      // it's a complete answer — log it as-is rather than appending the prior
      // food (which would mangle it into "… of pasta"). Only fragments
      // ("2 slices", "grilled", "no dressing") need reconstruction.
      const replyHasFood = [...FOOD_TOKEN_SET].some((tok) => new RegExp(`\\b${tok}\\b`, 'i').test(input.text));
      const candidate = replyHasFood ? input.text.trim() : reconstructed;

      // Partial-clarification handling (2026-06-15): if the reconstructed phrase
      // is STILL vague (e.g. "no dressing" answered the dressing question but the
      // salad's CONTENTS are unknown), don't force-log a guess and don't fall to
      // a generic fallback — acknowledge what they answered and ask the missing
      // piece. Keeps the food-logging flow alive across turns.
      {
        const reconVague = detectVagueFood(candidate, lastGraceMsg, { requireQuantity: true });
        // Anti-loop (general, any food): Grace asks a food clarification AT MOST
        // ONCE. Count how many clarification questions she's already asked in the
        // recent turns — if she's asked 2+ times, the user has answered enough;
        // log a best estimate instead of asking the same thing a third time.
        // This is the hard guarantee that no food can loop the clarification.
        const FOOD_CLARIFY_RE = /\b(what was in|what kind of|how much|how many|grilled, (?:baked|fried)|grilled, fried, or breaded|baked, or fried|any (?:dressing|sauce|oil)|palm-sized|full plate|roughly how much|what did you (?:have|order|get)|how many (?:scoops|eggs|slices)|how was the .{0,30} prepared|just need a bit more|how big)\b/i;
        const priorClarifyCount = history.filter(
          (turn) => turn.role === 'assistant' && turn.content.includes('?') && FOOD_CLARIFY_RE.test(turn.content),
        ).length;
        const alreadyReasked = priorClarifyCount >= 2;
        // DIRECT REPLY MODE never re-asks — it logs the best estimate and lets
        // Gemini confirm (no clarification loop, per the production screenshot
        // where "cup of spaghetti" still got asked for the amount again).
        if (reconVague.vague && !alreadyReasked && !this.directReplyMode) {
          const negPrep = /^(no|nope|none|nothing|without)\b/i.test(input.text.trim())
            || /\b(no dressing|no sauce|plain|unseasoned)\b/i.test(input.text);
          const ack = negPrep ? `Got it, ${input.text.trim().toLowerCase()}. ` : 'Got it. ';
          const food = (reconVague.matched ?? 'meal').toLowerCase();
          const contentAsk = /salad|bowl|wrap|sandwich|stir|soup|pasta|omelette|omelet|casserole|stew/.test(food)
            ? `What was in the ${food}? For example just veggies, or with chicken, tuna, eggs, or cheese.`
            : reconVague.response ?? `What exactly did you have?`;
          const reply = `${ack}${contentAsk}`;
          this.deps.logger.info({ userId: input.userId, reconstructed, reply: reply.slice(0, 80) }, 'ai.handle.continuation_reask');
          void this.deps.memory.appendTurn({ userId: input.userId, conversationId, role: 'user', content: input.text })
            .catch((err) => this.deps.logger.warn({ err }, 'continuation_reask.append_user.failed'));
          void this.deps.memory.appendTurn({ userId: input.userId, conversationId, role: 'assistant', content: reply })
            .catch((err) => this.deps.logger.warn({ err }, 'continuation_reask.append_assistant.failed'));
          return {
            text: reply,
            intent: 'food_clarify',
            confidence: 'high' as const,
            toolResults: [],
            usedRetrieval: false,
            latencyMs: Date.now() - t0,
          };
        }
      }

      // Prefer the deterministic fast-log so the answer is logged + confirmed
      // with real numbers, never a chatty LLM detour. Only when the clean
      // phrase resolves in the macro table; otherwise fall through to the
      // orchestrator force-log with the clean phrase.
      // GEMINI-FIRST: skip the deterministic confirmation so the orchestrator
      // force-log runs and Gemini phrases the confirmation (the clean phrase
      // is already set as the force-log target downstream — still persists).
      if (!this.geminiFirst) try {
        const u = await this.deps.users.getByPhone(input.userId).catch(() => null);
        const fast = await tryFoodLogFastResponse(candidate, {
          pool: this.deps.pool,
          logger: this.deps.logger,
          userId: input.userId,
          intentType: 'food_log',
          proteinGoalGrams: u?.protein_goal_grams ?? null,
          users: this.deps.users,
        });
        if (fast) {
          this.deps.logger.info(
            { userId: input.userId, reconstructed, briefDetail: input.text },
            'ai.handle.continuation_fast_log',
          );
          void this.deps.memory.appendTurn({ userId: input.userId, conversationId, role: 'user', content: input.text })
            .catch((err) => this.deps.logger.warn({ err }, 'continuation.append_user.failed'));
          void this.deps.memory.appendTurn({ userId: input.userId, conversationId, role: 'assistant', content: fast.text })
            .catch((err) => this.deps.logger.warn({ err }, 'continuation.append_assistant.failed'));
          return {
            text: fast.text,
            intent: 'food_log_continuation',
            confidence: 'high' as const,
            toolResults: [{
              name: 'log_food',
              args: { food: candidate },
              output: { ...fast.macros, daily_protein_g: fast.dailyProteinG, daily_calories: fast.dailyCalories },
              latencyMs: 0,
              ok: true,
            }],
            usedRetrieval: false,
            latencyMs: Date.now() - t0,
          };
        }
      } catch (err) {
        this.deps.logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'ai.handle.continuation_fast_log.error');
      }

      prePlannedDecision = {
        intent: 'log_food',
        needsTools: true,
        toolCalls: [{ name: 'log_food', args: { food: candidate } }],
        rationale: 'continuation_of_food_question',
      };
      this.deps.logger.info(
        { userId: input.userId, briefDetail: input.text, reconstructed, lastGraceMsgPreview: lastGraceMsg.slice(0, 80) },
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
    } else if (hasImageMedia) {
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

    // Build the reply system prompt. COMPACT_REPLY_MODE swaps the big
    // personalised prompt for a tiny "Nudge-style" one so Gemini can't produce
    // heading/breakdown essays — the real fix for reply SHAPE. Not used for a
    // brand-new user's very first message (that welcome wants the full warmth).
    //
    // UNIFIED_REPLY_PATH (consolidation, 2026-07-04): ONE lean grounded prompt —
    // the compact prompt's tight Nudge-style rules (no preamble, no hedging, no
    // asking for info it already has) PLUS all the grounding data (date/time,
    // injection schedule, today's LOGGED food items + totals, goals, diet,
    // memory). Accuracy from data, brevity from the rules. (Earlier this pointed
    // at the big personalised prompt, which reintroduced "that's a good
    // question… what kind of injection did you have?" — corrected here.)
    const systemPrompt = (this.unifiedReplyPath && !isNew)
      ? this.buildGroundedPrompt(user, { todaysFood, dietaryRestriction, dislikes: cleanFoodDislikes, knownFacts, memoryMd, userText: input.text })
      : (this.compactReplyMode && !isNew)
      ? this.buildCompactReplyPrompt(user, { todaysFood, dietaryRestriction, dislikes: cleanFoodDislikes })
      : this.buildPersonalisedPrompt(user, isNew, {
          todaysFood,
          checkinsToday,
          knownFacts,
          dietaryRestriction,
          currentUserText: input.text,
          memoryMd,
          dashboardSignals,
          ...(!topicSwitchAtAiService && conversationSummary ? { conversationSummary: conversationSummary.summary } : {}),
          ...(!topicSwitchAtAiService && activeTopic ? { activeTopic } : {}),
        });

    // Track which modality drove this request so log_food rows are tagged
    // correctly (text vs image vs voice) — used by analytics + dedup.
    const logFoodSource: 'text' | 'image' | 'voice' =
      hasImageMedia ? 'image'
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
    let systemPromptWithStrategy = banditHint
      ? `${systemPrompt}\n\n${banditHint}`
      : systemPrompt;
    // Follow-up reconstruction hint (2026-06-11): when the user's message is a
    // short fragment, the deterministic reconstruction has the standalone
    // meaning — give it to the model so it answers the full question.
    if (reconHint) {
      systemPromptWithStrategy += `\n\n[FOLLOW-UP — in the full conversation, the user is really asking: "${reconHint}". Answer THAT directly; do not restate earlier text.]`;
    }
    // DIRECT REPLY MODE facts injected by the early intercepts (reminder / water
    // / weekly summary / meal preference) — Gemini phrases the reply from these.
    if (directContextNote) {
      systemPromptWithStrategy += directContextNote;
    }

    // MULTI-PART UNDERSTANDING (2026-06-27): real messages bundle several
    // intents — "I had chicken and rice, I feel nauseous, how much protein do I
    // still need?" When ≥2 meaningful parts are present, inject a structured
    // breakdown so the single Gemini call addresses EVERY part (not just the
    // first/last), in one warm reply. Deterministic pre-pass; Gemini still
    // writes the words. Direct-reply path only (the orchestrator path has its
    // own MULTI-PART rule); unit tests construct AIService without guards so
    // directReplyMode is false and this is a no-op for them.
    //
    // Voice notes carry their content in the transcription (`description`), so
    // analyze that for audio — a multi-topic voice note gets the same handling
    // as a multi-topic text. Images are handled by the media pipeline above, so
    // analyze only a typed caption there (never the internal nutrition blob).
    let isMultiTopicReply = false;
    if (this.directReplyMode) {
      const understandingText =
        input.media[0]?.kind === 'audio' && description ? description : input.text;
      const understanding = analyzeMessage(understandingText);
      if (understanding.hasMultiple) {
        isMultiTopicReply = true;
        systemPromptWithStrategy += buildMultiPartNote(understanding);
        this.deps.logger.info(
          { userId: input.userId, kinds: understanding.kinds, source: input.media[0]?.kind ?? 'text' },
          'ai.multi_part.detected',
        );
      }
    }

    // Topic-closer detection: brief acknowledgments ("thanks", "ok", "got it")
    // signal the user is done with that topic. Strip history before the closer so
    // the LLM starts fresh and doesn't anchor on the old conversation thread.
    const TOPIC_CLOSERS = /^(thanks|thank you|thx|ty|ok|okay|got it|cool|great|perfect|awesome|nice|good|alright|sounds good|will do|noted|k|kk)\.?!?$/i;
    let effectiveHistory = history;
    if (isMultiTopicReply) {
      // A multi-topic message is SELF-CONTAINED (the user restates what they
      // ate / feel / want in it) — answer it with NO history at all.
      //
      // Why empty and not user-turns-only: the earlier fix kept only user
      // turns, which handed Gemini a transcript of 4-5 back-to-back user
      // messages with no assistant replies between them. That reads as a LIST
      // OF UNANSWERED ENTRIES, which is exactly what produced "Let's break
      // down your questions… 'I ate yogurt with berries…'" — quoting and
      // answering a PREVIOUS message instead of the current one (production
      // 2026-07-02, twice). Profile context (dietary, goals, today's totals)
      // still reaches the model via the system prompt.
      effectiveHistory = [];
      logger.info(
        { userId: input.userId, textPreview: input.text.slice(0, 60) },
        'ai.handle.multi_topic_history_dropped',
      );
    } else if (this.unifiedReplyPath) {
      // UNIFIED PATH (consolidation, 2026-07-03): give Gemini the FULL recent
      // history window (Nudge-style) for maximum accuracy — the [REPLY FOCUS …]
      // directive + the grounding facts keep it answering the CURRENT message,
      // so the standalone / food-log / topic-closer bleed-trims below aren't
      // needed. The multi-topic branch ABOVE is intentionally left in front of
      // this, so a multi-part message still gets the self-contained [] treatment
      // that the multi-part work depends on. Flag-gated (default off), so this
      // never affects the current path; its GENERATION behaviour is validated by
      // the auto-eval gate before the flag is flipped.
      effectiveHistory = history;
      logger.info(
        { userId: input.userId, turns: history.length, textPreview: input.text.slice(0, 60) },
        'ai.handle.unified_history_full',
      );
    } else if (
      // SUBSTANTIVE STANDALONE message (2026-07-02): a full-thought message
      // (≥8 words) that is NOT a short follow-up and does NOT explicitly refer
      // back ("earlier", "you said", "that one") stands on its own. Handing it a
      // deep transcript lets Gemini answer a PREVIOUS, clearer question instead
      // — production: "I'm eating at my friend's Friday night…" got a salmon
      // protein estimate from an earlier turn. Keep ONLY the immediately-prior
      // exchange for tone continuity; drop older topics so they can't bleed in.
      (() => {
        const words = input.text.trim().split(/\s+/).filter(Boolean).length;
        const backRef = /\b(earlier|before|you said|you mentioned|i mentioned|that one|the one|last time|you told me|like i said|as i said|you asked|we talked|the (?:salmon|chicken|meal|dinner|lunch) (?:i|you))\b/i.test(input.text);
        return words >= 8 && !backRef && !isRecommendationFollowUp(input.text);
      })()
    ) {
      effectiveHistory = history.slice(-2);
      logger.info(
        { userId: input.userId, textPreview: input.text.slice(0, 60) },
        'ai.handle.standalone_history_trimmed',
      );
    } else if (isolateFoodLog) {
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
      // CRITICAL fix (2026-06-14 audit): if the CURRENT message is a
      // recommendation follow-up ("recipe?", "any other ideas?", "how much
      // protein was in that?"), the user is CONTINUING the recommendation
      // thread — do NOT strip the recommendation out of history just because
      // the prior turn was a brief "okay". Only strip when they've genuinely
      // moved on (the current message isn't a back-referencing follow-up).
      const currentIsFollowUp = isRecommendationFollowUp(input.text);
      if (!currentIsFollowUp && lastUserTurn && TOPIC_CLOSERS.test(lastUserTurn.content.trim())) {
        const lastUserIdx = history.lastIndexOf(lastUserTurn);
        effectiveHistory = history.slice(Math.max(0, lastUserIdx));
      }
    }

    // Image follow-up context: when the user asks about "the picture/image/photo"
    // in a follow-up turn AND the current turn has no new image, scan recent
    // history for the most recent food/body image Grace analyzed and inject the
    // visual context so the LLM doesn't deny having seen the image.
    const hasNewImage = hasImageMedia;
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
    // Definitive path telemetry — logs EXACTLY which reply path + prompt builder
    // generated this turn, so "nothing changed after deploy" can be diagnosed
    // from one log line instead of inference.
    const promptKind = (this.unifiedReplyPath && !isNew) ? 'grounded' : (this.compactReplyMode && !isNew) ? 'compact' : 'personalised';
    this.deps.logger.info(
      { userId: input.userId, path: this.directReplyMode ? 'direct' : 'orchestrator', prompt: promptKind, unifiedReplyPath: this.unifiedReplyPath, isNew, intent: intentClass.type },
      'ai.reply.path',
    );
    let result: OrchestratorOutput;
    if (this.directReplyMode) {
      // DIRECT REPLY (competitor-style): one Gemini call on [system + history +
      // user], no orchestrator/guard cascade. Use the warm, non-terse user text
      // (skip the FRESH-START "respond in ONE sentence" HARD-RULE wrapper, which
      // is what made replies dry); keep the helpful first-message / image notes.
      const directUserText = isNew
        ? `[FIRST MESSAGE — greet the user warmly] ${augmentedText}`
        : priorImageContext
          ? `[IMAGE FOLLOW-UP — the user is asking about a photo you ALREADY analyzed. Your previous analysis: "${priorImageContext}". Reference what you saw; never deny image capability.] ${augmentedText}`
          : augmentedText;
      result = await this.runDirectReply({
        systemPrompt: systemPromptWithStrategy,
        history: effectiveHistory,
        userText: directUserText,
        rawUserText: input.text,
        intent: intentClass.type,
        userId: input.userId,
        tools,
        toolsEnabled: flags.toolsEnabled,
        dbRules,
        ...(dietaryRestriction ? { dietaryRestriction } : {}),
        medicationType,
        foodDislikes: cleanFoodDislikes,
        mediaPresent: input.media.length > 0,
        logger,
      });
    } else {
      result = await orchestrator.run({
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
    }

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
      // Direct/multi-part path stages — so /admin/latency shows where a direct
      // reply's time goes (extract vs reply vs shape-regen), not one opaque blob.
      if (typeof it.directExtract === 'number' && it.directExtract > 0) {
        stageTimings['direct_extract'] = it.directExtract;
      }
      if (typeof it.directReply === 'number' && it.directReply > 0) {
        stageTimings['direct_reply'] = it.directReply;
      }
      if (typeof it.directRegen === 'number' && it.directRegen > 0) {
        stageTimings['direct_regen'] = it.directRegen;
      }
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

    // Phase D — enqueue memory.md update for pilot-enrolled users. We only
    // enqueue when the user has memory.md content already loaded (memoryMd
    // !== null) — that's the pilot gate. Empty string still counts as
    // enrolled (newly-added user, worker will populate the initial file).
    // Best-effort, fire-and-forget. Skips trivial exchanges and safe-
    // fallback responses (no real content to memorize).
    if (
      this.deps.memoryMdQueue &&
      memoryMd !== null &&
      !result.usedSafeFallback &&
      input.text.trim().length + result.text.trim().length >= 30
    ) {
      void this.deps.memoryMdQueue
        .add('update', {
          userId: input.userId,
          userText: input.text,
          assistantText: result.text,
        })
        .catch((err) => logger.warn({ err }, 'memory-md-queue.add.failed'));
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

  /** Active DB content rules for the AI path (60s in-memory cache inside the
   *  service — effectively free). Centralized so EVERY checkContent call site
   *  enforces the same rule set: the four block-severity dose-safety rules
   *  live ONLY in the DB, so any path that skips dbRules can ship "take an
   *  extra dose" if the model emits it (2026-06-11 verification finding). */
  private async getDbRules(): Promise<import('@grace/shared').DbContentRule[]> {
    if (!this.deps.contentRulesService) return [];
    try {
      return await this.deps.contentRulesService.getActive('ai');
    } catch {
      return [];
    }
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
    // "Today" = the user's personal logging day (starts at wake_time), the SAME
    // window as getTodaysFoodSummary — so "check-ins today" and "food today"
    // never disagree at the pre-wake boundary.
    const { rows } = await this.deps.pool.query<{ count: string }>(
      `${USER_DAY_CTE}
       SELECT count(*)::text FROM check_ins, user_tz
       WHERE user_id = $1
         AND ${isCurrentUserDay('created_at')}`,
      [userId],
    );
    const value = Number(rows[0]?.count ?? 0);
    this.checkinsCountCache.set(userId, { value, expiresAt: Date.now() + this.CHECKIN_COUNT_TTL_MS });
    return value;
  }

  /**
   * Gather the derived DASHBOARD signals for THIS user so every chat reply can be
   * grounded in their real progress (not just today's food): weight lost + % to
   * goal, food-logging streak, recent mood, and the personal side-effect patterns
   * Grace has learned. Injected into the prompt as background — Grace references
   * it ONLY when the user's message is about that topic. All best-effort; a
   * missing table just drops that signal. Cached 60s (parallels the food read).
   */
  private dashboardSignalsCache = new Map<string, { value: DashboardSignals | null; expiresAt: number }>();
  private readonly DASHBOARD_SIGNALS_TTL_MS = 60_000;

  private async gatherDashboardSignals(
    userId: string,
    user: { starting_weight?: number | null; current_weight?: number | null; goal_weight?: number | null } | null,
  ): Promise<DashboardSignals | null> {
    const cached = this.dashboardSignalsCache.get(userId);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    const [proteinHist, moodRows, symptomRows] = await Promise.all([
      this.deps.users.getDailyProteinHistory(userId, 14).catch(() => [] as Array<{ day: string; protein_g: number; calories: number; item_count: number }>),
      this.deps.users.getMoodHistory(userId, 5).catch(() => [] as Array<{ mood_score: number; created_at: Date }>),
      this.deps.users.getRecentSymptomEpisodes(userId, 60).catch(() => [] as Array<{ symptom: string; days_since_injection: number | null; dose_mg: number | null; remedy_helped: string | null; created_at: Date }>),
    ]);

    const wp = weightProgress(user?.starting_weight ?? null, user?.current_weight ?? null, user?.goal_weight ?? null);
    const streak = loggingStreak(proteinHist);
    // Mood trend from the last few scores (most recent first from the query).
    let moodLatest: number | null = null;
    let moodTrend: 'up' | 'down' | 'steady' | null = null;
    if (moodRows.length > 0) {
      moodLatest = moodRows[0]!.mood_score;
      if (moodRows.length >= 3) {
        const recent = moodRows.slice(0, 2).reduce((s, r) => s + r.mood_score, 0) / 2;
        const older = moodRows.slice(-2).reduce((s, r) => s + r.mood_score, 0) / 2;
        moodTrend = recent - older >= 1 ? 'up' : older - recent >= 1 ? 'down' : 'steady';
      }
    }
    const patterns = summarizeSymptoms(symptomRows).slice(0, 3);

    const signals: DashboardSignals = {
      weightLost: wp.lostLbs, weightPct: wp.pct, streak, moodLatest, moodTrend, patterns,
    };
    // Null out when there's genuinely nothing worth surfacing (keeps the prompt clean).
    const hasSomething = (signals.weightLost != null && signals.weightLost > 0) || streak >= 2 || moodLatest != null || patterns.length > 0;
    const value = hasSomething ? signals : null;
    this.dashboardSignalsCache.set(userId, { value, expiresAt: Date.now() + this.DASHBOARD_SIGNALS_TTL_MS });
    return value;
  }

  /**
   * COMPACT reply prompt (the "Nudge" model, 2026-07-02). A deliberately TINY
   * system prompt for the reply call. A small prompt physically can't produce
   * the heading/breakdown/preamble essays the big personalised prompt was
   * steering Gemini into — this fixes the SHAPE of every reply at the source
   * instead of stripping openers one phrasing at a time. Keeps just the facts a
   * warm, specific reply needs (name, medication, today's totals, diet). Crisis
   * safety runs BEFORE this (SafetyGuard/hypoglycemia) and the dose-safety block
   * runs AFTER, so the reply prompt itself stays lean. Gated behind
   * COMPACT_REPLY_MODE.
   */
  private buildCompactReplyPrompt(
    user: (ReturnType<UserService['getById']> extends Promise<infer T> ? T : never),
    opts: {
      todaysFood?: { protein_g: number; calories: number; items: string[] };
      dietaryRestriction?: DietaryRestriction | null;
      dislikes?: string[];
    },
  ): string {
    const facts = buildKnownProfileFacts(user, { dietaryRestriction: opts.dietaryRestriction, dislikes: opts.dislikes });
    const f = opts.todaysFood;
    if (f && (f.protein_g > 0 || f.calories > 0)) {
      facts.push(`So far today: about ${Math.round(f.protein_g)}g protein${f.calories > 0 ? ` and ${Math.round(f.calories)} calories` : ''} logged`);
    }
    const factBlock = facts.length > 0 ? `\n\nWhat you know about them (USE this — never ask for anything already here):\n- ${facts.join('\n- ')}` : '';
    // Even the tiny compact prompt must carry the authoritative date/time, or the
    // model invents one (prod: "May 14, 2024") and claims real-time access.
    const temporalBlock = `\n\n${buildTemporalContextBlock(user?.timezone, new Date())}`;
    return (
      `You are Grace, a warm, concise companion for someone on a GLP-1 medication, texting them over iMessage/WhatsApp. You sound like a caring friend who happens to know nutrition — short, natural, specific, never clinical.${factBlock}${temporalBlock}\n\n` +
      `HOW YOU REPLY, every single time:\n` +
      `- Answer their latest message directly. Lead with the answer. 1 to 3 short sentences, like a real text.\n` +
      `- If they said several things in one message, answer ALL of them briefly, in one flowing reply — react to any feeling first, then the rest.\n` +
      `- NEVER open with narration or a preamble ("let's break down", "here's a breakdown", "estimating protein from…", "that sounds like a nice meal", "this is a rough estimate but…"). Just give the answer.\n` +
      `- NEVER use headings, titles, bullet points, numbered lists, or "Label:" breakdowns. Plain sentences only.\n` +
      `- For a food, commit to a rough number or range ("about 25-30g protein") — don't hedge with "it's tough to say".\n` +
      `- If they ask for a personal number you don't have (their goal weight, protein target, calorie target, etc.), ask for the one missing detail instead of inventing a figure. Never make up a date, a schedule, or a number.\n` +
      `- Don't restate, quote, label, or analyze their message. Don't add nutrition facts they didn't ask for. No em dashes.\n` +
      `- If they mention a serious/worsening symptom, be warm and supportive and suggest checking with their doctor; never give dosing or medical advice.` +
      (GRACE_VOICE_ENABLED ? GRACE_VOICE_BRIEF : '')
    );
  }

  /**
   * UNIFIED grounded reply prompt (the "one lean path", 2026-07-04). The REAL
   * consolidation target: the compact prompt's TIGHT Nudge-style rules — so the
   * model never hedges, adds preamble, or asks for info it already has — PLUS
   * ALL the grounding data (date/time, injection schedule, today's LOGGED food
   * items + totals, goals, diet, dislikes, learned facts). Accuracy comes from
   * the data; brevity + no-sprawl come from the rules. This replaces the mistake
   * of pointing UNIFIED_REPLY_PATH at the big personalised prompt (which caused
   * "That's a good question… what kind of injection did you have?" — the exact
   * hedging/ask-for-info behaviour the compact prompt exists to prevent).
   */
  private buildGroundedPrompt(
    user: (ReturnType<UserService['getById']> extends Promise<infer T> ? T : never),
    opts: {
      todaysFood?: { protein_g: number; calories: number; items: string[] };
      dietaryRestriction?: DietaryRestriction | null;
      dislikes?: string[];
      knownFacts?: Array<{ fact: string }>;
      memoryMd?: string | null;
      /** The user's current message — used to include ONLY the facts relevant to
       *  it. Flash models recite any fact you hand them, so an irrelevant fact in
       *  the prompt (injection schedule, full diary) gets dumped as the reply.
       *  Gating by relevance makes recitation structurally impossible. */
      userText?: string;
      /** Episodic memories recalled for THIS message (recency-weighted, from
       *  user_memories) — things the user told Grace in earlier sessions that are
       *  relevant now. Injected into the memory block so Grace has continuity
       *  beyond the 12-turn window + durable profile facts. */
      recalled?: string[];
    },
  ): string {
    const now = new Date();
    const med = user?.medication && !isEncryptedBlob(user.medication) ? user.medication.trim() : null;
    const q = (opts.userText ?? '').toLowerCase();
    // Relevance gates: only surface a fact the model would otherwise recite when
    // the message is actually about it.
    const asksSchedule = /\b(inject|injection|shot|jab|dose|dosing|pen|next|when|schedule|due|today|tomorrow|day)\b/.test(q) && /\b(inject|injection|shot|jab|dose|dosing|pen|med|ozempic|wegovy|mounjaro|zepbound|semaglutide|tirzepatide)\b/.test(q);
    const asksDiaryOrTotal = FOOD_DIARY_QUERY_RE.test(q) || /\b(protein|calorie|cals|kcal|total|how much have i|goal|left|remaining|so far)\b/.test(q);
    // Profile block — always-safe grounding (never the schedule or diary, which
    // are the recitation-prone snapshot lines gated below).
    const profileFacts = buildKnownProfileFacts(user, { dietaryRestriction: opts.dietaryRestriction, dislikes: opts.dislikes });
    if (opts.knownFacts && opts.knownFacts.length > 0) profileFacts.push(`Also known: ${opts.knownFacts.slice(0, 6).map((k) => k.fact).join('; ')}`);
    const profileBlock = profileFacts.length ? `WHAT YOU KNOW ABOUT THIS USER (background — use it, never ask for what's here, don't recite as a list):\n${profileFacts.map((f) => `- ${f}`).join('\n')}` : '';

    // Today-snapshot — RELEVANCE-GATED. The injection schedule is present only
    // when the message asks about timing; the food diary + totals only when it
    // asks about the diary/total. So a plain food/chat message has neither in the
    // prompt and flash cannot recite them.
    const snap: string[] = [];
    if (asksSchedule) {
      const sched = buildScheduleFactLine(
        computeInjectionSchedule({
          medicationType: inferMedicationType(med),
          medicationName: med,
          injectionDay: user?.injection_day ?? null,
          timezone: user?.timezone ?? null,
        }, now),
        med,
      );
      if (sched) snap.push(sched);
    }
    if (asksDiaryOrTotal) {
      const f = opts.todaysFood;
      const items = (f?.items ?? []).filter(Boolean);
      if (items.length > 0) {
        snap.push(`Diary today (the complete, authoritative list): ${items.slice(0, 12).join(', ')}${items.length > 12 ? ', and more' : ''}.`);
        snap.push(`Totals today: about ${Math.round(f!.protein_g)}g protein${f!.calories > 0 ? ` and ${Math.round(f!.calories)} calories` : ''}${user?.protein_goal_grams ? ` of a ${user.protein_goal_grams}g protein goal` : ''}.`);
      } else {
        snap.push(`Nothing logged yet today.`);
      }
    }
    const todaySnapshot = snap.length ? `TRUE FOR THEM TODAY:\n${snap.map((s) => `- ${s}`).join('\n')}` : '';

    // Memory block = the narrative memory.md (pilot users) PLUS the episodic
    // memories recalled for this message (all users). Recalled items are things
    // the user told Grace before that the 12-turn window + profile facts wouldn't
    // otherwise surface. De-duped against each other, capped so it can't bloat.
    const memParts: string[] = [];
    if (opts.memoryMd && opts.memoryMd.trim()) memParts.push(opts.memoryMd.trim().slice(0, 1200));
    const recalled = (opts.recalled ?? []).map((m) => m.trim()).filter(Boolean).slice(0, 3);
    if (recalled.length) memParts.push(recalled.map((m) => `- ${m}`).join('\n'));
    const memoryBlock = memParts.length ? `WHAT YOU REMEMBER ABOUT THEM (background — weave in only if relevant, never recite as a list):\n${memParts.join('\n')}` : '';

    return buildNudgeSystemPrompt({
      profileBlock,
      todaySnapshot,
      temporalBlock: buildTemporalContextBlock(user?.timezone, now),
      memoryBlock,
    }) + (GRACE_VOICE_ENABLED ? GRACE_VOICE_BRIEF : '');
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
      /** Phase D: per-user memory.md narrative file. null when the user
       *  is not enrolled in the pilot. When present, injected verbatim
       *  into the system prompt as a dedicated section. */
      memoryMd?: string | null;
      /** Derived dashboard progress signals (weight/streak/mood/symptom
       *  patterns) — background context so replies are grounded in the user's
       *  real progress, referenced only when relevant. */
      dashboardSignals?: DashboardSignals | null;
    },
  ): string {
    // CRITICAL: fall back to the code's GRACE_SYSTEM_PROMPT when no DB prompt is
    // loaded. Without this, a missing/empty active prompt left `base` undefined
    // and Grace replied as a generic assistant ("I can write code, explain
    // quantum physics…") with NO GLP-1 identity — reported in production.
    const base = this.systemPrompt ?? GRACE_SYSTEM_PROMPT;

    const lines: string[] = [];
    if (user) {
      lines.push('━━━ THIS USER\'S DATA (background only — do NOT dump into responses) ━━━');
      lines.push('RULE: 1) Answer the user\'s CURRENT message FIRST and ONLY. 2) Only reference data below if the user\'s message is specifically about that topic. 3) NEVER volunteer unrelated facts (injection site when they ask about fatigue, protein when they share emotions, weight when they ask about food). 4) If data is missing, do NOT invent it.');
      // Full temporal grounding — the single authoritative source of the current
      // date/time for THIS user, so the model can never hallucinate the date
      // (prod bug: "Today is Tuesday, May 14, 2024") or claim real-time access.
      // Always user-local; falls back safely on a bad timezone.
      const WEEK_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
      const nowForCtx = new Date();
      const temporal = resolveTemporalContext(user.timezone, nowForCtx);
      // Used downstream for day-of-week (e.g. injection day) math.
      const localTodayIdx = temporal.weekdayIndex >= 0 ? temporal.weekdayIndex : nowForCtx.getDay();
      lines.push(buildTemporalContextBlock(user.timezone, nowForCtx));
      // Scope food recs to the current meal, not a whole-day rundown, unless
      // the user names a meal or asks for a full-day plan (2026-07-02).
      lines.push('FOOD TIMING: when suggesting what to eat and the user has NOT named a meal or asked for a full-day plan, recommend options for the CURRENT meal that fits the time of day above (morning → breakfast, midday → lunch, evening → dinner, late night → a light snack). Do NOT lay out a full breakfast-lunch-dinner day.');

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
      // Cadence-aware schedule fact (concrete next/last dates + a hard "never deny"
      // instruction) so ANY injection/dose-timing phrasing the model handles is
      // grounded and can't fall back to the capability denial seen in prod.
      {
        const schedFact = buildScheduleFactLine(
          computeInjectionSchedule({
            medicationType: inferMedicationType(user.medication),
            medicationName: user.medication,
            injectionDay: user.injection_day ?? null,
            timezone: user.timezone ?? null,
          }, nowForCtx),
          user.medication,
        );
        if (schedFact) lines.push(schedFact);
      }
      if (user.starting_weight) {
        lines.push(`Starting weight: ${user.starting_weight} lbs`);
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
        // Same clamp the scheduler applies (1..3) — Grace must never claim a
        // cadence the scheduler won't actually deliver.
        const effectiveCadence = Math.min(3, Math.max(1, user.checkin_count_per_day));
        lines.push(`CHECKIN FREQUENCY: ${effectiveCadence} scheduled check-in(s) per day`);
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
        if (f.items.length > 0 && !this.leanReplyMode) {
          // Aggregated + deduped so the model never echoes a raw repetitive
          // dump ("2 eggs; 2 eggs; chicken breast; chicken breast; …").
          // LEAN MODE drops this enumerated list — another "entries to
          // categorize" trigger; the running totals above are enough.
          lines.push(`Foods logged today: ${formatAggregatedInline(aggregateFoodItems(f.items), 10)}`);
        }
        // The food log is the ONLY source of truth for intake. If the user asks
        // what they've eaten / their intake / totals today, answer ONLY from the
        // lines above. When nothing is logged (0g, no foods), say plainly that
        // nothing is logged yet today — NEVER reconstruct meals from earlier
        // messages, from something they "mentioned", or from before a reset, and
        // never offer to add past-mentioned food back in (prod IMG_6710).
        lines.push(
          `INTAKE SOURCE OF TRUTH: use ONLY the "Total protein TODAY"/"Foods logged today" lines above for what the user has eaten today. If nothing is logged, say so plainly; do NOT infer intake from conversation history or a reset, and never offer to re-add previously mentioned food.`,
        );
      }

      // PROGRESS SNAPSHOT — derived dashboard signals so replies are grounded in
      // the user's real journey, not just today. Background only: Grace weaves a
      // line in ONLY when the user's message is about progress / weight / their
      // streak / mood / side effects — never as an unsolicited data dump.
      // LEAN MODE suppresses this entirely: these labeled analytical lines are
      // exactly what Gemini turned into "Here's an analysis of your entries,
      // categorizing them… Dashboard/…" (production 2026-07-02).
      if (!this.leanReplyMode && runtime?.dashboardSignals) {
        const d = runtime.dashboardSignals;
        const snap: string[] = [];
        if (d.weightLost != null && d.weightLost > 0) {
          snap.push(`down ${d.weightLost} lbs from their starting weight${d.weightPct != null ? ` (${d.weightPct}% of the way to goal)` : ''}`);
        }
        if (d.streak >= 2) snap.push(`on a ${d.streak}-day food-logging streak`);
        if (d.moodLatest != null) snap.push(`recent mood ${d.moodLatest}/10${d.moodTrend && d.moodTrend !== 'steady' ? ` (trending ${d.moodTrend})` : ''}`);
        if (snap.length > 0) {
          lines.push(`PROGRESS (from their dashboard — acknowledge warmly ONLY if the user asks about progress/weight/streak/mood, never volunteer): ${snap.join('; ')}.`);
        }
        if (d.patterns.length > 0) {
          const pats = d.patterns.map((p) => {
            const bits = [p.symptom];
            if (p.typicalTiming) bits.push(`usually ${p.typicalTiming}`);
            if (p.topRemedy) bits.push(`${p.topRemedy} helped`);
            return bits.join(', ');
          });
          lines.push(`SIDE-EFFECT PATTERNS Grace has learned about THIS body (reference naturally ONLY if the user brings up a symptom — recall it like you remember them, never invent beyond this): ${pats.join('; ')}.`);
        }
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

    // Phase D — per-user memory.md. Injected verbatim when present.
    // The LLM has been trained on markdown so it consumes this format
    // natively. NEVER appears when the user is not in the pilot
    // (runtime.memoryMd === null).
    const memoryMdCtx = runtime?.memoryMd != null && runtime.memoryMd.length > 0
      ? `\n\n--- USER MEMORY (this user's narrative profile — use it, never quote it back) ---\n${runtime.memoryMd}\n--- END USER MEMORY ---`
      : '';

    if (lines.length === 0 && !factsBlock && !turnDirective && !memoryMdCtx) return `${dietBanner}${base ?? ''}`;
    const userCtx = lines.length > 0 ? `\n\n--- User context ---\n${lines.join('\n')}` : '';
    const factsCtx = factsBlock ? `\n\n--- What Grace has naturally learned about this user ---\n${factsBlock}\nUse these subtly. Never read them back mechanically. Never say "according to your profile."` : '';
    return `${dietBanner}${base ?? ''}${userCtx}${factsCtx}${memoryMdCtx}${turnDirective}`;
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

  /**
   * Learn durable profile changes the user volunteers in chat and persist them.
   *
   * Runs ONLY when a cheap deterministic pre-filter says the message plausibly
   * states a self-change, so the common turn never pays for the extra LLM call.
   * Validation/normalization is fully deterministic in profile-extract, so a
   * malformed/hallucinated value can never reach the users table. The persist is
   * fire-and-forget (closes the race for the NEXT turn); the returned merged
   * object makes THIS turn's reply reflect the change immediately.
   *
   * Returns the input user unchanged when learning is disabled, the message
   * isn't profile-shaped, or nothing valid/new was found. Never throws.
   */
  private async tryLearnProfile(
    input: InboundMessage,
    user: GraceUser | null,
    logger: Logger,
  ): Promise<GraceUser | null> {
    if (!PROFILE_LEARNING_ENABLED || !user?.phone) return user;
    if (!mightStateProfileChange(input.text)) return user;

    const current: ProfileSnapshot = {
      medication: user.medication ?? null,
      medication_frequency: user.medication_frequency ?? null,
      injection_day: user.injection_day ?? null,
      medication_time: user.medication_time ?? null,
      dose_mg: user.dose_mg ?? null,
      goal_weight: user.goal_weight ?? null,
      timezone: user.timezone ?? null,
      wake_time: user.wake_time ?? null,
      sleep_time: user.sleep_time ?? null,
      food_dislikes: user.food_dislikes ?? [],
    };

    // Cap the extra call so a slow extraction can't stall the reply; on timeout
    // we simply learn nothing this turn (a harmless no-op — the next turn tries
    // again). 3s is ample for the flash-lite JSON pass.
    const updates = await Promise.race<ProfileUpdates>([
      extractProfileUpdates(this.deps.llm, logger, input.text, current),
      new Promise<ProfileUpdates>((resolve) => setTimeout(() => resolve({}), 3000)),
    ]).catch(() => ({} as ProfileUpdates));

    const fields = Object.keys(updates);
    if (fields.length === 0) return user;

    void this.deps.users
      .update(user.phone, updates as Partial<GraceUser>)
      .then(() => logger.info({ phone: user.phone, fields }, 'ai.profile_learn.applied'))
      .catch((err) => logger.warn({ err, phone: user.phone }, 'ai.profile_learn.persist.failed'));

    // Supersede contradicting long-term memories so a stale fact can't resurface
    // and contradict the fresh profile. Currently scoped to a medication switch
    // (the case that actually lands in semantic memory as "medical" context, e.g.
    // "On Ozempic"). Fire-and-forget — never blocks or fails the reply.
    if (updates.medication && current.medication && this.deps.userMemory) {
      void this.deps.userMemory
        .supersedeChangedFact(
          input.userId,
          [current.medication],
          `Switched medication to ${updates.medication} (previously ${current.medication})`,
        )
        .catch((err) => logger.warn({ err, userId: input.userId }, 'ai.profile_learn.supersede.failed'));
    }

    // Merge for the current turn (a fresh copy — never mutate the cached object).
    return { ...user, ...updates } as GraceUser;
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

export interface FoodImageAnalysis {
  mealStatus: 'eaten_meal' | 'ambiguous';
  confidence: 'high' | 'medium' | 'low';
  items: string;
  proteinTotal: number | null;
  caloriesTotal: number;
  ask: string;
  /** True only for a confident, clearly-eaten meal — drives deterministic auto-log. */
  autoLog: boolean;
}

/**
 * Parse the single-pass food-image analysis block from analyzeMedia into the
 * fields the reply path needs. The autoLog gate is the heart of the Nudge-style
 * "describe + confirm, then log" flow: a fruit bowl / groceries / unclear
 * portion (MEAL_STATUS: ambiguous) or a low-confidence read is NEVER silently
 * logged — it gets a confirm question instead.
 */
export function parseFoodImageAnalysis(description: string): FoodImageAnalysis {
  const mealStatusRaw = description.match(/^MEAL_STATUS:\s*(\w+)/m)?.[1]?.toLowerCase();
  const mealStatus: FoodImageAnalysis['mealStatus'] = mealStatusRaw === 'eaten_meal' ? 'eaten_meal' : 'ambiguous';
  const confRaw = description.match(/^CONFIDENCE:\s*(\w+)/m)?.[1]?.toLowerCase();
  const confidence: FoodImageAnalysis['confidence'] = confRaw === 'high' ? 'high' : confRaw === 'low' ? 'low' : 'medium';
  const items = description.match(/^ITEMS:\s*(.+)$/m)?.[1]?.trim() ?? '';
  const proteinMatch = description.match(/^TOTAL:\s*protein\s*([\d.]+)\s*g/im);
  const proteinTotal = proteinMatch?.[1] ? Math.round(parseFloat(proteinMatch[1])) : null;
  const calMatch = description.match(/calories?\s*([\d.]+)\s*kcal/i) ?? description.match(/([\d.]+)\s*kcal/i);
  const caloriesTotal = calMatch?.[1] ? Math.round(parseFloat(calMatch[1])) : 0;
  const ask = description.match(/^ASK:\s*(.+)$/m)?.[1]?.trim() ?? '';
  const autoLog = mealStatus === 'eaten_meal' && confidence !== 'low' && proteinTotal != null && items.length > 0;
  return { mealStatus, confidence, items, proteinTotal, caloriesTotal, ask, autoLog };
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
/** The user's current local hour (0-23) from their timezone, or null if
 *  unknown/unparseable. Uses Intl so it's DST-correct. */
export function localHourForTimezone(tz: string | null | undefined): number | null {
  if (!tz) return null;
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', hour12: false }).formatToParts(new Date());
    const h = parseInt(parts.find((p) => p.type === 'hour')?.value ?? '', 10);
    return Number.isFinite(h) ? h % 24 : null;
  } catch {
    return null;
  }
}

/** Map a local hour to the meal a food recommendation should focus on RIGHT
 *  NOW, so "what should I eat?" answers for the current moment instead of a
 *  full-day plan. Early morning → breakfast, midday → lunch, late afternoon →
 *  snack, evening → dinner, late night → a light snack. */
export function mealForLocalHour(hour: number): 'breakfast' | 'lunch' | 'snack' | 'dinner' {
  if (hour >= 5 && hour < 11) return 'breakfast';
  if (hour >= 11 && hour < 15) return 'lunch';
  if (hour >= 15 && hour < 17) return 'snack';
  if (hour >= 17 && hour < 21) return 'dinner';
  return 'snack'; // 21:00–04:59 → keep it light
}

/** True when the user explicitly wants a WHOLE-DAY plan (so we should NOT scope
 *  the answer to the current meal). */
export function wantsFullDayPlan(text: string): boolean {
  return /\b(meal\s*plan|whole day|full day|entire day|for the (?:whole |entire )?day|all day|throughout the day|plan (?:my|the) day|breakfast[\s,]+lunch|day'?s worth|each meal|every meal)\b/i.test(text);
}

/**
 * TRUE when a reply has a STRUCTURED shape that reads like a report rather than
 * a text message — regardless of the specific words. Detects structure, not
 * phrases, so it generalizes to any wording/variation:
 *   - ≥2 "Capitalized Label:" segments (a breakdown: "Salmon: … Estimate: …")
 *   - a bullet or numbered list marker
 *   - a leading multi-word Title-Case heading ending in a colon
 * Used by the reply-shape guard to trigger a single plain-text regeneration.
 */
export function looksStructured(text: string): boolean {
  const t = (text ?? '').trim();
  if (t.length === 0) return false;
  // ≥2 "Label:" segments at a start/sentence/comma/colon boundary. The label is
  // Capitalized, ≤34 chars, no apostrophe (so "Here's …" / prose isn't counted).
  const labelHits = (t.match(/(?:^|[.,:!?]\s+)[A-Z][A-Za-z0-9 &/-]{1,34}:\s/g) ?? []).length;
  if (labelHits >= 2) return true;
  // Chained heading-style colons ("Let's break it down: Arguments for a Big
  // Dinner: You're probably hungry:") — a breakdown even when the labels contain
  // apostrophes/words the strict test above skips. ≥2 "word: Capital" segments
  // reads as a mini-report, not prose. (Prod: this exact shape shipped because
  // "Let's"/"You're" aren't clean labels.)
  const headingColons = (t.match(/\w:\s+[A-Z]/g) ?? []).length;
  if (headingColons >= 2) return true;
  // Bullet / numbered list markers at a line start.
  if (/(?:^|\n)\s*(?:[-*•]|\d+[.)])\s/.test(t)) return true;
  // An inline numbered list item ("… 1. Do this" / "step 2) …").
  if (/(?:^|[.:]\s)\d+[.)]\s+[A-Z]/.test(t)) return true;
  // A leading heading/preamble clause ending in a colon ("Estimating Protein in
  // Your Salmon Meal:", "Salmon with Potatoes and Salad, Protein Estimate:",
  // "Here's an analysis of your entries:"). Lowercase connector words allowed.
  if (/^[A-Z][^.!?\n]{4,95}:\s+\S/.test(t)) return true;
  // A colon that introduces an enumerated list mid-reply ("… broken down into
  // steps: Before You Go (The Pre-Game) 1."). Catches the truncated-list case.
  if (/:\s+[A-Z][^.!?\n]{0,90}\b\d+[.)]/.test(t)) return true;
  return false;
}

// A PURE date/day question ("what's the date today", "what day is it"). Anchored
// so "what should I eat today" never matches. Answered deterministically from the
// authoritative temporal context — the model denies the date even when it's in
// the prompt (prod: "I don't have access to the current date. As an AI…").
const DATE_QUESTION_RE = /^\s*(what(?:'?s| is)?\s+(?:the\s+)?(?:date|day)(?:\s+(?:today|now|is\s+it))?|what\s+day\s+is\s+it(?:\s+today)?|what\s+date\s+is\s+it(?:\s+today)?|today'?s\s+date|current\s+date|what(?:'?s| is)?\s+today'?s\s+date)\s*\??\s*$/i;

// Capability-denial / AI-disclosure phrasing Grace must never ship — false and
// trust-breaking (the facts are in the prompt). Triggers a grounded regen.
const UNIFIED_DENIAL_RE = /\b(as an ai|i'?m an ai|i am an ai|i'?m just an ai|i (?:do not|don'?t) have access|i (?:cannot|can'?t) (?:provide|give) (?:medical|specific)|(?:don'?t|do not) have a concept of|check your (?:device|phone|calendar)|look it up online|i (?:don'?t|do not) have (?:real-?time|personal)|access to (?:the current date|real-?time)|large language model)\b/i;

// A history-bleed / meta-breakdown reply — flash reading the whole thread and
// answering it as "Part 1 / Part 2" instead of the current message. Deterministic
// so it's caught even when the relevance judge (flash, lenient) passes it.
const UNIFIED_BREAKDOWN_RE = /(\bpart 1\b|\bpart 2\b|two (?:distinct )?parts|distinct parts to your|let'?s break (?:them|it|this|these|your)|\bbreak (?:it|this|them) down|here (?:is|'?s) (?:a|the|my) (?:quick |brief |detailed )?breakdown|breakdown of (?:how|the |your )?(?:i |nutrition|what|meal|that)|breaking (?:it|this|them) down|game\s?plan|here (?:is|'?s) (?:a|the|your|my)(?: \w+){0,4}\s+(?:plan|strategy|strategies|breakdown|approach|steps?|game\s?plan)\b|here (?:is|'?s) how (?:to|you|i)\b|here (?:is|'?s)[^.!?\n]{0,60}:\s*\d|\b\d\.\s+(?:the\s+)?[A-Z]|\b\d[.)]\s*$)/i;

// Deterministic last resort when the prose regen STILL comes back report-shaped
// (flash loves "here's the plan: 1. …" for planning questions). Strip the list/
// heading tail so ONLY the warm prose preamble ships — cut at the earliest
// list/heading marker, trim to the last complete sentence. Returns '' if there's
// no usable prose before the marker (caller keeps the regen instead).
export function stripReportShape(text: string): string {
  const markers: RegExp[] = [
    /here (?:is|'?s) (?:a|the|your|my)[^.!?\n]{0,40}\b(?:plan|strategy|strategies|breakdown|approach|steps?|game\s?plan)\b/i,
    /\bhere (?:is|'?s) how (?:to|you|i)\b/i,
    /\bgame\s?plan\b/i,
    /(?:^|[.!?]\s)\s*\d[.)]\s/,   // a numbered list item
    /:\s*\d[.)]?\s*$/,            // heading-colon dangling into a number
  ];
  let cut = text.length;
  for (const re of markers) {
    const m = re.exec(text);
    if (m && m.index < cut) cut = m.index;
  }
  let head = text.slice(0, cut).trim();
  const lastPunct = Math.max(head.lastIndexOf('.'), head.lastIndexOf('!'), head.lastIndexOf('?'));
  if (lastPunct >= 20) head = head.slice(0, lastPunct + 1).trim();
  return head;
}

// Assembled foods whose protein depends on an unknown filling (mirror of the
// food-portion set; used to name the specific ambiguous foods a message reports
// eating, so the reply can ask about each by name).
const ASSEMBLED_AMBIG_WORDS = ['sandwich', 'wrap', 'burrito', 'taco', 'sub', 'hoagie', 'quesadilla', 'panini', 'salad', 'poke bowl', 'grain bowl', 'buddha bowl'];

/**
 * The ambiguous foods a message reports EATING, derived deterministically from
 * the text (independent of the LLM extractor, which can drop them on a complex
 * planning message). Returns the specific ambiguous foods + the clarify question
 * to ask about each, or null when the message reports no ambiguous intake. This
 * is the general guarantee that a bare sandwich/shake buried in a planning
 * message is ALWAYS asked about, never assumed.
 */
/**
 * The SPECIFIC ambiguous food NAMES inside a consumption span — always clean
 * words ("sandwich", "protein shake"), NEVER the raw span/sentence. Shared by the
 * reply guard (ambiguousEatenFoods) and the log-path backstop so a clarification
 * always names the food, not the whole message. Prod (IMG_6709): the backstop
 * echoed the entire message ("how many scoops was the I ate pretty light, just a
 * protein shake and a sandwich…") because it passed the raw span as the item.
 */
export function ambiguousFoodNames(span: string, context = ''): string[] {
  const items: string[] = [];
  if (isCompositionAmbiguousFood(span)) {
    for (const w of ASSEMBLED_AMBIG_WORDS) {
      if (new RegExp(`\\b${w.replace(/\s+/g, '\\s*')}(?:es|s)?\\b`, 'i').test(span)) items.push(w);
    }
  }
  if (isProteinProductAmbiguous(span, context)) items.push('protein shake');
  // Any MATERIAL food eaten without a precise amount ("small yogurt", "some
  // crackers", "some soup") — so a span the LLM extractor failed to itemize (prod:
  // it returned `none` even for the clean span, and the raw sentence got logged at
  // a guessed ~10g) is ASKED per food, never logged raw. Split on food connectors,
  // take the food noun in each part, and include it unless it's obvious single-
  // serving, the part carries a real number/unit amount, or the part is an
  // assembled/product food already handled by the composition/protein blocks above
  // (also skips modifier mis-picks like "veggie" in "veggie wrap").
  const HANDLED_ELSEWHERE_RE =
    /\b(sandwich|sandwiches|wrap|wraps|burrito|burritos|taco|tacos|sub|subs|hoagie|grinder|quesadilla|panini|salad|salads|poke|bowl|bowls|shake|shakes|smoothie|smoothies|whey)\b/i;
  for (const seg of span.split(/\s+and\s+|,|;|\s+with\s+|\s+plus\s+/i)) {
    if (HANDLED_ELSEWHERE_RE.test(seg)) continue;
    const noun = firstSpecificFoodNoun(seg);
    if (!noun) continue;
    if (items.some((i) => i.includes(noun) || noun.includes(i))) continue;
    if (isObviousSingleServing(noun) || hasPreciseAmount(seg)) continue;
    items.push(noun);
  }
  return [...new Set(items)];
}

export function ambiguousEatenFoods(text: string): { items: string[]; clarify: string } | null {
  const span = foodSpanFromConsumption(text);
  if (!span) return null;
  const uniq = ambiguousFoodNames(span, text);
  if (uniq.length === 0) return null;
  return { items: uniq, clarify: buildPortionConfirmQuestion(uniq.map((i) => ({ item: i, protein_g: null }))) };
}

/**
 * True when a reply CLAIMS a present-tense consumed protein total that differs
 * from the authoritative logged total. Only consumption / "so far today"
 * phrasings are checked — GOAL / target / "to go" / "need" / remaining numbers
 * are deliberately left alone (they're legitimate advice). Prod: "you've likely
 * consumed about 50g so far today" while the diary was empty (0g). General guard
 * against an ASSUMED total on food that isn't actually logged.
 */
export function statesFalseConsumedTotal(reply: string, realTotal: number): boolean {
  const re =
    /\b(?:consumed|you'?ve had|you have had|you'?ve eaten|you have eaten|you'?re (?:now |currently )?at|logged|had (?:about |roughly |around )?)\s*(?:about |around |roughly |~)?(\d+)\s*g\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(reply))) {
    const n = Number(m[1]);
    const ctx = reply.slice(Math.max(0, m.index - 12), m.index + 34).toLowerCase();
    if (/\bgoal\b|\btarget\b|\bto go\b|\bto hit\b|\bneed\b|\bremaining\b|\bleft\b/.test(ctx)) continue;
    if (n !== realTotal) return true;
  }
  return false;
}

/**
 * When food is AMBIGUOUS/pending (we don't know the real protein), the reply may
 * mention ONLY the authoritative logged total and the user's goal. ANY other
 * gram figure is, by definition, an ASSUMED number — no matter how it's phrased
 * ("usually ~25-30g", "puts you around 50g", "~20-25g"). This replaces the
 * phrase-by-phrase whack-a-mole: instead of enumerating bad wordings, we allow
 * exactly the two numbers that CAN'T be an assumption and reject the rest.
 */
export function hasDisallowedProteinNumber(reply: string, allowed: number[]): boolean {
  const ok = new Set(allowed);
  for (const m of reply.matchAll(/\b(\d+)\s*g\b/gi)) if (!ok.has(Number(m[1]))) return true;
  return false;
}

/**
 * Deterministic backstop for the no-assume (ambiguous food) case: drop every
 * SENTENCE that either carries a protein gram figure not in `allowed` OR frames
 * an estimate/guess of the unlogged food ("let's estimate based on your
 * description", "I'll assume…"). So an assumed number — or the sentence that sets
 * one up — can never ship even if a regen keeps slipping it in. Sentences with no
 * gram figure and no estimate framing are kept.
 */
const ESTIMATE_FRAMING_RE = /\b(?:estimate|estimating|guess|guessing|assum\w*|based on (?:your|the) description)\b/i;
export function stripAssumedProteinSentences(reply: string, allowed: number[]): string {
  const ok = new Set(allowed);
  return reply
    .split(/(?<=[.!?])\s+/)
    .filter(
      (s) =>
        [...s.matchAll(/\b(\d+)\s*g\b/gi)].every((m) => ok.has(Number(m[1]))) &&
        !ESTIMATE_FRAMING_RE.test(s),
    )
    .join(' ')
    .trim();
}

// Hard per-call timeout for the unified reply generations. Keeps a turn from
// running long enough to blow past the webhook in-flight lock's wait budget
// (which, once exceeded, lets a second pipeline run concurrently for the same
// user and mismatches replies to messages).
const UNIFIED_GEN_TIMEOUT_MS = 11_000;

export function answerDateQuestion(text: string, timezone: string | null): string | null {
  const t = (text ?? '').trim();
  if (!DATE_QUESTION_RE.test(t)) return null;
  const tc = resolveTemporalContext(timezone, new Date());
  return `Today is ${tc.humanDate}.`;
}

export function splitMultiMealText(text: string): string[] {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  // 2026-06-14 fix: the old version anchored on the meal label and captured
  // FORWARD, so "Had two eggs for breakfast" collapsed to "for breakfast" —
  // the food (two eggs) BEFORE the label was silently dropped, and only the
  // snack got logged (production memory bug). Now we split into CLAUSES on
  // sentence terminators, newlines, and temporal transitions, keeping each
  // clause's FULL content (food may come before OR after the label).
  const clauses = cleaned
    .split(/[.!?\n]+|\b(?:and then|then|after that|afterwards|later)\b/gi)
    .map((s) => s.replace(/^[\s,;:.\-]+|[\s,;:.\-]+$/g, '').trim())
    .filter(Boolean);
  // Keep the splitter's narrow scope: only treat the message as multi-meal when
  // at least two clauses each reference a meal label. Single-meal multi-food
  // ("chicken and rice") is handled by estimateMultiItemFood, not here.
  const MEAL_LABEL_RE = /\b(breakfast|lunch|dinner|snack|brunch|supper)\b/i;
  const mealClauses = clauses.filter((c) => MEAL_LABEL_RE.test(c));
  const seen = new Set<string>();
  const segments = mealClauses.filter((m) => {
    const k = m.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
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

// 2026-06-13: additional signup-survey diet types beyond the vegan/vegetarian/
// pescatarian pattern enum. Partial-but-safe forbidden lists so the diet-aware
// suggestion + post-gen filter never recommend an obvious conflict.
const KOSHER_FORBIDDEN = [
  'pork', 'bacon', 'ham', 'prosciutto', 'pancetta', 'pepperoni', 'salami', 'chorizo',
  'shrimp', 'prawns', 'crab', 'lobster', 'scallops', 'oysters', 'mussels', 'clams', 'shellfish',
  'catfish', 'eel',
];
const HALAL_FORBIDDEN = [
  'pork', 'bacon', 'ham', 'prosciutto', 'pancetta', 'pepperoni', 'salami', 'chorizo',
  'alcohol', 'wine', 'beer', 'rum', 'vodka', 'gelatin', 'lard',
];
const GLUTEN_FREE_FORBIDDEN = [
  'wheat', 'bread', 'pasta', 'barley', 'rye', 'couscous', 'bulgur', 'farro', 'semolina',
  'flour tortilla', 'tortilla', 'pita', 'bagel', 'cracker', 'crackers', 'cereal', 'granola',
  'breaded', 'crouton', 'croutons', 'beer', 'soy sauce', 'seitan', 'noodles',
];
const GLUTEN_FREE_ALLOWED = [
  'rice', 'quinoa', 'potato', 'sweet potato', 'corn', 'gluten-free oats', 'eggs',
  'chicken', 'fish', 'beans', 'lentils', 'Greek yogurt', 'nuts',
];
const DAIRY_FREE_FORBIDDEN = [
  'milk', 'cheese', 'yogurt', 'greek yogurt', 'butter', 'cream', 'whey', 'casein',
  'dairy', 'cottage cheese', 'ice cream', 'latte', 'cheddar', 'mozzarella', 'parmesan',
];
const DAIRY_FREE_ALLOWED = [
  'almond milk', 'oat milk', 'soy milk', 'coconut yogurt', 'tofu', 'tempeh', 'beans',
  'lentils', 'chicken', 'fish', 'eggs', 'nuts', 'plant-based protein shake',
];

/**
 * Derive the effective dietary restriction from EITHER the dietary_pattern enum
 * (set in chat/admin) OR the dietary_restriction free-text captured at signup
 * ("vegan", "kosher", "gluten-free", ...). Production bug 2026-06-13: a vegan
 * who set it at signup (stored in dietary_restriction) still got salmon/chicken
 * recommendations because every food path only read dietary_pattern.
 */
export function effectiveDietaryRestriction(
  user: { dietary_pattern?: string | null; dietary_restriction?: string | null } | null | undefined,
): DietaryRestriction | null {
  if (!user) return null;
  // BOTH fields are real, editable sources (the enum pattern + a free-text
  // restriction like kosher/halal/gluten-free). The old code returned the
  // pattern and SILENTLY DROPPED the free-text one, so a "vegan + kosher" user
  // lost kosher in every food rec. Honor BOTH by merging their forbidden lists —
  // a stored restriction must never be silently ignored just because a pattern
  // is also set. Keeps a single source of truth: whatever the user saved wins.
  const a = user.dietary_pattern ? buildRestrictionFromLabel(user.dietary_pattern) : null;
  const b = user.dietary_restriction ? buildRestrictionFromLabel(user.dietary_restriction) : null;
  if (a && b && a.label !== b.label) return mergeDietaryRestrictions(a, b);
  return a ?? b;
}

/** Combine two dietary restrictions into one: forbidden = union of both,
 *  allowed = the union minus anything now forbidden (so an item one diet allows
 *  but the other bans is dropped). Keeps the PRIMARY (pattern) label so the diet
 *  key still resolves (vegan stays vegan) while the second restriction's
 *  forbidden foods are added. Used when a user has both a pattern (vegan) and a
 *  free-text restriction (kosher) — both must be respected. */
function mergeDietaryRestrictions(a: DietaryRestriction, b: DietaryRestriction): DietaryRestriction {
  const forbidden = Array.from(new Set([...a.forbidden, ...b.forbidden]));
  const forbiddenLc = new Set(forbidden.map((f) => f.toLowerCase()));
  const allowed = Array.from(new Set([...a.allowed, ...b.allowed])).filter((x) => !forbiddenLc.has(x.toLowerCase()));
  return { label: a.label, forbidden, allowed };
}

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
  // Normalize: lowercase, collapse separators ("gluten-free"/"gluten_free"/
  // "gluten free" → "gluten free"), trim.
  const norm = label.toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  switch (norm) {
    case 'vegan':
    case 'plant based':
      return { label: 'VEGAN', forbidden: VEGAN_FORBIDDEN, allowed: VEGAN_ALLOWED };
    case 'vegetarian':
    case 'veggie':
      return { label: 'VEGETARIAN', forbidden: VEGETARIAN_FORBIDDEN, allowed: VEGETARIAN_ALLOWED };
    case 'pescatarian':
    case 'pescetarian':
      return { label: 'PESCATARIAN', forbidden: PESCATARIAN_FORBIDDEN, allowed: PESCATARIAN_ALLOWED };
    case 'kosher':
      return { label: 'KOSHER', forbidden: KOSHER_FORBIDDEN, allowed: [] };
    case 'halal':
      return { label: 'HALAL', forbidden: HALAL_FORBIDDEN, allowed: [] };
    case 'gluten free':
    case 'glutenfree':
    case 'celiac':
    case 'coeliac':
    case 'no gluten':
      return { label: 'GLUTEN-FREE', forbidden: GLUTEN_FREE_FORBIDDEN, allowed: GLUTEN_FREE_ALLOWED };
    case 'dairy free':
    case 'dairyfree':
    case 'lactose free':
    case 'lactose intolerant':
    case 'no dairy':
      return { label: 'DAIRY-FREE', forbidden: DAIRY_FREE_FORBIDDEN, allowed: DAIRY_FREE_ALLOWED };
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
