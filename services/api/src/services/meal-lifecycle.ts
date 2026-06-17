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
