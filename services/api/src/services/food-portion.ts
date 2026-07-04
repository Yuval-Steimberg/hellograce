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
