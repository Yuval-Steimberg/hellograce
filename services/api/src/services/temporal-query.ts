/**
 * Deterministic answers for factual time questions (2026-07-07).
 *
 * "What is my local time?" and "when does my diary/day reset?" are FACTS Grace
 * knows — the user's timezone is in the profile and the local clock is computed
 * from it. Prod (IMG_6720/6721): the LLM hedged ("I don't have direct access to
 * your device's clock") AND gave the wrong time (New York, not the user's actual
 * zone) because the answer was a free-form guess. These must be answered from the
 * temporal context, never the model. The timezone itself is corrected from the
 * phone number in UserService.ensureUser, so the value here is the real one.
 */
import { resolveTemporalContext } from './temporal-context.js';

export type TemporalQuery = 'local_time' | 'day_reset' | null;

// "what time is it" is the wall-clock question — but NOT "what time is it best/
// good/ideal to inject / to take my pill / to eat" (timing guidance, answered by
// the grounded path), so a negative lookahead excludes those.
const LOCAL_TIME_RE =
  /\b(?:what(?:'?s| is)?\s+(?:my|the)\s+(?:local|current)?\s*time|what\s+time\s+is\s+it(?!\s+(?:best|good|ideal|better|to|should)\b)|my\s+(?:local|current)\s+time|current\s+time\s+(?:for\s+me|here|where\s+i\s+am))\b/i;
// A QUESTION about when the day/diary/totals reset (not the "reset my food log"
// command — that's a mutation handled elsewhere; this requires when/what-time).
const DAY_RESET_RE =
  /\b(?:when|what\s+time)\b[^?]*\b(?:diary|day|log|totals?|counts?|tracking)\b[^?]*\breset|\b(?:when|what\s+time)\b[^?]*\breset[^?]*\b(?:diary|day|log|totals?|counts?)\b/i;

export function detectTemporalQuery(text: string): TemporalQuery {
  const t = (text ?? '').trim();
  if (!t || t.length > 120) return null;
  if (DAY_RESET_RE.test(t)) return 'day_reset';
  if (LOCAL_TIME_RE.test(t)) return 'local_time';
  return null;
}

/** Readable zone label from an IANA id: "Asia/Jerusalem" → "Jerusalem". */
export function friendlyZone(timezone: string | null | undefined): string {
  if (!timezone) return 'your local time';
  const city = timezone.split('/').pop() ?? timezone;
  return `${city.replace(/_/g, ' ')} time`;
}

export function buildLocalTimeReply(timezone: string | null | undefined, now: Date = new Date()): string {
  const t = resolveTemporalContext(timezone, now);
  return `It's ${t.time12} where you are right now (${friendlyZone(timezone)}), ${t.weekday}.`;
}

export function buildDayResetReply(timezone: string | null | undefined, now: Date = new Date()): string {
  const t = resolveTemporalContext(timezone, now);
  return `Your day resets at midnight your local time (${friendlyZone(timezone)}) — at 12:00 AM your protein and calorie totals start fresh. It's ${t.time12} for you now.`;
}
