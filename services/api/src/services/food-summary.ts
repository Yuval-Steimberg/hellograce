/**
 * Food-log presentation helpers — turn raw stored food rows into a clean,
 * aggregated, human-readable summary.
 *
 * Stored rows repeat and leak internal labels ("2 eggs", "2 eggs",
 * "chicken breast (4oz)", "3 eggs + salad + rice", …). Dumping them verbatim
 * reads like a database export:
 *   "Chicken breast, rice, 2 eggs, 2 eggs, chicken breast, rice, … and 12 more"
 * These helpers dedupe identical foods into "Name × N", strip portion
 * parentheticals, explode multi-item meal labels, and never emit a vague
 * "and N more".
 *
 * Accuracy guarantee: presentation ONLY. Protein/calorie TOTALS are summed
 * from the rows upstream and passed in separately — aggregation never touches
 * them, so a summary can never change the day's nutrition numbers.
 */

export interface AggregatedFood {
  /** Display name, title-cased base ("Chicken breast", "Eggs"). */
  name: string;
  /** Summed leading quantity (defaults to 1 per log entry when none parsed). */
  qty: number;
}

/** Split a stored label that may itself be a multi-item meal ("3 eggs + salad
 *  + rice") into individual food strings. */
function explodeItems(rawItems: string[]): string[] {
  return rawItems
    .flatMap((s) => (s ?? '').split(/\s*\+\s*/))
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// Portion/serving/container words. When a leading count is followed by one of
// these, the count is part of the serving ("1 can tuna"), not a multiplier.
const UNIT_WORD_RE =
  /^(can|cans|cup|cups|slice|slices|bowl|bowls|scoop|scoops|serving|servings|piece|pieces|glass|glasses|bottle|bottles|oz|ounce|ounces|g|gram|grams|lb|lbs|tbsp|tablespoon|tablespoons|tsp|teaspoon|teaspoons|handful|handfuls|stick|sticks|bar|bars|packet|packets|plate|plates|portion|portions)\b/i;

/**
 * Aggregate raw food strings into deduped {name, qty} entries, ordered by qty
 * descending (then first-seen for stability). Parses a leading integer
 * quantity ("2 eggs" → qty 2) and strips portion parentheticals
 * ("chicken breast (4oz)" → "chicken breast").
 */
export function aggregateFoodItems(rawItems: string[]): AggregatedFood[] {
  const groups = new Map<string, { name: string; qty: number; order: number }>();
  let order = 0;
  for (const item of explodeItems(rawItems)) {
    // Strip portion parentheticals and collapse whitespace.
    let s = item.replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
    if (!s) continue;
    // Parse an optional leading integer quantity ("2 eggs" → qty 2). But NOT
    // when the count is followed by a portion/unit word ("1 can tuna",
    // "1 cup rice", "2 slices of toast") — there the number belongs to the
    // serving description, so keep the label intact at qty 1.
    let qty = 1;
    const m = s.match(/^(\d{1,3})\s+(.+)$/);
    if (m && Number(m[1]) > 0 && !UNIT_WORD_RE.test(m[2]!)) {
      qty = Number(m[1]);
      s = m[2]!.trim();
    }
    if (!s) continue;
    const key = s.toLowerCase();
    const existing = groups.get(key);
    if (existing) {
      existing.qty += qty;
    } else {
      groups.set(key, { name: titleCase(s), qty, order: order++ });
    }
  }
  return [...groups.values()]
    .sort((a, b) => b.qty - a.qty || a.order - b.order)
    .map(({ name, qty }) => ({ name, qty }));
}

/**
 * Compact one-line label for prompt context and short replies:
 *   "Eggs ×6, Chicken breast ×3, Rice ×2"
 * qty 1 shows no "×1". Overflow rolls into "+N more items" (never a raw dump).
 */
export function formatAggregatedInline(items: AggregatedFood[], max = 10): string {
  const shown = items.slice(0, max);
  const labels = shown.map((i) => (i.qty > 1 ? `${i.name} × ${i.qty}` : i.name));
  if (items.length > shown.length) {
    const extraQty = items.slice(max).reduce((s, i) => s + i.qty, 0);
    labels.push(`+${extraQty} more item${extraQty === 1 ? '' : 's'}`);
  }
  return labels.join(', ');
}

/**
 * Render a user-facing daily food summary as ONE conversational line.
 *
 * WhatsApp is the channel and the outbound enforcer strips structured layouts
 * (bullets, "Here's your day:" intros, "Label:" headers, multi-line lists) for
 * a conversational tone — a sectioned report gets gutted to nothing. So the
 * summary is a single aggregated sentence: deduped "Name × N" foods, a
 * meaningful rolled-up tail ("plus N more foods", never "and 12 more"), and the
 * totals in plain prose.
 *
 * Totals are passed in (summed upstream from the rows) — never recomputed here,
 * so presentation can never change the day's nutrition numbers.
 */
export function renderDailyFoodSummary(
  rawItems: string[],
  proteinTotal: number,
  calTotal: number,
  maxShown = 6,
): string {
  const agg = aggregateFoodItems(rawItems);
  if (agg.length === 0) {
    return `Nothing logged yet today. Send me what you've eaten and I'll track it.`;
  }
  const shown = agg.slice(0, maxShown).map((i) => (i.qty > 1 ? `${i.name} × ${i.qty}` : i.name));
  const tailQty = agg.slice(maxShown).reduce((s, i) => s + i.qty, 0);
  let list: string;
  if (tailQty > 0) {
    list = `${shown.join(', ')}, plus ${tailQty} more food${tailQty === 1 ? '' : 's'}`;
  } else {
    const last = shown.pop()!;
    list = shown.length === 0 ? last : `${shown.join(', ')}, and ${last}`;
  }
  const totals = calTotal > 0
    ? `That's ${proteinTotal}g protein and ${calTotal.toLocaleString('en-US')} calories.`
    : `That's ${proteinTotal}g protein.`;
  return `Today you've had ${list}. ${totals}`;
}
