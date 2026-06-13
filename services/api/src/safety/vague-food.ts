// Vague-food detector — catches brand/restaurant mentions and generic food
// categories without portion specifics, so Grace asks for clarification
// instead of hallucinating a protein estimate.
//
// Production bug (2026-05-29):
//   User: "I ate kfc this morning it was delicious"
//   Grace: "KFC logged. That's roughly 35g protein. You're still at 0g for the day."
// Both lines were wrong:
//   - "KFC logged" → no tool actually ran; Grace fabricated the action
//   - "35g protein" → fabricated; KFC could be 1 wing (10g) or a 16-pc bucket (200g)
//   - "still at 0g" → correct (nothing was logged) but contradicts the prior line
//
// Correct behavior: detect the brand/category WITHOUT specifics, return a
// short canned clarification, do NOT call log_food, do NOT involve the LLM.
// The continuation logic in ai.service.ts handles the user's follow-up reply
// ("3 tenders", "a chicken sandwich") and triggers log_food then.
//
// Style:
//   - Deterministic regex, ~1ms latency
//   - Specificity-aware (numbers + units + specific items override)
//   - Varied response templates (stable hash so same input → same template)

export interface VagueFoodCheck {
  vague: boolean;
  matched?: string;
  response?: string;
}

// ── Brand / restaurant names ────────────────────────────────────────────────
// Common US chains where the brand alone tells us nothing about portion or
// macros. A 3-piece tender at KFC is ~30g; a 16-piece bucket is ~200g.
const BRAND_NAMES = [
  // Fast food
  'kfc', "mcdonald's", 'mcdonalds', 'burger king', "wendy's", 'wendys',
  'taco bell', 'subway', 'chipotle', 'panera', 'five guys', 'in-n-out',
  'in n out', 'shake shack', 'popeyes', 'chick-fil-a', 'chick fil a',
  'chickfila', "domino's", 'dominos', 'pizza hut', "papa john's", 'papa johns',
  'dunkin', 'starbucks', "arby's", 'arbys', 'panda express', 'qdoba', 'sonic',
  'whataburger', "culver's", 'culvers', "jersey mike's", 'firehouse subs',
  "jimmy john's", 'sweetgreen', 'cava', 'noodles and company',
  // Sit-down chains
  'olive garden', 'cheesecake factory', 'red lobster', "applebee's", 'applebees',
  'tgi fridays', 'tgi friday', "chili's", 'chilis', 'outback', 'ihop',
  "denny's", 'dennys', 'cracker barrel', 'buffalo wild wings',
];

// ── Generic food categories ────────────────────────────────────────────────
// Words that describe a meal CATEGORY without telling us what's actually in
// it. "Pizza" alone could be 1 slice or 1 whole pie.
const VAGUE_CATEGORIES = [
  // Generic foods
  'pizza', 'burger', 'sandwich', 'pasta', 'burrito', 'taco', 'sushi',
  'wrap', 'soup', 'stir fry', 'stir-fry', 'curry', 'sub', 'salad',
  // Cuisine names
  'chinese food', 'thai food', 'mexican food', 'indian food',
  'italian food', 'japanese food', 'korean food', 'vietnamese food',
  // Meal labels with no content
  'fast food', 'takeout', 'take out', 'takeaway', 'delivery', 'leftovers',
];

// ── Specificity indicators ─────────────────────────────────────────────────
// If ANY match, the message has enough detail to estimate macros. Each
// pattern is anchored so it doesn't false-match on incidental words.

// Numbers / quantifiers followed by a food-unit noun (e.g. "3 tenders",
// "a slice", "two cups", "8oz", "200g"). "a/an/one" counts as quantity 1.
// Digits allow zero-width gap ("12oz"); word quantifiers require whitespace
// ("a slice", not "aslice").
const UNIT_WORDS =
  'piece|pieces|slice|slices|wing|wings|nugget|nuggets|tender|tenders|cup|cups|oz|ounce|ounces|gram|grams|g|lb|lbs|pound|pounds|serving|servings|bowl|bowls|sandwich|sandwiches|burger|burgers|taco|tacos|burrito|burritos|wrap|wraps|tablespoon|tablespoons|tbsp|teaspoon|tsp|portion|portions|bite|bites|spoonful|spoonfuls|handful|handfuls|cookie|cookies|donut|donuts|item|items|roll|rolls|stick|sticks|bar|bars|can|cans|bottle|bottles|patty|patties|sub|subs';
const NUMBER_UNIT_RE = new RegExp(
  `\\b(?:\\d+(?:\\.\\d+)?\\s*|(?:a|an|one|two|three|four|five|six|seven|eight|nine|ten|dozen|couple)\\s+)(?:${UNIT_WORDS})\\b`,
  'i',
);

// "slice of X", "piece of X", "cup of X", "bowl of X" — portion phrasing
// without a leading number still implies quantity 1.
const PORTION_OF_RE =
  /\b(slice|piece|cup|bowl|serving|portion|handful|spoonful|chunk|cube|loaf)\s+of\b/i;

// Specific menu/food item names — naming an actual dish tells us roughly what
// macros to expect. Word-boundaried to avoid sub-matches.
const SPECIFIC_ITEM_RE = new RegExp(
  '\\b(' + [
    // Proteins (when named explicitly with the brand)
    'chicken\\s+(?:sandwich|burger|tenders?|nuggets?|wings?|wrap|bowl|salad|breast|thigh|drumstick)',
    'cheeseburger', 'hamburger', 'whopper', 'big\\s+mac', 'baconator', 'mcchicken',
    'mcdouble', 'quarter\\s+pounder', 'mcnuggets?', 'footlong', '6[\\s-]inch',
    'crunchwrap', 'gordita', 'chalupa', 'quesarito', 'baja\\s+blast',
    'burrito\\s+bowl', 'salad\\s+bowl', 'taco\\s+salad',
    'frappuccino', 'latte', 'cappuccino', 'macchiato',
    // Sub items
    'tenders?', 'nuggets?', 'wings?', 'fries', 'biscuit', 'parfait',
    // Specific protein cuts
    'breast', 'thigh', 'drumstick', 'wing', 'shrimp', 'salmon\\s+fillet',
  ].join('|') + ')\\b',
  'i',
);

// Protein-qualifier + vague-category: "chicken burrito", "veggie pizza",
// "beef tacos". Naming the protein/filling makes the category specific enough.
const QUALIFIED_CATEGORY_RE =
  /\b(chicken|beef|pork|fish|salmon|tuna|tofu|veggie|veg|vegetarian|vegan|bean|black\s+bean|steak|carnitas|barbacoa|al\s+pastor|carne\s+asada|shrimp|cheese|pepperoni|sausage|mushroom|spinach|margherita|hawaiian|bbq|buffalo|turkey|ham|bacon|egg|breakfast|club|tuna|caesar|cobb|greek|caprese)\s+(?:pizza|burger|sandwich|sub|wrap|salad|burrito|taco|bowl|pasta|stir[\s-]fry|curry|soup)\b/i;

// Size words placed near the food (small/medium/large pizza, half a sandwich).
// More restrictive than catching "big" anywhere — must reach a food word within
// up to 3 intervening tokens (allows for brand names: "small Wendy's burger").
const SIZED_PORTION_RE =
  /\b(small|medium|large|big|tiny|huge|half|quarter|whole|full|footlong|six[\s-]inch|6[\s-]inch|12[\s-]inch|personal|individual|family[\s-]size|kid'?s?|kids|junior|regular)\b(?:\s+\S+){0,3}\s+(?:pizza|burger|sandwich|sub|wrap|salad|burrito|taco|bowl|fries|drink|coffee|soda|shake|coke|sprite|frappuccino|latte|meal|combo|order|pie|portion)\b/i;

// ── Uber-vague quantity overrides (QA report 2026-06-03, Step 3) ─────────
// Some "sized" portions are SO variable they should never count as specific.
// "A whole pizza" could be a 6-inch personal (40g protein) or a 16-inch
// family (160g) — four-fold uncertainty. Same for whole cakes, full loaves,
// entire boxes, and informal "tons of X" / "way too much" / "a ton of"
// phrasing. The QA report specifically called out the "whole pizza → 88g"
// hallucination; this regex forces those into the clarification path.
const UBER_VAGUE_QUANTITY_RE =
  /\b(?:a\s+(?:whole|full|entire|ton\s+of|tonne\s+of|loaf\s+of|loaves\s+of|bag\s+of|box\s+of|carton\s+of|tray\s+of|pan\s+of|sheet\s+of|jar\s+of)\b|(?:tons|loads|lots|heaps|piles|tonnes)\s+of\b|way\s+too\s+(?:much|many)\b|so\s+much\s+(?:pizza|pasta|bread|cake|cookies?|chips?|ice\s+cream|food)\b|(?:huge|massive|giant|enormous)\s+(?:pizza|burger|sandwich|burrito|bowl|portion|amount|plate)\b)/i;

// Common binge foods that wouldn't otherwise match VAGUE_CATEGORIES — when
// combined with the uber-vague phrasing above, route to clarification.
const COMMON_BINGE_FOODS_RE =
  /\b(pizza|burger|sandwich|pasta|burrito|taco|sub|wrap|cake|cookies?|brownies?|donuts?|muffins?|cupcakes?|pastr(?:y|ies)|croissants?|bagels?|pie|ice\s+cream|chips|crisps|crackers?|popcorn|cereal|bread|pancakes?|waffles?|fries|chocolate|candy|sweets|nuggets?|tenders?|wings?|ribs)\b/i;

function hasUberVagueQuantity(text: string): boolean {
  return UBER_VAGUE_QUANTITY_RE.test(text);
}

function matchUberVagueBinge(text: string): string | null {
  if (!UBER_VAGUE_QUANTITY_RE.test(text)) return null;
  const m = text.match(COMMON_BINGE_FOODS_RE);
  return m ? m[0].toLowerCase() : null;
}

function hasSpecificity(text: string): boolean {
  // Uber-vague phrasing trumps any apparent specificity. "A whole pizza"
  // matches SIZED_PORTION_RE ("whole" + "pizza") but is functionally unknown.
  if (hasUberVagueQuantity(text)) return false;
  return NUMBER_UNIT_RE.test(text)
    || PORTION_OF_RE.test(text)
    || SPECIFIC_ITEM_RE.test(text)
    || QUALIFIED_CATEGORY_RE.test(text)
    || SIZED_PORTION_RE.test(text);
}

// ── Response templates ─────────────────────────────────────────────────────
// Per the 2026-05-29 feedback spec:
//   - Never present a guess as fact (no "logged" or "X grams" before we know)
//   - Acknowledge what they said so it feels heard
//   - Explain WHY we need more info (different items = different protein)
//   - Ask one focused follow-up question
//
// Two template sets:
//   1. First time we see a vague mention → warm acknowledge + ask
//   2. User REPLIED to a prior ask but their reply was still vague → softer
//      ack ("got it") + more focused ask ("but which item specifically?")
function buildClarification(matched: string, followUp: boolean): string {
  const m = matched.replace(/\b\w/g, (c) => c.toUpperCase()); // title-case the brand
  const initialTemplates = [
    `Sounds like you enjoyed it 😊. What did you have at ${m}? Once I know roughly what you ordered, I can estimate the protein and calories accurately.`,
    `Nice. To estimate the protein I'd need to know what you actually had at ${m} — was it tenders, a sandwich, a wrap? Share the specifics and I'll log it.`,
    `Got it — noting that you had ${m} this morning. ${m} portions vary a lot, so tell me which items and I can give you an accurate protein estimate.`,
    `Yum. What did you order at ${m}? The more specific (e.g. "3 tenders" or "a chicken sandwich"), the more accurate the protein estimate I can give you.`,
  ];
  const followUpTemplates = [
    `Got it. Which specific item, though? ${m} has a few options — knowing the exact one lets me give you an accurate number instead of a guess.`,
    `Noted. To estimate the protein accurately I still need to know which item — a sandwich, tenders, a wrap? Different items have very different protein.`,
    `Thanks. Just to nail the protein down: which item exactly from ${m}? Each has a different protein range so I don't want to give you a wrong number.`,
  ];
  const templates = followUp ? followUpTemplates : initialTemplates;
  // Stable hash so same input → same template (avoids feeling random).
  let h = 0;
  for (let i = 0; i < matched.length; i++) h = (h * 31 + matched.charCodeAt(i)) | 0;
  return templates[Math.abs(h) % templates.length]!;
}

/**
 * Check if the message is a vague food mention that should trigger a
 * clarification ASK instead of a hallucinated log_food estimate.
 *
 * Returns vague=true only when a brand or generic category is present AND
 * the message lacks specificity indicators. False positives are avoided by
 * the specificity check — once the user names an item or quantity, we log
 * normally.
 *
 * `lastGraceMessage` (optional) is used to detect when Grace already asked
 * for clarification — if so, we use a softer "but which item specifically"
 * follow-up template instead of repeating the initial ask verbatim.
 */
// ── Consideration / suggestion framing (2026-06-11) ──────────────────────────
// Production bug from WhatsApp screenshots: "How about pizza for dinner?" →
// "Sounds like you enjoyed it 😊. What did you have at Pizza?" — Grace treated a
// FUTURE-tense suggestion as a PAST-tense eaten meal needing clarification.
// These framings mean the user is asking about / proposing a food, not
// reporting having eaten it. When present, this is NOT a vague food log — let
// it flow to the food-question / recommendation path instead.
const CONSIDERATION_RE =
  /\b(how about|what about|thinking (?:about|of)|considering|maybe i(?:'?ll| should| could| might)?|should i (?:have|eat|get|order|try|do)|can i (?:have|eat|get|order|try)|could i (?:have|eat|get)|is (?:it ok|.{0,20} (?:ok|okay|fine|good|healthy|allowed|alright))|what if i|planning (?:to|on)|going to (?:have|eat|get|order|try)|want(?:ing)? to (?:have|eat|get|order|try)|do you think i should|would (?:it be|.{0,15}) ok)\b/i;

export function detectVagueFood(text: string, lastGraceMessage?: string): VagueFoodCheck {
  const lower = text.toLowerCase().trim();
  if (lower.length === 0) return { vague: false };

  // A consideration ("how about pizza?", "should I have a burger?") is not a
  // log — never ship the "what did you have" clarification for it.
  if (CONSIDERATION_RE.test(lower)) return { vague: false };

  // Find a matching brand (case-insensitive, word-boundaried).
  let matched: string | null = null;
  for (const brand of BRAND_NAMES) {
    const escaped = brand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`\\b${escaped}\\b`, 'i').test(text)) {
      matched = brand;
      break;
    }
  }

  // If no brand, try generic categories.
  if (!matched) {
    for (const cat of VAGUE_CATEGORIES) {
      if (new RegExp(`\\b${cat}\\b`, 'i').test(lower)) {
        matched = cat;
        break;
      }
    }
  }

  // QA report 2026-06-03 Step 3: uber-vague phrasing on a binge-food noun
  // ("ate a whole cake", "tons of cookies", "way too much ice cream") still
  // counts as vague even when the food isn't in VAGUE_CATEGORIES. These
  // ALWAYS need a clarifying ask — the macro estimate is too uncertain
  // to volunteer without context.
  if (!matched) {
    const uberMatch = matchUberVagueBinge(text);
    if (uberMatch) matched = uberMatch;
  }

  if (!matched) return { vague: false };

  // If the message has any specificity, it's NOT vague — let log_food run.
  if (hasSpecificity(text)) return { vague: false };

  // If Grace's previous message was our own clarification ask, use the
  // follow-up template variant so the user doesn't see the same question twice.
  const followUp = !!lastGraceMessage && PRIOR_ASK_RE.test(lastGraceMessage);

  return {
    vague: true,
    matched,
    response: buildClarification(matched, followUp),
  };
}

// Detects whether the previous Grace message was OUR vague-food clarification.
// Matches all four initial templates AND all three follow-up templates.
const PRIOR_ASK_RE =
  /\b(what did you (have|order|get|eat)|what(?:'s)? did you (?:actually )?have|which (?:specific )?item|which item|estimate the protein accurately|share the specifics|the more specific)\b/i;
