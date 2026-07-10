/**
 * iMessage tapback / reaction detection.
 *
 * When a user taps a reaction (Love, Like, Dislike, Laugh, Emphasize, Question)
 * on a message, iMessage relays (Sendblue / LoopMessage / the SMS fallback)
 * deliver it as a literal TEXT string like `Liked "the original message"`. Those
 * are NOT conversational content — replying to them wastes turns and muddles the
 * thread (prod audit 2026-07: several "Liked …" tapbacks were processed as real
 * messages and got full replies).
 *
 * The patterns match ONLY the exact tapback grammar — a reaction phrase followed
 * by the QUOTED original message — so an ordinary sentence that merely starts
 * with "Loved"/"Liked" (e.g. `Loved the eggs, what's for dinner?`) is NOT
 * filtered: it has no wrapping quotes around a quoted original. Single-line only.
 */

// Straight (") and curly (“ ”) quotes — Apple wraps the quoted message in smart
// quotes; some relays downgrade to straight ASCII quotes.
const Q = '[“”"]';

const REACTION_RES: readonly RegExp[] = [
  // Loved / Liked / Disliked / Laughed at / Emphasized / Questioned "original"
  new RegExp(`^\\s*(?:loved|liked|disliked|laughed at|emphasized|questioned)\\s+${Q}.*${Q}\\s*$`, 'i'),
  // Removed a heart / like / laugh / exclamation / question mark / thumbs down from "original"
  new RegExp(`^\\s*removed (?:a|an) .+? from\\s+${Q}.*${Q}\\s*$`, 'i'),
  // Reacted 👍 / <emoji> / <text> to "original"  (Android relay / newer iOS)
  new RegExp(`^\\s*reacted\\s+.+?\\s+to\\s+${Q}.*${Q}\\s*$`, 'i'),
];

/** True when the text is an iMessage tapback reaction relayed as plain text. */
export function isTapbackReaction(text: string | null | undefined): boolean {
  const t = (text ?? '').trim();
  if (!t) return false;
  // Reactions are single-line; a multi-line message is genuine content.
  if (/[\r\n]/.test(t)) return false;
  return REACTION_RES.some((re) => re.test(t));
}
