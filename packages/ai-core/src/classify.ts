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
  // Phase 1 (coverage expansion plan) — new intent types for gap topics
  | 'exercise_log'   // "I did 30 min of resistance training", "walked 5k today"
  | 'injection_log'  // "I took my shot", "just injected", "did my weekly"
  | 'medication_question' // dose / timing / switching / refill — distinct from general knowledge
  | 'social_situation' // restaurants, weddings, holidays, travel meals, family pressure
  | 'pause_request'  // "pause messages", "stop texting for a week", "take a break"
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
// FOOD_SUMMARY_QUESTION matches anything that asks about TODAY'S logged
// protein/calorie state, including totals, breakdowns, items, "left",
// "did I", and "how am I doing on protein". These all share the same
// downstream behaviour: force get_food_summary so Grace answers from the
// actual food_logs rows instead of hallucinating or asking for clarification.
const FOOD_SUMMARY_QUESTION: RegExp[] = [
  // 2026-06-06: tightened to require today/so-far/eaten anchors. The old
  // generic "how much protein" matched REQUIREMENT questions ("how much
  // protein should I eat per day") which should route to knowledge with
  // clinical target answers (1.2-1.6g/kg), not food summary.
  /\bhow (much|many)\s+(protein|calorie|carb|gram|kcal)\b[^.?!]{0,40}\b(have i|did i|today|so far|left|remaining|consumed|eaten|logged|right now|currently)\b/i,
  /\b(what'?s|whats) my (protein|calorie|total)\b[^.?!]{0,40}\b(today|so far|right now|count|total|currently)\b/i,
  /\bhow (much|many) did i (eat|have|consume) (today|this (week|day))/i,
  /\b(my|today'?s) (protein|calorie) (count|total|so far)/i,
  /\b(at|on) (how much|how many|what)\b.{0,30}(today|so far)/i,
  /\b(calories|kcal|protein) (left|remaining|to go)\b/i,
  /\bdid i (over|under)?eat\b/i,
  /\b(can|could) i (still|even) (eat|have|drink)\b.{0,40}(today|now|left)/i,
  /\bhow much (can|should) i (eat|have)\b.{0,40}(today|left|tonight|for dinner)/i,
  /\bam i over (my )?(calorie|budget|target|goal)/i,
  // Production failure (2026-05-31): "How did I reached 40 g of protein?"
  // fell into 'general' → no get_food_summary → safe fallback fired.
  /\bhow (did i|do i|have i) (reach|reached|get|got|hit|hit at|end up at|arrive at|end up with) (to |at |my )?(\d+|the|my)/i,
  /\b(what|which) (foods?|meals?|items?|things?) (did i|have i) (eat|log|consume|have)\b/i,
  /\b(what'?s|whats) (in|on) my (food|protein|calorie) (log|count|total)/i,
  /\b(show|list|tell) me (what|all|the foods) i('?ve| have)? (eaten|logged|consumed|had) (today|so far)/i,
  /\b(break ?down|breakdown) (of|my) (today'?s )?(protein|calorie|food)/i,
  /\bwhere (is|are) (the|my) (\d+|extra )?(protein|calorie|gram|kcal) (coming from|from)/i,
  // Progress-style status checks ("how am I doing on protein", "protein update")
  /\bhow am i doing (on|with) (my )?(protein|calorie)/i,
  /\b(protein|calorie) (update|status|check)\b/i,
  /\b(am i|are we) (close to|on track for|hitting|missing) (my )?(protein|calorie|target|goal)/i,
  /\bwhere am i (at |on |with )(my )?(protein|calorie|target|goal)/i,
  // Conditional "if I eat X" / "if I add Y" / "will eggs put me at"
  /\bif i (eat|have|drink|add|skip) [^.?!]{1,40}(protein|calorie|target|goal|hit)/i,
  /\bwill (eating|having|drinking) [^.?!]{1,40}(hit|reach|put me at|get me to) (my )?(protein|calorie|target|goal)/i,
];

// Target/goal explanation queries — ROUTE to food_question so Grace uses
// get_user_profile + the protein-from-CURRENT-weight rule. Without these,
// "Why is my target 60g?" went to general → planner → inconsistent answer.
export const PROTEIN_TARGET_QUESTION: RegExp[] = [
  // "why is my protein target 60g" / "how was my protein goal calculated"
  /\b(why|how) (is|was|did|do you|are you) (my )?(protein|calorie) (target|goal) (\d+|so|calculated|computed|set)/i,
  /\b(what'?s|whats|what is) my (protein|calorie) (target|goal)\b/i,
  /\bhow (much|many) (protein|calorie|gram|kcal) (should|do) i (need|eat|consume|have) (per|a|each|every) (day|daily)?/i,
  // "is 60g of protein enough" — my/the are optional since user may say "is 60g..."
  /\b(is|are) (my |the )?(\d+ ?g|target|goal) (of )?(protein|calorie)? ?(right|enough|correct|too (much|low|high))/i,
  /\bwhy (so much|so little|that much) (protein|calorie)/i,
  // 2026-06-05 production failure: "How many proteins should have based on
  // research" missed every pattern above — "proteins" plural, no "I",
  // ends with "research" instead of "day". Broader catch-all for generic
  // protein-amount questions.
  /\bhow (much|many) (protein|proteins|calorie|calories|grams? of protein|carbs)\b/i,
  /\b(protein|calorie) (target|goal|requirement|needs?|recommend(ation|ed)|amount)\b/i,
  // 2026-06-05 v3: "How many grams of proteins should have based on
  // research" — "grams of proteins" (plural) with extra middle word
  // ("should have based on research"). Looser pattern allows for
  // intermediate words.
  /\bhow (much|many) grams? of (protein|proteins)\b/i,
  // 2026-06-05 v4: "What is the recommended proteins for a man?" /
  // "What is the protein for someone my size?" — recommendation-asking
  // patterns that don't lead with "how much" but ask about protein.
  /\b(what (is|are) (the )?recommended\s+(protein|proteins|grams of protein)|recommended\s+protein\s+(for|target|amount))\b/i,
  /\b(daily|recommended|suggested)\s+(protein|calorie)\s+(intake|amount|target|goal|for)\b/i,
];

// Past-day queries — ROUTE to food_question, but the AI service force-calls
// get_protein_history instead of get_food_summary.
export const FOOD_HISTORY_QUESTION: RegExp[] = [
  /\b(yesterday'?s?|past day'?s?|previous day'?s?) (protein|calorie|food|log|meal)/i,
  /\b(how much|how many) (protein|calorie) (did|have) i (eat|have|consume|log) (yesterday|last (week|night|day))/i,
  /\b(this|last|past) (week|7 days|few days)['']?s? (protein|calorie|average|total)/i,
  // "show me my protein history for the last 7 days" — connector words ("for",
  // "over", "across") may appear between "history" and "last", so allow up to
  // 15 non-terminal chars between them.
  /\b(show|tell|give) me (my )?(protein|calorie) (history|trend|breakdown)\b[^.?!]{0,20}\b(last|past) (\d+\s+)?(days?|week)/i,
  /\b(am i|have i been) (hitting|averaging|missing) (my )?(protein|calorie) (target|goal) (last|this|past|over) (week|few days)/i,
  /\b(what'?s|what was) my (protein|calorie) (yesterday|last (week|night))/i,
];

// Food removal / correction queries — ROUTE to food_question, force remove_food
export const FOOD_REMOVAL_QUESTION: RegExp[] = [
  /\b(remove|delete|undo|forget|cancel) (the |that |my )?(last |the )?(food|log|entry|eggs?|chicken|shake|yogurt|protein|meal|snack|item)/i,
  /\bi (didn'?t|did not) (eat|have|drink) (the|that|those)/i,
  /\b(that'?s|that was|its) wrong\b/i,
  /\bactually (it was|it'?s|i had|i ate)/i,
  /\b(remove|delete|undo) (the|that) last/i,
  /\bi (made a |was )?mistake/i,
];

// Recognized single-word foods/drinks — used by the bare multi-item list
// matcher so "tuna, rice, avocado" reads as a food log without a verb.
const FOOD_WORDS =
  'tuna|rice|avocado|chicken|beef|pork|fish|salmon|tofu|tempeh|seitan|eggs?|yogurt|oatmeal|oats|pasta|pizza|sushi|sandwich|burger|burrito|taco|wrap|soup|steak|turkey|bagel|toast|cereal|pancakes?|waffles?|fruit|banana|apple|orange|berries|grapes|salad|broccoli|spinach|kale|potato|sweet potato|quinoa|beans|lentils|chickpeas|edamame|hummus|cheese|milk|bread|nuts|almonds?|walnuts?|peanuts?|granola|smoothie|shake|coffee|tea|water|protein bar|protein shake|cottage cheese|shrimp|cod|tilapia|crackers?|popcorn|chocolate|cookie|cake|fries|nuggets?';

const FOOD_LOG: RegExp[] = [
  // Direct past-tense verbs at start of message
  // "also" covers "I also ate X" / "I also had X" (common continuation logs)
  /^(i )?(just |already |also |i'?ve |i've )?(had|ate|eaten|finished|grabbed|made|cooked|ordered|got|drank|consumed|tried|enjoyed|polished off|crushed|nibbled|munched|snacked) (a |an |some |the |my |2 |3 |4 )?\w/i,
  // "I'm eating", "I'm having" (present tense)
  /^i'?m (eating|having|drinking|finishing|munching|snacking|sipping)\b/i,
  // "Snacked on X" / "Snacking on X" — common casual log
  /\b(snacked|snacking|nibbling|munching) (on |upon )?(a |an |some |the )?\w/i,
  // Meal context phrases
  /\b(breakfast|lunch|dinner|snack|meal|brunch)\s*(was|had|:\s*|today|consist|started with|consisted of|included)/i,
  /\bfor (breakfast|lunch|dinner|snack|brunch)[,: ]/i,
  // Standalone meal labels at start: "Breakfast: 2 eggs" / "Lunch — chicken"
  // Also "Late breakfast", "Quick snack", "Light dinner"
  /^(late |early |quick |light |big |huge |small )?(breakfast|lunch|dinner|snack|brunch|meal)\s*[:—\-]\s*\w/i,
  // Time-of-day prefixes: "This morning I had", "Earlier I ate"
  /^(this morning|this afternoon|tonight|earlier|just now|a (?:bit|while) ago|few (?:hours|mins?) ago|today) (i )?(had|ate|grabbed|drank|made|cooked|ordered|got|finished|snacked|tried)\b/i,
  // Quantities — expanded with more units + fractional quantities
  /\b\d+\s*(eggs?|slices?|cups?|grams?|g\b|oz|ounces?|servings?|pieces?|bites?|tablespoons?|tbsp|tsp|teaspoons?|portions?|scoops?|handful?s?|pcs?|bowls?|plates?|cans?|bottles?|cookies?|chips?)\b/i,
  /\b(half|quarter|third|1\/2|1\/4|1\/3|2\/3|3\/4|a couple|a few)\s+(?:of\s+)?(?:a\s+|an\s+)?(cup|serving|slice|portion|piece|bowl|plate|scoop|tbsp|tsp|can|bottle|cookie|chip|stick|bar|donut|muffin)/i,
  // "About X" / "Around X" estimates
  /\b(about|around|roughly|approximately|maybe|like) (a |an |some |\d+)/i,
  // Drinks
  /\b(drank|drinking|had|having|sipping) (a |an |some )?(water|coffee|tea|shake|smoothie|juice|coke|soda|beer|wine|latte|cappuccino|americano|espresso|cocoa|matcha|kombucha|kefir)\b/i,
  /\b(protein shake|whey|smoothie|latte|cappuccino|americano|matcha) (with|had|drank|made|after|in|this)/i,
  /^(protein shake|smoothie|latte|cappuccino|americano|matcha|kombucha)\s*[.!?]?\s*$/i,
  // Common foods at the start of message (no verb, just a food list)
  /^(a |an |some |the |my )?(salad|chicken|fish|beef|pork|tofu|tempeh|seitan|eggs?|yogurt|oatmeal|rice|pasta|pizza|sushi|sandwich|burger|burrito|taco|wrap|soup|steak|salmon|tuna|turkey|bagel|toast|cereal|pancakes?|waffles?|fruit|banana|apple|orange|berries|smoothie|protein bar|kind bar|rxbar|quest bar|cliff bar)\b/i,
  // "I had X" / "I ate X" — broader food terms
  /\b(had|ate|eating) (salad|chicken|fish|beef|pork|tofu|tempeh|seitan|eggs?|yogurt|oatmeal|rice|pasta|pizza|sushi|sandwich|burger|burrito|taco|wrap|soup|steak|salmon|tuna|turkey|bagel|toast|cereal|pancakes?|waffles?|fruit|banana|apple|orange|berries|big mac|fries|coke|protein bar)/i,
  // Comma-separated food list (multi-item meal: "banana, eggs, coffee")
  /^[A-Za-z][a-z]+(\s+[a-z]+)?,\s*[A-Za-z][a-z]+/i,
  // "and" / "with" joiner with food words anywhere
  /\b(banana|egg|chicken|rice|salad|fries|burger|pizza|yogurt|toast|oatmeal|sandwich|pasta|salmon|tuna|steak|tofu|tempeh|edamame|broccoli|spinach|potato|sweet potato|quinoa) (and|with) (a |an |some |the )?(banana|egg|chicken|rice|salad|fries|burger|pizza|yogurt|toast|oatmeal|sandwich|pasta|salmon|tuna|steak|tofu|tempeh|edamame|broccoli|spinach|potato|sweet potato|quinoa|coffee|water|coke|soda|juice)/i,
  // Restaurant / brand prefixes — "Chipotle bowl", "Starbucks latte", etc.
  /\b(from|at|got from) (chipotle|starbucks|panera|sweetgreen|chick.?fil.?a|mcdonald'?s|wendy'?s|burger king|taco bell|subway|panda express|five guys|in.?n.?out|whole foods|trader joe'?s|costco)\b/i,
  /\b(chipotle|starbucks|panera|sweetgreen|chick.?fil.?a|mcdonald'?s|wendy'?s|burger king|taco bell|subway|panda express) (bowl|burrito|sandwich|salad|wrap|smoothie|shake|coffee|latte|burger|nuggets|fries|tacos?|enchilada)/i,
  // Bare multi-item food list, optionally led by a continuation word
  // ("And tuna, rice, avocado" / "And tuna\nRice\nAvocado" / "eggs and toast").
  // 2026-06-11 WhatsApp screenshot: a follow-up adding foods to a prior log
  // ("And tuna / Rice / Avocado") classified as 'general' → generic fallback.
  // Requires 2+ recognized food words so it can't fire on arbitrary lists.
  new RegExp(
    `^(?:and|also|plus|then|with)?\\s*(?:a |an |some |the |my |\\d+ )?(?:${FOOD_WORDS})\\b(?:\\s*[,\\n/]\\s*|\\s+(?:and|with|plus)\\s+)(?:a |an |some |the |\\d+ )?(?:${FOOD_WORDS})\\b`,
    'i',
  ),
];

const FOOD_QUESTION: RegExp[] = [
  /\bwhat (should|can|could) i (eat|have|make|cook|order|get|grab|pick|do|try)\b/i,
  // 2026-06-11 WhatsApp screenshot: "What I should eat for dinner" (dropped
  // auxiliary / inverted word order) missed the pattern above and routed to
  // 'general' → generic fallback. Catch the "what I should/can eat" form too.
  /\bwhat (?:i should|i can|i could|i'?d|to) (eat|have|make|cook|order|get|grab|pick|try)\b/i,
  // "How about X for dinner?" / "What about a salad?" — considering a food.
  // Routes to the recommendation path instead of being logged as eaten.
  /^(?:how about|what about)\s+.{1,40}\b(for (?:breakfast|lunch|dinner|a snack|dessert)|to eat|instead)\b/i,
  /\b(recommend|suggest)(ion)?(s)? for (food|meal|dinner|lunch|snack|breakfast|protein)/i,
  /\b(good (protein|snack|meal|food) (options?|ideas?|choices?))\b/i,
  /\bhow much protein (in|is|does|for)\b/i,
  /\bcan i (eat|have|drink)\b/i,
  /\b(hungry).{0,50}(what|any|suggest|recommend)/i,
  /\bany (food|meal|snack|dinner|lunch|breakfast|protein) (ideas?|suggestions?|recommendations?|options?)\b/i,
  /\bwhat('?s| is) (a )?(good|healthy|high.protein|filling|light) (meal|snack|option|food|breakfast|lunch|dinner)/i,
  // 2026-06-06 production failure: "Give me high-protein snacks" was
  // classified as 'general' → orchestrator failed → typed fallback shipped
  // "Say more — I'm with you." None of the patterns above catch the
  // imperative request form ("Give me X", "Show me X", "List X") or the
  // descriptive noun form ("high-protein snacks", "low-carb meals"). The
  // four patterns below close those gaps without firing on non-food
  // imperatives ("give me a minute", "show me the weight"): each requires
  // a concrete food/recommendation noun in the same sentence.
  // Imperative recommendation request: "Give/Show/List/Tell me ... <food-noun>"
  // "sides?" intentionally NOT in the noun list — "side" matched "side
  // effects" in the user message "Tell me about side effects" (a knowledge
  // question, not a food request).
  /^(give|show|list|find|suggest|name|tell|share|throw|send|bring|hit)\s+me\s+(?:some\s+|a\s+(?:few|list\s+of|couple|bunch)\s+|more\s+|new\s+)?[^.?!]{0,60}\b(snacks?|meals?|breakfasts?|lunches?|dinners?|brunches?|foods?|ideas?|options?|recipes?|recommendations?|bars?|drinks?|smoothies?|shakes?|desserts?|treats?|protein\s+(?:bars?|shakes?|options?))\b/i,
  // "I want/need/looking for ... <food-noun>"
  /^(?:i\s+)?(?:want|need|am\s+looking\s+for|looking\s+for|would\s+like|could\s+use)\s+(?:some\s+|a\s+(?:few|list\s+of|couple)\s+|more\s+|new\s+)?[^.?!]{0,60}\b(snacks?|meals?|breakfasts?|lunches?|dinners?|brunches?|foods?|ideas?|options?|recipes?|bars?|drinks?|smoothies?|shakes?|protein\s+(?:bars?|shakes?|options?))\b/i,
  // Descriptive noun phrase: "high-protein snacks", "low-carb meals", "keto breakfast"
  /\b(?:high[-\s]protein|low[-\s](?:carb|calorie|fat|sodium|sugar|cal)|protein[-\s]rich|fiber[-\s]rich|whole[-\s]food|plant[-\s]based|keto|vegan|vegetarian|paleo|mediterranean|low[-\s]glycemic|gluten[-\s]free|dairy[-\s]free|sugar[-\s]free|high[-\s]fiber|nutrient[-\s]dense)\s+(snacks?|meals?|breakfasts?|lunches?|dinners?|brunches?|foods?|ideas?|options?|recipes?|bars?|drinks?|smoothies?|shakes?|desserts?)\b/i,
  // "<meal-type> ideas/options/suggestions/recommendations/recipes"
  /\b(snack|meal|breakfast|lunch|dinner|brunch|food|protein|smoothie|shake|recipe|dessert|treat)\s+(ideas?|options?|suggestions?|recommendations?|recipes?)\b/i,
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
  /\bfeel (so |really |very )?(bad|sad|down|depressed|anxious|nervous|scared|afraid|worried|overwhelmed|stressed|hopeless|defeated|frustrated|angry|annoyed|defeated|stuck|lost|broken)\b/i,
  // 2026-06-06 production failure: "I'm nervous" → "What's the rest of that?"
  // because EMOTIONAL didn't include nervous/scared/worried/anxious in any
  // pattern. Add a dedicated "I'm <feeling>" matcher for these states.
  /\b(?:i'?m|im|i am)\s+(?:just |so |really |kind of |a bit |very |super )*(?:nervous|scared|afraid|worried|anxious|terrified|panicking|panicked|on edge|jittery|uneasy|apprehensive|fearful)\b/i,
  /\b(want to (give up|quit|stop)|not sure (if )?this is working)\b/i,
  /\b(lost (my |the )?motivation|can't (do this|keep going|stick to this))\b/i,
  /\b(really (tired|exhausted|drained|burned out) of)\b/i,
  /\b(having a (hard|tough|rough) (time|day|week|moment))\b/i,
  /\b(feel (like a failure|terrible|awful|hopeless|worthless))\b/i,
  /\b(cry|crying|sobbing|broke down)\b/i,
  // 2026-06-05 production failures: "Ugh, I'm just so incredibly frustrated
  // right now" and "It's just this stupid scale, Grace. I've been stuck at
  // 155 for like" — neither matched the regexes above.
  /\b(?:i'?m|im|i am)\s+(?:just |so |really |incredibly |super |totally |absolutely )*(?:frustrated|annoyed|fed up|done|over it|exhausted|drained|defeated|hopeless|stuck|angry|upset|sad|miserable|miserable)\b/i,
  /\bUgh\b[,.!]?\s+/i,
  /\b(?:stupid|damn|fucking|frigging)\s+(?:scale|number|weight|body|food|plateau|nausea)\b/i,
  /\bstuck\s+at\s+\d+\s+for\s+(?:like\s+)?(?:weeks?|months?|days?)/i,
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
  // SAME SENTENCE (legacy patterns)
  /\b(help me (write|draft|prepare|prep)|prepare me (for|to)|prep me (for)?|what should i ask|questions (for|to ask)|write (down |out )?(my |some )?questions)\b[^.?!]{0,80}\b(doctor|endocrinologist|endo|specialist|appointment|visit|consult|consultation|gp|pcp|provider|prescriber)\b/i,
  /\b(doctor|endocrinologist|endo|specialist|gp|pcp|provider|prescriber)\b[^.?!]{0,80}\b(appointment|visit|consult|consultation)\b[^.?!]{0,80}\b(help|prepare|prep|questions|what should i ask|write)/i,
  /\b(i have (?:my |an? )?(?:appointment|visit|consult)|(?:my )?appointment (?:is |coming|next))\b[^.?!]{0,80}\b(help|prepare|prep|questions|what should i ask|write)/i,
  /\bprepare (?:me )?(?:for )?(?:the |my )?(?:appointment|visit|consult|doctor|endocrinologist)\b/i,
  // CROSS-SENTENCE match — production failure (session 3):
  //   "I have my endocrinologist appointment next week. Help me write my questions"
  // The trigger phrase and the appointment word were in different sentences,
  // so [^.?!]{0,80} couldn't bridge them. Use lookaheads so both can be
  // anywhere in the message, independent of sentence boundaries.
  /^(?=[\s\S]*\b(doctor|endocrinologist|endo|specialist|gp|pcp|provider|prescriber|appointment|visit|consult|consultation)\b)(?=[\s\S]*\b(help me? (write|draft|prepare|prep|preparing|drafting|writing)|prepare me|prep me|what should i ask|questions? (for|to ask)|(?:help )?(?:preparing|prepping|drafting|writing) (?:my |some |the |a |these |those )?questions?|write (down |out )?(my |some |the )?questions?))/i,
  // Standalone unambiguous trigger — "help me write my questions" is always
  // appointment prep even if the appointment context was set in prior turns.
  /\b(help me? (write|draft|prepare|prep|preparing|drafting|writing)|prepare me|prep me|help (?:me )?(?:preparing|prepping|drafting|writing)) (?:my |some |the |a (?:list of |few )?)?questions?\b/i,
];

// Side-effect / symptom signals — body sensations that on a GLP-1 deserve
// acknowledgement BEFORE any co-occurring food log gets routed. Runs after
// the explicit log/question intents (so "I just had nausea after my shot"
// can still match medication_question if that fits better) but BEFORE
// food_log so messages like "I had 2 cups of coffee. My stomach hurts."
// don't get reduced to "Logged."
const SYMPTOM_SIGNAL: RegExp[] = [
  // Stomach / GI
  /\b(stomach|tummy|belly|gut|abdomen)\s+(hurts?|aches?|ache|aching|pain|painful|sore|cramping|cramp|upset|burning|tight|twisted|in knots)\b/i,
  /\b(my )?(stomach|tummy|belly|gut)\s+(is|feels?)\s+(killing|hurting|aching|cramping|upset|in pain|on fire|terrible|awful|bad)\b/i,
  /\b(stomach ?ache|tummy ?ache|belly ?ache|gut ?ache)\b/i,
  /\b(cramps?|cramping)\b/i,
  // Nausea / vomiting
  /\b(nauseous|nauseated|nausea|queasy|sick to my stomach)\b/i,
  /\b(throwing up|threw up|vomiting|vomited|puking|puked|gagging|dry heaving)\b/i,
  // Reflux / heartburn / burping
  /\b(heartburn|acid reflux|reflux|gerd|indigestion)\b/i,
  /\b(burping|belching|burps)\b/i,
  // Head
  /\b(headache|migraine|head hurts?|head is pounding|head pounding)\b/i,
  /\b(dizzy|lightheaded|light.headed|spinning|vertigo|woozy)\b/i,
  // Bowel
  /\b(constipated|constipation|haven'?t (been able to )?go|can'?t poop|backed up)\b/i,
  /\b(diarrhea|the runs|loose stool|loose stools)\b/i,
  // Fatigue / energy as body symptom (not emotional "tired of this")
  /\b(exhausted|wiped out|drained|so tired)\b(?!\s+of\b)/i,
  // Hair / face / body change (GLP-1 specific concerns)
  /\b(hair (loss|falling out|thinning|shedding))\b/i,
  // Tachycardia / palpitations (less common but reported)
  /\b(heart racing|heart pounding|palpitations|racing heart)\b/i,
  // General body pain that often signals a side-effect
  /\b(injection site (hurts?|pain|red|swollen|sore|bruised|itchy))\b/i,
];

const KNOWLEDGE: RegExp[] = [
  /\bwhy (is|does|do|am|are)\b.{5,}/i,
  /\bhow (does|do|long|often|much|come)\b.{5,}/i,
  // 2026-06-05 production failure: "How GLP can affect my muscles" was
  // missed by the regex above (no "does/do/long/etc" after "how"). Adding
  // "How X can|will|might affect" pattern to catch generic causation
  // questions about the medication.
  /\bhow\s+(?:does|do|can|will|might|would|could|should)\b/i,
  // 2026-06-05 v2: "How GLP can affect my muscles" — "how" then "GLP"
  // (1 word in between) then "can". Allow 1-3 words between "how" and the
  // verb so multi-token subjects ("how GLP-1 can", "how Wegovy will",
  // "how this drug might") still classify as knowledge.
  /\bhow\s+(?:[A-Za-z][\w-]*\s+){1,3}(?:does|do|can|will|might|would|could|should|affect|impact|cause|change|help|hurt)\b/i,
  // 2026-06-05 v2: "Can drink alcohol" / "Can I have wine" — modal-led
  // questions about consumables and lifestyle that should be knowledge,
  // not food_log or general.
  /\b(can|could|should|may|will|might)\s+(?:i\s+)?(drink|eat|have|take|use|do|skip|stop|miss|combine|mix)\b/i,
  /\bwhat (is|are|does|causes?|happens? (to|when|if))\b.{5,}/i,
  /\b(ozempic|wegovy|mounjaro|zepbound|semaglutide|tirzepatide|rybelsus)\b/i,
  /\bglp[.\s-]?1?\b/i,
  // 2026-06-05: was `\bmuscle\b` (singular only) — "How GLP can affect my
  // muscles" missed because "muscles" has a trailing 's' breaking the word
  // boundary. Use `muscles?` for both singular and plural.
  // 2026-06-05 v2: added alcohol, coffee, caffeine, sugar, carbs, sodium,
  // hydration, water, sleep, exercise, vitamins, supplements — common
  // GLP-1 question topics that were falling to general.
  /\b(side effect|nausea|vomiting|constipation|diarrhea|hair loss|muscles?|plateau|stall|fatigue|headache|reflux|heartburn|bloating|alcohol|wine|beer|caffeine|coffee|sugar|carbs|carbohydrates|sodium|salt|hydration|water intake|sleep|exercise|workout|vitamins?|supplements?|fiber)\b/i,
  /\b(is it normal|is this normal|should i be worried|does this happen|is that ok|is this ok|is that safe)\b/i,
  /\b(missed (my |a )?(dose|shot|injection)|forgot (to take|my) (pill|shot|injection))\b/i,
  /\binjection (site|day|schedule|timing|rotation)\b/i,
  /\b(how does (it|this) work|mechanism|explain)\b/i,
];

// ─── Phase 1 coverage expansion: new intent patterns ──────────────────────────

// User reporting an exercise / workout. Distinct from food_log because we
// need a different tone, no food estimation, and (later) a log_exercise tool.
const EXERCISE_LOG: RegExp[] = [
  // Past-tense workout verbs
  /\b(just |i )?(worked out|did a workout|finished (my )?workout|went to the gym|hit the gym|lifted|did weights|did cardio|did legs|did chest|did arms|did back|did shoulders|trained|crushed (a )?workout)\b/i,
  /\b(just )?(walked|ran|jogged|biked|cycled|swam|hiked|did pilates|did yoga|did spin) \d/i,
  /\b\d+\s*(min|mins|minutes|miles?|km|kilometers?|reps?|sets?|steps?)\s*(of|on|at|walking|running|jogging|biking|cycling|swimming|cardio|lifting|strength|treadmill|elliptical)\b/i,
  /\bran (a )?(\d+\s*(k|miles?|km)|5k|10k|half|marathon)\b/i,
  /\b(stepped|got|hit) (\d+,?\d{3}|10k|5k|8k) steps\b/i,
  // Present-tense workout in progress
  /\bi'?m (at the gym|working out|doing (a )?(workout|cardio|legs|chest|run))\b/i,
];

// User confirming they took their medication. Need a dedicated handler so
// Grace can advance the injection-day state machine without re-asking.
const INJECTION_LOG: RegExp[] = [
  /\b(just )?(took|did|got|finished|done with) (my|the) (shot|injection|jab|dose|pen|weekly|pill|rybelsus)\b/i,
  /\b(just )?injected\b(?!\s+(into\s+(a|the|my\s+\w+\s+is)))/i, // "just injected" / "I injected" — exclude reverse "injected the X"
  /\b(just )?(jabbed|pricked|stuck) (myself|my (thigh|belly|stomach|arm))\b/i,
  /\b(shot|injection|jab) (is )?done\b/i,
  /\b(took it|did it|done) (this morning|tonight|today)\b/i,
  /\bweekly (shot|injection|jab|dose) (done|taken|complete)\b/i,
];

// Medication-specific questions: dose, timing, switching, refill, storage.
// Distinct from generic 'knowledge' (which covers symptoms + mechanism). We
// route these to a warm clinical-redirect template for the dose-change ones
// and to FAQ cache for timing/storage.
const MEDICATION_QUESTION: RegExp[] = [
  /\b(when|what time) (should|do|can) i (take|inject|do|use) (my|the) (shot|injection|dose|pen|pill)\b/i,
  /\bcan i (change|move|shift|switch) (my )?(injection|shot|dose) day\b/i,
  /\b(how|where) (do|should) i (store|keep|refrigerate) (my )?(pen|injection|ozempic|wegovy|mounjaro|zepbound|rybelsus|medication)\b/i,
  /\bcan i (travel|fly|take.{0,10}(plane|flight|trip)) with my (pen|injection|medication)\b/i,
  /\b(switching|switch|change|move) (from )?(ozempic|wegovy|mounjaro|zepbound|semaglutide|tirzepatide|rybelsus) to\b/i,
  /\b(refill|prescription) (running out|empty|out|expired|due)\b/i,
  /\b(can i|should i) (increase|decrease|lower|raise|bump|reduce) (my )?dose\b/i,
  /\b(my )?pen (is )?(out|empty|done|expired|warm|left out|at room temperature)\b/i,
  /\binject(ed)? (in|on|into) (my )?(thigh|belly|stomach|arm|leg)\b/i,
];

// Social situation / event eating. Currently routes to food_question or
// general; gets a dedicated tone (practical strategies, no shame).
const SOCIAL_SITUATION: RegExp[] = [
  // Going out / planning an event: "going to a wedding" / "I have a wedding"
  /\b(going|i'?m going|i'?ll be) (out|to (a |an )?(restaurant|wedding|party|dinner|brunch|barbecue|bbq|holiday|thanksgiving|christmas|easter|passover|ramadan|iftar|bar mitzvah|baby shower|birthday|gathering|family dinner|reunion))/i,
  /\b(i have|got|attending|hosting) (a |an |my )?(restaurant|wedding|party|dinner|brunch|barbecue|bbq|holiday|thanksgiving|christmas|easter|passover|ramadan|iftar|bar mitzvah|baby shower|birthday|gathering|family dinner|reunion|event)\b/i,
  /\b(eating|dining|meal) (out|at (a )?(restaurant|friend'?s|family'?s|in.?laws|parents'?))/i,
  /\bgoing on (a )?(vacation|trip|cruise|holiday|road trip)\b/i,
  /\b(family|friends|my (mom|dad|husband|wife|partner|sister|brother)) (don'?t|doesn'?t) know (about|i'?m on)/i,
  /\b(can|how) (do|should) i (handle|navigate|manage|survive|deal with) (a |the )?(restaurant|wedding|party|dinner|holiday|vacation|buffet|cruise)/i,
  /\b(judging|judged|pressure|pressuring|commenting|comments) (me|about (my|the) (eating|weight|food|portion))/i,
  /\bbuffet\b/i,
  // 2026-06-04 production failure: "holiday dinner coming up" missed the
  // existing patterns (no "going to" / "I have" prefix) and fell into
  // 'general' → safe fallback "Tell me more about that". Catch upcoming
  // event mentions with "coming up" / "tonight" / "tomorrow" / "this week".
  /\b(restaurant|wedding|party|dinner|brunch|barbecue|bbq|holiday|thanksgiving|christmas|easter|passover|iftar|bar mitzvah|baby shower|birthday|gathering|family dinner|reunion|event|date night|girls'? night|happy hour|potluck)\b.{0,15}\b(coming up|tonight|tomorrow|this (weekend|week|saturday|sunday|friday|monday|tuesday|wednesday|thursday)|next (week|weekend|month)|on (saturday|sunday|friday|monday|tuesday|wednesday|thursday))/i,
];


// Pause / break request. Distinct from scheduling frequency changes.
const PAUSE_REQUEST: RegExp[] = [
  /^(pause|stop|hold|hold on|hold off|take a break|break)$/i,
  /\b(pause|stop|hold off|take a break from|stop sending) (the )?(messages|texts|reminders|notifications|check.?ins|check ins)\b/i,
  /\bi (need|want) (a |to take a |to )?(break|pause|breather)\b/i,
  /\bgive me (a |some )?(space|break|time|quiet)\b/i,
  /\bdon'?t text me (for|until|this) (a |the )?(week|few days|month|while)\b/i,
  /\b(taking|on) (a )?break (from|with) (grace|you|texting|messages)\b/i,
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

export function classifyMessage(rawText: string): ClassifyResult {
  // Normalize iOS smart-quote apostrophes (U+2019) → ASCII before any pattern
  // matching, so "what's", "I'm", "can't" all hit the regexes. Without this,
  // mobile-typed messages fall through to 'general' and the wrong path runs.
  //
  // 2026-06-05 production failure: "wha t should i get for breakfast
  // tommrrow?" → "Tell me a bit more?" because the typo "wha t" (split
  // by a stray space) didn't match the FOOD_QUESTION regex's "what".
  // Add common-typo normalization for high-frequency words so a few
  // mobile typos don't break classification.
  const text = rawText
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    // Stray-space typos in common question words
    .replace(/\bwha\s+t\b/gi, 'what')
    .replace(/\bwha\s*t\s*s\b/gi, "what's")
    .replace(/\bwhy\s+y\b/gi, 'why')
    .replace(/\bho\s+w\b/gi, 'how')
    // Missing letters / extra letters in common words
    .replace(/\btomm[rl]+row\b/gi, 'tomorrow')
    .replace(/\btomorow\b/gi, 'tomorrow')
    .replace(/\btomrrow\b/gi, 'tomorrow')
    .replace(/\bbreakfst\b/gi, 'breakfast')
    .replace(/\bdinr\b/gi, 'dinner')
    .replace(/\blunc\b/gi, 'lunch')
    // Common "what" typos
    .replace(/\bwat\b/gi, 'what')
    .replace(/\bwaht\b/gi, 'what')
    .replace(/\bwhats\b/gi, "what's")
    // 2026-06-11 WhatsApp screenshots + user-listed typos. High-frequency
    // misspellings/contractions that broke intent detection. Matching-only —
    // the raw text the user typed is still what gets stored / sent to Gemini.
    .replace(/\bima\b/gi, "i'm")          // "ima nervous" → "i'm nervous"
    .replace(/\bim\b/gi, "i'm")           // bare "im" → "i'm"
    .replace(/\bfel+ing\b/gi, 'feeling')  // "felling" / "feling" → "feeling"
    .replace(/\bh[ue]rts?\b/gi, 'hurts')  // "herts" / "hurt" → "hurts"
    .replace(/\bhungr?y\b/gi, 'hungry')   // "hungy" / "hungry"
    .replace(/\bnervu?s\b/gi, 'nervous')  // "nervus" → "nervous"
    .replace(/\bprot[ie]+n\b/gi, 'protein') // "protin" / "protien" → "protein"
    .replace(/\btufu\b/gi, 'tofu')
    .replace(/\bchikt?en\b/gi, 'chicken')
    .replace(/\bavacado\b/gi, 'avocado');
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
  // Past-day food history and target/goal explanation — both subclass of
  // food_question so the downstream prompt rules + tool selection apply.
  // The AI service inspects the verbatim regex match to decide which tool
  // to force-call (get_protein_history vs get_food_summary vs get_user_profile).
  if (matches(text, FOOD_HISTORY_QUESTION)) return { type: 'food_question', confidence: 0.95 };
  // 2026-06-06 production failure: "What is the recommended proteins for a
  // man?" was classified as food_question → food_question_direct → curated
  // bank shipped FOOD IDEAS ("grilled chicken breast, baked cod, cottage
  // cheese..."). User asked about REQUIREMENTS (grams/kg), not foods.
  //
  // Protein-target questions are CLINICAL/KNOWLEDGE questions. Route to
  // knowledge intent so knowledge_direct OR pickKnowledgeTopicFallback
  // ships the actual target (1.2-1.6g/kg, 90-130g, breakfast front-load).
  if (matches(text, PROTEIN_TARGET_QUESTION)) return { type: 'knowledge', confidence: 0.92 };
  if (matches(text, FOOD_REMOVAL_QUESTION)) return { type: 'food_question', confidence: 0.92 };
  // Pause request — explicit + short. Must come BEFORE scheduling since
  // "stop sending messages" overlaps with scheduling-frequency phrasing.
  if (matches(text, PAUSE_REQUEST)) return { type: 'pause_request', confidence: 0.95 };
  // Injection log — must come BEFORE food_log because "took my shot" doesn't
  // overlap, but generic "did" patterns could match food_log otherwise.
  if (matches(text, INJECTION_LOG)) return { type: 'injection_log', confidence: 0.95 };
  // Exercise log — must come BEFORE food_log; "I ran 5k" contains "ran"
  // which isn't a food verb but kept ordered for clarity.
  if (matches(text, EXERCISE_LOG)) return { type: 'exercise_log', confidence: 0.9 };
  if (matches(text, WEIGHT_LOG)) return { type: 'weight_log', confidence: 0.9 };
  // Medication-specific question — placed BEFORE food_log/knowledge so dose
  // timing / storage / travel-with-pen questions land in the dedicated handler.
  if (matches(text, MEDICATION_QUESTION)) return { type: 'medication_question', confidence: 0.9 };

  // 2026-06-05 production failure: "How GLP-1 can affect my muscles" got
  // food_log because "1" in "GLP-1" was treated by quantity patterns, and
  // "Can I drink alcohol" got food_question because "can i drink" matched
  // FOOD_QUESTION's recommendation regex. Knowledge shortcut: signature
  // drug names + causation verbs, AND "can/should drink/eat/take X" where
  // X is non-food (alcohol, coffee, etc.) — both reach knowledge before
  // food_log / food_question.
  const KNOWLEDGE_SHORTCUT: RegExp[] = [
    // Drug name + "can/will affect/impact/cause/help/work"
    /\b(ozempic|wegovy|mounjaro|zepbound|semaglutide|tirzepatide|rybelsus|glp[.\s-]?1?)\b[^.?!]{0,40}\b(affect|impact|cause|change|help|hurt|work|do|make|lead)\b/i,
    // "How X can/will/might verb" — multi-token subject
    /\bhow\s+(?:[A-Za-z][\w-]*\s+){1,3}(?:can|will|might|would|could)\s+(?:affect|impact|cause|change|help|hurt)\b/i,
    // "Can/should/may I drink/eat/take ALCOHOL/COFFEE/CAFFEINE/MEDS/etc."
    /\b(can|could|should|may|will|might)\s+(?:i\s+)?(drink|eat|have|take|use|combine|mix)\s+(?:alcohol|wine|beer|coffee|caffeine|sugar|salt|sodium|water|tea|vitamins?|supplements?|carbs?|fiber|protein\s+(?:bars?|shakes?))/i,
  ];
  if (matches(text, KNOWLEDGE_SHORTCUT)) return { type: 'knowledge', confidence: 0.92 };


  // 2026-06-05 production failure (second batch): user said "I'm feeling
  // good. But my stomach hurts. I had 2 cups of coffee" → classifier picked
  // food_log because "had 2 cups of coffee" matched FOOD_LOG quantity +
  // drinks patterns → Grace responded with "Logged." and IGNORED the
  // stomach pain. A symptom signal must always take precedence over a
  // co-occurring food log: the side-effect dimension is medically more
  // important and the user wants acknowledgement of the pain.
  //
  // We route symptom-containing messages to 'knowledge' (the side-effect
  // handler) instead of food_log. The knowledge fallback has substantive
  // GLP-1 facts about common side effects.
  if (matches(text, SYMPTOM_SIGNAL)) return { type: 'knowledge', confidence: 0.9 };
  // 2026-06-05 production failure: classifier was routing questions like
  // "Why does protein matter so much on GLP-1s? Everyone says aim for 100g
  // but I can barely eat 50g a day" and "Got my first injection yesterday
  // and woke up with terrible heartburn at 3am. Is this a side effect?"
  // into food_log because food verbs ("drank", "got", "had") and quantity
  // patterns ("100g", "50g") match FOOD_LOG even though these are
  // questions. The forced log_food tool call then hallucinated macros for
  // non-food content, drove the 100% regen rate on food_log intent, and
  // produced safe-fallbacks. Logs are ALWAYS declarative — never questions.
  // If the message contains a '?', skip FOOD_LOG and let the classifier
  // continue down to FOOD_QUESTION / KNOWLEDGE / general.
  const isQuestion = text.includes('?');
  if (!isQuestion && matches(text, FOOD_LOG)) return { type: 'food_log', confidence: 0.85 };
  if (matches(text, FOOD_QUESTION)) return { type: 'food_question', confidence: 0.85 };
  // Social situation — placed AFTER food_log/food_question because eating-out
  // questions can match food patterns; the more specific event/social signals
  // here override into a dedicated tone.
  if (matches(text, SOCIAL_SITUATION)) return { type: 'social_situation', confidence: 0.88 };
  if (matches(text, EMOTIONAL)) return { type: 'emotional', confidence: 0.85 };
  if (matches(text, SCHEDULING)) return { type: 'scheduling', confidence: 0.9 };
  if (matches(text, KNOWLEDGE)) return { type: 'knowledge', confidence: 0.75 };
  return { type: 'general', confidence: 0.5 };
}
