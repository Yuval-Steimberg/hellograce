/**
 * Deterministic macro-sanity guard (2026-07-08, adapted from the food_tracker
 * model's `calorie_sanity_check`). A logged item's macros must be internally
 * consistent: the calories implied by its protein alone can't exceed the stated
 * total calories. Protein is 4 kcal/g, so `protein_g * 4` must be ≤ the item's
 * calories (with a small tolerance). When it isn't, the estimate is impossible —
 * a hallucinated number like "salad → 40g protein / 60 cal" (160 kcal of protein
 * in a 60 kcal food) — so we DOWNGRADE the confidence to 'low' rather than trust
 * or silently ship it. Cheap, no LLM, catches a whole class of bad estimates
 * before they reach the diary. Pure + unit-testable.
 *
 * Grace stores only protein + calories (no fat/carb), so this is the protein-vs-
 * calories subset of the full 4·protein + 9·fat + 4·carb check — the part that
 * needs no fields Grace doesn't have.
 */

export type Confidence = 'exact' | 'high' | 'medium' | 'low';

const PROTEIN_KCAL_PER_G = 4;
// Allow 5% slack for rounding before flagging (protein rounded to 5g, calories
// rounded to 10 can nudge the ratio slightly over 1.0 on a legitimate item).
const TOLERANCE = 1.05;

/**
 * True when the item's protein calories don't exceed its stated calories.
 * Non-committal (returns true) when calories are missing/zero — there's nothing
 * to check against, so we don't penalize an item with no calorie estimate.
 */
export function isMacroConsistent(
  proteinG: number | null | undefined,
  calories: number | null | undefined,
): boolean {
  if (proteinG == null || calories == null) return true;
  if (!(calories > 0) || !(proteinG > 0)) return true;
  return proteinG * PROTEIN_KCAL_PER_G <= calories * TOLERANCE;
}

/**
 * The confidence to store: the given base, unless the macros are internally
 * impossible — then 'low', so the reply hedges and the number is never presented
 * as trustworthy. Never UP-grades; a already-low estimate stays low.
 */
export function macroSanityConfidence(
  proteinG: number | null | undefined,
  calories: number | null | undefined,
  base: Confidence,
): Confidence {
  return isMacroConsistent(proteinG, calories) ? base : 'low';
}

/** Confidence a reply should hedge on ("~Xg, rough estimate"). */
export function isRoughConfidence(c: Confidence | null | undefined): boolean {
  return c === 'low' || c === 'medium';
}

const CONFIDENCE_RANK: Record<Confidence, number> = { exact: 3, high: 2, medium: 1, low: 0 };

/** The LEAST confident of several estimates — used when collapsing multiple food
 *  items into one meal row: if any part was a rough guess, the meal is. Ignores
 *  nulls; returns 'medium' when there's nothing to rank. */
export function worstConfidence(cs: ReadonlyArray<Confidence | null | undefined>): Confidence {
  const present = cs.filter((c): c is Confidence => c != null);
  if (present.length === 0) return 'medium';
  return present.reduce((worst, c) => (CONFIDENCE_RANK[c] < CONFIDENCE_RANK[worst] ? c : worst), present[0]!);
}
