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

import { FOOD_TOKEN_SET } from '../tools/log-food.js';

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
  // 2026-06-13 expansion — categories whose macros swing widely by contents:
  'casserole', 'bowl', 'noodles', 'ramen', 'omelette', 'omelet',
  'smoothie', 'milkshake', 'stew',
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
  /\b(chicken|beef|pork|fish|salmon|tuna|tofu|veggie|veggies|veg|vegetarian|vegan|greens?|garden|green|side|house|mixed|leafy|lettuce|kale|arugula|romaine|antipasto|fruit|bean|black\s+bean|steak|carnitas|barbacoa|al\s+pastor|carne\s+asada|shrimp|cheese|pepperoni|sausage|mushroom|spinach|margherita|hawaiian|bbq|buffalo|turkey|ham|bacon|egg|breakfast|club|caesar|cobb|greek|caprese|ham\s+and\s+cheese|western|denver)\s+(?:pizza|burger|sandwich|sub|wrap|salad|burrito|taco|bowl|pasta|stir[\s-]fry|curry|soup|omelette|omelet|noodles|casserole|stew)\b/i;

// Size words placed near the food (small/medium/large pizza, half a sandwich).
// More restrictive than catching "big" anywhere — must reach a food word within
// up to 3 intervening tokens (allows for brand names: "small Wendy's burger").
const SIZED_PORTION_RE =
  /\b(small|medium|large|big|tiny|huge|half|quarter|whole|full|footlong|six[\s-]inch|6[\s-]inch|12[\s-]inch|personal|individual|family[\s-]size|kid'?s?|kids|junior|regular)\b(?:\s+\S+){0,3}\s+(?:pizza|burger|sandwich|sub|wrap|salad|burrito|taco|bowl|fries|drink|coffee|soda|shake|coke|sprite|frappuccino|latte|meal|combo|order|pie|portion|omelette|omelet|smoothie|milkshake|casserole|noodles|stew)\b/i;

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
// Per-category hint with a concrete example, so the clarification is specific
// and actionable instead of the generic brand-style "what did you have at X".
const CATEGORY_HINTS: Record<string, string> = {
  pizza: 'how many slices and what kind (e.g. 2 slices of cheese)',
  burger: 'what kind and how many (e.g. a single cheeseburger)',
  sandwich: 'what was in it and the size (e.g. a turkey sub)',
  sub: 'what was in it and the size (e.g. a 6-inch turkey)',
  wrap: 'what was in it (e.g. a chicken caesar wrap)',
  salad: 'what was in it and any dressing (e.g. a chicken caesar)',
  pasta: 'what kind and roughly how much (e.g. a cup of spaghetti with meat sauce)',
  burrito: "what's in it (e.g. a chicken burrito)",
  taco: 'what kind and how many (e.g. 2 beef tacos)',
  sushi: 'how many pieces or rolls (e.g. 6 pieces of salmon)',
  soup: 'what kind and how much (e.g. a bowl of chicken noodle)',
  curry: 'what kind and how much (e.g. a cup of chicken curry)',
  noodles: 'what kind and roughly how much (e.g. a cup of lo mein)',
  ramen: 'what was in it (e.g. a bowl of pork ramen)',
  casserole: "what's in it (e.g. a cup of chicken-and-rice casserole)",
  omelette: 'what was in it and how many eggs (e.g. a 3-egg cheese omelette)',
  omelet: 'what was in it and how many eggs (e.g. a 3-egg cheese omelet)',
  smoothie: "what's in it (e.g. a banana and protein-powder smoothie)",
  milkshake: 'what size and flavor (e.g. a medium chocolate)',
  stew: "what's in it (e.g. a bowl of beef stew)",
  bowl: "what's in it (e.g. a chicken-and-rice bowl)",
};

function buildClarification(matched: string, matchType: 'brand' | 'category', followUp: boolean): string {
  // ── Brand path (KFC, McDonald's…) — "what did you have AT <Brand>" reads
  //    naturally because it's a place. ────────────────────────────────────
  if (matchType === 'brand') {
    const m = matched.replace(/\b\w/g, (c) => c.toUpperCase());
    const initialTemplates = [
      `Sounds like you enjoyed it 😊. What did you have at ${m}? Once I know roughly what you ordered, I can estimate the protein and calories accurately.`,
      `Nice. To estimate the protein I'd need to know what you actually had at ${m} — was it tenders, a sandwich, a wrap? Share the specifics and I'll log it.`,
      `Yum. What did you order at ${m}? The more specific (e.g. "3 tenders" or "a chicken sandwich"), the more accurate the protein estimate I can give you.`,
    ];
    const followUpTemplates = [
      `Got it. Which specific item, though? ${m} has a few options — knowing the exact one lets me give you an accurate number instead of a guess.`,
      `Noted. To estimate the protein accurately I still need to know which item — a sandwich, tenders, a wrap? Different items have very different protein.`,
    ];
    const templates = followUp ? followUpTemplates : initialTemplates;
    let h = 0;
    for (let i = 0; i < matched.length; i++) h = (h * 31 + matched.charCodeAt(i)) | 0;
    return templates[Math.abs(h) % templates.length]!;
  }

  // ── Category path (pizza, salad, omelette…) — never say "at Pizza". Ask
  //    what kind + give a concrete example so the user knows exactly what to
  //    reply with. ──────────────────────────────────────────────────────────
  const cat = matched.toLowerCase();
  const hint = CATEGORY_HINTS[cat] ?? 'what was in it and roughly how much';
  const initialTemplates = [
    `Nice 😊 For the ${cat}, ${hint}? Then I can estimate the protein and calories accurately.`,
    `Sounds good. To log that ${cat} accurately I just need a bit more: ${hint}? The protein and calories vary a lot with what's in it.`,
  ];
  const followUpTemplates = [
    `Got it. Just need a bit more on the ${cat}: ${hint}? Then I can give you an accurate protein and calorie number instead of a guess.`,
  ];
  const templates = followUp ? followUpTemplates : initialTemplates;
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

// ── Prep-method clarification (2026-06-13) ───────────────────────────────────
// Some bare proteins/sides are commonly served fried OR grilled/baked, and the
// prep swings calories ~2x (grilled chicken breast ~180 kcal vs fried ~400).
// When the user names ONLY such a food with no prep/sauce detail and no
// quantity, ask how it was prepared instead of assuming. Naming a quantity,
// prep word, or sauce skips the ask — we then have enough to estimate.
const PREP_AMBIGUOUS_FOODS = [
  'chicken', 'fish', 'salmon', 'shrimp', 'prawns', 'tofu', 'pork', 'wings',
  'wing', 'eggplant', 'potato', 'potatoes', 'cauliflower', 'tilapia', 'cod',
];
const PREP_FOOD_RE = new RegExp(`^(?:${PREP_AMBIGUOUS_FOODS.join('|')})$`, 'i');

// Prep already specified → no need to ask.
const PREP_GIVEN_RE =
  /\b(grill\w*|bak\w*|fry|fried|frying|deep[-\s]?fried|pan[-\s]?fried|air[-\s]?fried|boil\w*|steam\w*|roast\w*|poach\w*|saut[eé]\w*|sear\w*|smok\w*|brais\w*|raw|breaded|battered|crispy|mashed|stir[-\s]?fr\w*|sashimi)\b/i;
const SAUCE_GIVEN_RE =
  /\b(sauce|gravy|glaze|marinad\w*|teriyaki|bbq|barbecue|buffalo|alfredo|curry|butter|oil|creamy|cheesy|honey|sweet[-\s]and[-\s]sour|tikka|masala|parm\w*|piccata|scampi|katsu)\b/i;

// Conversational scaffolding stripped so we can see whether the remaining
// content is a single bare prep-food.
const PREP_SCAFFOLD_RE =
  /\b(hey|hi|hello|so|well|ok|okay|yeah|today|this\s+morning|this\s+afternoon|tonight|earlier|just\s+now|for\s+(?:breakfast|lunch|dinner|supper|brunch|a\s+snack)|breakfast|lunch|dinner|supper|brunch|snack|i|just|also|then|only|had|ate|eat|eating|grabbed|made|cooked|got|having|enjoyed|some|a|an|the|my|one|of|plain|piece|pieces|bit|little)\b/gi;

function detectPrepNeeded(text: string): { food: string; response: string } | null {
  // A quantity present → they gave a portion; don't pile a prep ask on top
  // (keeps friction low and preserves existing quantity-based logs).
  if (/\d/.test(text)) return null;
  if (PREP_GIVEN_RE.test(text) || SAUCE_GIVEN_RE.test(text)) return null;

  const core = text
    .toLowerCase()
    .replace(PREP_SCAFFOLD_RE, ' ')
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // Single bare prep-food only — naming a cut ("chicken breast"), a dish, or
  // listing multiple foods ("chicken rice") leaves >1 token here and is skipped.
  if (!PREP_FOOD_RE.test(core)) return null;

  const templates = [
    `How was the ${core} prepared, grilled, baked, or fried? And any sauce or oil? That swings the calories a lot, so I'd rather log it accurately than guess.`,
    `Quick one so I log the ${core} accurately: grilled, baked, or fried, and any sauce or oil on it? Those change the calories quite a bit.`,
  ];
  let h = 0;
  for (let i = 0; i < core.length; i++) h = (h * 31 + core.charCodeAt(i)) | 0;
  return { food: core, response: templates[Math.abs(h) % templates.length]! };
}

// ── Low-confidence "I ate, but named nothing" references (2026-06-14) ────────
// Production failure: "Had two eggs for breakfast. Now having a small snack" →
// Grace logged the eggs (12g) and silently dropped the snack. "a small snack",
// "some food", "a bite", "a treat", or a bare meal label ("had lunch") carry
// ZERO macro info — logging them fabricates nutrition, ignoring them loses it.
//
// LOWCONF_NOUNS includes meal labels so a BARE "had lunch" asks for content,
// but they're also stripped from the core check below so "eggs for breakfast"
// (a real food + a meal label) does NOT trip the pure-low-confidence path.
const LOWCONF_NOUNS = [
  'snack', 'snacks', 'something', 'food', 'bite', 'bites', 'treat', 'treats',
  'nibble', 'nibbles', 'breakfast', 'lunch', 'dinner', 'supper', 'brunch', 'meal',
];
const MEAL_LABELS = new Set(['breakfast', 'lunch', 'dinner', 'supper', 'brunch', 'meal']);

// Scaffolding around a low-confidence reference — deliberately does NOT include
// any real food word, so a named food survives and disqualifies the pure match.
const LOWCONF_SCAFFOLD_RE =
  /\b(hey|hi|hello|so|well|ok|okay|yeah|now|just|currently|today|tonight|earlier|right|this|morning|afternoon|evening|for|i|im|i'?m|am|also|then|only|had|have|having|ate|eat|eating|grabbed|made|cooked|got|getting|gonna|going|to|enjoyed|some|a|an|the|my|one|of|small|quick|little|light|tiny|big|bit|nice|good|tasty)\b/gi;

function buildLowConfClarification(item: string): string {
  if (MEAL_LABELS.has(item)) {
    return `Got it. What did you have for ${item}? Even a rough list (e.g. eggs and toast) lets me log the protein and calories accurately.`;
  }
  if (item === 'food' || item === 'something') {
    return `Got it. What did you have? Even a rough idea (an apple, a granola bar, some nuts) lets me log the protein and calories accurately.`;
  }
  const noun = item.replace(/s$/, '');
  return `Got it. What was the ${noun}? Even a rough idea (an apple, a granola bar, some nuts) lets me log the protein and calories accurately.`;
}

// PURE case: the message is ESSENTIALLY ONLY a low-confidence reference (no
// identifiable food). Returns the clarification; null when a real food is also
// present (the compound case is handled by the add-on detector below).
function detectLowConfidenceMeal(text: string): { item: string; response: string } | null {
  const lower = text.toLowerCase();
  const nounRe = new RegExp(`\\b(${LOWCONF_NOUNS.join('|')})\\b`);
  const nm = lower.match(nounRe);
  if (!nm) return null;
  // A number means a quantity was given ("2 cookies", "3pm") — don't treat as
  // pure-vague; let it log / flow normally.
  if (/\d/.test(text)) return null;
  const core = lower
    .replace(LOWCONF_SCAFFOLD_RE, ' ')
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const withoutNoun = core
    .replace(new RegExp(`\\b(${LOWCONF_NOUNS.join('|')})\\b`, 'g'), '')
    .replace(/\s+/g, ' ')
    .trim();
  if (withoutNoun.length > 0) return null; // a real food word survived
  return { item: nm[1]!, response: buildLowConfClarification(nm[1]!) };
}

// ADD-ON case: a clear food was (or will be) logged AND the message also names
// a vague snack/bite/treat that carries no macro info. Returns the noun so the
// caller can append "What was the snack, so I can log it too?". Meal labels are
// NOT add-ons (they're context, not a separate item).
const VAGUE_ADDON_RE =
  /\b(?:a|an|the|some|small|quick|little|light|big|another)\s+(snack|bite|treat|nibble)\b|\bsome\s+(food)\b|\ba\s+little\s+(something)\b/i;
export function findVagueAddOnItem(text: string): string | null {
  const m = VAGUE_ADDON_RE.exec(text);
  if (!m) return null;
  const raw = (m[1] ?? m[2] ?? m[3] ?? 'snack').toLowerCase();
  // If the vague noun is qualified by a REAL food ("snack of almonds"), it's
  // specific enough — skip the ask. But "bite of something" / "snack of food"
  // is still vague, so only skip when the "of X" word isn't itself vague.
  const tail = text.slice(m.index + m[0].length, m.index + m[0].length + 30).toLowerCase();
  const ofMatch = /^\s+of\s+(\w+)/.exec(tail);
  if (ofMatch && !LOWCONF_NOUNS.includes(ofMatch[1]!)) return null;
  // Normalize to a friendly noun for the "What was the ___?" question.
  if (raw === 'food' || raw === 'something' || raw === 'nibble') return 'snack';
  return raw;
}

// A concrete amount / portion indicator. "a/an/one" count as a single unit
// (so "a banana" is specific); "some/few/several" do NOT (still vague).
const QUANTITY_PRESENT_RE =
  /\d|\b(a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|dozen|half|quarter)\b|\b(cup|cups|slice|slices|piece|pieces|serving|servings|oz|ounce|ounces|g|gram|grams|lb|lbs|pound|pounds|tbsp|tablespoon|tablespoons|tsp|teaspoon|teaspoons|handful|handfuls|bowl|bowls|plate|plates|glass|glasses|bottle|bottles|can|cans|scoop|scoops|bar|bars|stick|sticks|packet|packets|portion|portions|spoonful|spoonfuls|pinch|loaf|loaves|cube|cubes|chunk|chunks)\b|\b(small|medium|large|big|huge|tiny|little)\b/i;

/** True when the food text carries an explicit amount/portion/unit (number,
 *  unit word, single-unit article, or size). When FALSE, a logged item is a
 *  standard-serving ESTIMATE and the confirmation should say so. */
export function hasExplicitQuantity(text: string): boolean {
  return QUANTITY_PRESENT_RE.test(text);
}

// High-variance proteins: the portion + cooking method dominate the macro
// estimate, so a bare multi-food meal containing one of these gets a
// clarification (2026-06-15: "rice and chicken" → ask about the chicken).
// Expanded 2026-06-15 per the confidence-logging spec.
const HIGH_VARIANCE_PROTEINS = new Set([
  'chicken', 'beef', 'steak', 'pork', 'fish', 'salmon', 'tuna', 'shrimp',
  'prawns', 'turkey', 'lamb', 'tofu', 'tilapia', 'cod', 'halibut', 'scallops',
  'tempeh', 'seitan', 'meatballs', 'sausage', 'gyro', 'shawarma', 'egg', 'eggs',
]);

// Restaurant / takeout / "ate out" — portions are unknown and large, so ask
// what was ordered + rough amount instead of assuming a standard serving.
const ATE_OUT_RE =
  /\b(ate out|eating out|dined out|out to eat|at a restaurant|from a restaurant|restaurant meal|restaurant food|grabbed (?:takeout|take-?out|fast food)|ordered (?:out|in|takeout|take-?out|delivery))\b/i;
function detectAteOut(text: string): { matched: string; response: string } | null {
  if (!ATE_OUT_RE.test(text)) return null;
  return {
    matched: 'restaurant',
    response: `Got it. What did you order, and roughly how much? Restaurant and takeout portions vary a lot, so I'd rather log it right than guess.`,
  };
}

// Protein shakes/powders: the SCOOP count (or brand/size) drives the protein,
// and "a protein shake" gives none of that — ask even though "a" is present.
const PROTEIN_PRODUCT_RE = /\b(protein\s+shake|protein\s+drink|protein\s+powder|whey|mass\s+gainer)\b/i;
const SCOOP_OR_BRAND_RE = /\b(\d+\s*scoops?|one scoop|two scoops|\d+\s*g\b|\d+\s*grams?\b|optimum|gold standard|fairlife|premier| orgain|huel|isopure|ghost|quest|myprotein)\b/i;
function detectProteinProduct(text: string): { matched: string; response: string } | null {
  if (!PROTEIN_PRODUCT_RE.test(text)) return null;
  if (SCOOP_OR_BRAND_RE.test(text)) return null; // scoops/brand given → loggable
  return {
    matched: 'protein shake',
    response: `Got it. How many scoops was the protein shake, or what brand and size? The scoop count swings the protein a lot.`,
  };
}

// Does a SPECIFIC high-variance protein in the text carry its own portion/prep/
// cut/count? Used by the multi-item gate so a quantity on a DIFFERENT item
// ("2 eggs") doesn't mask a vague protein ("one chicken"). A bare count for a
// non-countable protein ("one chicken" — one breast? a whole bird?) is NOT a
// specifier; only foods naturally counted in units (wings/shrimp/etc.) are.
const NATURALLY_COUNTED = /^(wings?|shrimp|prawns?|scallops?|meatballs?)$/i;
function proteinHasSpecifier(lower: string, protein: string): boolean {
  if (protein === 'egg' || protein === 'eggs') {
    return /\b(\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten|dozen|couple)\s+eggs?\b/i.test(lower);
  }
  // Named cut → specific ("chicken breast", "salmon fillet", "pork chop").
  if (new RegExp(`\\b${protein}\\s+(breasts?|thighs?|drumsticks?|wings?|fillets?|filets?|cutlets?|tenders?|nuggets?|legs?|loins?|chops?|steaks?)\\b`, 'i').test(lower)) return true;
  // Weight unit near the protein ("6 oz chicken", "chicken, 200g").
  const wt = '(?:\\d+(?:\\.\\d+)?)\\s*(?:oz|ounces?|g|grams?|lb|lbs|pounds?)';
  if (new RegExp(`${wt}(?:\\s+\\w+){0,2}\\s+${protein}\\b`, 'i').test(lower)) return true;
  if (new RegExp(`\\b${protein}(?:\\s+\\w+){0,2}\\s+${wt}`, 'i').test(lower)) return true;
  // Prep word adjacent to the protein ("grilled chicken", "chicken, fried").
  const prep = 'grilled|baked|fried|deep[\\s-]?fried|pan[\\s-]?fried|air[\\s-]?fried|roasted|boiled|steamed|poached|seared|smoked|braised|breaded|battered|crispy|saut[eé]ed|stir[\\s-]?fried|raw|sashimi|mashed|shredded|pulled';
  if (new RegExp(`\\b(?:${prep})\\s+(?:\\w+\\s+){0,1}${protein}\\b`, 'i').test(lower)) return true;
  if (new RegExp(`\\b${protein}\\b\\s*,?\\s+(?:${prep})\\b`, 'i').test(lower)) return true;
  // A count is only a real specifier for naturally-counted proteins.
  if (NATURALLY_COUNTED.test(protein) &&
      new RegExp(`\\b(\\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten|dozen)\\s+${protein}\\b`, 'i').test(lower)) {
    return true;
  }
  return false;
}

// "No assumptions" gate (2026-06-14): a SINGLE bare food logged with NO amount
// or portion can't be tracked accurately, so ask instead of guessing a serving.
// Scoped to a single food — multi-food lists go through the multi-item logger,
// and brands/categories/prep/low-confidence are already caught upstream.
function detectMissingQuantity(text: string): { matched: string; response: string } | null {
  const lower = text.toLowerCase();
  const foods: string[] = [];
  for (const tok of FOOD_TOKEN_SET) {
    if (new RegExp(`\\b${tok}\\b`, 'i').test(lower)) foods.push(tok);
  }
  // FOOD_TOKEN_SET also contains prep/sauce modifier words ("grilled", "bbq").
  // Drop them so the food COUNT reflects actual foods — otherwise "chicken in
  // bbq sauce" reads as a 2-item meal and "grilled chicken" as two foods.
  const realFoods = foods.filter((f) => !PREP_GIVEN_RE.test(f) && !SAUCE_GIVEN_RE.test(f));
  if (realFoods.length === 0) return null; // not a recognizable food log → don't ask

  if (realFoods.length === 1) {
    const food = realFoods[0]!;
    // Specific enough when it carries an amount/portion, OR a prep/sauce detail
    // (per "specific amount OR details" — "grilled chicken" / "chicken in bbq
    // sauce" name how it was made, so we log rather than nag for a portion).
    if (QUANTITY_PRESENT_RE.test(lower)) return null;
    if (PREP_GIVEN_RE.test(lower) || SAUCE_GIVEN_RE.test(lower)) return null;
    return {
      matched: food,
      response: `For the ${food}, roughly how much or how many? Even a rough amount (a cup, 4 oz, a handful) lets me log it accurately.`,
    };
  }

  // Multi-food meal. Ask when a HIGH-VARIANCE protein lacks ITS OWN portion/
  // prep/cut/count — even if a DIFFERENT item is quantified. Production:
  // "I had 2 eggs for breakfast. For lunch one chicken and rice" → the eggs are
  // counted, but "one chicken" (one breast? a whole bird?) and bare "rice" are
  // unknown, so ask about the chicken instead of logging a guessed number.
  // "6 oz chicken and rice" / "grilled chicken and rice" / "2 eggs and toast"
  // all have their protein specified → no ask. A high-variance protein is what
  // makes the estimate uncertain (portion + cooking method swing it far more
  // than a rice quantity), so "yogurt and berries" still logs.
  const unspecified = realFoods.find(
    (f) => HIGH_VARIANCE_PROTEINS.has(f) && !proteinHasSpecifier(lower, f),
  );
  if (!unspecified) return null;
  // Eggs: the count is the high-impact detail, not portion/prep.
  if (unspecified === 'egg' || unspecified === 'eggs') {
    return {
      matched: unspecified,
      response: `Got it. How many eggs did you have? That changes the protein, so I'd rather count it right than guess.`,
    };
  }
  return {
    matched: unspecified,
    response: `Got it. About how much ${unspecified} did you have, closer to a palm-sized portion or a full plate? And was it grilled, fried, or breaded? That swings the protein and calories a lot, so I'd rather get it right than guess.`,
  };
}

export function detectVagueFood(
  text: string,
  lastGraceMessage?: string,
  opts?: { requireQuantity?: boolean },
): VagueFoodCheck {
  const lower = text.toLowerCase().trim();
  if (lower.length === 0) return { vague: false };

  // A consideration ("how about pizza?", "should I have a burger?") is not a
  // log — never ship the "what did you have" clarification for it.
  if (CONSIDERATION_RE.test(lower)) return { vague: false };

  // Find a matching brand (case-insensitive, word-boundaried).
  let matched: string | null = null;
  let matchType: 'brand' | 'category' = 'category';
  for (const brand of BRAND_NAMES) {
    const escaped = brand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`\\b${escaped}\\b`, 'i').test(text)) {
      matched = brand;
      matchType = 'brand';
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

  if (!matched) {
    // No brand/category — but a bare prep-ambiguous food (fried/sauce-prone)
    // with no prep info still needs a clarification (calories swing ~2x).
    const prep = detectPrepNeeded(text);
    if (prep) return { vague: true, matched: prep.food, response: prep.response };
    // A pure low-confidence reference ("a small snack", "some food", "had
    // lunch") names no food at all → ask what it was instead of logging 0g.
    const lowConf = detectLowConfidenceMeal(text);
    if (lowConf) return { vague: true, matched: lowConf.item, response: lowConf.response };
    // No-assumptions gate: a single bare food with no amount → ask for one.
    // ONLY when the caller says this is a food LOG (requireQuantity) — never on
    // casual food mentions or food questions ("is salmon healthy?"), which also
    // flow through this function.
    if (opts?.requireQuantity) {
      const ateOut = detectAteOut(text);
      if (ateOut) return { vague: true, matched: ateOut.matched, response: ateOut.response };
      const proteinProduct = detectProteinProduct(text);
      if (proteinProduct) return { vague: true, matched: proteinProduct.matched, response: proteinProduct.response };
      const missingQty = detectMissingQuantity(text);
      if (missingQty) return { vague: true, matched: missingQty.matched, response: missingQty.response };
    }
    return { vague: false };
  }

  // If the message has any specificity, it's NOT vague — let log_food run.
  if (hasSpecificity(text)) return { vague: false };

  // If Grace's previous message was our own clarification ask, use the
  // follow-up template variant so the user doesn't see the same question twice.
  const followUp = !!lastGraceMessage && PRIOR_ASK_RE.test(lastGraceMessage);

  return {
    vague: true,
    matched,
    response: buildClarification(matched, matchType, followUp),
  };
}

// Detects whether the previous Grace message was OUR vague-food clarification.
// Matches all four initial templates AND all three follow-up templates.
const PRIOR_ASK_RE =
  /\b(what did you (have|order|get|eat)|what(?:'s)? did you (?:actually )?have|which (?:specific )?item|which item|estimate the protein accurately|share the specifics|the more specific|how was the .* prepared|grilled, baked, or fried|any sauce or oil|what kind of|to log that .* accurately|a bit more on the)\b/i;
