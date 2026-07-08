/**
 * Portion-precision helpers for the unified food step (2026-07-04).
 *
 * Product ask: when a user reports a food WITHOUT a precise amount ("I ate
 * yogurt with berries"), Grace must NOT silently log a default/standard-serving
 * estimate. Instead she states the usual amount, asks the user to confirm or
 * correct it, and logs ONLY after that — so the protein number reflects what
 * they actually ate, not a guess. A real amount ("a cup", "6 oz", "2 eggs") or
 * an explicit confirmation ("that's about right") logs immediately.
 */

// A short, clear confirmation that the proposed standard portion is right. Kept
// tight (and length-capped) so a genuine portion answer ("a small cup") or a
// new topic is NOT mistaken for an affirmation. Only consulted when a pending
// portion is actually awaiting an answer.
const AFFIRM_RE =
  /^(?:yes|yep|yeah|yup|yes please|correct|that'?s? (?:right|correct|it|about right)|about right|roughly|the usual|usual|standard(?: serving)?|a standard serving|sounds right|that works|exactly|log it|log that|go with that|that'?s fine|fine|perfect)\b/i;

// Foods whose SERVING SIZE swings the protein/calories a lot, so a portion-less
// mention shouldn't be logged at a default guess — ask once. Everything NOT in
// this set is treated as "obvious enough" and logged with the estimate (an
// apple, a banana, toast, a boiled egg, a granola bar…) so Grace doesn't
// over-ask. Matched as whole words inside the item text.
const PORTION_SENSITIVE_TOKENS = [
  // High-variance proteins (portion + cut + prep dominate the macros)
  'chicken', 'beef', 'steak', 'pork', 'fish', 'salmon', 'tuna', 'shrimp',
  'prawns', 'turkey', 'lamb', 'tofu', 'tempeh', 'seitan', 'meatballs',
  'sausage', 'mince', 'meat', 'gyro', 'shawarma', 'brisket', 'ribs',
  // Carbs/grains served in very variable amounts
  'rice', 'pasta', 'noodles', 'spaghetti', 'cereal', 'oatmeal', 'oats',
  'quinoa', 'couscous', 'potato', 'potatoes', 'beans', 'lentils',
  'chickpeas',
  // Dairy / fats / spreads where a "serving" is highly variable
  'yogurt', 'yoghurt', 'cheese', 'nuts', 'almonds', 'peanuts', 'cashews',
  'walnuts', 'trail mix', 'peanut butter', 'hummus',
  // Mixed dishes with unknown contents/size
  'soup', 'stew', 'smoothie', 'salad', 'curry', 'casserole', 'stir fry',
  'stir-fry', 'chili', 'chilli', 'stew', 'bowl',
];
const PORTION_SENSITIVE_RE = new RegExp(
  `\\b(${PORTION_SENSITIVE_TOKENS.map((t) => t.replace(/[-\s]/g, '[-\\s]?')).join('|')})\\b`,
  'i',
);

/**
 * True when a food's serving size materially changes its macros, so a
 * portion-less mention warrants ONE clarification before logging. Obvious /
 * low-variance / naturally-portioned foods (an apple, toast, a boiled egg)
 * return false and are logged with the standard estimate — no over-asking.
 */
export function isPortionSensitiveFood(item: string): boolean {
  return PORTION_SENSITIVE_RE.test(item ?? '');
}

// A PRECISE amount — a number, number-word, or a real measuring unit — is enough
// to log accurately. A bare SIZE word ("small", "large") or a VAGUE quantifier
// ("some", "a few", "a bit") is deliberately NOT precise: "small yogurt" and
// "some crackers" still need a quick confirm. Checked against the item label +
// its serving_size together.
const PRECISE_AMOUNT_RE =
  /\d|\b(?:one|two|three|four|five|six|seven|eight|nine|ten|dozen|half|quarter|cup|cups|oz|ounces?|slices?|pieces?|scoops?|tbsp|tablespoons?|tsp|teaspoons?|grams?|lbs?|pounds?|handful|palmful|palm-sized|servings?|bowls?|plates?|glass|glasses|bottles?|cans?|cartons?|sticks?|bars?)\b/i;

/** True when the text carries a precise, loggable amount (number or unit) — a
 *  bare size/vague quantifier does not count. */
export function hasPreciseAmount(text: string): boolean {
  return PRECISE_AMOUNT_RE.test(text ?? '');
}

// Foods that come in an obvious single standard serving — asking "how much?"
// adds friction with ~no accuracy gain (a whole fruit, a wrapped bar). Everything
// else material is worth a quick portion confirm.
const OBVIOUS_SINGLE_SERVING_RE =
  /\b(?:apple|banana|orange|pear|peach|plum|kiwi|clementine|tangerine|mandarin|granola\s*bar|protein\s*bar|cereal\s*bar|nutri-?grain|clif\s*bar|rx\s?bar|kind\s*bar)\b/i;

/** True for a food whose standard serving is one obvious unit (a fruit, a bar) —
 *  logged with the estimate rather than asked about. */
export function isObviousSingleServing(item: string): boolean {
  return OBVIOUS_SINGLE_SERVING_RE.test(item ?? '');
}

// ── Composition-ambiguous assembled foods (2026-07-06) ───────────────────────
// A food whose protein depends ENTIRELY on an UNKNOWN filling — "a sandwich"
// could be ~5g (PB&J) or 35g (chicken club). We can't estimate it from the bare
// mention, so we must ASK what's in it rather than assume a deli-meat default.
// This is distinct from portion-sensitivity (how MUCH): here the QUESTION is
// what it's MADE OF. A bare article ("a sandwich") does NOT resolve this, so —
// unlike the portion gate — this fires even when a quantity/article is present.
// Prod (IMG_6699): Grace logged "a sandwich" at ~23g "assuming deli meat"; Nudge
// held it pending and asked. A NAMED filling/protein makes it loggable
// ("turkey sandwich", "chicken wrap", "egg sandwich", "peanut butter sandwich").
// Also covers MIXED DISHES whose protein is set by their (unknown) contents — a
// bare "salad" is ~2g of greens or ~40g chicken caesar; a "poke/grain/buddha
// bowl" swings the same way. Prod (2026-07-06): "2 eggs with salad" logged the
// salad at an assumed ~2-4g instead of asking. A named protein or a greens
// descriptor ("chicken salad", "tuna salad", "green/garden/side salad") resolves
// it → loggable; a bare "salad" / "caesar salad" / "poke bowl" is asked.
const ASSEMBLED_AMBIGUOUS_RE =
  /\b(sandwich|sandwiches|sub|subs|hoagie|grinder|wrap|wraps|burrito|burritos|taco|tacos|quesadilla|quesadillas|panini|pita\s*pocket|salad|salads|poke\s*bowl|grain\s*bowl|buddha\s*bowl|burrito\s*bowl|acai\s*bowl)\b/i;
const FILLING_KNOWN_RE =
  /\b(turkey|chicken|ham|beef|roast\s*beef|steak|tuna|salmon|smoked\s*salmon|lox|egg|eggs|cheese|veggie|vegetable|veg|falafel|hummus|avocado|blt|club|salami|pastrami|bacon|meatball|meatballs|tofu|peanut\s*butter|\bpb\b|jelly|jam|nutella|cream\s*cheese|shrimp|prawns|chickpea|quinoa|lentil|green|garden|side|house|leafy|spinach|arugula|kale)\b/i;

// Separators that join the assembled food to a DIFFERENT food ("eggs with
// salad", "eggs and salad"). A filling word sitting on the FAR side of such a
// separator belongs to that other food, NOT to the assembled one — so it must
// not resolve the assembled food's composition.
const FOOD_SEPARATOR_RE = /\b(?:with|and|plus|alongside|next to|w\/)\b|[,&+]/gi;

/**
 * True for an assembled/mixed food (sandwich/wrap/burrito/taco/salad/bowl…) whose
 * protein is unknowable because no filling is attached to THAT food, so it must
 * be ASKED, not assumed — even when an article/quantity is present ("a sandwich").
 *
 * A filling resolves it ONLY when the filling belongs to THIS food:
 *   • as a modifier right before the noun — "chicken salad", "turkey sandwich",
 *     "ham and cheese sandwich" (the immediate modifier "cheese"), OR
 *   • attached right after via with/of/in — "salad with chicken", "sub with tuna".
 * A filling that is a SEPARATE food joined by with/and ("eggs with salad", "2
 * eggs and salad") does NOT resolve it — the salad still has an unknown
 * composition and must be asked. Prod (IMG_6708): "2 eggs with salad" logged the
 * salad silently because the eggs' protein word masked the salad's ambiguity.
 */
export function isCompositionAmbiguousFood(item: string): boolean {
  const t = (item ?? '').toLowerCase();
  const m = ASSEMBLED_AMBIGUOUS_RE.exec(t);
  if (!m) return false;
  const noun = m[0]!;
  const start = m.index;
  const before = t.slice(0, start);
  const after = t.slice(start + noun.length);

  // (a) Filling as a modifier directly before the noun — take only the words
  // after the LAST separator, so a filling belonging to a different food
  // ("eggs with …") is excluded. "chicken salad" → "chicken"; "ham and cheese
  // sandwich" → "cheese"; "eggs with salad" → "" (nothing after "with").
  let lastSep = -1;
  for (const s of before.matchAll(FOOD_SEPARATOR_RE)) lastSep = s.index + s[0].length;
  const modifier = lastSep >= 0 ? before.slice(lastSep) : before;
  if (FILLING_KNOWN_RE.test(modifier)) return false;

  // (b) Filling attached AFTER the noun via with/of/in ("salad with chicken").
  // "and" is deliberately excluded — "salad and chicken" reads as two separate
  // foods, so the salad stays ambiguous.
  const afterFill = /^\s*(?:with|of|in|topped\s+with)\b([\s\S]*)$/.exec(after);
  if (afterFill && FILLING_KNOWN_RE.test(afterFill[1]!)) return false;

  return true;
}

// ── Protein products need scoop count / brand (2026-07-06) ────────────────────
// A "protein shake"/"drink"/"powder"/"whey" gives no protein number on its own —
// the SCOOP COUNT (or brand + size) drives it (one scoop ~20g, two ~40g). "a
// protein shake" tells us nothing, so — like an assembled food — ASK even though
// the article is present. A scoop count, gram figure, or a known brand makes it
// loggable. Mirrors vague-food.detectProteinProduct (compact path); kept local so
// food-portion.ts stays dependency-free. (A "protein BAR" is standard → excluded.)
const PROTEIN_PRODUCT_RE = /\b(protein\s*shakes?|protein\s*drinks?|protein\s*powder|whey|mass\s*gainer|protein\s*smoothie)\b/i;
const SCOOP_OR_BRAND_RE = /\b(\d+\s*scoops?|one scoop|two scoops|half\s*(?:a\s*)?scoop|\d+\s*g\b|\d+\s*grams?\b|optimum|gold standard|fairlife|premier|orgain|huel|isopure|ghost|quest|myprotein|core power|owyn|ready\s*to\s*drink|\brtd\b)\b/i;

/**
 * True when the text names a protein product but gives NO scoop count / gram
 * figure / brand — so its protein is unknowable and must be asked, not assumed.
 * `context` (the full message) is checked too, so "a protein shake, 2 scoops"
 * anywhere in the message counts as specified.
 */
export function isProteinProductAmbiguous(item: string, context = ''): boolean {
  const hay = `${item ?? ''} ${context ?? ''}`;
  if (!PROTEIN_PRODUCT_RE.test(hay)) return false;
  return !SCOOP_OR_BRAND_RE.test(hay);
}

/**
 * True when the user is confirming the standard/usual portion Grace proposed —
 * so the pending item is logged at its standard estimate. Only meaningful when
 * a pending portion is awaiting a reply.
 */
export function isPortionAffirmation(text: string): boolean {
  const t = (text ?? '').trim();
  if (!t || t.length > 40) return false;
  return AFFIRM_RE.test(t);
}

/**
 * A portion reference that FITS the food — a "cup" makes sense for rice but not
 * for chicken, and a "small container" fits yogurt but not steak. Keeps the
 * clarification concrete per-dish instead of a one-size-fits-all "a cup or a
 * small container" (which reads wrong for half the foods it's asked about).
 */
export function portionHint(item: string): string {
  const t = (item ?? '').toLowerCase();
  if (/\b(chicken|beef|steak|pork|fish|salmon|tuna|shrimp|prawns|turkey|lamb|meat|gyro|shawarma|brisket|ribs|sausage|meatballs|mince|tofu|tempeh|seitan)\b/.test(t)) return 'a palm-sized piece';
  if (/\b(rice|pasta|noodles|spaghetti|cereal|oatmeal|oats|quinoa|couscous|potato|potatoes|beans|lentils|chickpeas)\b/.test(t)) return 'about a cup';
  if (/\b(yogurt|yoghurt|cheese|hummus|peanut butter)\b/.test(t)) return 'a small container';
  if (/\b(nuts|almonds|peanuts|cashews|walnuts|trail[-\s]?mix)\b/.test(t)) return 'a small handful';
  if (/\b(soup|stew|smoothie|salad|curry|casserole|chili|chilli|bowl|stir[-\s]?fry)\b/.test(t)) return 'a bowl';
  return 'a rough amount';
}

// Recognized food tokens — used to reduce an item label that was accidentally
// passed as a whole sentence/span down to the actual food, so a clarification can
// never echo the user's entire message (prod IMG_6709: "how many scoops was the I
// ate pretty light, just a protein shake and a sandwich…").
const KNOWN_FOOD_TOKEN_RE =
  /\b(protein\s*shakes?|protein\s*drinks?|protein\s*powder|protein\s*smoothie|whey|sandwiches?|wraps?|burritos?|tacos?|subs?|hoagie|quesadillas?|panini|poke\s*bowl|grain\s*bowl|buddha\s*bowl|salads?|smoothie|milkshake|shakes?|chicken|beef|steak|pork|fish|salmon|tuna|shrimp|prawns|turkey|lamb|tofu|tempeh|rice|pasta|noodles|spaghetti|oatmeal|oats|quinoa|couscous|potatoes?|beans|lentils|chickpeas|yogurt|yoghurt|cheese|nuts|almonds|soup|stew|curry|casserole|chili|chilli|bowl|omelette|omelet|eggs?|toast|bagel|burger|pizza|cereal)\b/i;

/**
 * A clean, short food label. A normal food phrase ("yogurt with berries", "ham
 * and cheese sandwich") is kept as-is; an over-long, sentence-like value (a raw
 * consumption span that slipped through) is reduced to its recognized food token
 * so the question never echoes the whole message. Defense-in-depth: the source
 * paths already pass clean names; this guarantees it for any future caller too.
 */
function foodLabel(raw: string): string {
  const t = (raw ?? '').trim();
  if (t.length <= 32 && t.split(/\s+/).length <= 5) return t;
  const m = KNOWN_FOOD_TOKEN_RE.exec(t);
  return m ? m[0].toLowerCase().replace(/\s+/g, ' ') : t.slice(0, 32).trim();
}

/**
 * Build the clarification question for foods reported without an explicit
 * amount. For a SINGLE dish it states a fitting usual serving; for a MULTI-item
 * meal it asks about EACH dish by name with its own fitting reference — so
 * "chicken and rice" gets "for the chicken, a palm-sized piece; for the rice, a
 * cup?" instead of one generic "a cup or a small container" that fits neither.
 * The user confirms or gives real amounts, so the log is accurate rather than a
 * default guess.
 */
export function buildPortionConfirmQuestion(
  items: Array<{ item: string; protein_g: number | null }>,
): string {
  const named = items
    .filter((i) => i.item && i.item.trim())
    .map((i) => ({ ...i, item: foodLabel(i.item) }));
  if (named.length === 0) return '';
  if (named.length === 1) {
    const it = named[0]!;
    // Protein product: the scoop count / brand drives the protein — ask for it.
    if (isProteinProductAmbiguous(it.item)) {
      return `Got it — how many scoops was the ${it.item}, or what brand and size? The scoop count swings the protein a lot.`;
    }
    // Composition-ambiguous (a bare sandwich/wrap/…): ask what's IN it, not how
    // much — the protein is unknowable from the mention, so never guess a filling.
    if (isCompositionAmbiguousFood(it.item)) {
      return `Got it — what was in the ${it.item}? (turkey, chicken, cheese, veggie…) I'd rather log it right than guess the protein.`;
    }
    return `Yum, ${it.item} 🙌 About how much did you have — roughly ${portionHint(it.item)}? Or just say "that's about right" and I'll log a standard serving.`;
  }
  const list = named.map((i) => i.item).join(' and ');
  // Per-dish so each item is captured — a protein product asks scoops/brand, a
  // composition-ambiguous food asks what's in it, a portion-variable food asks
  // how much. Cap the spelled-out references at the first two to keep it readable.
  const perDish = named
    .slice(0, 2)
    .map((i) =>
      isProteinProductAmbiguous(i.item)
        ? `how many scoops the ${i.item} was`
        : isCompositionAmbiguousFood(i.item)
          ? `what was in the ${i.item}`
          : `for the ${i.item}, ${portionHint(i.item)}`,
    )
    .join('; ');
  const tail = named.length > 2 ? ', and the rest' : '';
  return `Nice — ${list} 🙌 A couple quick things so I log it right — ${perDish}${tail}? Or say "that's about right" for standard servings.`;
}
