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

export type MessageContext =
  | 'food_log'
  | 'food_question'
  | 'weight_log'
  | 'mood_log'
  | 'greeting'
  | 'emotional'
  | 'scheduling'
  | 'knowledge'
  | 'gibberish'
  | 'general';

// ─── Runtime-context dump openers ──────────────────────────────────────────
// Grace's system prompt has runtime context (today's protein, weight, mood).
// She sometimes opens with this data even when the user didn't ask about it.
// These patterns catch the most common dumps; we strip the first sentence
// when the user's message type doesn't justify it.
const FOOD_CONTEXT_OPENERS: RegExp[] = [
  /^You'?ve had \d+\s*g (of )?protein[^.!?]*[.!?]\s*/i,
  /^You'?re at \d+\s*g (of )?protein[^.!?]*[.!?]\s*/i,
  /^You'?ve had \d+(\.\d+)?\s*(calories|kcal)[^.!?]*[.!?]\s*/i,
  /^You'?ve logged \d+\s*g[^.!?]*[.!?]\s*/i,
  /^Today you'?ve had[^.!?]*[.!?]\s*/i,
  /^So far today[^.!?]*\d+\s*g[^.!?]*[.!?]\s*/i,
  /^Your (current )?protein (intake|total) is[^.!?]*[.!?]\s*/i,
];

const WEIGHT_CONTEXT_OPENERS: RegExp[] = [
  /^Your (current )?weight is \d+[^.!?]*[.!?]\s*/i,
  /^You'?re (currently )?at \d+\s*(lbs?|pounds?|kg)[^.!?]*[.!?]\s*/i,
  /^You'?ve lost \d+(\.\d+)?\s*(lbs?|pounds?|kg)[^.!?]*[.!?]\s*/i,
];

const MOOD_CONTEXT_OPENERS: RegExp[] = [
  /^Your mood (score|today) (is|was) \d+[^.!?]*[.!?]\s*/i,
];

// Generic AI-speak / filler openers that add no value
const FILLER_OPENERS: RegExp[] = [
  /^I (totally |completely |really |truly |fully )?understand (your concern|how you feel|what you'?re saying)[,.!]?\s*/i,
  /^Thanks (so much |very much )?for sharing (that|this)( with me)?[,.!]?\s*/i,
  /^As (an AI|a language model|an assistant)[,.!]?\s*[^.!?]*[.!?]\s*/i,
  /^Let me (start by|begin by) saying[,.!]?\s*/i,
];

// Map: each context type allows these specific runtime-data openers.
// Everything else gets stripped.
const ALLOWED_OPENERS_BY_CONTEXT: Record<MessageContext, RegExp[][]> = {
  food_log: [FOOD_CONTEXT_OPENERS],
  food_question: [FOOD_CONTEXT_OPENERS],
  weight_log: [WEIGHT_CONTEXT_OPENERS],
  mood_log: [MOOD_CONTEXT_OPENERS],
  greeting: [],
  emotional: [],
  scheduling: [],
  knowledge: [],
  gibberish: [],
  general: [],
};

const ALL_CONTEXT_OPENERS: RegExp[] = [
  ...FOOD_CONTEXT_OPENERS,
  ...WEIGHT_CONTEXT_OPENERS,
  ...MOOD_CONTEXT_OPENERS,
];

export function enforceFormat(
  input: string,
  opts?: { stripFirstName?: string; messageContext?: MessageContext; lastAssistantMessage?: string },
): FormatEnforcementResult {
  let text = input;
  const fixes: string[] = [];

  // ─── Duplicate previous-message prefix strip ────────────────────────────
  // Gemini Flash sometimes "continues" the previous assistant turn instead of
  // starting a fresh reply. The result is that the new response begins by
  // copy-pasting the entire last Grace message and then appends the new answer
  // as a final sentence. Detect the overlap and strip the repeated prefix.
  if (opts?.lastAssistantMessage) {
    const prev = opts.lastAssistantMessage.trim();
    if (prev.length >= 40) {
      let overlap = 0;
      const minLen = Math.min(text.length, prev.length);
      while (overlap < minLen && text[overlap] === prev[overlap]) {
        overlap++;
      }
      if (overlap >= 40) {
        const remainder = text.slice(overlap).trim();
        if (remainder.length >= 20) {
          text = remainder.charAt(0).toUpperCase() + remainder.slice(1);
          fixes.push('duplicate_prev_message_stripped');
        }
      }
    }
  }

  // ─── Irrelevant context-dump opener strip ────────────────────────────────
  // Grace sometimes opens with runtime context ("You've had 15g protein
  // today...", "Your weight is...", "Your mood score was...") even when
  // the user asked about something totally different (muscle loss, side
  // effects, emotions, etc.). Strip the opener when it doesn't match the
  // question type. Universal rule — applies to every response.
  if (opts?.messageContext) {
    const allowedPatternBanks = ALLOWED_OPENERS_BY_CONTEXT[opts.messageContext] ?? [];
    const allowedPatterns = allowedPatternBanks.flat();
    for (const pattern of ALL_CONTEXT_OPENERS) {
      if (allowedPatterns.includes(pattern)) continue;
      if (pattern.test(text)) {
        const stripped = text.replace(pattern, '').trim();
        if (stripped.length > 30) {
          text = stripped;
          fixes.push('irrelevant_context_opener_stripped');
          break;
        }
      }
    }
  }

  // ─── Generic AI-filler opener strip (universal — every response) ─────────
  // "I understand your concern..." / "Thanks for sharing..." / "As an AI..."
  // These are corporate-AI tells that add no value. Strip them unconditionally.
  for (const pattern of FILLER_OPENERS) {
    if (pattern.test(text)) {
      const stripped = text.replace(pattern, '').trim();
      if (stripped.length > 30) {
        // Capitalize the new first letter
        text = stripped.charAt(0).toUpperCase() + stripped.slice(1);
        fixes.push('filler_opener_stripped');
        break;
      }
    }
  }

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

  // ─── Collapse multi-paragraph responses into a single paragraph ──────
  // Gemini sometimes emits multi-paragraph responses with double newlines.
  // On WhatsApp, paragraph breaks look like separate messages and encourage
  // wall-of-text reading. Collapse them to a single space (one paragraph).
  if (/\n{2,}/.test(text)) {
    text = text.replace(/\n{2,}/g, ' ').replace(/\n/g, ' ').replace(/ {2,}/g, ' ').trim();
    fixes.push('paragraphs_collapsed');
  }

  // ─── Hard length cap (WhatsApp readability) ─────────────────────────
  // Per-context limits are stricter than the universal 420-char fallback.
  // Responses over the cap are truncated at the last sentence boundary
  // that fits. If the response is already under the limit this is a no-op.
  const CONTEXT_MAX: Record<MessageContext, number> = {
    greeting:      160,  // one warm sentence
    emotional:     260,  // 2 sentences of warmth, no unsolicited tips
    mood_log:      220,  // acknowledge the score + one warm observation
    weight_log:    240,  // confirm the log + brief reaction
    food_log:      480,  // protein number + daily total + optional brief tip
    food_question: 420,  // 3-4 food options with brief reasoning
    scheduling:    220,  // confirm the change and done
    knowledge:     600,  // educational answers need room for facts + user tie-in
    gibberish:     160,  // short clarifying question
    general:       500,  // default cap — enough for a real answer
  };
  const MAX_CHARS = opts?.messageContext ? (CONTEXT_MAX[opts.messageContext] ?? 420) : 420;
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
    if (lastEnd > MAX_CHARS / 3) {
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
