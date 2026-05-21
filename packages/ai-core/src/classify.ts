/**
 * Fast deterministic message-intent classifier. Runs before the planner for
 * two purposes:
 *   1. Typed fallbacks — never say "can you rephrase?" to someone who just
 *      logged food. Each type gets contextually appropriate fallback text.
 *   2. Planner skip — greetings and gibberish don't need a Gemini planning
 *      call; we save the round-trip and go straight to chat mode.
 *
 * Classification is regex-only (no LLM call). Ambiguous messages fall through
 * to 'general' — the planner then handles them normally.
 */

export type MessageType =
  | 'food_log'       // past food logged: "ate", "had", "just finished"
  | 'food_question'  // asking what to eat / nutrition question
  | 'weight_log'     // logged weight on scale
  | 'mood_log'       // explicit mood / energy check-in
  | 'greeting'       // hi / hello / good morning
  | 'emotional'      // distress, struggle, frustration, giving up
  | 'scheduling'     // wants more / fewer check-ins
  | 'knowledge'      // GLP-1 / medication / side-effect question
  | 'gibberish'      // emoji-only, random chars, unparseable
  | 'general';       // catch-all — let the planner decide

export interface ClassifyResult {
  type: MessageType;
  /** 0–1 confidence in the classification. */
  confidence: number;
}

// ─── Pattern banks ─────────────────────────────────────────────────────────────

const FOOD_LOG: RegExp[] = [
  /\b(just |already )?(had|ate|eaten|finished|grabbed|made|cooked|ordered|got) (a |an |some |the )?\w/i,
  /\b(breakfast|lunch|dinner|snack|meal)\s*(was|had|:\s*)/i,
  /\bfor (breakfast|lunch|dinner|snack)[,: ]/i,
  /\b\d+\s*(eggs?|slices?|cups?|grams?|oz|ounces?|servings?|pieces?|bites?)\b/i,
  /\b(drank|drinking|had) (a |some )?(water|coffee|tea|shake|smoothie|juice)/i,
  /\b(protein shake|whey|smoothie) (with|had|drank|made|after)/i,
  /\b(had|ate) (salad|chicken|fish|beef|pork|tofu|eggs?|yogurt|oatmeal|rice|pasta|pizza)/i,
];

const FOOD_QUESTION: RegExp[] = [
  /\bwhat (should|can|could) i (eat|have|make|cook|order)\b/i,
  /\b(recommend|suggest)(ion)?(s)? for (food|meal|dinner|lunch|snack|breakfast|protein)/i,
  /\b(good (protein|snack|meal|food) (options?|ideas?|choices?))\b/i,
  /\bhow much protein (in|is|does|for)\b/i,
  /\bcan i (eat|have|drink)\b/i,
  /\b(hungry).{0,50}(what|any|suggest|recommend)/i,
  /\bany (food|meal|snack|dinner|lunch|breakfast) (ideas?|suggestions?|recommendations?)\b/i,
  /\bwhat('?s| is) (a )?(good|healthy|high.protein|filling|light) (meal|snack|option|food|breakfast|lunch|dinner)/i,
];

const WEIGHT_LOG: RegExp[] = [
  /\b(weighed (in|myself)|on the scale|my weight (is|was|today))\b/i,
  /\b(scale (says?|reads?|showed?|is))\b/i,
  /\b\d{2,3}(\.\d{1,2})?\s*(lbs?|pounds?|kg|kilos?)\b/i,
  /\b(gained|lost)\s+\d+(\.\d)?\s*(lbs?|pounds?|kg)\b/i,
  /\bweigh(ed|ing)?\s+\d{2,3}\b/i,
];

const GREETING: RegExp[] = [
  /^(hey|hi|hello|good morning|good afternoon|good evening|yo|hola|sup|what'?s up)[!.?🙂👋]?\s*$/i,
  /^(hey|hi|hello)\s*(grace|there)[!.?]?\s*$/i,
  /^(morning|evening|afternoon)[!.?]?\s*$/i,
  /^(good (morning|evening|afternoon))\s*(grace)?[!.?]?\s*$/i,
];

const EMOTIONAL: RegExp[] = [
  /\b(struggling|hard day|rough day|bad day|not (a )?(great|good) day)\b/i,
  /\bfeel (so |really |very )?(bad|sad|down|depressed|anxious|overwhelmed|stressed|hopeless|defeated)\b/i,
  /\b(want to (give up|quit|stop)|not sure (if )?this is working)\b/i,
  /\b(lost (my |the )?motivation|can't (do this|keep going|stick to this))\b/i,
  /\b(really (tired|exhausted|drained|burned out) of)\b/i,
  /\b(having a (hard|tough|rough) (time|day|week|moment))\b/i,
  /\b(feel (like a failure|terrible|awful|hopeless|worthless))\b/i,
  /\b(cry|crying|sobbing|broke down)\b/i,
];

const SCHEDULING: RegExp[] = [
  /\btext me (less|more|fewer|once|twice)\b/i,
  /\bcheck.?in (more|less|every other day|once a day|twice a day)\b/i,
  /\bstop (texting|messaging|sending) so (much|often)\b/i,
  /\b(change|update|adjust) (my |the )?(schedule|frequency|check.?in)\b/i,
  /\bmessage me (less|more|every|once|twice|daily|only)\b/i,
  /\b(too many|too much|fewer) (messages?|texts?|check.?ins?)\b/i,
  /\byou('?re| are) (texting|messaging) (me )?(too much|too often|a lot)\b/i,
];

const KNOWLEDGE: RegExp[] = [
  /\bwhy (is|does|do|am|are)\b.{5,}/i,
  /\bhow (does|do|long|often|much|come)\b.{5,}/i,
  /\bwhat (is|are|does|causes?|happens? (to|when|if))\b.{5,}/i,
  /\b(ozempic|wegovy|mounjaro|zepbound|semaglutide|tirzepatide|rybelsus)\b/i,
  /\bglp.?1\b/i,
  /\b(side effect|nausea|vomiting|constipation|diarrhea|hair loss|muscle|plateau|stall|fatigue|headache|reflux)\b/i,
  /\b(is it normal|is this normal|should i be worried|does this happen)\b/i,
  /\b(missed (my |a )?(dose|shot|injection)|forgot (to take|my) (pill|shot|injection))\b/i,
  /\binjection (site|day|schedule|timing|rotation)\b/i,
  /\b(how does (it|this) work|mechanism|explain)\b/i,
];

// ─── Gibberish detection ───────────────────────────────────────────────────────

function isGibberish(text: string): boolean {
  const t = text.trim();
  if (t.length === 0) return true;
  // Emoji-only (no alphabetic / numeric content)
  if (/^[\p{Emoji}‍️\s]+$/u.test(t) && !/[a-zA-Z0-9]/.test(t)) return true;
  // 1–2 chars and not a known single-word reply
  if (t.length <= 2 && !/^(ok|hi|k|yo|no|ok|👍|👎)$/i.test(t)) return true;
  // Pure repeating characters (aaaaaaa, ?????)
  if (/^(.)\1{4,}$/.test(t)) return true;
  // Less than 20% alphabetic characters → likely random symbols or numbers
  if (t.length > 6 && (t.match(/[a-zA-Z]/g)?.length ?? 0) / t.length < 0.2) return true;
  return false;
}

function matches(text: string, patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(text));
}

// ─── Public API ────────────────────────────────────────────────────────────────

export function classifyMessage(text: string): ClassifyResult {
  if (isGibberish(text)) return { type: 'gibberish', confidence: 0.9 };
  if (matches(text, GREETING)) return { type: 'greeting', confidence: 0.95 };
  if (matches(text, WEIGHT_LOG)) return { type: 'weight_log', confidence: 0.9 };
  if (matches(text, FOOD_LOG)) return { type: 'food_log', confidence: 0.85 };
  if (matches(text, FOOD_QUESTION)) return { type: 'food_question', confidence: 0.85 };
  if (matches(text, EMOTIONAL)) return { type: 'emotional', confidence: 0.85 };
  if (matches(text, SCHEDULING)) return { type: 'scheduling', confidence: 0.9 };
  if (matches(text, KNOWLEDGE)) return { type: 'knowledge', confidence: 0.75 };
  return { type: 'general', confidence: 0.5 };
}
