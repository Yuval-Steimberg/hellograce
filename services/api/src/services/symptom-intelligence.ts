/**
 * Symptom intelligence (2026-07-01) — Grace's signature differentiator.
 *
 * Grace learns how THIS person's body handles GLP-1 side effects over time:
 * when a symptom tends to hit relative to their injection, and what settled it
 * last time. That lets her recall a PERSONAL pattern instead of generic advice —
 * "this usually hits you the day after your shot, and ginger tea helped last
 * time" — reactively when it recurs, and proactively on injection day. It's the
 * one thing a generic tracker or a 15-minute clinic visit structurally can't do,
 * and it compounds (a switching-cost moat: you can't export what Grace learned).
 *
 * Pure functions (no I/O) so the pattern logic is fully unit-testable; the thin
 * DB layer lives in user.service.
 */

export type CanonSymptom =
  | 'nausea' | 'vomiting' | 'constipation' | 'diarrhea' | 'fatigue'
  | 'headache' | 'dizziness' | 'heartburn' | 'bloating';

/** Ordered specific → generic so "throwing up" maps to vomiting, not nausea. */
const SYMPTOM_PATTERNS: Array<[RegExp, CanonSymptom]> = [
  [/\b(throwing up|threw up|vomit\w*|puk\w*)\b/i, 'vomiting'],
  [/\b(nause\w*|queasy|sick to my stomach|so sick|feel sick|gonna be sick)\b/i, 'nausea'],
  [/\b(constipat\w*|backed up|can'?t (go|poop)|haven'?t (gone|pooped))\b/i, 'constipation'],
  [/\b(diarrh\w*|the runs|loose stool|upset stomach and runs)\b/i, 'diarrhea'],
  [/\b(heartburn|acid reflux|reflux|indigestion)\b/i, 'heartburn'],
  [/\b(bloat\w*|so gassy|full of gas|distended)\b/i, 'bloating'],
  [/\b(headache|migraine|head is pounding|head hurts)\b/i, 'headache'],
  [/\b(dizzy|dizziness|lighthead\w*|room is spinning)\b/i, 'dizziness'],
  [/\b(exhaust\w*|so tired|no energy|wiped out|fatigue\w*|drained|zonked)\b/i, 'fatigue'],
];

/** Map a free-text message to a canonical GLP-1 symptom, or null. */
export function classifySymptom(text: string): CanonSymptom | null {
  const t = text ?? '';
  for (const [re, sym] of SYMPTOM_PATTERNS) {
    if (re.test(t)) return sym;
  }
  return null;
}

// ── Remedy-outcome capture ────────────────────────────────────────────────────

// "the ginger tea helped", "that worked", "feel better after the crackers".
const OUTCOME_HELPED_RE =
  /\b(help\w*|work\w*|better|settled|eased|calmed|did the trick|feel\w* (?:good|great|fine|ok|better)|that fixed it|going away|subsid\w*)\b/i;
// Negations that void a "helped" match ("didn't help", "no better").
const OUTCOME_NEG_RE =
  /\b(didn'?t|did not|not|no|hasn'?t|hasn'?t been|still|worse|nothing)\b[^.!?]{0,20}\b(help\w*|work\w*|better|ease\w*|settl\w*)\b/i;

/** A short remedy phrase extracted from "the ginger tea helped" → "ginger tea".
 *  Best-effort; null when nothing clear. */
export function extractRemedy(text: string): string | null {
  const t = (text ?? '').toLowerCase();
  const REMEDIES: Array<[RegExp, string]> = [
    [/ginger\s*(tea|ale|chews?)?/, 'ginger'],
    [/\bpeppermint( tea)?\b/, 'peppermint tea'],
    [/\bcracker/, 'crackers'],
    [/\btoast\b/, 'toast'],
    [/\bwater\b|\bhydrat/, 'hydration'],
    [/\bsmall(er)? meals?\b|\bsmall bites?\b|\beating less\b/, 'smaller meals'],
    [/\bplain( food| meals?)?\b|\bbland\b/, 'bland food'],
    [/\bfiber\b|\bprunes?\b/, 'fiber'],
    [/\bwalk\b|\bwalking\b|\bmov\w+ around\b/, 'a walk'],
    [/\brest\w*\b|\bnap\b|\blay(ing)? down\b|\blie down\b/, 'rest'],
    [/\belectrolyte/, 'electrolytes'],
    [/\bmiralax\b|\bstool softener\b|\blaxative\b/, 'a stool softener'],
  ];
  for (const [re, label] of REMEDIES) {
    if (re.test(t)) return label;
  }
  return null;
}

/** Detect that the user is reporting a remedy WORKED (so we can attribute it to
 *  their last open symptom episode). Returns the remedy phrase (may be null) or
 *  null when this isn't a positive outcome report. */
export function detectRemedyOutcome(text: string): { remedy: string | null } | null {
  const t = text ?? '';
  if (!OUTCOME_HELPED_RE.test(t)) return null;
  if (OUTCOME_NEG_RE.test(t)) return null; // "didn't help" / "no better"
  return { remedy: extractRemedy(t) };
}

// ── Injection timing ──────────────────────────────────────────────────────────

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

/** Day of week (0 = Sunday … 6 = Saturday) in the user's timezone. Falls back to
 *  UTC on a bad zone. */
export function localDayOfWeek(tz: string | null | undefined, now: Date = new Date()): number {
  try {
    const wd = new Intl.DateTimeFormat('en-US', { timeZone: tz || 'America/New_York', weekday: 'short' }).format(now);
    const i = DAYS.findIndex((d) => d.slice(0, 3) === wd);
    return i >= 0 ? i : now.getUTCDay();
  } catch {
    return now.getUTCDay();
  }
}

/** How many days since the user's most recent injection day (0 = today is
 *  injection day, 1 = the day after, … up to 6). Null when no injection day set. */
export function daysSinceInjection(injectionDay: string | null | undefined, localDow: number): number | null {
  if (!injectionDay) return null;
  const target = DAYS.findIndex((d) => d.toLowerCase() === injectionDay.toLowerCase());
  if (target < 0) return null;
  return (localDow - target + 7) % 7;
}

// ── Pattern analysis (the IP) ─────────────────────────────────────────────────

export interface SymptomEpisode {
  symptom: string;
  days_since_injection: number | null;
  dose_mg: number | null;
  remedy_helped: string | null;
  created_at: Date | string;
}

export interface SymptomPattern {
  symptom: string;
  /** How many prior episodes of this symptom we've seen (excludes the current one). */
  count: number;
  /** Human timing relative to the shot, when a clear one exists: "the day after
   *  your shot", "on injection day", "a couple days after your shot", else null. */
  typicalTiming: string | null;
  /** The remedy that helped most often, if any. */
  topRemedy: string | null;
}

function timingPhrase(daysSince: number): string {
  if (daysSince === 0) return 'on injection day';
  if (daysSince === 1) return 'the day after your shot';
  if (daysSince === 2) return 'a couple days after your shot';
  return `a few days after your shot`;
}

/**
 * Analyze the user's PRIOR episodes of a symptom into a personal pattern. Needs
 * at least one prior episode to say anything; the timing claim needs a clear
 * mode (the same day-since-injection appearing in most episodes) so Grace never
 * over-claims a pattern from noise.
 */
export function analyzeSymptomPattern(symptom: string, priorEpisodes: SymptomEpisode[]): SymptomPattern | null {
  const eps = priorEpisodes.filter((e) => e.symptom === symptom);
  if (eps.length === 0) return null;

  // Typical timing: the most common days_since_injection, but only when it's a
  // real majority (>= half of the timed episodes and at least 2 occurrences).
  const timed = eps.map((e) => e.days_since_injection).filter((d): d is number => d != null);
  let typicalTiming: string | null = null;
  if (timed.length >= 2) {
    const counts = new Map<number, number>();
    for (const d of timed) counts.set(d, (counts.get(d) ?? 0) + 1);
    let bestDay = -1;
    let bestCount = 0;
    for (const [d, c] of counts) if (c > bestCount) { bestDay = d; bestCount = c; }
    if (bestCount >= 2 && bestCount >= timed.length / 2) typicalTiming = timingPhrase(bestDay);
  }

  // Top remedy: the most frequent non-null remedy_helped.
  const remedyCounts = new Map<string, number>();
  for (const e of eps) {
    if (e.remedy_helped) remedyCounts.set(e.remedy_helped, (remedyCounts.get(e.remedy_helped) ?? 0) + 1);
  }
  let topRemedy: string | null = null;
  let topRemedyCount = 0;
  for (const [r, c] of remedyCounts) if (c > topRemedyCount) { topRemedy = r; topRemedyCount = c; }

  return { symptom, count: eps.length, typicalTiming, topRemedy };
}

// ── Note builders (fed to Gemini so it phrases the recall warmly) ─────────────

/**
 * The reactive recall note: when a symptom recurs and we've seen it before, tell
 * Gemini to weave in the PERSONAL pattern so the reply feels like Grace knows
 * this body. Only asserts what we actually have (timing and/or remedy); never
 * invents. Returns null when there's nothing personal worth recalling.
 */
export function buildSymptomRecallNote(pattern: SymptomPattern | null): string | null {
  if (!pattern) return null;
  const bits: string[] = [];
  if (pattern.typicalTiming) bits.push(`for this user, ${pattern.symptom} usually hits ${pattern.typicalTiming}`);
  if (pattern.topRemedy) bits.push(`last time, ${pattern.topRemedy} helped settle it`);
  if (bits.length === 0) {
    if (pattern.count >= 2) {
      return `\n\n[SYMPTOM MEMORY — you've noticed this user gets ${pattern.symptom} a few times before. Acknowledge you remember it's come up for them, warmly, without inventing a timing or remedy you don't have.]`;
    }
    return null;
  }
  return `\n\n[SYMPTOM MEMORY — recall this PERSONAL pattern naturally (only if it fits, never as a list): ${bits.join('; ')}. Weave it in warmly so it feels like you remember how their body handles this — e.g. offer what worked before. These are real facts from their own history; do NOT invent other numbers or remedies, and still give safe, gentle guidance + when to call their doctor if it's severe.]`;
}

/**
 * The proactive injection-day note (for the scheduler's injection message): if
 * the user has a clear symptom pattern tied to the shot, gently give them a
 * heads-up + what helped before. Returns null when there's no confident pattern
 * to warn about (we never manufacture worry).
 */
export function buildInjectionDaySymptomNote(patterns: SymptomPattern[]): string | null {
  const withTiming = patterns.filter((p) => p.typicalTiming && p.count >= 2);
  if (withTiming.length === 0) return null;
  const p = withTiming.sort((a, b) => b.count - a.count)[0]!;
  const remedy = p.topRemedy ? ` ${p.topRemedy} helped last time` : '';
  return `\n\n[INJECTION-DAY HEADS-UP — this user tends to get ${p.symptom} ${p.typicalTiming}.${remedy ? ` What helped before:${remedy}.` : ''} Gently work a personal heads-up into the message (not alarming) so they can get ahead of it — never invent a symptom or remedy beyond this.]`;
}
