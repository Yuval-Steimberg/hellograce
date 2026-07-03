// Deterministic post-generation format auto-fix. Runs on every LLM response
// BEFORE content checks. Silent (never triggers regen) — just string transforms.
//
// Auto-fixes: em/en dashes → commas, markdown bold/italic/headers → plain text,
// numbered/bulleted lists → comma-joined prose, duplicate previous-message prefix
// removal, irrelevant context-dump opener stripping, AI-filler opener removal,
// user first-name stripping (NAME ZERO TOLERANCE), multi-paragraph collapse,
// per-context hard length caps, link placeholder → real URL, greeting "!" → ".".

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
  | 'appointment_prep'
  | 'gibberish'
  | 'general'
  // Phase 1 coverage expansion — keep in sync with MessageType in classify.ts
  | 'exercise_log'
  | 'injection_log'
  | 'medication_question'
  | 'social_situation'
  | 'pause_request';

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
  // 2026-06-03 production: "Ugh, " / "Sigh, " openers strip — the content
  // checker also flags these (regen) but stripping deterministically guards
  // against the case where regen also produces one.
  /^ugh[,.!\s—-]+/i,
  /^sigh[,.!\s—-]+/i,
  // 2026-06-03 production: "That's a great question!" + variants slipped past
  // the content checker via gemini-2.0-flash's higher filler rate. Strip
  // deterministically so the user NEVER sees them. Banned content rules
  // still log the violation for telemetry.
  /^(that'?s |what )?a great question[!.,]?\s*/i,
  /^(oh,?\s*)?(that'?s |what )?(such )?(a |an )?(great|excellent|fantastic|wonderful|amazing|brilliant|terrific|awesome|fabulous|insightful) (question|point|observation|thought)[!.,]?\s*/i,
  /^(absolutely|definitely|of course)[!.,]?\s+(yes|sure|i can|happy to)[,.!]?\s*/i,
  /^happy to (help|chat|share|talk about that)[,.!]?\s*/i,
  // 2026-06-03 production failure: "It's wonderful you're thinking about a
  // nourishing dinner!" — Grace praising the user for asking. Sycophantic,
  // patronizing, and adds zero value. Strip the entire "it's/that's/what an
  // X you're Y" prefix up to the first sentence terminator.
  /^(it'?s |that'?s |how )?(so |really |truly |absolutely )?(wonderful|lovely|amazing|fantastic|great|nice|beautiful|smart|thoughtful|mindful|brilliant|insightful|admirable) (?:that |to (?:see|hear|know) (?:that )?)?(you'?re|you (?:are|have))[^.!?]{0,80}[.!]?\s*/i,
  // "What an X choice / question / idea"
  /^what (?:a |an )(?:amazing|wonderful|great|excellent|smart|thoughtful|brilliant|fantastic|lovely|inspiring) (?:choice|question|idea|thought|approach|mindset)[!.,]?\s*/i,
  // "I love that you're..." / "Love that you're..." — same patronizing pattern
  /^(?:i )?love (?:that |how )(?:you'?re|you (?:are|have))[^.!?]{0,80}[.!]?\s*/i,
  // 2026-06-03 behavioral-guard catches these as principle violations forcing
  // a 3s regen. Strip deterministically:
  //   - "Congrats on / Congratulations on ..." (NO SYCOPHANTIC OPENERS)
  /^(?:congrats|congratulations)\b[^.!?]{0,80}[.!]?\s*/i,
  //   - "Wonderful / Lovely / Beautiful / Smart that you ..."
  /^(?:wonderful|lovely|beautiful|smart|thoughtful|nice|perfect|fantastic|amazing|excellent|brilliant) (?:that |to (?:hear|see|know))[^.!?]{0,80}[.!]?\s*/i,
  //   - "Yeah, " / "Sure, " / "Alright, " / "So, " preambles (NO PREAMBLE).
  //     Only the clear AI-tell openers; "Got it, " / "Okay, " / "Right, " /
  //     "Ok, " stay because they're legitimate brief acknowledgments Grace
  //     uses on log confirmations.
  /^(?:yeah|sure|alright|so)\s*[,—-]+\s*/i,
  //   - Generic fallback openers with clear context (NO GENERIC FALLBACKS)
  /^(?:i'?m here (?:and )?ready to help|how can i help (?:you )?today|what'?s on your mind|happy to (?:chat|help|assist))[!.,]?\s*/i,
  // "Of course! Yes," "Definitely! Sure," patterns
  /^(?:of course|definitely|absolutely)[!.,]?\s+(?:yes|sure|i can|happy to|i'?d be (?:happy|glad))[,.!]?\s*/i,
  // 2026-07-02 production: replies opened by NARRATING what Grace is about to
  // do instead of just doing it — meta-analysis / "let's break it down" /
  // "that sounds like a nice meal, let's…" preambles. Strip the whole preamble
  // so the reply starts at the actual answer. Applied on every outbound, so it
  // generalizes across intents (food estimate, knowledge, advice), not one case.
  //   "It looks like you're asking for a mix of advice and calculations. Let's break it down."
  /^it (?:looks|seems|sounds) like you'?re (?:asking|interested|looking|trying|wondering)[^.!?]*[.!?]\s*(?:let'?s [a-z]+[^.!?:]*[:.!?]\s*)?/i,
  //   "Let's break down / dive into / go over / unpack / tackle / discuss your questions…"
  /^(?:okay|ok|alright|sure|great)?[,.!]?\s*let'?s (?:break|dive|go|take|walk|unpack|tackle|discuss|explore|look|get)[^.!?:]{0,80}[:.!?]\s*/i,
  //   "That sounds like a delicious and nutritious meal." (sycophantic meal preamble)
  /^(?:that|this|it) (?:sounds|looks) (?:like )?(?:a |an )?(?:really |very |so |quite )?(?:delicious|tasty|great|nutritious|balanced|healthy|solid|lovely|wonderful|good|nice|yummy|hearty|light)[^.!?]{0,60}(?:meal|choice|dinner|lunch|breakfast|option|combo|plate)[!.,]?\s*/i,
  //   "Here's an analysis of your entries, categorizing them…"
  /^here'?s an analysis[^.!?:]*[:.!?]\s*/i,
  /^here'?s a (?:breakdown|summary|categorization|rundown) of your (?:entries|messages|questions|requests|meal|day)[^.!?:]*[:.!?]\s*/i,
  //   "here's a typical breakdown:" / "here's the breakdown:" (mid or lead)
  /^here'?s (?:a |the )?(?:typical |quick |rough )?(?:breakdown|rundown|estimate)[^.!?:]{0,40}:\s*/i,
  //   Leading GERUND HEADING with a colon — "Estimating Protein in Your Salmon
  //   Meal:", "Calculating Your Macros:", "Breaking Down Your Dinner:". A
  //   title-style label the reply should never open with; strip up to the colon.
  /^(?:estimating|calculating|breaking down|analyzing|understanding|assessing|reviewing|regarding|about) [A-Z][^:.!?]{3,55}:\s*/i,
  //   "This is a rough estimate as portion sizes vary, but here's a typical…" —
  //   the disclaimer-before-answer preamble (strip up to "but"/colon).
  /^this is (?:just )?a (?:rough|general|ballpark|quick) estimate[^.!?]*?(?:,\s*but\s*|:\s*)/i,
  //   Hedge-without-answer opener: "It's tough to give an exact number, but…"
  /^it'?s (?:tough|hard|difficult|tricky|impossible) to (?:give|say|know|provide|pin down)[^.!?]*,?\s*but\s*/i,
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
  appointment_prep: [],
  gibberish: [],
  general: [],
  // Phase 1 coverage expansion — none of these need runtime-data openers
  exercise_log: [],
  injection_log: [],
  medication_question: [],
  social_situation: [],
  pause_request: [],
};

const ALL_CONTEXT_OPENERS: RegExp[] = [
  ...FOOD_CONTEXT_OPENERS,
  ...WEIGHT_CONTEXT_OPENERS,
  ...MOOD_CONTEXT_OPENERS,
];

export function enforceFormat(
  input: string,
  opts?: { stripFirstName?: string; messageContext?: MessageContext; lastAssistantMessage?: string; userMessage?: string },
): FormatEnforcementResult {
  let text = input;
  const fixes: string[] = [];

  // ─── User-message echo strip ────────────────────────────────────────────
  // The LLM sometimes opens a food-log response by parroting the user's
  // exact message back as a noun phrase. Example:
  //   user: "I ate two eggs"
  //   Grace: "I ate two eggs is about 12g protein. You're at 35g of your 60g target."
  // The opening "I ate two eggs " is dead weight that breaks the conversational
  // tone. Detect any verbatim copy of the user's leading 3+ words and strip.
  if (opts?.userMessage && opts.userMessage.trim().length >= 6) {
    const uTrim = opts.userMessage.trim();
    // Normalize both sides for comparison: lowercase, collapse whitespace.
    // We require an exact case-insensitive prefix match of the user's first
    // 3-12 words to avoid false positives on partial substring overlap.
    const uWords = uTrim.split(/\s+/).slice(0, 12);
    for (let take = Math.min(uWords.length, 12); take >= 3; take--) {
      const prefix = uWords.slice(0, take).join(' ');
      // Build a regex that matches the prefix at start of text, allowing
      // small punctuation/case variation. The user prefix is treated literally.
      const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`^["']?${escaped}[\\s,.:!?-]*`, 'i');
      if (re.test(text)) {
        const stripped = text.replace(re, '').trim();
        // Only accept the strip if (a) something substantial remains and
        // (b) the leftover doesn't start with a connector ("and", "is", "was")
        // unless we capitalize / inject a natural transition.
        if (stripped.length >= 10) {
          let next = stripped;
          // If the remainder begins with "is/are/was/were [something]", drop
          // that linking verb too — those are leftovers from the LLM treating
          // the echoed prefix as the subject of the sentence.
          next = next.replace(/^(is|are|was|were|has|have|had)\s+(?:about\s+|roughly\s+|approximately\s+)?/i, '');
          // Capitalize first letter.
          next = next.charAt(0).toUpperCase() + next.slice(1);
          text = next;
          fixes.push('user_message_echo_stripped');
          break;
        }
      }
    }
  }

  // ─── Duplicate previous-message prefix strip ────────────────────────────
  // Gemini Flash sometimes "continues" the previous assistant turn instead of
  // starting a fresh reply. The result is that the new response begins by
  // copy-pasting the entire last Grace message and then appends the new answer
  // as a final sentence. Detect the overlap and strip the repeated prefix.
  if (opts?.lastAssistantMessage) {
    const prev = opts.lastAssistantMessage.trim();
    // 2026-06-05 production failure: response began with "Your injection
    // day is Sunday. Regarding how GLP-1 medications..." — the 29-char
    // previous response ("Your injection day is Sunday.") was below the
    // 40-char threshold, so the strip didn't fire. Two-pronged detection:
    //
    // 1. EXACT FULL-PREFIX match: if the response starts with the entire
    //    previous message verbatim (case-insensitive) and has ≥20 chars
    //    of new content after, strip the full prefix. Catches short
    //    prev-replies like "Your injection day is Sunday."
    // 2. PARTIAL OVERLAP (original): for longer prev messages (≥40 chars)
    //    where Gemini "continues" mid-sentence. Catches long context.
    const textLower = text.toLowerCase();
    const prevLower = prev.toLowerCase();
    if (prev.length >= 10 && textLower.startsWith(prevLower)) {
      const remainder = text.slice(prev.length).trim();
      if (remainder.length >= 20) {
        text = remainder.charAt(0).toUpperCase() + remainder.slice(1);
        fixes.push('duplicate_prev_message_stripped');
      }
    } else if (prev.length >= 40) {
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
  // Strip CHAINED openers, not just the first — a reply can stack two or three
  // ("That sounds like a delicious meal. Let's break down the protein. Here's
  // how…") and only removing one still ships preamble. Loop up to 3 passes.
  for (let pass = 0; pass < 3; pass++) {
    let strippedThisPass = false;
    for (const pattern of FILLER_OPENERS) {
      if (pattern.test(text)) {
        const stripped = text.replace(pattern, '').trim();
        if (stripped.length > 30) {
          // Capitalize the new first letter
          text = stripped.charAt(0).toUpperCase() + stripped.slice(1);
          fixes.push('filler_opener_stripped');
          strippedThisPass = true;
          break;
        }
      }
    }
    if (!strippedThisPass) break;
  }

  // ─── Em dash (—) and en dash (–) → comma ───────────────────────────────
  // Used as punctuation only. We collapse surrounding whitespace so we
  // don't leave "word , word" with a leading space.
  //
  // 2026-06-05 production failure: numeric range "64–80 ounces" got
  // converted to "64, 80 ounces" because en-dash between digits also
  // matched. Preserve digit-en-dash-digit and digit-em-dash-digit by
  // converting to a hyphen (canonical range form).
  if (/\d\s*[—–]\s*\d/.test(text)) {
    text = text.replace(/(\d)\s*[—–]\s*(\d)/g, '$1-$2');
  }
  if (/[—–]/.test(text)) {
    text = text.replace(/\s*[—–]\s*/g, ', ');
    fixes.push('em_dash_replaced');
  }

  // ─── Double dash (--) → comma ──────────────────────────────────────────
  if (/--+/.test(text)) {
    text = text.replace(/\s*--+\s*/g, ', ');
    fixes.push('double_dash_replaced');
  }

  // ─── List-intro / section-header / Title-Case-header stripping (early) ──
  // These must run BEFORE stray_colon_cleaned. Otherwise stray_colon_cleaned
  // strips the trailing `:` from "How GLP-1 Medications Work:" before this
  // rule has a chance to fire, leaving the orphan header words awkwardly in
  // prose ("...about coffee How GLP-1 Medications Work GLP-1..."). Moved
  // from later in the function to fire here (2026-06-04 production failure).
  //
  // Pattern 1: "Here's why X, Y, and Z:" / "Here's a breakdown of...:" / etc.
  const listIntroEarlyRe = /\b(here'?s (?:a |the |my )?(?:breakdown|summary|explanation|overview)[^.:!?\n]{0,80}|here'?s why[^.:!?\n]{0,120}|here'?s what[^.:!?\n]{0,120}|here'?s how[^.:!?\n]{0,120}|here are (?:[^\n.:!?]{0,80}?)(?:points?|tips?|things?|options?|suggestions?|ideas?|steps?|reasons?|causes?|ways?|meals?|dinners?|lunches|breakfasts|snacks|foods?|recipes?|examples?)[^.:!?\n]{0,120})\s*:\s*/gi;
  if (listIntroEarlyRe.test(text)) {
    text = text.replace(listIntroEarlyRe, '');
    fixes.push('list_intro_stripped');
  }

  // Pattern 1b (2026-06-05 production failure): "How GLP can affect my
  // muscles" → response ended with "Here's how GLP-1 can affect your
  // muscles: 1." — list intro that wasn't caught by Pattern 1, and the
  // dangling "1." remained. Add a catch-all for "Here's X:" at end of
  // response, plus strip dangling list markers ("1.", "1)", "First,") at
  // the END of the response after the colon-strip.
  const trailingListIntroRe = /\b(here'?s\s+(?:how|why|what)\s+[^.!?\n]{0,150}):\s*\d+\.\s*$/gi;
  if (trailingListIntroRe.test(text)) {
    text = text.replace(trailingListIntroRe, '$1.');
    fixes.push('trailing_list_intro_stripped');
  }

  // Pattern 1b2 (2026-06-05 v3 production failure): "...might relate to
  // muscles: 1." — response ended with "X: 1." but didn't start with
  // "Here's". This is still a truncated list intro. Strip the trailing
  // ": 1." (or ": 1" / ": 2." / ": First,") that signals an interrupted
  // enumeration.
  const trailingTruncatedListRe = /:\s*(?:\d+[.):]|first|second|third)\s*[.,]?\s*$/i;
  if (trailingTruncatedListRe.test(text)) {
    text = text.replace(trailingTruncatedListRe, '.');
    fixes.push('trailing_truncated_list_stripped');
  }
  // 2026-06-05 production failure: "Your protein goal of 60g is set for a
  // few important reasons, especially in the context of using GLP-1
  // medications and focusing on health and weight management: Muscle
  // Preservation: When you lose weight..." — "Muscle Preservation:" is a
  // Title-Case header (2 words) followed by a colon and body. labelColonRe
  // only fires at sentence boundaries (^|[.!?]\s+) so this mid-sentence
  // header escaped. titleCaseHeaderRe required 3+ words. Add a 2-word
  // Title-Case header stripper that fires AFTER a colon (catches double-
  // colon patterns: "X: Y Z: Body" → "X: body" with Y Z + colon stripped).
  const midSentenceTitleHeaderRe = /([:.!?,]\s+)([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})\s*:\s+(?=[A-Z])/g;
  if (midSentenceTitleHeaderRe.test(text)) {
    text = text.replace(midSentenceTitleHeaderRe, '$1');
    fixes.push('mid_sentence_title_header_stripped');
  }

  const brandDumpRe = /\s*\((?:[A-Z][a-z]+(?:[ -][A-Z][a-z]+)?(?:,\s*)?){3,}\)/g;
  if (brandDumpRe.test(text)) {
    text = text.replace(brandDumpRe, '');
    fixes.push('brand_dump_stripped');
  }

  // Pattern 2: Generalized Title-Case Header followed by Colon. 3+ Title Case
  // words (allowing uppercase tokens like "GLP-1" / "USDA" in the middle)
  // followed by `:` and a body. Anchored at sentence/clause start so we
  // never strip inside flowing prose. Production failure: "How GLP-1
  // Medications Work: GLP-1 is a hormone..." — 4-word Title Case header.
  const titleCaseHeaderEarlyRe = /(^|[.!?:]\s+)([A-Z][\w-]*(?:\s+[A-Z][\w-]*){2,5}):\s+/g;
  if (titleCaseHeaderEarlyRe.test(text)) {
    text = text.replace(titleCaseHeaderEarlyRe, (_, prefix) => prefix);
    fixes.push('title_case_header_stripped');
  }

  // ─── Stray colons in mid-sentence ("foods that: are bland" → "foods that are bland")
  // Gemini sometimes inserts colons before clauses where none is needed.
  // Only strip colons NOT preceded by a known label pattern (e.g. "Rate this:").
  //
  // 2026-06-05 production failure: "A few options: Tofu stir-fry" got the
  // colon stripped to space, producing "A few options Tofu stir-fry"
  // because the prior 15-char-prefix check looked at "A few option" (15
  // chars before "s: T") which doesn't end with "options" plural. Now we
  // look at the full word ending right before the colon, plus an extended
  // multi-word prefix.
  // 2026-06-05 production failure: "However, there are a few important
  // things to keep in mind: Potential for increased side effects: Both
  // alcohol and GLP-1s..." → "...to keep in mind Potential for increased
  // side effects Both alcohol..." — case-insensitive matching stripped
  // colons followed by capital-letter clauses ("X: Capital Y") which are
  // almost always legitimate prose punctuation (a colon introducing an
  // important phrase), NOT stray colons. Make the rule lowercase-to-
  // lowercase ONLY (the original "foods that: are bland" case), so
  // legitimate "to keep in mind: Potential" patterns survive.
  if (/[a-z]\s*:\s+[a-z]/.test(text)) {
    const ALLOWED_LEAD_WORDS = /\b(example|note|tip|here|ideas|tries|try|options?|include|such|like|background|summary|total|totals|breakdown)$/i;
    const ALLOWED_LEAD_PHRASES = /\b(a few options|a few ideas|some options|some ideas|running total|daily total|today'?s total|protein today|calories today)$/i;
    text = text.replace(/([a-z])\s*:\s+([a-z])/g, (match, before, after, offset: number) => {
      let wordStart = offset;
      while (wordStart > 0 && /[A-Za-z]/.test(text[wordStart - 1]!)) wordStart--;
      const fullWordBefore = text.slice(wordStart, offset + 1);
      if (ALLOWED_LEAD_WORDS.test(fullWordBefore)) return match;
      const extStart = Math.max(0, wordStart - 30);
      const extendedPrefix = text.slice(extStart, offset + 1);
      if (ALLOWED_LEAD_PHRASES.test(extendedPrefix)) return match;
      return `${before} ${after}`;
    });
    fixes.push('stray_colon_cleaned');
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
  // Strip at line start AND mid-line (Gemini sometimes emits "### 1." inline)
  if (/^#{1,6}\s+/m.test(text)) {
    text = text.replace(/^#{1,6}\s+/gm, '');
    fixes.push('markdown_header_stripped');
  }
  if (/\s#{2,6}\s+/.test(text)) {
    text = text.replace(/\s#{2,6}\s+/g, ' ');
    fixes.push('inline_markdown_header_stripped');
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

  // 2026-06-05 production failure: "Your protein goal is 60 grams per day.
  // Why? * Satiety and Hunger Control GLP-1 medications..." — a SINGLE
  // bullet marker (not a list) sneaked through because bulletListRegex
  // requires 2+ consecutive items. Strip lone leading "* " / "- " markers
  // at the start of any sentence or line.
  // 2026-06-14 production failure: "...gentle on a GLP-1 stomach, * Greek
  // yogurt power bowl:" — the bullet followed a COMMA, not a sentence
  // terminator, so it escaped. Boundary widened to include , ; : as well.
  if (/(?:^|[.!?,;:]\s+|\n\s*)[*-]\s+[A-Z]/.test(text)) {
    text = text.replace(/((?:^|[.!?,;:]\s+|\n\s*))[*-]\s+(?=[A-Z])/g, '$1');
    fixes.push('lone_bullet_stripped');
  }

  // ─── Residual markdown / formatting-symbol sweep (2026-06-14) ───────────
  // STRICT requirement: zero markdown artifacts reach the user. The
  // structured rules above handle WELL-FORMED markdown (paired **bold** /
  // *italic*, line-start bullets, headers, multi-item lists). This final
  // sweep catches the MALFORMED leftovers that slip through — an UNPAIRED
  // asterisk has no closing `*`, so the italic strip never touched it.
  // Grace never legitimately emits a literal `*`, so any survivor is an
  // artifact and is removed.
  //
  // 1. Horizontal-rule / separator lines (---, ***, ___).
  if (/(?:^|\n)[ \t]*(?:-{3,}|\*{3,}|_{3,})[ \t]*(?=\n|$)/.test(text)) {
    text = text.replace(/(?:^|\n)[ \t]*(?:-{3,}|\*{3,}|_{3,})[ \t]*(?=\n|$)/g, '\n');
    fixes.push('separator_line_stripped');
  }
  // 2. Any remaining asterisk(s) — unpaired emphasis or stray bullet.
  if (text.includes('*')) {
    text = text.replace(/\*+/g, '');
    fixes.push('residual_asterisk_stripped');
  }
  // 3. Residual header markers (# / ## / ###) anywhere, not just line start.
  //    Requires a following space so "#1" / "channel #5" are left untouched.
  if (/(?:^|\s)#{1,6}\s+/.test(text)) {
    text = text.replace(/(?:^|\s)#{1,6}\s+/g, ' ');
    fixes.push('residual_header_stripped');
  }
  // 4. Three-or-more underscores (separator / leftover rule).
  if (/_{3,}/.test(text)) {
    text = text.replace(/_{3,}/g, '');
    fixes.push('residual_underscore_stripped');
  }
  // Tidy spacing + orphaned leading punctuation the strips may have left.
  // (No blanket recapitalization — the lone-bullet rule already preserves the
  // capital after a leading bullet, and capitalizing every lowercase start
  // would corrupt inputs that legitimately begin lowercase.)
  text = text.replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+([,.!?;:])/g, '$1').trim();

  // ─── Greeting exclamation ("Good morning!" → "Good morning.") ──────────
  // The prompt forbids "!" on greetings. Auto-strip the offender.
  const greetingPattern = /^(Good morning|Good afternoon|Good evening|Good night|Morning|Afternoon|Evening|Hi|Hello|Hey)([,\s]+[A-Z][a-zA-Z]*)?!/m;
  if (greetingPattern.test(text)) {
    text = text.replace(greetingPattern, (m) => m.slice(0, -1) + '.');
    fixes.push('greeting_exclamation_stripped');
  }

  // ─── Global exclamation strip (2026-05-30 clinical report H5) ──────────
  // SMS channel must stay calm and grounded. "!" anywhere in the response
  // is a violation. Auto-rewrite to "." regardless of position. Skip the
  // rate-this RLHF appended block (added AFTER format enforcement runs).
  if (text.includes('!')) {
    text = text.replace(/!/g, '.');
    fixes.push('exclamation_marks_stripped');
  }

  // ─── Label:description list disguised as prose (H3) ────────────────────
  // Patterns like "Bananas: easy to digest. Eggs: high protein." — these
  // are list items pretending to be prose. Replace the colon with em-dash
  // so they read as flowing prose. Threshold lowered from 2 → 1 (2026-05-30
  // feedback) — a single "Bananas: easy to digest" is still a list-item leak.
  // The risk of stripping a legitimate definition is low because most
  // definitions in Grace's voice are written as "X means Y" not "X: Y".
  //
  // Lookahead `(?=[.\n])` for the trailing terminator so consecutive matches
  // can re-anchor on the SAME period that ended the previous match.
  // Body upper-bound raised 80 → 240 (production failure 2026-06-03:
  // "Tofu Scramble with Spinach: Crumble a block of tofu and cook it with some
  // cumin, paprika, and nutritional yeast for a cheesy flavor. Add a handful
  // of spinach for extra fiber." — the body is 180+ chars; the old 80 cap
  // skipped it entirely). Hyphen now allowed in label too ("High-Protein").
  // Label length 32 → 60 (2026-06-03): production failure showed
  // "Creamy Tomato Soup with Grilled Cheese Croutons: A classic for a reason"
  // (49-char label) escaping the strip and rendering as a list-item to users.
  // 60 chars covers compound dish names without false-positiving on natural
  // sentence prefixes (typical "Subject: " preamble is < 30 chars).
  // 2026-06-05 production failure: "Watch out for side effects: Both alcohol
  // and GLP-1s..." (25 chars label) got matched by labelColonRe and the
  // colon flattened to em-dash → comma. Long phrases like "Watch out for
  // side effects" are PROSE, not labels. Real labels are short (≤22
  // chars: "Greek Yogurt Parfait" 19, "Notes" 5, "Tip" 3). Tightening the
  // max from 60 → 22 covers all known good labels and stops prose
  // collateral damage.
  // Prefix includes , : as well as . ! ? — a label-breakdown chains its items
  // with commas or a leading colon ("Here's an idea: Salmon: …, Estimate: …,
  // Potatoes: …"), so those labels were previously invisible to this rule and
  // shipped as a list (production 2026-07-02). Capital-letter + colon still
  // guards against flattening ordinary lowercase prose ("two things: …").
  const labelColonRe = /(^|[.!?,:]\s+)([A-Z][\w\s-]{2,22}):\s+(\w[^.\n]{4,240})(?=[.\n])/g;
  // 2026-06-04: "Label:," pattern — Gemini sometimes emits "Greek Yogurt
  // Parfait:, 1 cup of..." (colon immediately followed by a comma). The
  // body regex above requires `\w[^.\n]{4,240}` so the comma-leading body
  // is missed. Catch and convert "Label:, " to "Label, " up front.
  const labelColonCommaRe = /(^|[.!?]\s+)([A-Z][\w\s-]{2,22}):\s*,\s*/g;
  if (labelColonCommaRe.test(text)) {
    text = text.replace(/(^|[.!?]\s+)([A-Z][\w\s-]{2,22}):\s*,\s*/g, (_, prefix, label) => `${prefix}${label}, `);
    fixes.push('label_colon_comma_stripped');
  }
  // 2026-06-05 production failure: "Today you've had X. Running total:
  // 140g protein, 2610 kcal." — labelColonRe matched "Running total:" and
  // flattened the colon to an em-dash (then turned into a comma later),
  // producing "Running total, 140g protein, 2610 kcal." Allow-list the
  // specific summary labels Grace uses so their colons survive.
  //
  // 2026-06-05 v2: "A few options: Tofu stir-fry..." → labelColonRe also
  // stripped this colon, producing "A few options Tofu stir-fry..." (no
  // comma either since the em-dash → comma rule ran later). Add the
  // direct-path opener labels to the allow-list.
  const SUMMARY_LABEL_RE = /^(running total|total|daily total|today'?s total|protein today|calories today|breakdown|summary|a few options|options|some options|ideas|some ideas|a few ideas)$/i;
  let labelHits = 0;
  text.replace(labelColonRe, (_match, _prefix, label: string) => {
    if (!SUMMARY_LABEL_RE.test(label.trim())) labelHits++;
    return '';
  });
  if (labelHits >= 1) {
    text = text.replace(labelColonRe, (match, prefix, label: string, body) => {
      if (SUMMARY_LABEL_RE.test(label.trim())) return match;
      return `${prefix}${label} — ${body}`;
    });
    fixes.push('label_colon_flattened');
  }

  // Section-header colons at line start (e.g. "Why it's happening:" / "What to do:")
  // These don't get caught by the early list-intro or title-case strips because
  // they're shorter and start at line beginning, not mid-sentence.
  const sectionHeaderRe = /^\s*(why it'?s happening|what to do|causes?|solutions?|tips?|steps?|key points?|main points?|background|the answer|the (?:short|tl;?dr) (?:answer|version))\s*:\s*/gim;
  if (sectionHeaderRe.test(text)) {
    text = text.replace(sectionHeaderRe, '');
    fixes.push('section_header_stripped');
  }

  // ─── Orphaned enumeration markers (only after list-intro was stripped) ──
  // Production failure: after list_intro_stripped, the response was left with
  // "1. Mechanism of Action (The Core Difference) Ozempic (Semaglutide):..."
  // — a SINGLE "1." with no matching "2." anywhere. That's a broken list.
  // Only run this strip when listIntroRe just fired (otherwise "1." in prose
  // like "Step 1. is the priority" would be incorrectly stripped).
  if (fixes.includes('list_intro_stripped')) {
    const orphanedNumberedRe = /(^|\n)\s*(\d+)[.)]\s+/g;
    const matches = [...text.matchAll(orphanedNumberedRe)];
    // Only one marker → orphan, strip it.
    if (matches.length === 1) {
      text = text.replace(/(^|\n)\s*\d+[.)]\s+/, '$1');
      fixes.push('orphaned_enumeration_stripped');
    }
  }

  // ─── Truncation residue: dangling enumeration markers at the END ───────
  // After list-intro stripping or natural mid-list cutoff, the response often
  // ends with a dangling "1." / "1)" / "•" / "-" / colon. Production failure:
  //   "...Here's a breakdown of how Ozempic actually works in the body: 1."
  // After list_intro_stripped:
  //   "...weight management. 1."
  // The bare "1." reads as broken. Strip dangling markers from the end.
  // Only strip an orphan numbered marker ("1.", "2)") that follows another
  // sentence ending — that's the truncated-list pattern. A trailing " 4." in
  // "...by week 4." is a quantity, NOT a list marker, and must be kept.
  // Bullet markers and dangling colons stay broadly matched.
  const trailingMarkerRe = /(?:[.!?]\s+\d+[.)]|\s+[-*•]\s*|\s*:)\s*$/;
  if (trailingMarkerRe.test(text)) {
    text = text.replace(trailingMarkerRe, '').trimEnd();
    fixes.push('trailing_list_marker_stripped');
  }

  // Mid-list cutoff: response ends WITHOUT punctuation (no `.`, `!`, `?`, emoji)
  // after the trailing-marker strip. Common when LLM hit max_tokens mid-list.
  // We can't recover the missing content here — flag it so the orchestrator
  // can decide to regen with a higher token budget. The flag is emitted via
  // fixes[] which orchestrator's caller reads.
  const trimmed = text.trim();
  if (trimmed.length > 80 && !/[.!?…]$|[\p{Emoji_Presentation}\p{Extended_Pictographic}]$/u.test(trimmed)) {
    fixes.push('truncation_suspected');
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

  // ─── Missing space after sentence terminator ─────────────────────────────
  // Production failure 2026-06-01: "I don't have any food logged for you
  // today, so you're at 0g protein so far.You're at 0g protein for the day
  // so far." — period directly followed by a capital letter with no space.
  // Insert the missing space so the response reads cleanly.
  if (/[.!?][A-Z]/.test(text)) {
    text = text.replace(/([.!?])([A-Z])/g, '$1 $2');
    fixes.push('missing_space_after_period');
  }

  // ─── Consecutive duplicate sentences ─────────────────────────────────────
  // Production failure 2026-06-01: Grace emitted near-identical sentences
  // back to back ("...so you're at 0g protein so far." then "You're at 0g
  // protein for the day so far."). Two detectors:
  //
  //   (a) EXACT-DUPLICATE sentences (case-insensitive, terminal-punct
  //       agnostic) — always safe to dedupe.
  //   (b) Same SPECIFIC QUANTITY (like "0g protein", "40g", "150 kcal")
  //       repeated in two different sentences within the response. That's
  //       the production pattern even when wording differs.
  {
    const sentenceSplit = text.split(/(?<=[.!?])\s+/);
    if (sentenceSplit.length >= 2) {
      // (a) Exact-duplicate dedupe — first occurrence wins.
      const seenExact = new Set<string>();
      const kept: string[] = [];
      for (const s of sentenceSplit) {
        const norm = s.toLowerCase().replace(/[.!?]+$/, '').replace(/\s+/g, ' ').trim();
        if (norm.length === 0) continue;
        if (seenExact.has(norm)) continue;
        seenExact.add(norm);
        kept.push(s);
      }
      // (b) Same-quantity dedupe — if two sentences both reference the
      // same `\d+g X` / `\d+ kcal` / `\d+ lbs` pattern, keep only the
      // first. This catches the production case where wording differs
      // but both sentences convey the same protein/calorie/weight number.
      const QUANTITY_KEY_RE = /\b(\d{1,4}(?:\.\d{1,2})?\s*(?:g|grams?|kcal|kg|lbs?|pounds?|cal|calories))\s+(protein|carb|carbs|fat|fiber|sugar|kcal|calories)/gi;
      const sentenceQuantities = kept.map((s) => {
        const out: string[] = [];
        for (const m of s.toLowerCase().matchAll(QUANTITY_KEY_RE)) {
          if (m[1] && m[2]) out.push(`${m[1].replace(/\s+/g, '')}_${m[2]}`);
        }
        return out;
      });
      const seenQty = new Set<string>();
      const finalKept: string[] = [];
      for (let i = 0; i < kept.length; i++) {
        const qtys = sentenceQuantities[i] ?? [];
        const isQtyDupe = qtys.length > 0 && qtys.every((q) => seenQty.has(q));
        if (isQtyDupe) continue;
        for (const q of qtys) seenQty.add(q);
        finalKept.push(kept[i]!);
      }
      if (finalKept.length < sentenceSplit.length) {
        text = finalKept.join(' ').trim();
        fixes.push('duplicate_sentence_stripped');
      }
    }
  }

  // ─── Hard length cap (WhatsApp readability) ─────────────────────────
  // Per-context limits are stricter than the universal 420-char fallback.
  // Responses over the cap are truncated at the last sentence boundary
  // that fits. If the response is already under the limit this is a no-op.
  const CONTEXT_MAX: Record<MessageContext, number> = {
    greeting:         160,  // one warm sentence
    emotional:        260,  // 2 sentences of warmth, no unsolicited tips
    mood_log:         220,  // acknowledge the score + one warm observation
    weight_log:       240,  // confirm the log + brief reaction
    food_log:         480,  // protein number + daily total + optional brief tip
    food_question:    420,  // 3-4 food options with brief reasoning
    scheduling:       220,  // confirm the change and done
    knowledge:        600,  // educational answers need room for facts + user tie-in
    appointment_prep: 800,  // 4-6 specific questions for the doctor visit
    gibberish:        160,  // short clarifying question
    general:          500,  // default cap — enough for a real answer
    // Phase 1 coverage expansion intents
    exercise_log:        220,  // brief acknowledgment, no calorie burn math
    injection_log:       200,  // confirmation + one tip max
    medication_question: 420,  // dose/timing/storage answers, no lectures
    social_situation:    420,  // practical strategies, brief
    pause_request:       200,  // confirmation only
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
    } else {
      // No clean sentence boundary late enough in the window — the reply is a
      // long run-on (e.g. an essay whose only early period is a short opener,
      // then a colon/comma "Option 1 / Option 2" list). This USED to skip
      // truncation, so the whole 1800-char essay shipped (production bug). Now
      // hard-cap at the last word boundary before MAX_CHARS so a rambling list
      // can never ship in full — the multi-part note keeps Gemini brief so this
      // safety net rarely fires.
      const hard = text.slice(0, MAX_CHARS);
      const lastSpace = hard.lastIndexOf(' ');
      const cut = lastSpace > MAX_CHARS / 2 ? hard.slice(0, lastSpace) : hard;
      text = cut.replace(/[\s,;:—–-]+$/, '').trim() + '.';
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

  // ─── Multi-question collapse ───────────────────────────────────────────
  // Production telemetry (2026-06-03): every food_question regen was firing
  // on "two_questions" — the model produced multiple "?" marks. The regen LLM
  // call took 3.4s to rewrite. Deterministic strip is ~free: when the
  // response contains 2+ question marks, keep only the LAST one (the most
  // useful follow-up) and convert earlier ones to periods. This kills the
  // regen trigger at source. Safer than dropping the response altogether and
  // costs zero LLM time.
  const allQuestionMarks = (text.match(/\?/g) ?? []).length;
  if (allQuestionMarks >= 2) {
    // Protect URLs first — a query string legitimately contains '?', and the
    // collapse below would mangle a link (/upgrade?phone=… → /upgrade.phone=…,
    // a real production bug that 404'd every upgrade/settings link with a query
    // param). Mask URLs, collapse only the '?' that live in prose, then restore.
    const urls: string[] = [];
    const masked = text.replace(/https?:\/\/\S+/gi, (m) => `  U${urls.push(m) - 1}  `);
    if ((masked.match(/\?/g) ?? []).length >= 2) {
      const lastQ = masked.lastIndexOf('?');
      if (lastQ > 0) {
        const collapsed = masked.slice(0, lastQ).replace(/\?/g, '.') + masked.slice(lastQ);
        text = collapsed.replace(/ U(\d+) /g, (_, i) => urls[Number(i)] ?? '').replace(/[ \t]{2,}/g, ' ');
        fixes.push('multi_question_collapsed');
      }
    }
    // else: the only extra '?' lived inside URL(s) — nothing in prose to collapse.
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
