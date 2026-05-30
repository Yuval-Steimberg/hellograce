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
  | 'appointment_prep' // doctor / endocrinologist appointment — help draft questions
  | 'gibberish'      // emoji-only, random chars, unparseable
  | 'general';       // catch-all — let the planner decide

export interface ClassifyResult {
  type: MessageType;
  /** 0–1 confidence in the classification. */
  confidence: number;
}

// ─── Pattern banks ─────────────────────────────────────────────────────────────

// Question patterns — must check BEFORE food log patterns because
// "how many proteins did i eat today" contains "ate" but is a question
// about totals, not a logging event.
const FOOD_SUMMARY_QUESTION: RegExp[] = [
  /\bhow (much|many)\s+(protein|calorie|carb|gram|kcal)/i,
  /\b(what'?s|whats) my (protein|calorie|total)/i,
  /\bhow (much|many) did i (eat|have|consume) (today|this (week|day))/i,
  /\b(my|today'?s) (protein|calorie) (count|total|so far)/i,
  /\b(at|on) (how much|how many|what)\b.{0,30}(today|so far)/i,
  /\b(calories|kcal|protein) (left|remaining|to go)\b/i,
  /\bdid i (over|under)?eat\b/i,
  /\b(can|could) i (still|even) (eat|have|drink)\b.{0,40}(today|now|left)/i,
  /\bhow much (can|should) i (eat|have)\b.{0,40}(today|left|tonight|for dinner)/i,
  /\bam i over (my )?(calorie|budget|target|goal)/i,
];

const FOOD_LOG: RegExp[] = [
  // Direct past-tense verbs at start of message
  /^(i )?(just |already |i'?ve |i've )?(had|ate|eaten|finished|grabbed|made|cooked|ordered|got|drank|consumed|tried|enjoyed) (a |an |some |the |my |2 |3 |4 )?\w/i,
  // "I'm eating", "I'm having" (present tense)
  /^i'?m (eating|having|drinking|finishing|munching)\b/i,
  // Meal context phrases
  /\b(breakfast|lunch|dinner|snack|meal|brunch)\s*(was|had|:\s*|today|consist)/i,
  /\bfor (breakfast|lunch|dinner|snack|brunch)[,: ]/i,
  // Quantities
  /\b\d+\s*(eggs?|slices?|cups?|grams?|oz|ounces?|servings?|pieces?|bites?|tablespoons?|tbsp|tsp|portions?)\b/i,
  // Drinks
  /\b(drank|drinking|had) (a |some )?(water|coffee|tea|shake|smoothie|juice|coke|soda|beer|wine)/i,
  /\b(protein shake|whey|smoothie) (with|had|drank|made|after)/i,
  // Common foods at the start of message (no verb, just a food list)
  /^(a |an |some |the |my )?(salad|chicken|fish|beef|pork|tofu|eggs?|yogurt|oatmeal|rice|pasta|pizza|sushi|sandwich|burger|burrito|taco|wrap|soup|steak|salmon|tuna|turkey|bagel|toast|cereal|pancakes?|waffles?|fruit|banana|apple|orange|berries|smoothie)/i,
  // "I had X" / "I ate X" — broader food terms
  /\b(had|ate|eating) (salad|chicken|fish|beef|pork|tofu|eggs?|yogurt|oatmeal|rice|pasta|pizza|sushi|sandwich|burger|burrito|taco|wrap|soup|steak|salmon|tuna|turkey|bagel|toast|cereal|pancakes?|waffles?|fruit|banana|apple|orange|berries|big mac|fries|coke)/i,
  // Comma-separated food list (multi-item meal: "banana, eggs, coffee")
  /^[A-Za-z][a-z]+(\s+[a-z]+)?,\s*[A-Za-z][a-z]+/i,
  // "and" joiner with food words anywhere
  /\b(banana|egg|chicken|rice|salad|fries|burger|pizza|yogurt|toast|oatmeal|sandwich|pasta|salmon|tuna|steak|tofu) (and|with) (a |an |some |the )?(banana|egg|chicken|rice|salad|fries|burger|pizza|yogurt|toast|oatmeal|sandwich|pasta|salmon|tuna|steak|tofu|coffee|water|coke|soda|juice)/i,
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

// ─── Doctor appointment prep ───────────────────────────────────────────────────
// Fires on combos of (appointment | doctor | endocrinologist | specialist visit)
// + (help me | prep | prepare | write | questions | what should I ask).
// Detection has to be eager — Session 3 feedback showed Grace responding
// "What's on your mind?" to a clear appointment prep request. The hard
// override must fire on the FIRST message, not the second.
const APPOINTMENT_PREP: RegExp[] = [
  // Explicit "help me prep / write questions" + doctor/appointment mention
  /\b(help me (write|draft|prepare|prep)|prepare me (for|to)|prep me (for)?|what should i ask|questions (for|to ask)|write (down |out )?(my |some )?questions)\b[^.?!]{0,80}\b(doctor|endocrinologist|endo|specialist|appointment|visit|consult|consultation|gp|pcp|provider|prescriber)\b/i,
  /\b(doctor|endocrinologist|endo|specialist|gp|pcp|provider|prescriber)\b[^.?!]{0,80}\b(appointment|visit|consult|consultation)\b[^.?!]{0,80}\b(help|prepare|prep|questions|what should i ask|write)/i,
  /\b(i have (?:my |an? )?(?:appointment|visit|consult)|(?:my )?appointment (?:is |coming|next))\b[^.?!]{0,80}\b(help|prepare|prep|questions|what should i ask|write)/i,
  /\bprepare (?:me )?(?:for )?(?:the |my )?(?:appointment|visit|consult|doctor|endocrinologist)\b/i,
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
  // Appointment prep MUST come BEFORE knowledge / general, since "Help me write
  // my questions for my endocrinologist appointment next week" otherwise
  // matches knowledge patterns weakly and falls into general → generic chat
  // fallback. The hard override fires here on the first message.
  if (matches(text, APPOINTMENT_PREP)) return { type: 'appointment_prep', confidence: 0.95 };
  // Food summary questions MUST come before food_log — "how many proteins
  // i ate today" contains "ate" but is asking about totals, not logging.
  if (matches(text, FOOD_SUMMARY_QUESTION)) return { type: 'food_question', confidence: 0.95 };
  if (matches(text, WEIGHT_LOG)) return { type: 'weight_log', confidence: 0.9 };
  if (matches(text, FOOD_LOG)) return { type: 'food_log', confidence: 0.85 };
  if (matches(text, FOOD_QUESTION)) return { type: 'food_question', confidence: 0.85 };
  if (matches(text, EMOTIONAL)) return { type: 'emotional', confidence: 0.85 };
  if (matches(text, SCHEDULING)) return { type: 'scheduling', confidence: 0.9 };
  if (matches(text, KNOWLEDGE)) return { type: 'knowledge', confidence: 0.75 };
  return { type: 'general', confidence: 0.5 };
}
