/**
 * Meal lifecycle (2026-06-15): recommendation → exploration → consumption.
 *
 * Production bug this fixes: Grace treated PREFERENCE language ("Halloumi and
 * roasted vegetable plate sounds good") as CONSUMPTION ("I ate a halloumi
 * plate") and logged it — inflating protein/calorie totals for a meal the user
 * never ate.
 *
 * The lifecycle has three states:
 *   1. Recommendation request   → suggest only, never log (handled by the
 *      food_question path).
 *   2. Recommendation exploration ("sounds good", "maybe the dal", "I'll have
 *      the omelet", "I might make it") → status stays SUGGESTED. NEVER logged.
 *   3. Consumption confirmation ("I ate the dal", "just finished dinner",
 *      "log the halloumi plate", "ended up having it") → logged.
 *
 * Universal rule: nutrition totals only update when consumption is EXPLICITLY
 * confirmed. Interest / selection / planning are not consumption.
 *
 * Pure string functions — no deps, no I/O. Easy to unit-test. This is the
 * single source of truth consulted by every logging path in ai.service.
 */

export type MealLifecycleState = 'consumed' | 'preference' | 'neither';

// ── Consumption signals (explicit eating, or a logging imperative) ──────────
// Past tense ("I ate / had / finished"), present-progressive ("I'm eating /
// having"), "for <meal> I had", "ended up eating/having/making", and explicit
// "log / track / add it". A leading "I" is optional ("Had the omelet").
const CONSUMPTION_RE: RegExp[] = [
  // Past / completed eating, optional leading "I" + filler adverbs.
  /^\s*(?:i\s+)?(?:just\s+|already\s+|also\s+|finally\s+|basically\s+|literally\s+|kinda\s+|sorta\s+)*(?:ate|eaten|had|have\s+had|have\s+eaten|finished|finished\s+eating|done\s+eating|polished\s+off|demolished|devoured|scarfed(?:\s+down)?|inhaled|downed|chowed(?:\s+down)?|wolfed(?:\s+down)?|gobbled(?:\s+up)?|snacked(?:\s+on)?|grabbed|consumed)\b/i,
  // "I ate / had / finished" anywhere (not just at start).
  /\bi\s+(?:just\s+|already\s+|also\s+|finally\s+)*(?:ate|had|finished\s+eating|finished\s+(?:my|the|a)|polished\s+off|devoured|scarfed|downed|consumed|grabbed)\b/i,
  // Present-progressive eating = eating now.
  /\bi'?m\s+(?:eating|having|finishing|munching|snacking|sipping|drinking|chowing|devouring)\b/i,
  /\bi\s+am\s+(?:eating|having|finishing|munching|snacking|drinking)\b/i,
  // "ended up eating / having / making / getting" → they made AND ate it.
  /\bended\s+up\s+(?:eating|having|making|getting|grabbing|going\s+with|with)\b/i,
  // "for <meal> I had / ate / made / grabbed"
  /\bfor\s+(?:breakfast|lunch|dinner|brunch|supper|a\s+snack|dessert|my\s+\w+)\s*,?\s+i\s+(?:had|ate|made|grabbed|got|did|finished)\b/i,
  // Explicit logging imperative + an object ("log the halloumi plate", "log it",
  // "track my lunch", "add that"). Requires a reference so it can't fire on a
  // bare verb that means something else.
  /^\s*(?:can\s+you\s+|could\s+you\s+|would\s+you\s+|please\s+|pls\s+|plz\s+|go\s+ahead\s+and\s+|just\s+)?(?:log|track|record|note|count|jot\s+down|put\s+down|add)\s+(?:it|that|this|the|my|a\s|an\s|\d|in\b|down\b|some\b|in\s+|the\s)/i,
];

// Negation that voids a consumption verb ("I didn't eat", "haven't had",
// "not going to eat yet"). When present we do NOT treat the message as eaten.
const CONSUMPTION_NEGATION_RE =
  /\b(?:didn'?t|did\s*not|haven'?t|have\s*not|hadn'?t|hasn'?t|never|not\s+(?:yet|going\s+to|gonna|really)|won'?t|will\s+not|no\s+longer|skip(?:ped|ping)?|gonna\s+skip)\b/i;

// ── Preference / exploration signals (interest, selection, planning) ────────
// These express INTENT or INTEREST, never eating. They must never log.
const PREFERENCE_RE: RegExp[] = [
  // "sounds good" / "looks great" / "sounds delicious"
  /\b(?:sounds?|looks?)\s+(?:good|great|perfect|delicious|tasty|nice|amazing|yummy|lovely|appealing|appetizing|interesting|fun|solid|wonderful|incredible|fantastic|tempting)\b/i,
  // "that/this/it sounds/looks/works/seems good"
  /\b(?:that|this|those|it)\s+(?:sounds?|looks?|works?|would\s+work|seems?\s+(?:good|great|nice|fine|perfect))\b/i,
  // "that works" / "that'll work"
  /\bthat(?:'?ll)?\s+works?\b/i,
  // Picking a suggested option: "<dish> will/would work", "the oats work",
  // "works for me / for now / great". After a food suggestion, "X will work"
  // is a selection, not eating — production: "Overnight oats will work".
  /\b(?:will|would|'?ll)\s+work\b/i,
  /\bworks?\s+(?:for\s+me|for\s+now|great|well|fine|perfectly|too)\b/i,
  /\b(?:that|this|it)(?:'?ll)?\s+(?:will\s+)?do\b/i,
  // "I like / love / prefer / fancy that/the/this"
  /\bi\s+(?:like|love|prefer|fancy|dig|am\s+into)\s+(?:that|the|this|those|it)\b/i,
  // Future intent: "I'll have / make / go with / try / get the omelet"
  /\bi'?ll\s+(?:have|make|do|go\s+with|take|try|get|cook|grab|order|pick|choose|whip\s+up|prep|prepare|give\s+(?:it|that)\s+a\s+(?:try|go))\b/i,
  // Tentative intent: "I think I'll / I might / I may / I could / I want to /
  // I plan to have/make/try/eat ..."
  /\bi\s+(?:think\s+i'?ll|might|may(?:\s+just)?|could|would|wanna|want\s+to|plan\s+(?:to|on)|intend\s+to|hope\s+to|aim\s+to|was\s+thinking\s+(?:i'?ll|of|about))\s+(?:have|make|do|go\s+with|take|try|get|cook|grab|order|eat|give|whip|prep|prepare)\b/i,
  // "I'm gonna / going to / planning / thinking about / considering / leaning"
  /\bi'?m\s+(?:gonna|going\s+to|planning\s+(?:to|on)|thinking\s+(?:about|of)|considering|leaning\s+(?:toward|towards))\b/i,
  // Standalone planning / considering / thinking-of phrasings
  /\bplanning\s+(?:to|on)\s+(?:eat|have|make|cook|try|get|order)\b/i,
  /\bconsidering\b/i,
  /\bthinking\s+(?:about|of)\b/i,
  // "let's do / go with / try / make X"
  /\blet'?s\s+(?:do|go\s+with|try|make|have)\b/i,
  // "going with the dal" / "I pick / I choose / I'll pick"
  /\bgoing\s+with\b/i,
  /\bi(?:'?ll)?\s+(?:pick|choose)\b/i,
  // "maybe" / "perhaps" the X (tentative selection)
  /\bmaybe\b/i,
  /\bperhaps\b/i,
  // "the salmon one" / "the first option"
  /\bthe\s+\w+\s+(?:one|option)\b/i,
];

// Broad food / dish vocabulary — used to confirm a preference message is
// actually ABOUT a meal ("the omelet sounds good") and not a bare affirmation
// to a non-food offer ("that sounds good" → "want me to walk you through?").
const FOOD_MENTION_RE =
  /\b(food|meal|dish|plate|bowl|wrap|sandwich|sub|burger|burrito|taco|pizza|sushi|soup|stew|curry|dal|dahl|chili|casserole|scramble|omelet(?:te)?|frittata|salad|stir.?fry|smoothie|shake|oatmeal|oats|cereal|pancakes?|waffles?|toast|bagel|yogurt|cottage\s+cheese|cheese|halloumi|tofu|tempeh|seitan|edamame|falafel|hummus|lentils?|chickpeas?|beans|quinoa|rice|pasta|noodles?|ramen|egg|eggs|chicken|turkey|beef|steak|pork|bacon|ham|fish|salmon|tuna|cod|tilapia|shrimp|prawns?|seafood|veg(?:gie|etable)s?|broccoli|spinach|kale|cauliflower|potato(?:es)?|sweet\s+potato|avocado|fruit|banana|apple|berries|nuts|almonds?|granola|protein\s+(?:bar|shake)|snack|breakfast|lunch|dinner|brunch|supper|dessert)\b/i;

/** True when the text names a recognizable food / dish / meal. */
export function mentionsFood(text: string): boolean {
  return FOOD_MENTION_RE.test(text ?? '');
}

// Generic meal-TIME / container words that name WHEN or HOW MUCH someone ate,
// not WHAT — "breakfast", "a big lunch", "dinner", "a snack". On their own these
// are NOT loggable food (we don't know what the food was). Stripped before the
// real-food check so "I had breakfast late" logs nothing, but "breakfast burrito"
// (a real dish) still does.
const GENERIC_FOOD_WORD_RE =
  /\b(?:food|meal|meals|dish|plate|bowl|snack|snacks|breakfast|lunch|dinner|brunch|supper|dessert|bite|something|anything|portion|serving|helping)\b/gi;

/**
 * True when the text names a SPECIFIC food/dish — not merely a meal-time or
 * container word. "I had salmon" / "breakfast burrito" → true; "I had breakfast
 * late" / "a big lunch" / "skipped dinner" → false. Used so the logger never
 * records a bare meal-time word as if it were a food (prod: "I had breakfast
 * late, skipped lunch…" → "Glad that's logged").
 */
export function namesSpecificFood(text: string): boolean {
  const stripped = (text ?? '').replace(GENERIC_FOOD_WORD_RE, ' ');
  return FOOD_MENTION_RE.test(stripped);
}

/** True when the message explicitly confirms the user ate / wants logged. */
export function isConsumptionConfirmed(text: string): boolean {
  const t = (text ?? '').trim();
  if (t.length === 0) return false;
  if (CONSUMPTION_NEGATION_RE.test(t)) return false;
  return CONSUMPTION_RE.some((re) => re.test(t));
}

/** True when the message is preference / exploration only (never log). */
export function isPreferenceLanguage(text: string): boolean {
  const t = (text ?? '').trim();
  if (t.length === 0) return false;
  return PREFERENCE_RE.some((re) => re.test(t));
}

/**
 * Classify the meal-lifecycle intent of a message. Consumption is checked
 * FIRST so "I ended up eating the dal that sounded good" → consumed (not
 * preference). Returns 'neither' for everything that is neither an explicit
 * eat nor an explicit preference (a plain food log like "2 eggs and toast"
 * is 'neither' here — it has no preference words and the dedicated food-log
 * paths handle it).
 */
export function detectMealConsumption(text: string): MealLifecycleState {
  const t = (text ?? '').trim();
  if (t.length === 0) return 'neither';
  if (isConsumptionConfirmed(t)) return 'consumed';
  if (isPreferenceLanguage(t)) return 'preference';
  return 'neither';
}

/**
 * A bare consumption back-reference: the user confirms they ate the
 * recommended meal WITHOUT naming it ("I ended up making it", "had it",
 * "ate that", "finished it"). When true, the caller resolves the meal name
 * from the stored active recommendation instead of asking again.
 */
const BARE_BACKREF_RE =
  /^\s*(?:i\s+)?(?:just\s+|finally\s+|already\s+)?(?:ate|had|made|finished|finished\s+eating|did|made\s+and\s+ate|ended\s+up\s+(?:eating|having|making|getting))\s+(?:it|that|those|them|the\s+(?:dish|meal|one|recipe|plate|option|first\s+one|second\s+one))\b[\s.!]*$/i;

export function isBareConsumptionBackReference(text: string): boolean {
  const t = (text ?? '').trim();
  if (t.length === 0) return false;
  if (CONSUMPTION_NEGATION_RE.test(t)) return false;
  // Short, pronoun-y, names no concrete food.
  if (t.split(/\s+/).filter(Boolean).length > 9) return false;
  return BARE_BACKREF_RE.test(t);
}

// ── Consumption feedback (the 4th lifecycle signal) ─────────────────────────
// The user TRIED something — usually one of Grace's prior suggestions — and is
// reporting how it went ("I feel good after drinking the smoothie", "that
// worked", "I tried it", "the omelet was great", "the one you suggested"). This
// is neither a fresh request NOR a clean food log: it's a FOLLOW-UP. Grace must
// connect it to the prior turn — acknowledge, OFFER to log (never force, never
// assume macros without details), and NEVER restart the recommendation flow or
// re-ask preferences. General across topics; the caller gates on food context.
const CONSUMPTION_FEEDBACK_RE: RegExp[] = [
  // "after eating / drinking / having / finishing / trying / I ate / I had ..."
  /\bafter\s+(?:eating|drinking|having|finishing|trying|that|i\s+(?:ate|had|drank|tried|made|finished))\b/i,
  // "I tried / tested it" / "gave it a try/go/shot"
  /\bi\s+(?:tried|tested)\b|\bgave\s+(?:it|that|the\s+\w+)\s+a\s+(?:try|go|shot)\b/i,
  // "that / it / this worked / helped / did the trick / was helpful"
  /\b(?:that|it|this)\s+(?:worked|helped|did\s+the\s+trick|was\s+(?:helpful|perfect|great|good|delicious|filling))\b/i,
  // "the <food> was / tasted good / great / delicious / filling ..."
  /\bthe\s+\w+\s+(?:was|tasted)\s+(?:good|great|nice|delicious|amazing|perfect|lovely|tasty|filling|fine|solid|wonderful|so\s+good)\b/i,
  // "I feel good / better / great / full / less <symptom> ..." (state report)
  /\bi\s+feel\s+(?:good|better|great|fine|full|amazing|satisfied|so\s+much\s+better|less\s+\w+)\b/i,
  // Explicit back-reference to a prior suggestion.
  /\b(?:the|that)\s+one\s+you\s+(?:suggested|recommended|mentioned|said|gave)\b/i,
  /\byou\s+(?:suggested|recommended)\b/i,
];

// NEGATIVE feedback / symptoms — "I don't feel good after eating that", "the
// smoothie didn't sit well", "feeling nauseous". These match the "after eating"
// trigger but are the OPPOSITE of positive feedback — they belong to the
// symptom/health paths, never the offer-to-log handler.
const NEGATIVE_FEEDBACK_RE =
  /\b(?:don'?t|do\s*not|doesn'?t|didn'?t|did\s*not|not|no\s+longer)\s+feel\b|\bfeel(?:ing)?\s+(?:bad|worse|sick|ill|unwell|nauseous|nauseated|queasy|terrible|awful|off|crampy|cramping|bloated|dizzy|weird|gross|heavy)\b|\b(?:didn'?t|don'?t|doesn'?t|did\s*not)\s+(?:work|help|sit\s+well|agree\s+with)\b/i;

/**
 * True when the message is POSITIVE follow-up feedback after trying something
 * (often a prior recommendation): a tried-it report, a how-it-felt update, or a
 * back-reference to a suggestion. Negated / negative-feeling messages void it
 * ("I don't feel good after…", "it didn't sit well" → symptoms, handled
 * elsewhere). The caller must additionally confirm food context (named food or
 * a prior food recommendation) before acting, so a generic "that worked" to a
 * non-food offer isn't hijacked.
 */
export function detectConsumptionFeedback(text: string): boolean {
  const t = (text ?? '').trim();
  if (t.length === 0) return false;
  if (CONSUMPTION_NEGATION_RE.test(t)) return false;
  if (NEGATIVE_FEEDBACK_RE.test(t)) return false;
  return CONSUMPTION_FEEDBACK_RE.some((re) => re.test(t));
}

/**
 * Pull the first concrete food/dish word the message names, for echoing back
 * ("glad the smoothie felt good"). Returns null for generic meal words
 * (breakfast/lunch/snack/food/meal) — those don't name a dish to reference.
 */
export function extractFoodMention(text: string): string | null {
  const m = (text ?? '').match(FOOD_MENTION_RE);
  if (!m) return null;
  const w = m[0].toLowerCase().trim();
  if (/^(?:food|meal|dish|plate|bowl|snack|breakfast|lunch|dinner|brunch|supper|dessert|fruit|veg(?:gie|etable)s?)$/.test(w)) {
    return null;
  }
  return w;
}

// Everything from here on is a QUESTION / planning clause, not the eaten food:
// "how much protein…", "what should I eat later", "any snack idea", a trailing
// "?" — so it must be sliced off before the eaten-food span is logged.
const QUESTION_TAIL_RE =
  /\b(how\s+(?:much|many)|what\s+(?:should|can|could|do|to|else|would)|is\s+that|are\s+those|any\s+(?:snack|idea|ideas|suggestions?|thoughts?)|should\s+i|and\s+what|and\s+how|what'?s\s+(?:a\s+)?good)\b/i;

// Trailing NON-food state/context clauses that follow the eaten food in the same
// sentence (no period between them), e.g. "I ate yogurt with berries after my
// injection and now I'm a little hungry". These are not part of the meal and
// must be sliced off so only the eaten food is logged. Scoped tightly ("and now",
// "now i'm", "after my <injection/shot/dose/workout>") so it never cuts a real
// food phrase like "chicken with rice".
const CONSUMPTION_TAIL_RE =
  /\b(?:and\s+now\b|now\s+i'?m\b|after\s+my\s+(?:injection|shot|jab|dose|workout|run|exercise))/i;

/**
 * When the message reports food the user ALREADY ate AND names a real food,
 * return JUST the eaten-food span — with any trailing question / planning clause
 * ("...how much protein is that, and what should I eat later?") sliced off — so a
 * caller can log it. Returns null when the message isn't a food-consumption
 * statement (a pure question, preference, or non-food).
 *
 * This is the deterministic NEVER-DROP backstop for the "I had X … <question>"
 * shape: the single-intent LLM extractor can misread the whole message as a
 * query/none because it also asks something, silently dropping real intake.
 * Consumption is explicit + food is named, so it can't fire on "what should I
 * eat?" (nothing eaten) or "that sounds good" (preference).
 */
export function foodSpanFromConsumption(text: string): string | null {
  const t = (text ?? '').trim();
  if (!isConsumptionConfirmed(t)) return null;
  // Cut at the EARLIEST of: first sentence end, first '?', first question clause.
  const idx = (re: RegExp): number => { const m = t.search(re); return m < 0 ? Infinity : m; };
  const cut = Math.min(idx(/[.!?]/), idx(QUESTION_TAIL_RE), idx(CONSUMPTION_TAIL_RE));
  let span = (cut !== Infinity && cut > 0 ? t.slice(0, cut) : t).trim();
  // Trim a dangling connector/punctuation left by the cut ("… and salad ,").
  span = span.replace(/[\s,;:.!?]+$/g, '').replace(/\s+(?:and|with|plus|,|&)\s*$/i, '').trim();
  // Require a SPECIFIC food, not just a meal-time word ("I had breakfast late"
  // names no dish → nothing to log).
  if (span.length < 2 || !namesSpecificFood(span)) return null;
  return span;
}
