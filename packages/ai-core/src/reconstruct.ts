/**
 * Deterministic follow-up intent reconstruction.
 *
 * Short context-dependent fragments ("on glp?", "why 12?", "for women?") are
 * meaningless on their own — classified and routed on the fragment alone they
 * misfire. Production failure (2026-06-11 WhatsApp): "is hair loss common?"
 * then "on glp?" → the second message matched the GLP keyword and returned the
 * generic GLP-1 *mechanism* answer instead of "is hair loss common on GLP-1?".
 *
 * This module merges a fragment with the prior turn into a standalone meaning,
 * deterministically (no LLM call — fast, and works during a quota outage). The
 * caller uses the result to (a) route on the reconstructed question and (b)
 * give Gemini an explicit "what they actually mean" hint.
 *
 * High-precision by design: anything that isn't an unambiguous dependent
 * fragment returns kind:'none' so normal messages pass through untouched.
 */

export interface ReconstructResult {
  /** For 'continuation': the merged standalone question (use for routing +
   *  prompt hint). For 'reasoning': a prompt hint referencing the prior reply
   *  (do NOT route on it). For 'none': the original text unchanged. */
  reconstructed: string;
  isFollowUp: boolean;
  kind: 'continuation' | 'reasoning' | 'none';
}

export interface ReconstructContext {
  previousUserMessage?: string | null;
  lastAssistantMessage?: string | null;
}

const NONE = (text: string): ReconstructResult => ({ reconstructed: text, isFollowUp: false, kind: 'none' });

// A bare prepositional / qualifier fragment that only makes sense appended to a
// prior question: "on glp", "for women", "with food", "in men", "about that".
const CONTINUATION_RE =
  /^(?:and\s+|but\s+|or\s+|ok\s+|so\s+)?(on|for|with|in|about|regarding)\s+(.{1,40})$/i;

// A reasoning fragment that asks about the PRIOR reply: "why", "why 12",
// "how come", "how so". Optional leading filler / trailing number.
const REASONING_RE =
  /^(?:and\s+|but\s+|so\s+|ok\s+|wait\s+)?(why|how come|how so|why is that|why'?s that)(?:\s+\d+)?\s*\??$/i;

// The previous user message must read like a question for a continuation
// splice to be safe.
function isQuestionLike(s: string): boolean {
  const t = s.trim();
  if (t.length === 0) return false;
  return (
    /\?\s*$/.test(t) ||
    /^(is|are|am|was|were|do|does|did|can|could|should|would|will|how|what|why|when|where|which|who|has|have)\b/i.test(t)
  );
}

function stripTrailingPunct(s: string): string {
  return s.trim().replace(/[?.!,\s]+$/, '');
}

/**
 * Reconstruct a short follow-up fragment into a standalone meaning.
 * Returns kind:'none' for anything that isn't an unambiguous dependent
 * fragment, so the caller falls back to the verbatim message.
 */
export function reconstructFollowUp(current: string, ctx: ReconstructContext): ReconstructResult {
  const text = current.trim();
  // Gate: only short fragments. Long messages are self-contained.
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  if (text.length === 0 || text.length > 40 || wordCount > 7) return NONE(current);

  const prevUser = (ctx.previousUserMessage ?? '').trim();
  const lastAssistant = (ctx.lastAssistantMessage ?? '').trim();

  // ── Continuation: splice the qualifier onto the previous user question ──
  const cont = CONTINUATION_RE.exec(text);
  if (cont && prevUser && isQuestionLike(prevUser)) {
    const qualifier = `${cont[1]!.toLowerCase()} ${cont[2]!.trim().replace(/[?.!]+$/, '')}`.trim();
    const base = stripTrailingPunct(prevUser);
    // Avoid duplicating a qualifier already present in the base.
    if (base.toLowerCase().includes(qualifier.toLowerCase())) return NONE(current);
    return {
      reconstructed: `${base} ${qualifier}?`,
      isFollowUp: true,
      kind: 'continuation',
    };
  }

  // ── Reasoning: the user is asking WHY the prior reply said what it said ──
  if (REASONING_RE.test(text) && lastAssistant) {
    const priorClaim = lastAssistant.length > 160 ? `${lastAssistant.slice(0, 160).trim()}…` : lastAssistant;
    return {
      reconstructed: `The user is asking why your previous reply said: "${priorClaim}". Explain the reasoning behind that specific point.`,
      isFollowUp: true,
      kind: 'reasoning',
    };
  }

  return NONE(current);
}
