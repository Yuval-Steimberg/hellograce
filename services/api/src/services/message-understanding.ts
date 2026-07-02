/**
 * Message understanding layer (2026-06-27).
 *
 * Real users write messy, multi-topic messages: "I had chicken and rice for
 * lunch, I feel a little nauseous, also how much protein do I still need
 * today?" — a food log + a symptom + a progress question, all at once. Grace
 * must address EVERY important part in one warm reply, not just the first or
 * last sentence.
 *
 * This is a DETERMINISTIC pre-pass (no LLM — consistent with the codebase's
 * TRUST_GEMINI stance: the understanding step is deterministic; Gemini still
 * writes the natural reply). It splits a message into the set of meaningful
 * intents present, then the caller injects a structured note into the single
 * Gemini call so the model covers all of them. Pure string functions — easy to
 * unit-test, no I/O.
 *
 * It is intentionally CONSERVATIVE about what counts as a distinct part, so a
 * plain one-topic message ("I had 2 eggs") yields a single part and the normal
 * fast paths handle it — the multi-part note only fires when ≥2 meaningful
 * kinds are genuinely present.
 */

import { mentionsFood } from './meal-lifecycle.js';

export type MessagePartKind =
  | 'food'
  | 'food_question'
  | 'symptom'
  | 'progress_question'
  | 'question'
  | 'emotion'
  | 'injection'
  | 'medication'
  | 'weight'
  | 'sleep'
  | 'exercise'
  | 'hydration'
  | 'craving'
  | 'appointment'
  | 'social'
  | 'reminder'
  | 'gratitude';

export interface MessagePart {
  kind: MessagePartKind;
  /** Short human label for the structured note. */
  label: string;
}

export interface MessageUnderstanding {
  parts: MessagePart[];
  /** True when ≥2 DISTINCT meaningful kinds are present → needs combined handling. */
  hasMultiple: boolean;
  kinds: MessagePartKind[];
}

// ── Detectors (lean, self-contained regexes) ────────────────────────────────

// GLP-1 symptom vocabulary (the common side effects + acute warning signs).
// Typo-tolerant: naus\w* catches nausea/nauseous/nauseus/nauseated; diarr\w*
// catches diarrhea/diarhea/diarrhoea; constipat\w* catches constipated/constipation.
const SYMPTOM_RE =
  /\b(naus\w*|vomit\w*|throw(?:ing)?\s+up|puk(?:e|ing)|constipat\w*|diarr\w*|reflux|heart\s?burn|indigest\w*|bloat\w*|gas(?:sy)?|cramp\w*|stomach\s*(?:ache|pain|cramps?|issues?)|tummy\s*(?:ache|pain|hurts?)|belly\s*(?:ache|hurts?)|head\s?ache|migraine|dizz\w*|light\s?head\w*|fatigue\w*|exhaust\w*|tired|drained|wiped\s+out|sluggish|weak|shaky|sweaty|palpitation\w*|blurry|sick|unwell|queasy|nauseaus|burp\w*|food\s+noise|acid\s+reflux|hair\s+(?:loss|falling|shedding|thinning))\b/i;

// Protein / calorie / weight + a "how much / left / today" framing → progress Q.
const PROGRESS_Q_RE =
  /\b(?:protein|calorie|calories|cals?|weight|macros?)\b/i;
const PROGRESS_Q_FRAMING_RE =
  /\b(?:how\s+much|how\s+many|left|remaining|still\s+need|so\s+far|today|hit\s+my|over|under|reach|on\s+track|enough)\b/i;

// Injection / dose mentions.
const INJECTION_RE =
  /\b(?:shot|inject\w*|jab|pen|dose|dosing|my\s+(?:ozempic|wegovy|mounjaro|zepbound|semaglutide|tirzepatide))\b/i;

// Weight / progress UPDATE (not a question) — "I'm down 3 lbs", "weighed 180".
const WEIGHT_UPDATE_RE =
  /\b(?:i'?m\s+down|lost\s+\d|weighed?\s+\d|down\s+\d+\s*(?:lbs?|pounds?|kg)|scale\s+(?:said|read|showed))\b/i;

// A request for food/meal IDEAS (a recommendation), distinct from logging what
// they ate. Typo/grammar-tolerant: allows a stray word between "i" and the verb
// ("what should I WILL make for Friday night"), and covers meal-idea phrasing.
const FOOD_REC_RE =
  /\b(?:what\s+(?:should|can|could|do|will|to)\s+i\s+(?:\w+\s+){0,2}(?:eat|have|make|cook|order|try|prepare|fix)|(?:dinner|lunch|breakfast|brunch|supper|snack|meal|something)\s+(?:idea|ideas|option|options|suggestion|suggestions|recommendation|recommendations)|(?:recommend|suggest)\s+(?:a\s+|some\s+|me\s+)?(?:meal|food|dinner|lunch|breakfast|snack)|what'?s\s+(?:a\s+|for\s+)?(?:good|healthy|filling|nice)\s+(?:[\w-]+\s+){0,2}(?:to\s+eat|meal|food|snack|dinner|lunch|breakfast)|(?:ideas?|options?|suggestions?)\s+for\s+(?:dinner|lunch|breakfast|brunch|a\s+snack|friday|saturday|sunday|monday|tuesday|wednesday|thursday|tonight|the\s+weekend)|what\s+to\s+(?:eat|make|cook|have))\b/i;

// Sleep trouble.
const SLEEP_RE =
  /\b(?:insomnia|sleepless|barely\s+slept|hardly\s+slept|no\s+sleep|not\s+sleeping|wide\s+awake|up\s+all\s+night|restless\s+night|(?:couldn'?t|can'?t|cannot|didn'?t|hard\s+to|trouble|struggl(?:e|ing))\s+(?:to\s+|with\s+)?sleep\w*|slept\s+(?:badly|poorly|terribly|awful|like\s+crap|so\s+bad|horribly))\b/i;

// Exercise / movement.
const EXERCISE_RE =
  /\b(?:work(?:ed|ing)?\s*out|workout|went\s+(?:for\s+)?(?:a\s+)?(?:run|walk|jog|hike|swim|bike\s+ride|ride)|hit\s+the\s+gym|at\s+the\s+gym|to\s+the\s+gym|exercis\w*|lift(?:ed|ing)?\s+weights?|cardio|yoga|pilates|spin\s+class|ran\s+\d|jog(?:ged|ging)?|walk(?:ed|ing)?\s+\d|\d+\s*(?:k|km|miles?|mins?|minutes?)\s*(?:run|walk|jog)?|\d+\s*(?:k\s+)?steps)\b/i;

// Hydration / water.
const HYDRATION_RE =
  /\b(?:hydrat\w*|dehydrat\w*|(?:drank|drink|drinking|had|having)\s+(?:\w+\s+){0,3}water|water\s+(?:intake|today)|(?:oz|ounces|glasses?|liters?|litres?|bottles?)\s+of\s+water|(?:not|barely|hardly)\s+drink\w*)\b/i;

// Cravings / appetite / food noise.
const CRAVING_RE =
  /\b(?:crav\w*|food\s+noise|snack\s+attack|sugar\s+craving|want(?:ing)?\s+(?:something\s+)?(?:sweet|salty|sugar|junk|carbs?|chocolate)|can'?t\s+stop\s+(?:eating|snacking|thinking\s+about\s+food)|keep\s+wanting\s+to\s+eat)\b/i;

// Medication / dosing questions (distinct from a bare injection mention).
const MEDICATION_RE =
  /\b(?:dose|dosage|dosing|titrat\w*|increas\w*\s+(?:my\s+)?(?:dose|dosage)|up\s+my\s+dose|next\s+dose|missed\s+(?:my\s+)?(?:dose|shot|injection|pen)|skip(?:ped)?\s+(?:my\s+)?(?:dose|shot|injection)|(?:when|how|where)\s+(?:should\s+|do\s+|can\s+)?i\s+(?:take|inject|store)|store\s+(?:my\s+)?(?:pen|ozempic|wegovy|mounjaro|zepbound|rybelsus)|\d+\s*mg\b)\b/i;

// Doctor / appointment / labs.
const APPOINTMENT_RE =
  /\b(?:doctor'?s?\s+appointment|appointment\s+(?:with|next|this|on|tomorrow|coming)|see(?:ing)?\s+(?:my\s+)?(?:doctor|doc|endo|endocrinologist|nurse|provider|gp)|dr\.?\s+appointment|check\s?up|blood\s+(?:work|test|panel|draw)|lab\s+work|labs\b|physical\s+exam)\b/i;

// Social eating / events.
const SOCIAL_RE =
  /\b(?:eating\s+out|dining\s+out|eat\s+out|dinner\s+(?:party|out)|lunch\s+out|going\s+out\s+(?:to\s+)?(?:eat|for\s+(?:dinner|lunch|drinks))|(?:at|to)\s+a\s+(?:party|wedding|restaurant|bbq|barbecue|gathering|reunion|celebration)|restaurant|date\s+night|family\s+(?:dinner|gathering|reunion)|holiday\s+(?:meal|dinner|party)|friends?\s+(?:are\s+coming|for\s+dinner|over))\b/i;

// Reminders / scheduling / check-ins (the product feature itself).
const REMINDER_RE =
  /\b(?:remind\s+me|my\s+reminder|reminders?|check[\s-]?in\w*|text\s+me\s+(?:less|more|at|every|daily|tomorrow)|message\s+me\s+(?:less|more)|stop\s+texting|nudge\s+me|notif\w*)\b/i;

// Pure thanks / appreciation (a distinct part worth a warm beat).
const GRATITUDE_RE =
  /\b(?:thank\s+you|thanks|thx|ty|appreciate\s+(?:it|you|this|that)|grateful\s+for|you'?re\s+(?:the\s+best|amazing|awesome|so\s+helpful))\b/i;

// Emotional content — "I feel <emotion>", "I'm/I am <emotion>", or bare phrases.
// Intensifiers/adverbs are allowed between the trigger and the emotion word
// ("I'm feeling super frustrated", "I am quite worried", "im kinda anxious").
const EMO_WORDS =
  'good|great|amazing|wonderful|fantastic|happy|excited|proud|hopeful|motivated|grateful|thrilled|pumped|relieved|ok(?:ay)?|fine|down|sad|low|blue|anxious|nervous|worried|scared|afraid|frustrated|stressed|overwhelmed|discouraged|defeated|lonely|guilty|ashamed|embarrassed|upset|disappointed|terrible|awful|gross|miserable|hopeless|stuck|emotional|angry|mad|annoyed|cranky|irritable|meh|drained|burnt\\s+out|burned\\s+out|worn\\s+out|tired\\s+of';
const INTENSIFIER = '(?:so|really|super|very|quite|kinda|kind\\s+of|a\\s+bit|a\\s+little|pretty|getting|feeling)\\s+';
const EMOTION_RE = new RegExp(
  `\\b(?:i\\s+feel|i'?m\\s+feeling|feeling|i'?m|i\\s+am|im)\\s+(?:${INTENSIFIER})*(?:${EMO_WORDS})\\b` +
    `|\\bso\\s+(?:proud|happy|excited|frustrated|anxious|discouraged|grateful|stressed|down|sad|worried|nervous)\\b` +
    `|\\b(?:stress(?:ing|ed)?\\s+me\\s+out|freaking\\s+out|falling\\s+apart|at\\s+my\\s+(?:wits?|breaking\\s+point)|struggling|i\\s+give\\s+up|can'?t\\s+do\\s+this)\\b`,
  'i',
);

function hasQuestion(text: string): boolean {
  if (text.includes('?')) return true;
  return /\b(?:how|what|when|where|which|why|who|can|could|should|would|will|do|does|did|is|are|am)\b[^.?!]*$/i.test(
    text.trim(),
  );
}

/**
 * Split a message into the set of meaningful intents it contains. The result
 * drives a structured note for the LLM; `hasMultiple` gates whether the
 * multi-part handling is needed at all.
 */
export function analyzeMessage(text: string): MessageUnderstanding {
  const t = (text ?? '').trim();
  const parts: MessagePart[] = [];
  const add = (kind: MessagePartKind, label: string) => {
    if (!parts.some((p) => p.kind === kind)) parts.push({ kind, label });
  };

  if (t.length === 0) return { parts, hasMultiple: false, kinds: [] };

  // Is this a food-IDEA request? Computed first so a request ("what should I eat
  // for dinner") is never also counted as a food LOG.
  const isFoodQ = FOOD_REC_RE.test(t);

  // A food LOG: a real eating report (i ate/had/made/grabbed… — the leading "i"
  // is optional so slang "had chicken n rice" still logs) paired with a food or
  // meal word, OR a named food joined by a conjunction (and/n/&/plus) when it's
  // NOT a food-idea request. Requiring an eating verb or explicit conjunction
  // keeps a pure request ("what should I eat for dinner") out of the log path.
  const MEAL_WORD_RE = /\b(?:breakfast|lunch|dinner|brunch|supper|snack|meal)\b/i;
  const ATE_VERB_RE = /\b(?:i\s+)?(?:ate|had|grabbed|made|drank|got|finished|having|eating)\b/i;
  const CONJ_RE = /\b(?:and|n|&|plus)\b/i;
  const foodish =
    (ATE_VERB_RE.test(t) && (mentionsFood(t) || MEAL_WORD_RE.test(t))) ||
    (!isFoodQ && mentionsFood(t) && CONJ_RE.test(t));
  if (foodish) add('food', 'food they ate (log it if the amount is clear; otherwise ask one short question)');

  if (SYMPTOM_RE.test(t)) add('symptom', 'a symptom / how they feel physically (acknowledge + apply safety rules)');

  const isProgressQ =
    PROGRESS_Q_RE.test(t) && (hasQuestion(t) || PROGRESS_Q_FRAMING_RE.test(t)) && !WEIGHT_UPDATE_RE.test(t);
  if (isProgressQ) add('progress_question', "a question about today's protein/calories/weight (answer from the totals in context)");

  if (WEIGHT_UPDATE_RE.test(t)) add('weight', 'a weight / progress update');

  // Medication/dosing takes priority over a bare injection mention when both
  // match (it's the more specific, more actionable topic).
  if (MEDICATION_RE.test(t)) add('medication', 'a medication / dosing point (answer accurately + safely; never advise changing a prescribed dose)');
  else if (INJECTION_RE.test(t)) add('injection', 'an injection / dose mention');

  if (SLEEP_RE.test(t)) add('sleep', 'a sleep struggle (acknowledge + brief practical guidance)');
  if (EXERCISE_RE.test(t)) add('exercise', 'an exercise / movement note (acknowledge, tie to protein/energy if relevant)');
  if (HYDRATION_RE.test(t)) add('hydration', 'a hydration / water note (acknowledge, encourage)');
  if (CRAVING_RE.test(t)) add('craving', 'a craving / appetite note (validate, offer one practical strategy)');
  if (APPOINTMENT_RE.test(t)) add('appointment', 'a doctor / appointment mention (offer to help prep questions if useful)');
  if (SOCIAL_RE.test(t)) add('social', 'a social eating / event plan (give practical, non-restrictive strategies)');
  if (REMINDER_RE.test(t)) add('reminder', 'a reminder / scheduling point (Grace IS the interface; explain or point to Settings, never deny the capability)');

  if (EMOTION_RE.test(t)) add('emotion', 'an emotional note (respond to the feeling FIRST, warmly)');

  // A food/meal-idea request — answer with SPECIFIC foods, never deflect.
  if (isFoodQ) add('food_question', 'a request for food/meal ideas — answer with 3-5 SPECIFIC foods that fit their diet and the time of day/occasion; NEVER deflect with "I can help you think about it" or "let\'s make sure your meal supports your goals"');

  // Gratitude only counts as its own part when there's something ELSE too — a
  // bare "thanks" is a topic-closer handled elsewhere, not a multi-part message.
  if (GRATITUDE_RE.test(t) && parts.length > 0) add('gratitude', 'a thank-you (acknowledge warmly, briefly)');

  // A general question that is NOT already the progress or food-idea question.
  if (!isProgressQ && !isFoodQ && hasQuestion(t)) add('question', 'a question to answer directly');

  const kinds = parts.map((p) => p.kind);
  return { parts, hasMultiple: parts.length >= 2, kinds };
}

/**
 * Build the structured note injected into the single Gemini call so it covers
 * every part of a multi-topic message in ONE short, warm reply. Returns '' when
 * the message isn't multi-part (caller skips injection).
 */
export function buildMultiPartNote(understanding: MessageUnderstanding): string {
  if (!understanding.hasMultiple) return '';
  // Deliberately a SINGLE plain-language instruction — NOT an enumerated
  // "Parts to cover: 1)… 2)…" block. That structured list caused Gemini to
  // treat the prompt scaffolding as data and reply "Here's an analysis of your
  // entries, categorizing them…" (production 2026-07-02). Keep it conversational
  // so Gemini answers like a person, not a report generator.
  return (
    '\n\nThe user just said a few things in one text. Reply to ALL of it in ONE short, warm message, the way a friend texts back. LEAD WITH THE ANSWER — do NOT open by narrating what you\'re about to do ("let\'s break down", "let\'s discuss", "here\'s how", "estimating protein from…"), do NOT restate/label/analyze their message, and do NOT write a heading. React to any feeling FIRST in a few words, then give each part a direct, specific answer: for a food they named, COMMIT to a rough protein/calorie number or range (don\'t hedge with "it\'s tough to say" — just estimate and say it\'s approximate); for what to eat next, name 1-2 concrete foods. Plain prose only, no lists, no "Option 1/2". Use ONLY what THIS message says; never bring in a food or topic from earlier turns.'
  );
}
