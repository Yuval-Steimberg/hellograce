/**
 * Water / hydration tracking helpers (2026-06-15).
 *
 * Water is an ISOLATED metric — its own table (water_logs) and its own
 * detection here, so a hydration query can never return protein/food data
 * (the production bug: "how much water today?" answered with protein totals).
 *
 * Pure functions: detect a water LOG vs a water QUERY, and parse an amount in
 * ounces. Storage + wake-window totals live in services/water-log.ts and the
 * water_today branch of query-fast.ts.
 */

export const WATER_GOAL_MIN_OZ = 64;
export const WATER_GOAL_MAX_OZ = 80;

// Volume units → ounces. Standard conversions; a "glass" is the common 8 oz,
// a "bottle" the common ~16.9 oz single-serve.
const UNIT_TO_OZ: Record<string, number> = {
  oz: 1, ounce: 1, ounces: 1,
  cup: 8, cups: 8,
  ml: 0.033814, milliliter: 0.033814, milliliters: 0.033814,
  l: 33.814, liter: 33.814, liters: 33.814, litre: 33.814, litres: 33.814,
  glass: 8, glasses: 8,
  bottle: 16.9, bottles: 16.9,
};
const UNIT_ALT = Object.keys(UNIT_TO_OZ).join('|');

const WORD_NUMBERS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12, couple: 2,
};

const AMOUNT_UNIT_RE = new RegExp(
  `\\b(\\d+(?:\\.\\d+)?|a|an|one|two|three|four|five|six|seven|eight|nine|ten|twelve|couple)\\s*(${UNIT_ALT})\\b`,
  'gi',
);

// A water reference: explicit "water"/"hydrate", or a drink+volume phrasing.
const WATER_WORD_RE = /\b(water|hydrate|hydration|h2o|fluids?)\b/i;
// A volume unit strongly implies a drink/water log when no solid-food word is
// present ("65 oz", "two glasses", "500 ml").
const VOLUME_UNIT_RE = new RegExp(`\\b(\\d+(?:\\.\\d+)?|a|an|one|two|three|four|five|six|seven|eight|nine|ten|twelve|couple)\\s*(${UNIT_ALT})\\b`, 'i');
// Food words that mean a volume is about FOOD, not water ("1 cup of rice").
const SOLID_FOOD_NEARBY_RE = /\b(rice|oats?|oatmeal|yogurt|soup|cereal|pasta|beans|coffee|tea|juice|milk|soda|smoothie|shake|broth|wine|beer|protein)\b/i;

// A water TOTAL query — interrogative AND about the running total. NOT a bare
// "how much water" (goal/education) and NOT a declarative log ("I had water").
const WATER_QUERY_RE = new RegExp([
  // "how much/many water … today/so far/had/left/total/already/remaining"
  String.raw`\bhow (?:much|many)\b[^?]*\bwater\b[^?]*\b(?:today|so far|had|left|remaining|total|already|intake|drunk|drank)\b`,
  String.raw`\bhow (?:much|many) water (?:have i had|did i (?:drink|have)|today|so far|already|left|remaining)\b`,
  // "have I had / did I drink / do I have … water"
  String.raw`\b(?:have i had|did i (?:drink|have|log)|do i have)\b[^?]*\bwater\b`,
  // "water total/left/remaining/intake", "my water today/total/so far"
  String.raw`\bwater\b[^?]*\b(?:total|left|remaining|intake)\b`,
  String.raw`\bmy water (?:today|total|so far|intake|level)\b`,
].join('|'), 'i');

// Interrogative / goal phrasing — these are questions, never a log. Keeps
// "how much water should I drink" (education) and "did I drink water" (query)
// out of the logging path even when they contain a drink verb.
const INTERROGATIVE_RE =
  /\b(how much|how many|should i|do i need|need to|what(?:'?s| is)|how do i|is it|can i|do i have|have i|did i)\b/i;

// Consumption verbs (broad) — declarative intake. "drank/sipped" are
// unambiguous liquids; "had/having/got/finished" are ambiguous (need a water
// word or water context). Used for declarative log detection only.
const CONSUME_VERB_RE = /\b(drank|drink|drinking|sipped|sipping|chugged|guzzled|downed|had|have|having|finished|got|getting|consumed)\b/i;
const DRINK_VERB_RE = /\b(drank|drink|drinking|sipped|sipping|chugged|guzzled|downed)\b/i;

/** Parse a total ounces from any amount+unit phrases in the text (summing
 *  multiple, e.g. "a glass and 12 oz"). Returns null when no amount is found. */
export function parseWaterOz(text: string): number | null {
  let total = 0;
  let found = false;
  for (const m of text.matchAll(AMOUNT_UNIT_RE)) {
    const rawQty = m[1]!.toLowerCase();
    const unit = m[2]!.toLowerCase();
    const qty = /^\d/.test(rawQty) ? parseFloat(rawQty) : (WORD_NUMBERS[rawQty] ?? 1);
    const perOz = UNIT_TO_OZ[unit];
    if (perOz && qty > 0) { total += qty * perOz; found = true; }
  }
  if (!found) return null;
  return Math.round(total);
}

/** Is this a water LOG? Either it names water + an amount, or it's a bare
 *  volume amount with no solid-food word AND the prior turn was about water
 *  (e.g. "Had already 65 oz today" right after a hydration reply). */
export function isWaterLog(text: string, lastGraceMessage?: string): boolean {
  const t = text.trim();
  if (t.includes('?')) return false;            // a question is a query, not a log
  if (INTERROGATIVE_RE.test(t)) return false;   // "how much water should I drink" etc.
  const hasWaterWord = WATER_WORD_RE.test(t);
  const hasVolume = VOLUME_UNIT_RE.test(t);
  const hasSolidFood = SOLID_FOOD_NEARBY_RE.test(t);
  // Water explicitly named + a volume OR a consumption verb ("I had water",
  // "drank a glass of water", "16 oz water").
  if (hasWaterWord && (hasVolume || CONSUME_VERB_RE.test(t))) return true;
  if (hasSolidFood) return false;               // a volume about food ("1 cup of rice", "coffee")
  // An unambiguous drink verb + a volume → water/liquid ("I drank 20 oz").
  if (hasVolume && DRINK_VERB_RE.test(t)) return true;
  // Bare volume ("65 oz today", "two glasses") with no water word → water only
  // when the previous Grace turn was about water (session context).
  if (hasVolume && !hasWaterWord && lastGraceMessage && WATER_WORD_RE.test(lastGraceMessage)) return true;
  return false;
}

/** Is this a water QUERY ("how much water today?", "water total")? */
export function isWaterQuery(text: string): boolean {
  return WATER_QUERY_RE.test(text);
}
