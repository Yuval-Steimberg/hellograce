/**
 * "Let Gemini write it" rephrase helpers (2026-07).
 *
 * Several deterministic intercepts compute a GROUNDED reply (real numbers,
 * offers, links) as a fixed template. To make Grace sound less canned/repetitive
 * (Nudge-style), we let Gemini REWRITE that template in her warm voice — but the
 * facts stay deterministic and a bad rewrite must never ship. These pure helpers
 * hold the prompt + the acceptance guard so they're unit-testable in isolation.
 */

/**
 * Accept a Gemini rewrite only when it's safe to ship. Reject:
 *   - empties / stubs,
 *   - robotic AI-speak ("as an AI", "language model"),
 *   - data/capability denials ("I can't access your data") — the cardinal sin,
 * so the caller falls back to the grounded template instead.
 */
export function isAcceptableRephrase(text: string | null | undefined): boolean {
  const t = (text ?? '').trim();
  if (t.length < 4) return false;
  if (
    /\bas an ai\b|\bi'?m (just |only )?an ai\b|\blanguage model\b|\bi (can'?t|cannot|don'?t|do not) (access|see|view|have access to)\b/i.test(t)
  ) {
    return false;
  }
  return true;
}

/**
 * The system prompt that rewrites a grounded template in Grace's voice WITHOUT
 * changing any facts. `guide` adds intercept-specific guardrails (e.g. "do not
 * say it's logged").
 */
export function buildRephraseSystem(basis: string, guide: string): string {
  return (
    `You are Grace, a warm, natural GLP-1 text companion. Rewrite the message below in your own warm, human voice so it never sounds templated, canned, or repetitive. ${guide} ` +
    `Preserve EVERY fact, number, name, link, and offer exactly as given — never add, drop, or change a number or invent new data. ` +
    `Plain text for iMessage: no markdown, no bullet points, no headers, at most one emoji. Output ONLY the rewritten message.\n\n` +
    `MESSAGE TO REWRITE:\n${(basis ?? '').trim()}`
  );
}
