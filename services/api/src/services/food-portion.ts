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
 * Build the ONE clarification question for foods reported without an explicit
 * amount: state the usual serving + its protein, and ask the user to confirm or
 * give the real amount, so the log is accurate rather than a default guess.
 */
export function buildPortionConfirmQuestion(
  items: Array<{ item: string; protein_g: number | null }>,
): string {
  const named = items.filter((i) => i.item && i.item.trim());
  if (named.length === 0) return '';
  if (named.length === 1) {
    const it = named[0]!;
    const p = it.protein_g != null && it.protein_g > 0
      ? ` — a standard serving is about ${Math.round(it.protein_g)}g protein`
      : '';
    return `Before I log the ${it.item}, roughly how much did you have${p}? Tell me the amount (a cup, ~6 oz, a handful) or say "that's about right" and I'll log it accurately.`;
  }
  const list = named.map((i) => i.item).join(' and ');
  return `Before I log the ${list}, roughly how much of each did you have? Give me the amounts (a cup, ~6 oz, a handful) or say "that's about right" for a standard serving and I'll log it accurately.`;
}
