/**
 * Recommendation-conversation context helpers (2026-06-14).
 *
 * Audit finding: the "recommend → ack → recipe → alternatives → 'how much
 * protein was in that?'" flow broke in several places — a bland ack after a
 * recommendation got a canned fast-path reply, the topic-closer strip then
 * erased the recommendation from history, and follow-ups like "recipe?" /
 * "any other ideas?" / "that suggestion" never had the recommended dish
 * re-injected. These deterministic detectors fix the routing so a
 * recommendation can evolve into a full contextual conversation.
 *
 * All pure string functions — no deps, no I/O. Easy to unit-test.
 */

import type { ChatTurn } from '@grace/shared';

/**
 * Does this assistant message look like a RECOMMENDATION (food / exercise /
 * wellness)? Used to (a) skip the canned fast-path ack so an "okay"/"yes"
 * after a recommendation advances the thread, and (b) locate the dish/idea to
 * re-inject on a follow-up. Keyword heuristic — these words rarely appear in a
 * non-recommendation Grace turn.
 */
const RECOMMENDATION_MARKER_RE =
  /\b(recommend|suggest(?:ion)?|option|idea|you could (?:try|have|go|do|add|swap)|how about|consider|i'?d (?:go|suggest|recommend|try)|try (?:the|a|some|adding)|a few (?:options|ideas|things)|some (?:options|ideas)|good (?:pick|choice)|great (?:pick|choice|option)|here are|here'?s a few|works well|sits well|go for)\b/i;

export function looksLikeRecommendation(text: string | null | undefined): boolean {
  if (!text) return false;
  const t = text.trim();
  if (t.length < 8) return false;
  if (RECOMMENDATION_MARKER_RE.test(t)) return true;
  // A comma-separated list of 3+ short noun phrases also reads as a set of
  // suggestions ("Greek yogurt, cottage cheese, eggs, edamame.").
  const commaItems = t.split(',').map((s) => s.trim()).filter(Boolean);
  if (commaItems.length >= 3 && commaItems.every((s) => s.split(/\s+/).length <= 4)) return true;
  return false;
}

/**
 * Is the user's message a follow-up that depends on a PRIOR recommendation —
 * a recipe/prep request, an ask for alternatives/more, a portion/macro question
 * about "that", or a bare back-reference ("the first one", "that suggestion")?
 * When true we must (1) NOT strip the recommendation out of history as a
 * topic-closer, and (2) re-inject the prior recommendation into context.
 */
const RECIPE_REQUEST_RE =
  /\b(recipe|how (?:do|would|should|can) (?:i|you) (?:make|cook|prepare|prep)|how to (?:make|cook|prepare)|how'?s it made|make it|cook it|prepare it|preparation|cooking (?:method|instructions?)|instructions?|ingredients?|what(?:'?s| is) in (?:it|that)|how do i prep)\b/i;

const ALTERNATIVES_REQUEST_RE =
  /\b(any (?:other|more) (?:ideas?|options?|suggestions?)|other (?:ideas?|options?)|something else|anything else|alternatives?|what else|more options?|different (?:idea|option|one)|not (?:a fan|feeling) (?:of )?that|don'?t like that)\b/i;

const BACK_REFERENCE_RE =
  /\b(that (?:one|suggestion|meal|idea|option|recipe|dish|recommendation|workout|exercise)|the (?:first|second|third|last|other) one|those|it|them)\b/i;

const DETAILS_REQUEST_RE =
  /\b(tell me more|more (?:about|on) (?:it|that)|how (?:much|many) (?:protein|calories?|carbs?|fat)|what(?:'?s| is) the (?:protein|calorie|macro)|sounds good,? (?:what|how)|go on|expand)\b/i;

export function isRecipeRequest(text: string): boolean {
  return RECIPE_REQUEST_RE.test(text);
}

export function isRecommendationFollowUp(text: string): boolean {
  const t = text.trim();
  if (t.length === 0) return false;
  return (
    RECIPE_REQUEST_RE.test(t) ||
    ALTERNATIVES_REQUEST_RE.test(t) ||
    DETAILS_REQUEST_RE.test(t) ||
    // A bare back-reference only counts as a rec follow-up when short (a
    // pronoun-y fragment), so we don't misread a long unrelated sentence that
    // happens to contain "it"/"that".
    (BACK_REFERENCE_RE.test(t) && t.split(/\s+/).length <= 8)
  );
}

/**
 * Find the most recent assistant turn that reads like a recommendation, so it
 * can be re-injected as context on a follow-up. Searches newest→oldest.
 */
export function extractLastRecommendation(history: ChatTurn[]): string | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const turn = history[i]!;
    if (turn.role === 'assistant' && looksLikeRecommendation(turn.content)) {
      return turn.content.trim();
    }
  }
  return null;
}

/**
 * When the user acks a recommendation ("sounds good" / "okay" / "yes"), give a
 * deterministic reply that ADVANCES the thread (offer the recipe or more ideas)
 * instead of the LLM's generic "Happy to help." Rotated by a stable seed so the
 * same user doesn't see the identical line twice in a row.
 */
const ACK_ADVANCE_REPLIES: readonly string[] = [
  'Glad those sound good. Want the recipe for one, or a few other ideas?',
  'Nice. I can walk you through how to make one, or suggest a couple more, whichever helps.',
  'Good pick. Want a quick recipe, or some other options?',
];
export function buildRecommendationAckAdvance(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  return ACK_ADVANCE_REPLIES[Math.abs(h) % ACK_ADVANCE_REPLIES.length]!;
}
