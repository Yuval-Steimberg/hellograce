/**
 * Normalize Unicode smart punctuation that iOS / Android keyboards auto-insert
 * into the straight-ASCII equivalents used by our regex matchers.
 *
 * Production failure 2026-06-05: user typed "What's my week number" on iPhone.
 * iOS converted the straight apostrophe (U+0027) to curly U+2019 → the
 * query-fast WEEK_NUMBER_RE used a literal U+0027 → no match → message
 * fell through to the full LLM pipeline → guards rejected the output →
 * safe-fallback shipped ("Give me a moment to get that right for you.").
 *
 * The fix has to live at every matcher entry point. We do NOT mutate the text
 * that gets stored, sent to Gemini, or echoed to the user — Gemini handles
 * curly quotes fine and the DB should preserve what the user actually typed.
 * This is matching-only normalization.
 */
export function normalizeUserText(text: string): string {
  return text
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/[  -​]/g, ' ');
}
