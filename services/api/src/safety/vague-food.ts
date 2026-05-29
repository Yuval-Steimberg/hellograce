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
  'wrap', 'soup', 'stir fry', 'stir-fry', 'curry', 'sub',
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

function hasSpecificity(text: string): boolean {
  return NUMBER_UNIT_RE.test(text)
    || PORTION_OF_RE.test(text)
    || SPECIFIC_ITEM_RE.test(text)
    || QUALIFIED_CATEGORY_RE.test(text)
    || SIZED_PORTION_RE.test(text);
}

// ── Response templates ─────────────────────────────────────────────────────
// Short, warm, ASKS the user to specify. Mentions what brand/category they
// said so it feels heard, not robotic. Rotated by stable hash.
function buildClarification(matched: string): string {
  const m = matched.replace(/\b\w/g, (c) => c.toUpperCase()); // title-case the brand
  const templates = [
    `Sounds good! What exactly did you have from ${m}? Knowing the items (and rough portions) lets me log it accurately.`,
    `Nice — what'd you order at ${m}? Once I know the specific items I can log it properly.`,
    `Yum. Give me the rough details — what did you get from ${m}? Then I can log it right.`,
    `Got it. What did you eat exactly? ${m} portions vary a lot, so tell me the items and I'll log it accurately.`,
  ];
  // Stable hash of the matched brand so the same brand → same template.
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
 */
export function detectVagueFood(text: string): VagueFoodCheck {
  const lower = text.toLowerCase().trim();
  if (lower.length === 0) return { vague: false };

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

  if (!matched) return { vague: false };

  // If the message has any specificity, it's NOT vague — let log_food run.
  if (hasSpecificity(text)) return { vague: false };

  return {
    vague: true,
    matched,
    response: buildClarification(matched),
  };
}
