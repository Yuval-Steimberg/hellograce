/**
 * "Reset today's food log" detection (2026-07-04).
 *
 * A user needs a way to zero out today's food totals from chat — after a wrong
 * estimate, an accidental double-log, or accumulated test entries — without
 * deleting items one by one. This is a deterministic intercept: when it fires,
 * every food_logs row in the user's current logging day is deleted and Grace
 * confirms the day is back to 0. Scoped tightly so a normal "remove the pizza"
 * (single-item delete) or a food question never triggers a full wipe.
 */

// Must clear the WHOLE day's food. Requires a reset/clear verb + a today-food
// object ("food log", "today's food", "my protein/calories today", "everything
// I logged today"). "start over" / "from scratch" also qualify with a food noun.
const RESET_VERB_RE = /\b(reset|clear|wipe|erase|empty|delete all|remove all|start (?:over|again|fresh)|zero out|clean out)\b/i;
const FOOD_SCOPE_RE = /\b(food log|food diary|food entries|today'?s food|todays food|my food|my protein|my calories|everything i (?:ate|logged|had)|all (?:my |the )?(?:food|meals|entries|logs)|the day|today)\b/i;
// Never fire on a single-item delete ("remove the pizza") or a query.
const SINGLE_ITEM_RE = /\b(remove|delete|take off|undo)\s+(the\s+|my\s+|that\s+)?(?!all\b|everything\b)[a-z]/i;

export function detectFoodReset(text: string): boolean {
  const t = (text ?? '').trim();
  if (!t || t.length > 120) return false;
  if (!RESET_VERB_RE.test(t)) return false;
  if (!FOOD_SCOPE_RE.test(t)) return false;
  // "reset/clear/start over" carry the intent; a bare "remove the pizza" lacks a
  // reset verb so it won't reach here. But guard the "delete all"/"remove all"
  // forms against a trailing single item ("delete all the pizza" → single item).
  if (/\b(delete all|remove all)\b/i.test(t) && SINGLE_ITEM_RE.test(t) && !/\b(food|meals|entries|logs|everything|today)\b/i.test(t)) {
    return false;
  }
  return true;
}

/** Warm confirmation after a reset. */
export function buildFoodResetReply(deleted: number): string {
  if (deleted <= 0) {
    return `Your food log for today is already empty — you're at 0g protein so far. Log a meal whenever you're ready and I'll track it.`;
  }
  return `Done — cleared today's food log. You're back to 0g protein and 0 calories for today. Log your next meal and we'll start the count fresh 🤍`;
}
