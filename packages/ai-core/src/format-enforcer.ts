/**
 * Deterministic post-generation format auto-fix.
 *
 * Gemini Flash routinely violates "no markdown / no em dash / no numbered list"
 * rules even when they are stated explicitly at the top of a 71k-char system
 * prompt. This module strips the violations after generation so the user never
 * sees them, regardless of LLM compliance.
 *
 * Auto-fixes are SILENT — they never trigger a regen. They are safe textual
 * transforms (replace em dash with comma, strip "**" around bold text, flatten
 * numbered lists into prose).
 *
 * The list of fixes applied is returned alongside the cleaned text so the
 * caller can log telemetry on what's still slipping through the prompt.
 */

export interface FormatEnforcementResult {
  text: string;
  fixes: string[];
}

export function enforceFormat(input: string, opts?: { stripFirstName?: string }): FormatEnforcementResult {
  let text = input;
  const fixes: string[] = [];

  // ─── Em dash (—) and en dash (–) → comma ───────────────────────────────
  // Used as punctuation only. We collapse surrounding whitespace so we
  // don't leave "word , word" with a leading space.
  if (/[—–]/.test(text)) {
    text = text.replace(/\s*[—–]\s*/g, ', ');
    fixes.push('em_dash_replaced');
  }

  // ─── Double dash (--) → comma ──────────────────────────────────────────
  if (/--+/.test(text)) {
    text = text.replace(/\s*--+\s*/g, ', ');
    fixes.push('double_dash_replaced');
  }

  // ─── " - " used as dash (single hyphen with spaces) → comma ────────────
  // Be conservative: only when surrounded by spaces on a single line. Using
  // [ \t]+ (not \s+) is critical — \s+ would span newlines and eat bullet
  // list separators ("text\n- bullet" → "text, bullet"), corrupting the
  // bullet-list rule below.
  if (/\S[ \t]+-[ \t]+\S/.test(text)) {
    text = text.replace(/(\S)[ \t]+-[ \t]+(\S)/g, '$1, $2');
    fixes.push('hyphen_dash_replaced');
  }

  // ─── Markdown bold (**text**) and italic (*text*, _text_) → plain ──────
  if (/\*\*[^*\n]+\*\*/.test(text)) {
    text = text.replace(/\*\*([^*\n]+)\*\*/g, '$1');
    fixes.push('markdown_bold_stripped');
  }
  // Single-asterisk italic: only when paired and not at line-start (line-start
  // asterisks are bullet lists, handled below).
  if (/(?<!\*)\*[^*\n]+\*(?!\*)/.test(text)) {
    text = text.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '$1');
    fixes.push('markdown_italic_stripped');
  }
  // Underscore italic
  if (/(?<![\w_])_([^_\n]+)_(?![\w_])/.test(text)) {
    text = text.replace(/(?<![\w_])_([^_\n]+)_(?![\w_])/g, '$1');
    fixes.push('markdown_underscore_stripped');
  }

  // ─── Markdown headers (# foo, ## foo) → strip prefix ───────────────────
  if (/^#{1,6}\s+/m.test(text)) {
    text = text.replace(/^#{1,6}\s+/gm, '');
    fixes.push('markdown_header_stripped');
  }

  // ─── Numbered lists (1. foo\n2. bar\n3. baz) → comma-joined sentence ──
  // Only collapse when there are 2+ items in a row — single "1. " might be
  // an ordinal in normal prose.
  const numberedListRegex = /(?:^|\n)\s*\d+\.\s+([^\n]+)(?:\n\s*\d+\.\s+[^\n]+)+/g;
  if (numberedListRegex.test(text)) {
    text = text.replace(numberedListRegex, (match) => {
      const items = match
        .split(/\n/)
        .map((line) => line.replace(/^\s*\d+\.\s+/, '').trim())
        .filter(Boolean);
      return '\n' + flattenList(items);
    });
    fixes.push('numbered_list_flattened');
  }

  // ─── Bulleted lists (- foo\n- bar or * foo\n* bar) → comma-joined ──────
  const bulletListRegex = /(?:^|\n)\s*[-*]\s+([^\n]+)(?:\n\s*[-*]\s+[^\n]+)+/g;
  if (bulletListRegex.test(text)) {
    text = text.replace(bulletListRegex, (match) => {
      const items = match
        .split(/\n/)
        .map((line) => line.replace(/^\s*[-*]\s+/, '').trim())
        .filter(Boolean);
      return '\n' + flattenList(items);
    });
    fixes.push('bullet_list_flattened');
  }

  // ─── Greeting exclamation ("Good morning!" → "Good morning.") ──────────
  // The prompt forbids "!" on greetings. Auto-strip the offender.
  const greetingPattern = /^(Good morning|Good afternoon|Good evening|Good night|Morning|Afternoon|Evening|Hi|Hello|Hey)([,\s]+[A-Z][a-zA-Z]*)?!/m;
  if (greetingPattern.test(text)) {
    text = text.replace(greetingPattern, (m) => m.slice(0, -1) + '.');
    fixes.push('greeting_exclamation_stripped');
  }

  // ─── "[link]" placeholder → real settings URL ──────────────────────────
  // Cheap auto-fix saves a regen for the most common variants.
  if (/\[(link|settings link|url|here)\]/i.test(text)) {
    text = text.replace(/\[(link|settings link|url|here)\]/gi, 'https://graceglp.com/settings');
    fixes.push('link_placeholder_replaced');
  }
  if (/<link>/i.test(text)) {
    text = text.replace(/<link>/gi, 'https://graceglp.com/settings');
    fixes.push('link_angle_placeholder_replaced');
  }

  // ─── User's first name (if not first message + name provided) ──────────
  // The system prompt has a "NAME USAGE — ZERO TOLERANCE" rule but Gemini
  // still injects names in ~20% of responses. Strip every occurrence except
  // when the user explicitly said "Grace" in their message (we can't know
  // that here; the caller decides whether to pass stripFirstName).
  if (opts?.stripFirstName) {
    const name = opts.stripFirstName.trim();
    if (name.length >= 2) {
      // Patterns: "Got it, Name." / "Hi Name" / "Sure thing, Name!" /
      // "Name, that sounds…". Match Name surrounded by punctuation or
      // word boundaries.
      const namePattern = new RegExp(
        `(\\s*,\\s*${escapeRegex(name)}\\b|\\b${escapeRegex(name)}\\s*,\\s*|\\b${escapeRegex(name)}\\b)`,
        'gi',
      );
      if (namePattern.test(text)) {
        text = text.replace(namePattern, () => '');
        // Clean double spaces and orphaned punctuation left behind
        text = text
          .replace(/  +/g, ' ')
          .replace(/\s+([,.!?])/g, '$1')
          // Strip leading commas/spaces left by ", Name" → ""
          .replace(/^[\s,]+/g, '')
          // Strip leading commas mid-paragraph too (after . ! ?)
          .replace(/([.!?])\s*[,\s]+/g, '$1 ');
        // Recapitalize sentence starts (the next word after stripping a
        // leading "Name, " was lowercase in the original).
        text = text.replace(/(^|[.!?]\s+)([a-z])/g, (_, prefix, ch: string) =>
          prefix + ch.toUpperCase(),
        );
        fixes.push('user_name_stripped');
      }
    }
  }

  // ─── Hard length cap (WhatsApp readability) ─────────────────────────
  // Responses over 600 characters are walls of text on mobile. Truncate at
  // the last sentence ending (. ! ?) that fits within the limit. If the
  // entire response is under the limit, this is a no-op.
  const MAX_CHARS = 600;
  if (text.length > MAX_CHARS) {
    const window = text.slice(0, MAX_CHARS + 1);
    // Regex lookahead matches . ! ? followed by whitespace OR end-of-string,
    // so we never miss a sentence that ends right at the window boundary.
    let lastEnd = -1;
    const sentenceRe = /[.!?](?=\s|$)/g;
    let m: RegExpExecArray | null;
    while ((m = sentenceRe.exec(window)) !== null) {
      lastEnd = m.index + 1; // position just after the punctuation char
    }
    if (lastEnd > MAX_CHARS / 2) {
      text = text.slice(0, lastEnd).trim();
      fixes.push('length_capped');
    }
  }

  // ─── ".,"-style double punctuation (period immediately followed by comma) ─
  // Produced when a list item ending in "." is joined with ", ". Replace with
  // just ", " (stripping the period).
  if (/\.,/.test(text)) {
    text = text.replace(/\.\s*,\s*/g, ', ');
    fixes.push('dot_comma_fixed');
  }

  // ─── Final whitespace cleanup ─────────────────────────────────────────
  // Drop leading/trailing whitespace per line, collapse 3+ blank lines.
  text = text
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { text, fixes };
}

function flattenList(items: string[]): string {
  // Strip trailing sentence punctuation so "item., next" doesn't happen
  const clean = items.map((s) => s.replace(/[.!?]+$/, '').trim());
  if (clean.length === 0) return '';
  if (clean.length === 1) return clean[0]!;
  if (clean.length === 2) return `${clean[0]} and ${clean[1]}`;
  const head = clean.slice(0, -1).join(', ');
  return `${head}, and ${clean[clean.length - 1]}`;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
