/**
 * Deterministic completeness check for an ENUMERATED multi-ask message
 * (2026-07-08). A message like
 *   "help me plan what to eat before dinner, what to choose at the meal,
 *    and how to handle dessert without feeling guilty?"
 * lists three distinct asks. The single grounded reply occasionally drops one
 * (prod: only the before-dinner tip landed). This extracts the asks as keyword
 * groups so the reply path can check each is covered and, if not, regenerate
 * ONCE — the caller adopts the retry only when it covers strictly more, so a
 * false positive can never ship a worse reply (worst case is a wasted call).
 *
 * Deliberately CONSERVATIVE: fires only when the message is a question with ≥2
 * comma/"and"-separated wh-clauses after an explicit ask head ("help me…",
 * "can you help…"). A single question, or a multi-topic message that isn't an
 * enumerated ask list, yields no groups → no guard. Pure + unit-tested.
 */

const STOP = new Set([
  'what', 'whats', 'how', 'when', 'where', 'which', 'who', 'why',
  'to', 'the', 'a', 'an', 'and', 'or', 'for', 'me', 'my', 'at', 'as',
  'i', 'you', 'your', 'should', 'could', 'can', 'would', 'do', 'does', 'did',
  'of', 'in', 'on', 'is', 'are', 'be', 'am', 'was', 'were',
  'without', 'feeling', 'feel', 'handle', 'choose', 'pick', 'eat', 'eating',
  'have', 'having', 'get', 'getting', 'plan', 'about', 'with', 'that', 'this',
  'it', 'so', 'still', 'also', 'some', 'any', 'more', 'help', 'figure', 'decide',
  'know', 'want', 'need', 'not', 'sure', 'out', 'up', 'go', 'going', 'make',
  'making', 'before', 'after', 'then', 'next', 'later', 'good', 'best', 'right',
]);

// Light synonym expansion so a genuinely-covered ask isn't falsely flagged
// (e.g. a reply that says "before you go" has covered the "before dinner" ask).
const SYNONYMS: Record<string, string[]> = {
  dinner: ['dinner', 'before you go', 'beforehand', 'pre-dinner', 'ahead of time', 'snack before', 'head over', 'arriving'],
  meal: ['meal', 'at the table', 'on your plate', 'at dinner', 'when you get there', "once you're there", 'the spread', 'the food there', 'the buffet', 'servings', 'fill your plate', 'plate'],
  dessert: ['dessert', 'sweet', 'sweets', 'treat', 'something sweet'],
  guilty: ['guilty', 'guilt', 'shame', 'ashamed', 'hard on yourself', 'no rules', 'enjoy it', 'kind to yourself', 'no guilt'],
  breakfast: ['breakfast', 'morning'],
  lunch: ['lunch', 'midday'],
  snack: ['snack', 'nibble', 'bite'],
};

function keywordsOf(segment: string): string[] {
  return segment
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w));
}

/**
 * The distinct ask segments (each as a keyword group) in an enumerated multi-ask
 * question. Empty unless there are ≥2 comma/"and"-separated wh-clauses after an
 * ask head. Conservative on purpose.
 */
export function askKeywordGroups(text: string): string[][] {
  if (!/\?/.test(text)) return [];
  const head = text.match(
    /\b(?:help me|can you (?:help|tell me|walk me)|i(?:'?d| would)? (?:like|want) to know|not sure|figure out|plan)\b([\s\S]*)$/i,
  );
  const region = head ? head[1] : '';
  if (!region || !region.trim()) return [];
  const segs = region.split(/,|\band\b/i).map((s) => s.trim()).filter(Boolean);
  const groups: string[][] = [];
  for (const seg of segs) {
    // A real ask segment carries a wh/action cue or a named eating occasion.
    if (!/\b(what|how|which|choose|eat|handle|dessert|meal|dinner|snack|breakfast|lunch)\b/i.test(seg)) continue;
    const kws = keywordsOf(seg);
    if (kws.length) groups.push(kws);
  }
  return groups.length >= 2 ? groups : [];
}

function groupCovered(group: string[], replyLower: string): boolean {
  for (const kw of group) {
    if (replyLower.includes(kw)) return true;
    const syn = SYNONYMS[kw];
    if (syn && syn.some((s) => replyLower.includes(s))) return true;
  }
  return false;
}

/** Count of enumerated asks NOT covered by the reply. 0 when it isn't an
 *  enumerated multi-ask, or everything is covered. */
export function uncoveredAskCount(text: string, reply: string): number {
  const groups = askKeywordGroups(text);
  if (groups.length === 0) return 0;
  const r = (reply ?? '').toLowerCase();
  return groups.filter((g) => !groupCovered(g, r)).length;
}

/** Representative keyword for each dropped ask — used to word the regen. */
export function missingAskTopics(text: string, reply: string): string[] {
  const groups = askKeywordGroups(text);
  if (groups.length === 0) return [];
  const r = (reply ?? '').toLowerCase();
  return groups.filter((g) => !groupCovered(g, r)).map((g) => g[0]!);
}
