/**
 * Deterministic content-rule violations that warrant a regeneration.
 *
 * Unlike format-enforcer (silent auto-fix), these are semantic violations
 * that cannot be fixed by string replacement — they require the LLM to
 * actually pick different words. Any non-empty violation list forces the
 * orchestrator to regen once with a targeted instruction.
 *
 * Current checks:
 *   - Forbidden foods given a dietary restriction
 *   - Banned phrases ("Hang in there", "You've got this", etc.)
 *   - Privacy leak ("I don't have a user named X", references to other users)
 *   - "[link]" placeholder instead of a real settings URL
 *
 * Add a new check by writing a function that returns ContentViolation[]
 * and calling it from checkContent().
 */

import type { DietaryRestriction, DbContentRule } from '@grace/shared';

export interface ContentViolation {
  /** Short code for telemetry: 'forbidden_food', 'banned_phrase', etc. */
  code: string;
  /** Human-readable description for the regen instruction. */
  message: string;
  /** The specific offending token (e.g. "chicken"). */
  match?: string;
  /** Severity from the DB rule. Undefined = 'regen' (backward compat). */
  severity?: 'log' | 'regen' | 'block';
}

export interface ContentCheckOpts {
  dietaryRestriction?: DietaryRestriction;
  /** Cleaned food-dislike list (no "I don't like" prefix). */
  foodDislikes?: string[];
  /** Medication category — enables the contradiction guard. */
  medicationType?: 'weekly_injection' | 'daily_pill' | 'daily_injection' | 'unknown';
  /** Response modality. 'image_body' triggers the medical-leak guard. */
  responseMode?: 'text' | 'image_food' | 'image_body' | 'voice';
  /** Active DB-driven rules loaded by ContentRulesService. */
  dbRules?: DbContentRule[];
  /** User's latest message — for context-aware checks like privacy misfire and double-question detection. */
  userMessage?: string;
  /** Classified message intent. Used to skip the two-question check for
   *  appointment_prep (where a list of questions IS the deliverable). */
  intentType?: string;
  /** System context block (today's protein/calorie totals, user profile,
   *  weight, etc.) — used by checkStaleContextEcho to whitelist numbers
   *  that are legitimately part of the current turn's context. */
  systemContext?: string;
  /** Stringified tool results from this turn — same whitelist purpose. */
  toolResultsText?: string;
  /** Skip the stale-context-echo guard. Set to TRUE for FAQ cache hits
   *  (pre-vetted educational responses with intentional citation numbers
   *  like "STEP-1 trial: ~40%" that aren't in the user message but are
   *  canonical knowledge, not memory echo). */
  skipStaleContextEcho?: boolean;
  /** The previous user message (one turn before the current). Used to detect
   *  when Grace's current response is re-litigating sub-topics from the
   *  PRIOR user turn instead of answering the latest one. Production failure
   *  2026-06-02: prior user message was "Thanks. I slept well, but my
   *  stomach is killing me"; current user message was "Im feeling it on the
   *  bottom left side"; Grace opened "Anytime. Glad to hear you slept well…"
   *  — re-addressing things from the PRIOR message instead of the location
   *  the user just gave. */
  previousUserMessage?: string;
}

export function checkContent(text: string, opts: ContentCheckOpts): ContentViolation[] {
  const violations: ContentViolation[] = [];

  if (opts.dietaryRestriction) {
    violations.push(...checkDietaryViolations(text, opts.dietaryRestriction));
  }
  if (opts.foodDislikes && opts.foodDislikes.length > 0) {
    violations.push(...checkFoodDislikes(text, opts.foodDislikes));
  }
  if (opts.medicationType && opts.medicationType !== 'unknown') {
    violations.push(...checkMedicationContradiction(text, opts.medicationType));
  }
  if (opts.responseMode === 'image_body') {
    violations.push(...checkBodyPhotoLeak(text));
  }
  violations.push(...checkBannedPhrases(text));
  violations.push(...checkLinkPlaceholder(text));
  violations.push(...checkPrivacyLeak(text));
  if (opts.userMessage) {
    violations.push(...checkPrivacyMisfire(text, opts.userMessage));
    // Appointment_prep is exempt from the one-question ceiling — the whole
    // point of the intent is to produce a list of 4-6 doctor questions.
    if (opts.intentType !== 'appointment_prep') {
      violations.push(...checkTwoQuestions(text));
    }
    violations.push(...checkFoodLogPreambleLeak(text, opts.userMessage));
    violations.push(...checkUserMessageEcho(text, opts.userMessage));
    violations.push(...checkEmotionBeforeData(text, opts.userMessage));
    violations.push(...checkEmotionalDeadEnd(text, opts.userMessage));
    if (opts.previousUserMessage) {
      violations.push(
        ...checkPriorMessageRelitigation(text, opts.userMessage, opts.previousUserMessage),
      );
    }
    // FINAL LAYER (per user directive 2026-06-01): every response must answer
    // the current message using ONLY quantities from the current turn (user
    // message + system context + tool results). Numbers that don't appear in
    // any of those are treated as stale memory echo → regen.
    // Exception: FAQ cache hits are pre-vetted educational responses with
    // intentional citation numbers (e.g. "STEP-1 trial: ~40%") that aren't
    // tied to the current user message but are canonical knowledge.
    if (!opts.skipStaleContextEcho) {
      violations.push(
        ...checkStaleContextEcho(
          text,
          opts.userMessage,
          opts.systemContext ?? '',
          opts.toolResultsText ?? '',
        ),
      );
    }
  }
  if (opts.dbRules && opts.dbRules.length > 0) {
    violations.push(...checkDbRules(text, opts.dbRules));
  }
  // Always check: inline label-colon list (production failure 2026-06-01).
  // The format-enforcer's existing labelColonRe only matches when each
  // "Label: description" is bounded by sentence terminators, missing the
  // comma-joined inline variant ("Lentil soup: ... , Tofu stir-fry: ... ,
  // Greek yogurt: ...") that the lunch-recommendation response produced.
  violations.push(...checkInlineLabelColonList(text));
  // Always check: phrase repetition (production failure 2026-06-04).
  // "GLP-1 medications" appearing 4× in 3 sentences slipped past every other
  // guard. Deterministic 2-gram frequency check catches it.
  violations.push(...checkPhraseRepetition(text));
  // Always check: validation-only response on a forward-looking fear/worry.
  // Catches the production failure: user said "I'm scared I'll gain all the
  // weight back" → Grace ONLY validated ("really understandable common fear,
  // takes courage...") with no reframe, no information, no practical next
  // step. The behavioral guard's principle 16 caught this when active, but
  // TRUST_GEMINI disables it; this deterministic check is the safety net.
  if (opts.userMessage) {
    violations.push(...checkValidationOnly(text, opts.userMessage));
  }

  return violations;
}

// ── Inline label-colon list ──────────────────────────────────────────────────
// Matches the food-recommendation list-disguised-as-prose pattern:
//   "Lentil soup: This is great. Tofu stir-fry: Toss some... Cheddar
//    chickpea slice: This is a high-protein... Greek yogurt power bowl: Mix..."
// All separated by commas or periods, all on one line, but structurally a
// 4-item list with label-colon items. H3 PROSE ONLY explicitly bans this
// but the LLM still emits it on food-recommendation responses. We catch
// any response with 2+ "Capitalized Phrase:" markers followed by a
// description and force regen.
//
// 2026-06-04 production failure: "Here's why GLP-1 medications work, and a
// bit more about coffee: How GLP-1 Medications Work: GLP-1 (...) is a..."
// — two colons in a row. The old INLINE_LABEL_COLON_RE required `[A-Z][a-z]+`
// for the label, missing "How GLP-1 Medications Work" (uppercase GLP-1 in
// the middle). And the count threshold was 3, so even with the broader regex
// two colons wouldn't fire. Now: label allows uppercase + digits + hyphens
// inside, and threshold is 2 (a single header is still suspicious; two is
// definitively a leak).
const INLINE_LABEL_COLON_RE = /\b([A-Z][\w-]*(?:[\s-]+[A-Za-z][\w-]*){0,5}):\s+[A-Za-z]/g;

function checkInlineLabelColonList(response: string): ContentViolation[] {
  // Skip very short responses (no room for a list anyway).
  if (response.length < 80) return [];
  const matches = [...response.matchAll(INLINE_LABEL_COLON_RE)];
  // Threshold lowered 3 → 2: two "Title Case:" patterns in one response is
  // already a list-leak. (One could be a legitimate "Subject: blah" preamble.)
  if (matches.length < 2) return [];
  const labels = matches.slice(0, 5).map((m) => m[1]).filter(Boolean);
  return [{
    code: 'inline_label_colon_list',
    message: `Response contains ${matches.length} "Label: description" patterns (${labels.map((l) => `"${l}"`).join(', ')}) — that's a list disguised as prose. H3 PROSE ONLY bans this. Rewrite as flowing prose with NO colon-followed-by-explanation structures. Example: instead of "Lentil soup: it's hydrating. Tofu stir-fry: toss with edamame." write "Lentil soup is hydrating, tofu stir-fry with edamame is filling, and a Greek yogurt bowl is quick."`,
    severity: 'regen',
  }];
}

// ── Phrase repetition ─────────────────────────────────────────────────────────
// Catches the production failure where Grace echoes the same multi-word phrase
// over and over within a few sentences:
//   "...on GLP-1 medications, coffee is fine. Here's why GLP-1 medications
//    work... How GLP-1 Medications Work: GLP-1 (...) is a hormone... GLP-1
//    medications are synthetic versions..."
// "GLP-1 medications" appears 4× in 3 sentences. The behavioral guard doesn't
// reliably catch this; we need a deterministic check.
//
// Algorithm: tokenize lowercased response, count 2-gram phrase frequencies,
// flag any 2-word phrase that appears ≥4 times. 4× is the threshold because
// some phrases (the user's medication, "protein target") legitimately repeat
// 2-3× in a longer response. 4+ in <600 chars is robot-speak.
function checkPhraseRepetition(response: string): ContentViolation[] {
  // Short responses don't have room for repetition.
  if (response.length < 200) return [];
  // Tokenize: lowercase, strip punctuation, keep word chars + hyphens + digits.
  const tokens = response
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 0);
  if (tokens.length < 30) return [];
  // Build 2-gram counts, skipping stop-word-led grams ("is the", "of a") which
  // legitimately repeat in any prose.
  const STOP_WORDS = new Set([
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'and', 'or', 'but', 'so', 'if', 'then', 'than', 'as', 'at', 'by', 'in',
    'on', 'to', 'of', 'for', 'with', 'from', 'into', 'about', 'over', 'under',
    'i', 'you', 'we', 'they', 'he', 'she', 'it', 'me', 'us', 'my', 'your',
    'our', 'their', 'his', 'her', 'its', 'this', 'that', 'these', 'those',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'can', 'could',
    'should', 'may', 'might', 'must', 'one', 'two', 'three', 'first', 'also',
    'just', 'only', 'very', 'much', 'more', 'some', 'any', 'no', 'not', 'yes',
  ]);
  const counts = new Map<string, number>();
  for (let i = 0; i < tokens.length - 1; i++) {
    const a = tokens[i]!;
    const b = tokens[i + 1]!;
    // Skip if first token is stop word (low-signal) or either is empty.
    if (STOP_WORDS.has(a)) continue;
    if (a.length < 3 || b.length < 2) continue;
    const gram = `${a} ${b}`;
    counts.set(gram, (counts.get(gram) ?? 0) + 1);
  }
  // Find the most over-repeated 2-gram.
  let worstGram = '';
  let worstCount = 0;
  for (const [gram, n] of counts) {
    if (n > worstCount) {
      worstCount = n;
      worstGram = gram;
    }
  }
  // Threshold: 4+ occurrences in <600 chars, or 5+ in any response.
  const threshold = response.length < 600 ? 4 : 5;
  if (worstCount < threshold) return [];
  return [{
    code: 'phrase_repetition',
    message: `Response repeats "${worstGram}" ${worstCount} times — that's robotic. Rewrite using varied phrasing (pronouns "it" / "they", synonyms, or just dropping repeat references). One mention is enough for the reader to track.`,
    severity: 'regen',
  }];
}

// ── Validation-only on forward-looking fear / worry ──────────────────────────
// Production failure 2026-06-04: user said "I'm scared I'll gain all the
// weight back one day" → Grace's response was 100% acknowledgment ("That's a
// really understandable and common fear...takes a lot of courage..."), with
// zero reframe and zero practical takeaway. The user wanted help moving
// forward; they got a sympathy paragraph.
//
// Detection:
//   1. User message contains forward-looking concern markers
//      (I'm scared/afraid/worried/anxious + future word)
//   2. Grace response is at least 60 chars (not a trivial one-liner ack)
//   3. Grace response LACKS any of: practical-action markers, reframe
//      markers, concrete-information markers
//   → flag as validation_only, force regen with explicit "add reframe +
//     practical step" instruction.
const FORWARD_LOOKING_FEAR_RE = /\b(i'?m|im|i am|i'?ve been)\s+(scared|afraid|worried|anxious|nervous|terrified)\s+(i'?ll|i will|it'?ll|that|about|of\s+(?:gaining|losing|failing|regaining|having))/i;
const ACTION_REFRAME_RE = /\b(try|do|start|practice|focus on|aim for|build|track|set|consider|one (?:thing|step)|next (?:step|move)|when (?:that|this) (?:happens|comes up)|if (?:that|this) happens|research shows|studies show|the data|evidence (?:shows|suggests)|most people who maintain|maintenance (?:research|studies)|the way to|what helps|what works|the key)/i;
function checkValidationOnly(response: string, userMessage: string): ContentViolation[] {
  if (!FORWARD_LOOKING_FEAR_RE.test(userMessage)) return [];
  if (response.trim().length < 60) return [];
  if (ACTION_REFRAME_RE.test(response)) return [];
  return [{
    code: 'validation_only_on_fear',
    message:
      'User expressed a FORWARD-LOOKING concern (fear/worry about something that hasn\'t happened) and the response is pure validation with no reframe or practical step. Rewrite to include THREE elements: (1) brief validation (one phrase, not a paragraph), (2) reframe with real info (e.g. maintenance research: ~85% of people who lose weight on a GLP-1 regain SOME, but those who maintain protein intake + resistance training keep most of the loss), (3) ONE practical next step they can take now. Drop "really understandable" / "common fear" / "takes courage" — those are validation-only.',
    severity: 'regen',
  }];
}

// ── Privacy rule misfire ─────────────────────────────────────────────────────
// Grace says "I only know about you and your journey" when the user's message
// is about THEIR OWN health/feelings/body — NEVER about another person. This
// catches the production bug where "I feel so nauseous after my shot" got
// the privacy refusal as the opener.
const HEALTH_ANCHOR_RE = /\b(nausea|nauseous|tired|exhaust\w+|fatigue|sick|pain|cramp|bloat\w+|gas|stomach|belly|constipat\w+|diarrhea|hair|face|saggy|skin|weight|protein|calorie|kcal|food|meal|snack|breakfast|lunch|dinner|eat|ate|hungry|appetite|water|hydrat\w+|shot|injection|jab|dose|ozempic|wegovy|mounjaro|zepbound|semaglutide|tirzepatide|rybelsus|glp|mood|sad|anxious|depressed|lonely|frustrat\w+|plateau|stall)\b/i;
// Other-person query patterns — the ONLY case where the privacy line is correct
const OTHER_PERSON_RE = /\b(another user|other user|other users|do you have a user|is .{1,20} a user|my (friend|husband|wife|partner|mom|dad|sister|brother|daughter|son|coworker) (use|using|on grace|signed up)|can you (text|contact|message|call) (my |someone)|how many (users|people|women|men))\b/i;

function checkPrivacyMisfire(response: string, userMessage: string): ContentViolation[] {
  // Catch the "I only know about you and your journey" line AND its common
  // rewordings ("I only have access to your data", "I don't have info on
  // other users", "I can't share details about other users"). The previous
  // pattern was too narrow — production showed Grace using paraphrases that
  // bypassed the guard but still misfired on self-referencing health Qs.
  const privacyLine = /\b(i only know about you|i only have (?:access to |info on |information about )?your|i (?:don'?t|do not) have (?:any )?(?:info|information|details|data) (?:on|about|regarding) (?:other|another)|i (?:can'?t|cannot) (?:share|give|provide|tell you) (?:about|details (?:on|about)) (?:another|other) (?:user|users|people))\b/i;
  if (!privacyLine.test(response)) return [];
  // The privacy line was used. Check the user's message: if it's about their
  // OWN health/feelings/body and not about another person, this is a misfire.
  const userHasHealthAnchor = HEALTH_ANCHOR_RE.test(userMessage);
  const userAsksAboutOther = OTHER_PERSON_RE.test(userMessage);
  if (userHasHealthAnchor && !userAsksAboutOther) {
    return [{
      code: 'privacy_misfire',
      message: 'Privacy rule fired on a self-referencing health message — REWRITE without any "I only know about you" / "I can\'t share about other users" line. The user is asking about THEIR OWN health, not another person. Answer the question directly without privacy disclaimers.',
      severity: 'regen',
    }];
  }
  return [];
}

// ── Two-question detector ────────────────────────────────────────────────────
// Grace must ask at most one question per response, at the END. Multi-question
// chains ("How long does it last? And do you take it with food?") leave users
// unsure which to answer.
function checkTwoQuestions(response: string): ContentViolation[] {
  const questionMarks = (response.match(/\?/g) ?? []).length;
  if (questionMarks <= 1) return [];
  return [{
    code: 'two_questions',
    message: `Response contains ${questionMarks} question marks. Maximum ONE question per response, at the end. Pick the more important one and delete the rest.`,
    severity: 'regen',
  }];
}

// ── Food log preamble leak ───────────────────────────────────────────────────
// When the user logs food ("just had X", "I had Y", "I ate Z"), Grace's response
// must open with food acknowledgment — NOT with a callback to the previous
// emotional/feeling topic. This catches the production bug where Grace replied
// to "just had protein shake" with "That's great you're feeling strong. A protein
// shake is..." — the "feeling strong" was from a prior turn and was already
// acknowledged. The food log response should jump straight to the food.
const FOOD_LOG_USER_RE = /\b(just\s+(had|ate|finished|drank|made|cooked|grabbed)|i\s+(had|ate|finished|drank|made|cooked|grabbed)|i'?m\s+(having|eating|drinking)|just\s+(finishing|having|eating|drinking))\b/i;
const FEELING_CALLBACK_OPENER_RE = /^(that'?s (great|wonderful|amazing|awesome|good|nice)|glad|love (hearing|that)|so glad|wonderful|happy to hear|great to hear)\s+(you'?re|to hear (?:you'?re|that you'?re)|that you'?re|you (?:are|feel|are feeling))\s+(feeling|doing|having|getting|sleeping|staying)\s+\w+/i;

function checkFoodLogPreambleLeak(response: string, userMessage: string): ContentViolation[] {
  if (!FOOD_LOG_USER_RE.test(userMessage)) return [];
  // The user logged food. Check the response's opening sentence.
  const firstSentence = response.split(/[.!?]\s/)[0] ?? '';
  if (FEELING_CALLBACK_OPENER_RE.test(firstSentence)) {
    return [{
      code: 'food_log_preamble_leak',
      message: `Response to a food log MUST open with the food + protein number, NOT with a callback to a previous feeling/emotion topic. The user just said: "${userMessage.slice(0, 80)}". Rewrite so the FIRST WORDS are about the food they just logged. Example: "Protein shake logged — about 24g protein, you're at Xg today." Do NOT mention how they're feeling — that topic is closed.`,
      severity: 'regen',
    }];
  }
  return [];
}

// ── Emotion (or physical pain) before data ───────────────────────────────────
// When the user expresses an emotional state OR a current physical symptom —
// frustration, failure, sadness, fear, pain, nausea, sickness — the response
// MUST open with empathic acknowledgment, NOT food logging / protein numbers
// / data callbacks.
//
// Production failure A (session 3):
//   User:  "I'm trying and I still feel like I'm failing"
//   Grace: "Toast and orange juice logged. That's about 4g protein. You're at
//          4g of your 114g target today. It sounds like you're carrying a lot..."
//
// Production failure B (2026-06-02 screenshot):
//   User:  "Thanks. I slept well, but my stomach is killing me"
//   Grace: "You haven't logged any food today, so you're at 0g protein so far.
//          Ugh, stomach pain is really rough..."
//
// Both are the same bug: stale food/protein data opens a response that the
// user needs empathy + targeted attention for. The fix is to expand the
// trigger to physical-pain expressions too.
const EMOTIONAL_USER_RE = /\b(feel(?:ing)?\s+(?:like|so|really|kind\s+of)\s+(?:i'?m\s+)?(?:failing|broken|alone|lonely|sad|hopeless|defeated|exhausted|stuck|done|empty|lost|invisible|worthless|like\s+giving\s+up)|i'?m\s+(?:so\s+|really\s+|just\s+)?(?:failing|struggling|exhausted|broken|done|defeated|hopeless|stuck|lonely|sad|frustrated|overwhelmed|anxious|scared|terrified|crying|breaking down|losing it)|i\s+(?:want to|just want to|need to|feel like i should) (?:give up|quit|stop|cry|disappear)|i (?:can'?t do this|can'?t keep going|don'?t (?:want|know how) to keep)|this isn'?t working|nothing'?s working|why bother|what'?s the point)\b/i;
// Physical-pain / acute-symptom expressions. Matches "stomach is killing me",
// "head hurts", "my back is so sore", "feel sick", "throwing up", etc.
// Includes the user's body-part + "killing me" / "hurts" / "in pain" pattern
// plus the bare "feel(ing) X" symptom verbs.
const PHYSICAL_PAIN_USER_RE = /\b(?:(?:my\s+|the\s+)?(?:stomach|belly|head|back|chest|side|leg|arm|neck|shoulder|throat|tooth|tummy|gut|jaw)\s+(?:is|are|'?s|feels?)\s+(?:killing|hurting|aching|throbbing|so\s+sore|really\s+sore|on\s+fire)|(?:my\s+)?(?:stomach|head|back|tooth|throat|jaw|side|leg|arm|chest)\s+hurts?|in\s+(?:so\s+much\s+|a\s+lot\s+of\s+|real\s+|bad\s+)?pain|feel\s+(?:so\s+|really\s+|kind\s+of\s+|sort\s+of\s+|pretty\s+)?(?:sick|nauseous|nauseated|awful|terrible|horrible|like\s+(?:crap|garbage|hell))|throwing\s+up|vomit(?:ing|ed)|can'?t\s+stop\s+(?:throwing\s+up|vomiting)|killing\s+me|hurts?\s+(?:so\s+|really\s+)?(?:bad|much)|cramping\s+(?:so\s+bad|really\s+bad|hard)?)\b/i;
const DATA_OPENER_RE = /^(?:[a-z][\w\s,()'-]{0,60}\s+(?:logged|noted|recorded|added)\b|that'?s about \d|that'?s roughly \d|logged\s*[—,.-]|got it,?\s+(?:that'?s|about|around)\s+\d|you'?re (?:at|now at) \d|that brings you|adding that|you\s+haven'?t\s+logged|you\s+have\s+not\s+logged|so\s+you'?re\s+at\s+\d|so\s+far\s+(?:you'?re|you\s+have))/i;

function checkEmotionBeforeData(response: string, userMessage: string): ContentViolation[] {
  const isEmotional = EMOTIONAL_USER_RE.test(userMessage);
  const isPhysicalPain = PHYSICAL_PAIN_USER_RE.test(userMessage);
  if (!isEmotional && !isPhysicalPain) return [];
  const firstSentence = response.split(/[.!?]\s/)[0] ?? '';
  if (DATA_OPENER_RE.test(firstSentence)) {
    const kind = isPhysicalPain ? 'PHYSICAL-PAIN / SYMPTOM' : 'EMOTIONAL';
    const example = isPhysicalPain
      ? 'user says "my stomach is killing me" → Grace opens "Ugh, stomach pain like that is rough. Where exactly is it sitting?" — NEVER opens with food log status or daily protein totals.'
      : 'user says "I feel like I\'m failing" → Grace opens "That feeling can hit so hard when you\'re putting in the effort. What\'s been making it feel like failing lately?" — NEVER opens with food.';
    return [{
      code: 'emotion_before_data',
      message: `Response to a ${kind} message MUST open with empathic acknowledgment — NOT food logging / protein numbers / data ("you haven't logged anything", "you're at 0g", etc.). The user said: "${userMessage.slice(0, 100)}". The first sentence currently starts with data ("${firstSentence.slice(0, 80)}..."). REWRITE: open with one warm sentence acknowledging the feeling or pain. Food / protein totals are IRRELEVANT to a pain message — drop them entirely. Example: ${example}`,
      severity: 'regen',
    }];
  }
  return [];
}

// ── Dead-end emotional ack guard (2026-06-06) ─────────────────────────────────
// When the user expresses an emotion, the response must engage with it — not
// stamp it. Bare one-line acks ("I hear you.", "Got it.", "Noted.",
// "Understood.", "Thanks for sharing.") create a conversational dead-end.
//
// Per the 4-step framework: recognize + (optional context) + gentle open
// question + (optional personalization). A response of one short sentence
// that's JUST an acknowledgment with no follow-on door fails this check.
//
// Excluded from the guard:
//   - Responses that are NOT replying to an emotional user message.
//   - Responses that have a follow-on question or substantive second
//     sentence (the four-step framework is met).
//   - Responses where the emotional acknowledgment is part of a richer
//     reply (e.g. "I hear you. What's the heaviest piece of it?" — fine).

/** A bare acknowledgment phrase the response consists ENTIRELY of. */
const DEAD_END_ACK_RE = /^(?:i hear you|got it|noted|understood|thanks for sharing|i'?m here|with you on that|that'?s a lot)\.?\s*$/i;

/** Lightweight detector for emotion in the user's message — broader than the
 *  Level-2 / failure cases EMOTIONAL_USER_RE matches, so that even mild
 *  expressions of feeling ("I'm nervous", "I'm excited") trigger the
 *  dead-end guard. Intentionally permissive: false positives just nudge
 *  Grace to engage more richly, never block content. */
const EMOTION_USER_BROAD_RE = /\b(?:i'?m|im|i am|i feel|feeling)\s+(?:so |really |kind of |a bit |very |super |just )*(?:nervous|scared|afraid|worried|anxious|terrified|on edge|jittery|uneasy|apprehensive|fearful|excited|thrilled|disappointed|let down|sad|down|low|blue|hurt|hopeless|stuck|lost|defeated|exhausted|drained|burnt out|burned out|frustrated|annoyed|angry|upset|overwhelmed|stressed|confused|conflicted|empty|lonely|alone|ashamed|embarrassed|guilty|happy|content|relieved|grateful|proud)\b|\bfeel(?:ing)?\s+(?:like\s+)?(?:i'?m\s+)?(?:failing|drowning|breaking|cracking|stuck|trapped|lost|invisible|worthless|like giving up)\b/i;

function checkEmotionalDeadEnd(response: string, userMessage: string): ContentViolation[] {
  // Only enforce when the user clearly expressed an emotion.
  if (!EMOTION_USER_BROAD_RE.test(userMessage)) return [];
  // Strip leading/trailing whitespace + emoji noise for the match.
  const trimmed = response.trim().replace(/^[\p{Emoji}\s]+|[\p{Emoji}\s]+$/gu, '').trim();
  if (!DEAD_END_ACK_RE.test(trimmed)) return [];
  return [{
    code: 'emotional_dead_end',
    message: `Response to an emotional message is JUST a bare acknowledgment ("${trimmed}") — a conversational dead-end. Per the 4-step framework: recognize the feeling + add a brief contextual line OR a gentle open question that invites the user to share more. Example: user says "I'm nervous" → "Nervous makes a lot of sense before a shot — there's real uncertainty in it. What's the part that's weighing most?" — NOT just "I hear you."`,
    severity: 'regen',
  }];
}

// ── Prior-message re-litigation ──────────────────────────────────────────────
// When the user sends a message answering Grace's previous question (e.g.,
// "Im feeling it on the bottom left side" after Grace asked "where is it?"),
// Grace must respond to the LATEST message — not re-address sub-topics from
// the PRIOR user message (e.g., "Thanks" / "I slept well") that her own
// prior response already covered.
//
// Production failure 2026-06-02:
//   Previous user: "Thanks. I slept well, but my stomach is killing me"
//   Current user:  "Im feeling it on the bottom left side"
//   Grace's reply: "Anytime. Glad to hear you slept well, but ugh, that
//                   stomach pain sounds really rough, especially on the
//                   bottom left side. How long has it been hurting this
//                   time? Are you experiencing any other symptoms..."
//
// "Anytime" addresses "Thanks" from the prior message. "Glad to hear you
// slept well" addresses "I slept well" from the prior message. Both were
// already implicitly addressed by Grace's first response and have ZERO
// relevance to the current location answer.
//
// Detection: extract the closed sub-topics from the prior user message
// (thanks acknowledgments, sleep/eating updates, greeting tokens) and
// check if Grace's response references them — IF the current user message
// is on a different/continuing topic (i.e. not itself a "thanks" or sleep
// message).

const PRIOR_THANKS_RE = /\b(?:thanks|thank you|ty|appreciate (?:it|that))\b/i;
const PRIOR_SLEEP_UPDATE_RE = /\bi\s+(?:slept|woke up)\s+(?:well|good|great|fine|ok|okay|badly|rough|terribly)/i;
const PRIOR_ATE_UPDATE_RE = /\bi\s+(?:ate|had a (?:good|great|nice|big|small))\s+(?:breakfast|lunch|dinner|meal)/i;

const RESP_ANYTIME_OPENER_RE = /^anytime[\s!.,]/i;
const RESP_SLEEP_CALLBACK_RE = /\bglad to hear (?:you|that you)\s+(?:slept|woke up)\b/i;
const RESP_ATE_CALLBACK_RE = /\bglad to hear (?:you|that you)\s+(?:ate|had|enjoyed)\b/i;

function checkPriorMessageRelitigation(
  response: string,
  currentUserMessage: string,
  previousUserMessage: string,
): ContentViolation[] {
  // If the CURRENT user message is itself a "thanks" or sleep update,
  // those callbacks ARE relevant — skip this check.
  if (PRIOR_THANKS_RE.test(currentUserMessage)) return [];
  if (PRIOR_SLEEP_UPDATE_RE.test(currentUserMessage)) return [];

  const violations: ContentViolation[] = [];

  // 1) "Anytime" opener triggered by a "thanks" in the PRIOR user message
  //    (not the current one). The current message is a different topic, so
  //    "Anytime" is misplaced.
  if (PRIOR_THANKS_RE.test(previousUserMessage) && RESP_ANYTIME_OPENER_RE.test(response.trimStart())) {
    violations.push({
      code: 'prior_message_relitigation',
      message: `Response opens with "Anytime" — but the user's CURRENT message is "${currentUserMessage.slice(0, 80)}", not a thank-you. The "thanks" was in their PRIOR message and you already responded to that turn. Drop "Anytime" — answer ONLY the current message.`,
      severity: 'regen',
    });
  }

  // 2) "Glad to hear you slept well" referencing a sleep update from the
  //    PRIOR user message when the current message is about a different topic.
  if (PRIOR_SLEEP_UPDATE_RE.test(previousUserMessage) && RESP_SLEEP_CALLBACK_RE.test(response)) {
    violations.push({
      code: 'prior_message_relitigation',
      message: `Response includes "Glad to hear you slept well" — but the user's CURRENT message is "${currentUserMessage.slice(0, 80)}", not a sleep update. The sleep update was in their PRIOR message and is a CLOSED sub-topic. Drop the sleep callback — answer ONLY the current message.`,
      severity: 'regen',
    });
  }

  // 3) "Glad to hear you ate well" referencing an eating update from the
  //    PRIOR user message when the current message is about a different topic.
  if (PRIOR_ATE_UPDATE_RE.test(previousUserMessage) && RESP_ATE_CALLBACK_RE.test(response)) {
    violations.push({
      code: 'prior_message_relitigation',
      message: `Response includes "Glad to hear you ate/had X" — but the user's CURRENT message is "${currentUserMessage.slice(0, 80)}", not a meal update. The meal update was in their PRIOR message and is a CLOSED sub-topic. Drop the callback — answer ONLY the current message.`,
      severity: 'regen',
    });
  }

  return violations;
}

// ── User-message echo ────────────────────────────────────────────────────────
// Catches the bug where Grace echoes the user's own words back at the start of
// her response, e.g.:
//   User:  "Feeling good, just ate two eggs and salad"
//   Grace: "Feeling good, just ate two eggs and salad is about 15g protein..."
// This is a classic LLM auto-complete failure that reads like a chatbot
// parroting input. Triggers when ≥4 leading words of the response match the
// leading words of the user message verbatim (case- and punctuation-insensitive).
function normalizeForEcho(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 0);
}

function checkUserMessageEcho(response: string, userMessage: string): ContentViolation[] {
  const userWords = normalizeForEcho(userMessage);
  const respWords = normalizeForEcho(response);
  // Need enough words on both sides to be a real echo (not just "ok" / "yes").
  if (userWords.length < 4 || respWords.length < 4) return [];
  // Compare the first N=4 words. If they match, this is a verbatim echo.
  const N = 4;
  for (let i = 0; i < N; i++) {
    if (userWords[i] !== respWords[i]) return [];
  }
  return [{
    code: 'user_message_echo',
    message: `Response opens by echoing the user's own words back ("${userWords.slice(0, N).join(' ')}..."). Rewrite so the first words are Grace's own framing — never parrot the user's sentence as a prefix. Example: user says "Feeling good, just ate two eggs and salad" → Grace replies "Two eggs and a salad — about 15g protein. You're at Xg of your Yg target today." NOT "Feeling good, just ate two eggs and salad is about 15g..."`,
    severity: 'regen',
  }];
}

// ── Stale-context echo (FINAL LAYER — runs on EVERY response) ────────────────
//
// User directive 2026-06-01: "The context and memory issue cannot happen in
// any case again. The last layer should be that if Grace answers the last
// question without repeating any of the words [from prior turns]. This
// layer should be for every response."
//
// Production failure: user said "Morning, felling good" and Grace replied
// with "I apologize for the confusion. I incorrectly stated 40g earlier."
// The "40g" was a number from a PRIOR day's conversation — neither in the
// current user message nor in the current system context. This is the
// canonical stale-context echo: Grace surfacing a specific quantity from
// memory that has no anchor in the current turn.
//
// Detection: extract specific quantities (numbers with units) from Grace's
// response and verify each one is present in the legitimate scope of this
// turn — current user message OR system context OR current tool results.
// Anything else is treated as a stale echo and triggers regen.
//
// Why numbers and not arbitrary words: words like "you", "today",
// "protein", "feeling" recur naturally and aren't a memory leak. Specific
// quantities like "40g" / "120 kcal" / "175 lbs" / "Week 8" only enter a
// response when Grace is referencing concrete data — and that data must
// come from the current turn, not memory.

// Quantity patterns: matches "40g", "40 grams", "120 kcal", "175 lbs",
// "2 eggs", "30 mins", "Week 8", etc. Capture group 1 is the bare number
// so the whitelist check can match either "40g" verbatim or "40" near a
// similar unit in the scope text.
const RESPONSE_QUANTITY_RE = /\b(\d{1,4}(?:\.\d{1,2})?)\s*(g|grams?|kcal|kg|lbs?|pounds?|oz|ounces?|cal|calories|kj|mins?|minutes?|hours?|hrs?|days?|weeks?|months?|years?|eggs?|scoops?|cups?|tbsp|tsp|servings?|pieces?|slices?)\b/gi;
// "Week 8" / "Month 3" — capture the inverted form too (label before number).
const RESPONSE_INVERTED_QUANTITY_RE = /\b(week|month|year|day|stage|phase|month|level)\s+(\d{1,3})\b/gi;
// Numbers without units that we still care about — only flag bare integers
// 10+ that aren't already covered by a unit pattern. Smaller numbers
// (1-9) appear in natural prose ("a few", "one or two") so we skip them.
const RESPONSE_BARE_LARGE_NUMBER_RE = /\b(\d{2,4})\b(?!\s*(?:g|grams?|kcal|kg|lbs?|pounds?|oz|ounces?|cal|calories|mins?|minutes?|hours?|hrs?|days?|weeks?|months?|years?|eggs?|scoops?|cups?|am|pm|st|nd|rd|th))/gi;

interface ExtractedQuantity {
  /** The raw number captured (e.g. "40", "8"). */
  number: string;
  /** Whether the number is part of a labeled inverted pattern (e.g. "Week 8")
   *  — those are always meaningful regardless of magnitude. The bare-number
   *  and unit-suffixed patterns get the "skip if <= 9" small-number filter. */
  alwaysMeaningful: boolean;
}

function extractQuantities(text: string): ExtractedQuantity[] {
  const out: ExtractedQuantity[] = [];
  for (const m of text.matchAll(RESPONSE_QUANTITY_RE)) {
    if (m[1]) out.push({ number: m[1], alwaysMeaningful: false });
  }
  // Inverted patterns ("Week 8", "Month 3", "Day 12") — the LABEL makes the
  // number significant even when small, so it must be in scope.
  for (const m of text.matchAll(RESPONSE_INVERTED_QUANTITY_RE)) {
    if (m[2]) out.push({ number: m[2], alwaysMeaningful: true });
  }
  for (const m of text.matchAll(RESPONSE_BARE_LARGE_NUMBER_RE)) {
    if (m[1]) out.push({ number: m[1], alwaysMeaningful: false });
  }
  return out;
}

/**
 * Check if Grace's response contains specific quantities that aren't in
 * the legitimate scope of THIS turn (current user message, system context,
 * or current tool results). Stale quantities → regen.
 *
 * IMPORTANT: keep this conservative — false positives here cause needless
 * regen latency. The whitelist is generous (any appearance of the bare
 * number anywhere in scope counts as a match) so common cases pass through.
 */
function checkStaleContextEcho(
  response: string,
  userMessage: string,
  systemContext: string,
  toolResultsText: string,
): ContentViolation[] {
  const quantities = extractQuantities(response);
  if (quantities.length === 0) return [];

  const scope = `${userMessage} ${systemContext} ${toolResultsText}`.toLowerCase();
  // Treat numbers as legitimate when:
  //   1. The bare number appears anywhere in scope (e.g. response says "40g",
  //      system context shows "Total protein TODAY: 40g / 60g target").
  //   2. For non-labeled numbers only: the number is too small (1-9) to be a
  //      memory anchor — those appear naturally in prose ("a few", "3 days").
  //      Labeled patterns like "Week 8" are always meaningful even when small.
  const stale = quantities.filter((q) => {
    const num = parseFloat(q.number);
    if (Number.isNaN(num)) return false;
    if (!q.alwaysMeaningful && num <= 9) return false;
    return !scope.includes(q.number);
  }).map((q) => q.number);

  if (stale.length === 0) return [];

  // Dedupe so the regen message stays readable.
  const unique = Array.from(new Set(stale)).slice(0, 5);
  return [{
    code: 'stale_context_echo',
    message: `Response contains specific quantities not in the current message or context: ${unique.join(', ')}. These appear to be carried over from a prior turn (stale memory echo). Rewrite the response to answer ONLY the current message: "${userMessage.slice(0, 100)}". If you don't have a number for the current turn, don't invent one or recall an old one — just answer the actual question or feeling.`,
    severity: 'regen',
  }];
}

/**
 * Check text against DB-driven content rules loaded from the content_rules
 * table. Each rule carries its own severity so the orchestrator can decide
 * whether to block, regen, or just log the violation.
 *
 * Invalid regex patterns in the DB are silently skipped (never crash a user
 * response because an admin saved a bad pattern).
 */
export function checkDbRules(text: string, rules: DbContentRule[]): ContentViolation[] {
  const hits: ContentViolation[] = [];
  for (const rule of rules) {
    try {
      const re = rule.is_regex
        ? new RegExp(rule.pattern, rule.flags)
        : new RegExp(escapeRegex(rule.pattern), rule.flags);
      const m = re.exec(text);
      if (m) {
        hits.push({
          code: `db_rule_${rule.id}`,
          message: rule.reason,
          match: m[0],
          severity: rule.severity,
        });
      }
    } catch {
      // Invalid regex in DB — skip without crashing.
    }
  }
  return hits;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const NEGATION_WORDS = /\b(no|not|without|skip|avoid|never|except|exclude|other\s+than|aside\s+from|besides|free\s+of)\b/i;
const SENTENCE_END = /[.!?]/;

/**
 * Scan a response for any forbidden food words.
 *
 * Match rules:
 *   - Whole-word boundaries (so "cottage cheese" matches but "cheese" inside
 *     it doesn't double-flag — overlapping matches are deduped by position).
 *   - Case-insensitive.
 *   - Negation-aware at the SENTENCE level: if the same sentence contains
 *     "no / not / without / skip / avoid / never / except / free of" BEFORE
 *     the food word, the match is skipped. This propagates through list
 *     connectors so "Avoid chicken, beef, and pork" skips all three.
 *   - When a longer forbidden phrase ("cottage cheese") overlaps with a
 *     shorter one ("cheese"), the longer one wins.
 */
export function checkDietaryViolations(
  text: string,
  restriction: DietaryRestriction,
): ContentViolation[] {
  const lower = text.toLowerCase();

  // First pass: collect every match with start/end positions.
  const rawHits: Array<{ word: string; start: number; end: number }> = [];
  for (const word of restriction.forbidden) {
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`\\b${escaped}\\b`, 'gi');
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(lower)) !== null) {
      rawHits.push({ word, start: m.index, end: m.index + m[0].length });
      // Guard against zero-width matches (shouldn't happen with \b…\b but
      // pattern.lastIndex would loop forever if it did).
      if (m.index === pattern.lastIndex) pattern.lastIndex += 1;
    }
  }

  // Sort by length desc so the longer match wins overlap (e.g. "cottage
  // cheese" wins over "cheese" at the same position).
  rawHits.sort((a, b) => (b.end - b.start) - (a.end - a.start));

  // Dedupe overlapping positions: keep the first (longest) hit for each
  // span of characters.
  const taken: Array<[number, number]> = [];
  const dedupedByPos: typeof rawHits = [];
  for (const h of rawHits) {
    const overlaps = taken.some(([s, e]) => h.start < e && h.end > s);
    if (overlaps) continue;
    taken.push([h.start, h.end]);
    dedupedByPos.push(h);
  }

  // Negation gate: for each remaining hit, check whether its sentence
  // contains a negation word before the match.
  const allowed: ContentViolation[] = [];
  for (const h of dedupedByPos) {
    if (isNegated(lower, h.start)) continue;
    allowed.push({
      code: 'forbidden_food',
      message: `mentioned "${h.word}" but user is ${restriction.label}`,
      match: h.word,
    });
  }

  // Final dedupe by word so the same forbidden word reported multiple times
  // is collapsed.
  const seen = new Set<string>();
  const unique: ContentViolation[] = [];
  for (const h of allowed) {
    const key = h.match ?? h.code;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(h);
  }
  return unique;
}

/**
 * Returns true if the match position is preceded by a negation word within
 * the current sentence. Sentence boundary = last [.!?] before the match.
 */
function isNegated(lowerText: string, matchStart: number): boolean {
  // Find the start of the current sentence: walk back to the most recent
  // sentence-end character (or beginning of string).
  let sentenceStart = 0;
  for (let i = matchStart - 1; i >= 0; i--) {
    const ch = lowerText[i];
    if (ch !== undefined && SENTENCE_END.test(ch)) {
      sentenceStart = i + 1;
      break;
    }
  }
  const sentencePrefix = lowerText.slice(sentenceStart, matchStart);
  return NEGATION_WORDS.test(sentencePrefix);
}

// Banned phrases grouped by category: (1) emotional amplification ("Oh, I'm so
// sorry"), (2) alarm/panic language, (3) premature medical escalation,
// (4) artificial reactions, (5) fabricated technical excuses, (6) developer-
// feedback acks, (7) AI-cliche openers, (8) empathy cliches, (9) sycophantic
// acks, (10) capability denials, (11) profile-recall language, (12) corporate tone.
const BANNED_PHRASES: Array<{ pattern: RegExp; reason: string }> = [
  // Reminder/capability denial — Grace DOES send scheduled reminders. Exposing a
  // platform/LLM limitation contradicts the product and confuses the user.
  // Explain the schedule + redirect to Settings instead (2026-06-15).
  { pattern: /\bi (can'?t|cannot|am unable to|am not able to|do not have the ability to|don'?t have the ability to) (send|schedule|set ?up|initiate|deliver) (you )?(a |any )?(reminders?|messages?|texts?|check.?ins?|notifications?)\b/i, reason: 'capability denial about reminders — Grace DOES send them; explain schedule + redirect to Settings' },
  { pattern: /\bi (don'?t|do not) have (the ability|access) to (send|schedule|initiate|set|deliver)\b/i, reason: '"I don\'t have the ability/access to..." — capability denial, banned; explain config instead' },
  { pattern: /\bi'?m unable to (send|schedule|initiate|deliver) (you )?(a |any )?(reminders?|messages?|texts?|check.?ins?)\b/i, reason: '"I\'m unable to send reminders" — capability denial, banned' },
  { pattern: /\bi (can'?t|cannot) initiate (messages?|texts?|conversations?|reminders?)\b/i, reason: '"I can\'t initiate messages" — capability denial, banned' },
  { pattern: /\binitiate (a )?(messages?|texts?|conversations?) (at a future time|in the future|on my own|proactively)\b/i, reason: '"initiate messages at a future time" — exposes scheduler internals, banned' },

  // Emotional amplification — sounds like a therapy chatbot, not a calm companion
  { pattern: /\boh,?\s*i'?m so sorry\b/i, reason: '"Oh, I\'m so sorry" — emotional amplification, banned' },
  { pattern: /\boh no,?\s*i'?m sorry\b/i, reason: '"Oh no, I\'m sorry" — emotional amplification, banned' },
  { pattern: /^oh no[,!.]/im, reason: '"Oh no" opener — artificial customer-service tone, banned' },
  { pattern: /\bi'?m (so )?sorry to hear\b/i, reason: '"I\'m sorry to hear" — emotional amplification, banned' },
  { pattern: /\bi'?m sorry you'?re (going|dealing|struggling)\b/i, reason: '"I\'m sorry you\'re going through this" — emotional amplification, banned' },
  { pattern: /\bsounds? incredibly (difficult|hard|confusing|tough)\b/i, reason: '"sounds incredibly difficult" — emotional amplification, banned' },
  { pattern: /\bconcerns? me deeply\b/i, reason: '"concerns me deeply" — emotional amplification, banned' },
  { pattern: /\breally (concerns|worries) me\b/i, reason: '"really concerns me" — emotional amplification, banned' },
  { pattern: /\bthat must be (so|really|incredibly) (hard|difficult|tough|confusing|frustrating)\b/i, reason: '"that must be so hard" — emotional projection, banned' },
  { pattern: /\bplease know that\b/i, reason: '"please know that" — preachy tone, banned' },
  { pattern: /\bi just want you to know\b/i, reason: '"I just want you to know" — preachy tone, banned' },
  { pattern: /\bwhat really stands out\b/i, reason: '"what really stands out" — therapy-speak, banned' },

  // Alarm / panic language — health concerns need calm intelligence, not warning labels
  { pattern: /\bthat is (generally )?(considered )?(too fast|unhealthy|dangerous)\b/i, reason: '"that is too fast/unhealthy/dangerous" — alarm language, rephrase with context and nuance' },
  { pattern: /\bthat'?s? (too fast|unhealthy|dangerous|alarming)\b/i, reason: '"that\'s too fast/unhealthy" — alarm language, use hedged phrasing' },
  { pattern: /\ba very significant amount\b/i, reason: '"a very significant amount" — alarm language, acknowledge calmly instead' },
  { pattern: /\bpotentially (unhealthy|dangerous|harmful)\b/i, reason: '"potentially unhealthy/dangerous" — alarm language, reframe with context' },
  { pattern: /\bthat'?s? (concerning|alarming)\b/i, reason: '"that\'s concerning/alarming" — alarm language, use calm exploration instead' },
  { pattern: /\bi'?m (worried|concerned) about\b/i, reason: '"I\'m worried/concerned about" — alarm language, Grace observes calmly without dramatizing' },
  { pattern: /\bthis is (bad|dangerous|serious|alarming)\b/i, reason: '"this is bad/dangerous" — alarm language, use nuanced framing' },

  // Premature medical escalation — Grace gathers context before escalating
  { pattern: /\bcontact your (healthcare provider|doctor|clinician) (right away|immediately|as soon as possible|urgently)\b/i, reason: '"contact doctor right away" — premature escalation, gather context first and use conditional framing ("if this continues/worsens")' },
  { pattern: /\b(call|see|visit|reach out to) (your|a) (doctor|healthcare provider|clinician) (right away|immediately|ASAP)\b/i, reason: 'immediate medical escalation — use gradual conditional escalation instead' },
  { pattern: /\bseek (immediate )?medical (attention|help|care) (right away|immediately)?\b/i, reason: '"seek medical attention" — reserved for SafetyGuard emergencies only, not common side effects' },
  { pattern: /\byou (need|should|must) (see|call|visit|contact) (a |your )(doctor|clinician|provider)\b/i, reason: 'directive medical escalation — use conditional "if X continues/worsens, worth mentioning to your doctor"' },

  // Artificial emotional reactions — Grace is calm, not dramatic
  { pattern: /^oh dear\b/im, reason: '"Oh dear" — artificial emotional reaction, banned' },
  { pattern: /^oh my\b/im, reason: '"Oh my" — artificial emotional reaction, banned' },
  { pattern: /^oh gosh\b/im, reason: '"Oh gosh" — artificial emotional reaction, banned' },
  { pattern: /^oh wow\b/im, reason: '"Oh wow" — artificial emotional reaction, banned' },
  { pattern: /^yikes\b/im, reason: '"Yikes" — artificial emotional reaction, banned' },
  // ── 2026-06-03 production screenshots: "Ugh" / "Sigh" openers are not
  // empathetic — they read as Grace being annoyed or emotionally drained by
  // the user. Hard-banned regardless of position (Grace was using them
  // mid-sentence too: "Anytime. Glad to hear you slept well, but ugh, that
  // stomach pain sounds rough."). Matches "ugh," "ugh," "ugh!" anywhere.
  { pattern: /\bugh[,.!\s—-]/i, reason: '"Ugh" — sounds annoyed/drained, never empathetic. Drop it entirely.' },
  { pattern: /\bsigh[,.!\s—-]/i, reason: '"Sigh" — sounds emotionally exhausted by the user, banned' },

  // Meta-AI self-awareness — Grace never talks about herself as a system/AI/model
  { pattern: /\binternal processing error\b/i, reason: '"internal processing error" — meta-AI self-reference, banned' },
  { pattern: /\bgenerated similar (advice|response|answer)\b/i, reason: 'meta-AI self-reference about generating responses, banned' },
  { pattern: /\bi might over-?emphasize\b/i, reason: 'meta-AI self-awareness about behavior patterns, banned' },
  { pattern: /\bi'?ll strive to be more\b/i, reason: '"I\'ll strive to be more" — meta-AI improvement promise, banned' },
  { pattern: /\bavoid such redundancies\b/i, reason: 'meta-AI self-correction language, banned' },
  { pattern: /\bmy (apologies|response|algorithm|system|processing)\b/i, reason: 'meta-AI self-reference, banned' },
  { pattern: /\bthere was (a|an) (internal|processing|system) (error|issue|glitch)\b/i, reason: 'meta-AI error acknowledgment, banned' },
  { pattern: /\b(as an AI|as a language model|as a chatbot|as an assistant)\b/i, reason: 'AI self-identification, banned' },
  // Unprompted self-apology for previous turns. Production failure 2026-06-01:
  // user said "Morning, felling good" and Grace replied "I apologize for the
  // confusion. It looks like there was a mix-up in my tracking, and I
  // incorrectly stated 40g earlier. My apologies for that." Grace must never
  // bring up her own past errors when the user didn't ask about them.
  { pattern: /\bi apologize for (the )?(confusion|mix.?up|misunderstanding|error|mistake|inaccuracy)\b/i, reason: '"I apologize for the confusion" — unprompted self-correction; do not surface past mistakes' },
  { pattern: /\bi (incorrectly|wrongly|mistakenly) (stated|said|reported|claimed|mentioned)\b/i, reason: '"I incorrectly stated X earlier" — referencing past Grace mistakes without being asked, banned' },
  { pattern: /\bthere was (a|an)?\s*mix.?up (in|with) my (tracking|records|log|notes|memory)\b/i, reason: '"There was a mix-up in my tracking" — developer voice about Grace\'s internal state, banned' },
  { pattern: /\b(let me )?(get it logged correctly|correct (the|my) (log|tracking|records?))\b/i, reason: 'Self-correction framing after a brief greeting — banned (don\'t volunteer cleanup)' },
  { pattern: /\bbased on what i have logged\b/i, reason: 'Developer-voice phrasing about Grace\'s state. Use "your log shows" or just answer.' },
  { pattern: /\b(could|can) you (tell me|let me know) what you'?ve eaten (so far )?today\b/i, reason: 'Asking the user to re-state today\'s meals in response to a brief greeting is wrong — banned' },

  // Model-identity leak — Grace must NEVER reveal her underlying model, vendor,
  // or training. Production bug (2026-05-29): "hoe many users you have" →
  // Grace replied "I'm a large language model developed by Google, and I'm
  // integrated into various applications and services…". Triple-layer defense:
  // (1) scope guard catches the question, (2) this content checker catches
  // any leaked answer, (3) regen with explicit instruction.
  { pattern: /\bi'?(?:m| am)\s+(?:an?\s+)?(?:large\s+)?language\s+model\b/i, reason: 'Model identity leak — never say "I am a language model"' },
  { pattern: /\bdeveloped\s+by\s+(google|openai|anthropic|meta|microsoft|deepmind)\b/i, reason: 'Vendor identity leak — never name the AI vendor' },
  { pattern: /\b(?:trained|built|created|made)\s+by\s+(google|openai|anthropic|meta|microsoft|deepmind)\b/i, reason: 'Vendor identity leak — never name the AI vendor' },
  { pattern: /\bi'?(?:m| am)\s+(?:powered\s+by\s+|based\s+on\s+|running\s+on\s+)?(gemini|gpt|chatgpt|claude|llama|mistral|palm|bard)\b/i, reason: 'Model name leak — never identify the underlying model' },
  { pattern: /\bi'?(?:m| am)\s+(?:integrated\s+into|deployed\s+as|available\s+(?:in|on))\s+(?:various|multiple|many)\s+(applications|services|platforms|products)\b/i, reason: 'Platform-integration leak — Grace exists only as Grace' },
  { pattern: /\bmy\s+(training|training\s+data|knowledge\s+cutoff|model|weights|parameters)\b/i, reason: 'Training/model internals leak, banned' },
  { pattern: /\bi\s+don'?t\s+have\s+(?:a\s+)?(?:specific\s+)?(?:count|number|figure|total|tally)\s+of\s+(?:["']?users["']?|people|members|customers)/i, reason: 'Discussing user counts at all — refuse via scope guard, never engage' },
  { pattern: /\bmy\s+(?:interactions?|conversations?|responses?)\s+(?:happen|occur|take\s+place|are)\s+(?:across|on|in|over)\s+(?:many|multiple|various|different|several)\b/i, reason: 'Platform-spread leak — Grace exists only as Grace, not across platforms' },
  { pattern: /\b(?:across|on|in|over)\s+(?:many|multiple|various|several)\s+(?:different\s+)?(?:applications?|apps?|services?|platforms?|products?)\b/i, reason: 'Platform-spread leak — never describe being deployed across platforms' },
  { pattern: /\bi'?(?:m| am)\s+(?:an?\s+)?(?:ai\s+|virtual\s+|digital\s+)?(?:assistant|model|bot|program|system|tool)\s+(?:developed|built|created|made|trained|powered|designed|operated)\b/i, reason: 'AI self-description leak — Grace is Grace, not "an AI assistant developed by…"' },
  // 2026-06-05 production failures — Gemini emitted AI refusal disclaimers
  // ("I cannot provide personalized dietary advice", "My purpose is to help
  // with tasks like summarizing information") despite the system prompt
  // forbidding them. Banning every form so they never reach the user.
  { pattern: /\bi\s+cannot\s+provide\s+(?:you\s+(?:with\s+)?)?(?:personalized|specific|individual|tailored|medical|dietary|health|nutrition(?:al)?|professional)\b/i, reason: 'AI refusal disclaimer — Grace must answer, not refuse with "I cannot provide personalized X"' },
  { pattern: /\bi\s+(?:am|'m)\s+(?:an\s+)?ai\s+and\s+(?:do\s+not|don'?t|cannot|can'?t)\s+have\s+access\b/i, reason: 'AI assistant disclaimer — refuses access to user data' },
  { pattern: /\bmy\s+purpose\s+is\s+to\s+(?:help|assist)\s+with\s+(?:tasks|questions|things)\b/i, reason: 'Generic chatbot purpose statement — Grace is a specific GLP-1 companion, not a generic helper' },
  { pattern: /\bi\s+am\s+not\s+equipped\s+to\b/i, reason: 'Refusal phrase — Grace answers what she can with what she knows' },
  { pattern: /\bi\s+do\s+not\s+have\s+access\s+to\s+your\s+(?:personal|medical|health|individual)\b/i, reason: 'AI disclaimer about user data access' },
  { pattern: /\bconsult\s+(?:with\s+)?(?:your\s+)?(?:doctor|healthcare\s+provider|physician|registered\s+dietitian)\s+(?:or\s+(?:a\s+)?(?:registered\s+dietitian|healthcare\s+provider|doctor))\b/i, reason: 'Double-redirect to professionals — generic AI deflection rather than substantive help' },
  { pattern: /\bto\s+get\s+accurate\s+information\s+about\s+your\b/i, reason: 'AI deflection — "to get accurate information about your X, consult Y"' },
  { pattern: /\bunderstanding\s+your\s+individual\s+(?:dietary\s+)?(?:needs|preferences|health\s+conditions|goals)\b/i, reason: 'AI deflection phrasing about needing to understand individual needs' },

  // 2026-06-05 production failures (week of screenshots audit). These exact
  // strings were typed fallbacks earlier today, removed because they LIED
  // about producing a follow-up that never came. Ban them globally so even
  // if the LLM emits the same phrasing (or a rotated typed fallback re-
  // introduces it), the content-checker rejects.
  { pattern: /\bgive\s+me\s+a\s+(?:moment|sec|minute|second)\s+to\s+(?:get|figure|pull|grab|look)\b/i, reason: 'Lying fallback — promises to look something up but never does' },
  { pattern: /\bbear\s+with\s+me,?\s+(?:pulling|getting|grabbing|looking|figuring)\b/i, reason: 'Lying fallback — promises action that never completes' },
  { pattern: /\bone\s+sec,?\s+(?:i\s+want\s+to\s+give|let\s+me\s+(?:give|get|pull|look)|pulling|getting)\b/i, reason: 'Lying fallback — "one sec, let me…" never delivers' },
  { pattern: /\bof\s+course\s+[—\-,]\s+what\s+works\s+better\s+for\s+you\b/i, reason: 'Settings-question deflection — should redirect to graceglp.com/settings, not ask' },
  { pattern: /\bof\s+course!?\s+(?:happy|glad)\s+to\s+(?:help|adjust)\b/i, reason: 'AI assistant opener' },

  // Topic-switching follow-up questions after a log — the user told you what
  // they ate / weighed / did. Don't pivot to a generic "how's your day?"
  // question that ignores what they just shared. Allow up to ~40 chars
  // between the log acknowledgement and the pivot question so we catch
  // "Got it, that's tracked. How's your day going?" etc.
  { pattern: /\b(?:logged|got it|tracked|noted)\b[^.?!]{0,40}[.!?]?\s+how\s+(?:are\s+you\s+feeling|'?s\s+your\s+(?:day|week|night)|is\s+your\s+(?:day|week|night)|('?s|is)\s+(?:everything|things)|are\s+things)\b/i, reason: 'Topic-switching after a log — pivots away from what user just said' },
  { pattern: /\blogged\s+that\s+for\s+you\b/i, reason: 'Patronizing acknowledgement — just "Logged." or with the macros is enough' },
  // 2026-06-05: also ban the standalone trailing "How's your day going?" /
  // "How are you feeling today?" when they appear at the END of a response
  // (after a period) — these are the topic-switch pattern in any form.
  { pattern: /[.!]\s+how'?s\s+your\s+(?:day|week|night)\s+(?:going|been)\s*\??\s*$/i, reason: 'Ends with topic-switching "How\'s your day going?"' },
  { pattern: /[.!]\s+how\s+are\s+you\s+feeling\s+(?:today|now|after that)\s*\??\s*$/i, reason: 'Ends with topic-switching "How are you feeling today?"' },

  // Sycophantic / ChatGPT-style template openers
  { pattern: /\bto\s+give\s+you\s+the\s+best\s+(?:recommendations?|suggestions?|advice|answer|guidance)\b/i, reason: 'ChatGPT-style "to give you the best X, I need to know Y" preamble' },
  { pattern: /\bi\s+need\s+a\s+little\s+more\s+information\s+about\s+you\b/i, reason: 'AI clarification stalling — answer with what you have' },
  { pattern: /\bwhat\s+kind\s+of\s+meal\s+are\s+you\s+thinking,?\s+breakfast,?\s+lunch,?\s+dinner,?\s+or\s+a?\s*snack\b/i, reason: 'Tone-deaf food fallback — echoes back what user already said (often they named the meal)' },

  // Bullet/numbered prose leak — Gemini occasionally types out a list as
  // prose like "1. Foo. 2. Bar. 3. Baz." Strip the visible numbering.
  { pattern: /\b\d+\.\s+[A-Z][a-z]+\s+[a-z]+\.?\s+\d+\.\s+[A-Z]/i, reason: 'Numbered list in prose ("1. Foo. 2. Bar.")' },

  // Asking for clarification on food logs instead of just logging — generalized
  { pattern: /\bhow much (protein|calories?|carbs?|fat|fiber|sugar) (was |were |is )?in (your |the |that )/i, reason: 'Asking macro detail — just estimate and log' },
  { pattern: /\b(what|which|what kind of|what type of|what brand) (was |were |is )?in (your |the |that )/i, reason: 'Asking what was in the food — just estimate and log with best guess' },
  { pattern: /\bcan you tell me (more about|what was in|what kind|the brand)/i, reason: 'Asking for food details — just estimate' },
  { pattern: /\b(how big|how large|how small|what size|what portion) (was |were |is )?(your |the |that |it )/i, reason: 'Asking for portion size — estimate from common sense' },
  { pattern: /\bdo you (remember|recall|know) (the )?(brand|portion|amount|exact|specific)\b/i, reason: 'Asking the user to recall specifics — just estimate' },
  { pattern: /\bcould you (clarify|specify|tell me|let me know)\b.{0,40}(food|meal|portion|amount|brand)/i, reason: 'Clarification request on food — just log it' },

  // Sycophantic exclamations / generic openers — generalized to any
  // single-word praise opener followed by ! or , at line start
  { pattern: /^(great|awesome|wonderful|perfect|fantastic|amazing|excellent|brilliant|marvelous|splendid|terrific|superb|outstanding|incredible|stellar|nice job|good job|way to go|kudos)\s*[!,]/im, reason: 'Sycophantic exclamatory opener — Grace is calm and warm, not a cheerleader' },

  // ── 2026-05-30 clinical-report banned phrases ─────────────────────────────
  // Wellness-corporate jargon and validated-feeling cliches that the report
  // flagged as breaking the peer-companion tone. Each is matched verbatim
  // (with apostrophe variants) so a single regex won't accidentally catch
  // legitimate uses of the underlying words.
  { pattern: /\bi understand how (frustrating|hard|difficult|tough)\b/i, reason: '"I understand how frustrating" — clinical empathy cliche, banned by 2026-05-30 report' },
  { pattern: /\bit'?s completely understandable\b/i, reason: '"It\'s completely understandable" — validation cliche, banned' },
  { pattern: /\b(incredibly|quite|really|very)\s+common(\s+(challenge|experience|issue|problem|side[\s-]?effect))?\b/i, reason: '"X common" framing — flattens user\'s specific experience, banned' },
  { pattern: /\bcommon\s+experience\s+for\s+many\s+people\b/i, reason: '"common experience for many people" — depersonalizing cliche, banned' },
  { pattern: /\bit'?s actually quite common to (hit|experience|have)\s+(plateaus|stalls?|setbacks?)\b/i, reason: '"it\'s actually quite common to hit plateaus" — verbatim banned phrase from report' },
  { pattern: /\bthat'?s a really (understandable|valid|complex)\s+(worry|concern|feeling|emotion|fear|fears|anxiety|thought)\b/i, reason: '"That\'s a really understandable/complex …" — validation cliche, banned' },
  { pattern: /\bthat'?s a (really |very |so )?(understandable|valid|common)\s+(and\s+(common|understandable|valid)\s+)?(fear|worry|concern|anxiety)\b/i, reason: '"That\'s a really understandable and common fear" — pure validation filler, banned' },
  { pattern: /\b(common|understandable)\s+(and\s+)?(common|understandable)\s+(fear|worry|concern|anxiety|thought)\b/i, reason: '"common and understandable fear/worry" — dual-validation filler, banned' },
  { pattern: /\bit takes a lot of courage to (work\s+towards|begin|start|stick|commit)\b/i, reason: '"It takes a lot of courage to..." — AI-generated motivational filler, banned' },
  { pattern: /\bmany people on a (weight loss|glp-?1|wellness|health)\s+journey\s+(experience|feel|face|go through)\b/i, reason: '"Many people on a weight loss journey experience…" — depersonalizing cliche, banned' },
  { pattern: /\bthe thought of (losing that progress|gaining (it|the weight) back|not maintaining|relapsing)\s+can be (scary|hard|frightening|overwhelming|daunting)\b/i, reason: 'Restating the user\'s fear as filler — banned. Reframe and offer one practical step instead' },
  { pattern: /\bit'?s something (so many|many|a lot of) (people|users|women|men)\s+(feel|experience|go through)\b/i, reason: '"It\'s something many people feel" — depersonalizing, banned' },
  { pattern: /\bthat fear is (so|really|very|completely)\s+valid\b/i, reason: '"That fear is so valid" — pure validation filler, banned. Validate + reframe + practical step instead' },
  { pattern: /\bit'?s a (very |really )?valid concern\b/i, reason: '"It\'s a very valid concern" — clinical validation cliche, banned' },

  // ── 2026-05-30 Session 3 + full-feedback banned phrases ──────────────────
  { pattern: /\byou'?re asking a really important question\b/i, reason: '"You\'re asking a really important question" — patronizing opener, banned' },
  { pattern: /\bit'?s excellent that you'?re thinking about\b/i, reason: '"It\'s excellent that you\'re thinking about this" — patronizing, banned' },
  { pattern: /\b(these are )?absolutely critical questions\b/i, reason: '"absolutely critical questions" — warning-label language, banned in clinical redirects' },
  { pattern: /\byou\s+must\s+discuss\s+(?:this\s+|these\s+)?(?:with\s+(?:your\s+)?(?:doctor|provider|prescriber))/i, reason: '"you MUST discuss with your doctor" — pharmaceutical warning tone, use the warm template instead' },
  { pattern: /\byou\s+should\s+not\s+make\s+any\s+changes\b/i, reason: '"you should not make any changes" — preachy redirect, banned' },
  { pattern: /\bwithout\s+their\s+explicit\s+guidance\b/i, reason: '"without their explicit guidance" — warning-label phrasing, banned' },
  { pattern: /\bit'?s really important to share this feeling with your (doctor|provider|prescriber)/i, reason: 'Sending an emotional/plateau message to the doctor — wrong redirect, educate + empathize instead' },
  { pattern: /\bhope it hit the spot\b/i, reason: '"Hope it hit the spot" — greeting-card filler, banned' },
  { pattern: /\b(sounds|sounded)\s+like\s+a\s+(good|nice|classic)\s+(breakfast|lunch|dinner|meal|snack)\b/i, reason: 'Generic meal compliment without logging — log the food instead' },
  { pattern: /\blayers? of complexity\b/i, reason: '"layers of complexity" — vague filler, give specific information' },
  { pattern: /\bholistic approach\b/i, reason: '"holistic approach" — wellness jargon, be specific instead' },
  { pattern: /\bmore careful monitoring\b/i, reason: '"more careful monitoring" — vague, name what to monitor specifically' },

  // ── 2026-06-03 memory-limitation exposure (CRITICAL launch rule) ────────
  // Users should never see internal AI/system disclaimers. If context is
  // missing, ask a NATURAL clarifying question instead of explaining that
  // Grace's memory is limited. Each pattern triggers regen with the
  // instruction "ask a natural clarifying question, do not explain memory".
  { pattern: /\bi (?:lost|don'?t have) (?:the |any |access to )?(?:context|conversation|previous (?:messages?|turns?)|history|earlier (?:parts?|messages?|conversation))/i, reason: 'Exposing memory limitations — ban. Ask a natural clarifying question instead.' },
  { pattern: /\bmy memory (?:doesn'?t|does not) (?:carry over|persist|work that way|hold|retain)\b/i, reason: 'Exposing memory limitations — ban' },
  { pattern: /\bi can'?t see (?:earlier|previous|prior|past) (?:parts?|messages?|turns?|conversation|content)\b/i, reason: 'Exposing memory limitations — ban' },
  { pattern: /\bi don'?t (?:have|maintain|keep|retain) (?:memory|history|context) (?:of|from|across)\b/i, reason: 'Exposing memory limitations — ban' },
  { pattern: /\bi don'?t remember what (?:you|we) (?:told me|said|asked|mentioned|discussed) (?:before|earlier|previously|last time)\b/i, reason: 'Exposing memory limitations — ban' },
  { pattern: /\bi (?:don'?t have|lack|missing) (?:access to|the ability to recall|the context (?:to|of))\b/i, reason: 'Exposing memory/access limitations — ban' },
  { pattern: /\b(?:my )?(?:context|conversation) (?:window|history|limit|limitation)\b/i, reason: 'Exposing system/context limitations — ban' },

  // ── 2026-06-03 production screenshots: corporate medical-advice deflection
  // "While I'm here to support you on your GLP-1 journey, I can't give medical
  // advice" — this is the lazy fallback for ANY drug-interaction question and
  // it strips Grace of all her real knowledge. Grace knows common GLP-1 drug
  // interactions (NSAIDs/ibuprofen, alcohol, insulin, sulfonylureas) and
  // should answer with the knowledge she has, ending with a "your pharmacist
  // can confirm specifics" warm redirect — NOT a flat refusal.
  { pattern: /\bi\s+can'?t\s+give\s+(?:you\s+)?(?:any\s+)?medical\s+advice\b/i, reason: '"I can\'t give medical advice" — flat refusal, banned. Answer with what you know + warm pharmacist/doctor redirect for specifics.' },
  { pattern: /\bwhile\s+i'?m\s+here\s+to\s+support\s+you\s+on\s+your\s+glp-?1\s+journey,?\s*i\s+can'?t\b/i, reason: 'Corporate disclaimer opener before refusing — banned. Just answer or warmly redirect.' },

  // ── 2026-06-03 production screenshots: passive-aggressive clarifications
  // "Tell me a bit more so I can actually help" / "so I can give you
  // something useful" implies the user's input wasn't useful — feels
  // dismissive on a vulnerable message ("I have no appetite, is that the
  // medication?" → this passive-aggressive prompt instead of an answer).
  { pattern: /\bso\s+(?:i\s+can\s+)?(?:actually\s+)?(help|be\s+useful)\b/i, reason: '"so I can actually help" / "so I can be useful" — implies the user wasn\'t helpful. Use "so I can support you" instead.' },
  { pattern: /\bso\s+i\s+can\s+give\s+you\s+something\s+useful\b/i, reason: '"so I can give you something useful" — implies the previous turn wasn\'t useful, banned' },
  { pattern: /\btell\s+me\s+(?:a\s+bit\s+)?more\s+(?:about\s+what'?s\s+going\s+on\s+)?so\s+(?:i\s+can\s+)?(?:actually\s+help|give\s+you\s+something)/i, reason: '"Tell me more so I can actually help/give you something" — passive-aggressive ask, banned' },

  // ── 2026-06-02 production screenshot bans ────────────────────────────────
  // Production failures from the stomach-pain screenshots produced two
  // clusters of bugs. The CROSS-TURN re-litigation cluster (where Grace's
  // response addresses sub-topics from the PRIOR user turn instead of the
  // current one) is handled by checkPriorMessageRelitigation — those bans
  // are CONTEXT-AWARE, not unconditional, because the same phrases ARE
  // correct when the current message contains the matching content
  // (e.g. "Glad to hear you slept well" IS the right opener when the user's
  // current message contains "I slept well").
  //
  // The bans below are the ALWAYS-wrong cluster:
  //   1) patronizing memory callbacks ("you've mentioned this before")
  //   2) "this time" memory recall sneaking into questions
  // Both are wrong regardless of conversation state.
  { pattern: /\byou(?:'?ve)?\s+(?:mentioned|talked about|brought (?:this|that|it) up|said|told me|noted)\s+(?:this|that|it)\s+(?:before|earlier|previously|in the past|last (?:time|week))\b/i, reason: '"You\'ve mentioned this before" — patronizing memory callback. Never surface that the user repeated themselves; just answer the current message.' },
  { pattern: /\byou (?:said|mentioned|told me)\s+(?:earlier|previously|before|last (?:time|week))\s+(?:that\s+)?you\b/i, reason: 'Surfacing past statements ("you said earlier that you...") is patronizing. Drop the callback, answer the current message.' },
  { pattern: /\blast time you (?:mentioned|said|told me|brought up)\b/i, reason: '"Last time you mentioned X" — irrelevant memory callback, banned' },
  { pattern: /\bhow long has (?:it|this) been\s+(?:hurting|happening|going on|like this|bothering you)\s+(?:this time|again)\b/i, reason: '"How long has it been hurting THIS TIME / AGAIN" — "this time"/"again" sneaks in patronizing memory recall, banned. Use "how long has it been hurting?" instead.' },

  // ── Protein-from-goal-weight factual error ───────────────────────────────
  // The feedback flagged Grace saying "per kilogram of your goal body weight"
  // — incorrect. Should be current body weight. Forces regen with the right phrasing.
  { pattern: /\bper\s+kilogram\s+of\s+your\s+goal\s+(body\s+)?weight\b/i, reason: 'Protein target uses CURRENT body weight, not goal weight — factually incorrect' },
  { pattern: /\bper\s+kg\s+of\s+(your\s+)?goal\s+(body\s+)?weight\b/i, reason: 'Protein target uses CURRENT body weight, not goal weight — factually incorrect' },

  // ── Wrong redirect on "Ozempic isn't working anymore" ────────────────────
  // This is emotional/plateau venting, not a clinical question. The feedback
  // gave this as a critical wrong call. Block redirect framing on the topic.
  { pattern: /\b(share|talk to|discuss|reach out)\b[^.?!]{0,60}\b(doctor|provider|prescriber|clinician|healthcare provider)\b[^.?!]{0,60}\b(isn'?t working|not working anymore|stopped working|feels? like|feeling like|frustrated|frustration)\b/i, reason: 'Redirecting an emotional/plateau message to doctor — educate + empathize instead' },
  { pattern: /\b(feels? like|feeling like|i feel like)\b[^.?!]{0,40}\b(?:medication|ozempic|wegovy|mounjaro|shot|injection|it)\s+(isn'?t|is\s+not|stopped)\s+working\b[^.?!]{0,80}\b(doctor|provider|prescriber|clinician)\b/i, reason: 'Redirecting "isn\'t working anymore" feeling to doctor — wrong call, educate calmly' },

  // ── List-introducing phrases (H3 in prompt) ──────────────────────────────
  // These guarantee a list follows. Block + force prose rewrite.
  { pattern: /\bhere'?s a breakdown\b/i, reason: '"Here\'s a breakdown" — introduces a list, rewrite as prose' },
  { pattern: /\bhere'?s why it'?s happening\b/i, reason: '"Here\'s why it\'s happening" — introduces a list, rewrite as prose' },
  { pattern: /\bhere'?s what you can do\b/i, reason: '"Here\'s what you can do" — introduces a list, rewrite as prose' },
  { pattern: /\bhere are (the |some |a few |my )?(key |main |important |top )?(points|tips|things|options|suggestions|ideas|steps|reasons|causes|ways)\b/i, reason: '"Here are the X" — introduces a list, rewrite as prose' },
  { pattern: /^why it'?s happening:?$/im, reason: '"Why it\'s happening:" header — banned, write prose' },
  { pattern: /^(what to do|causes?|solutions?|tips|steps|key points?|main points?):/im, reason: 'Header line followed by colon — banned, write prose' },

  // ── Image capability denial — Grace CAN see and analyze images ────────────
  // After Grace has already analyzed an image, denying capability contradicts
  // the previous turn and destroys user trust. These patterns block any reply
  // that claims Grace can't see/receive/analyze images.
  { pattern: /\bi (cannot|can'?t|am (not|unable))\s+(actually\s+)?(see|view|access|receive|read|analyze|process|look at|interpret)\s+(images?|pictures?|photos?|pics?|the (image|picture|photo))/i, reason: 'Denying image capability — Grace HAS visual analysis via Gemini, never deny' },
  { pattern: /\b(as|i'?m) a text[\s-]based ai\b/i, reason: '"text-based AI" — denies capabilities Grace has, banned' },
  { pattern: /\bi don'?t have (the )?(capability|ability) to (see|view|analyze|process)\s+(images?|pictures?|photos?)/i, reason: 'Denying image capability — Grace has it, banned' },
  { pattern: /\b(if you|please) describe the (picture|image|photo)\s+(to me|for me)/i, reason: 'Asking user to describe their photo — Grace sees images, never ask this' },
  { pattern: /\bi (cannot|can'?t)\s+["'"]?see["'"]?\s+or receive (images?|pictures?|photos?)/i, reason: 'Denying image capability — Grace has visual analysis, banned' },

  // ── Premature medical redirect on normal GLP-1 effects ────────────────────
  // The report specifically flagged Grace redirecting users to a doctor for
  // PLATEAUS, "isn't working anymore" feelings, hair loss, fatigue, etc.
  // These are educational events, not clinical referrals. The patterns below
  // match the most common redirect phrasings AS COMBINED with a normal-effect
  // word so we don't false-fire on legitimate referrals for severe pain.
  // Two directions for the redirect-on-normal-effect anti-pattern:
  //   (a) "talk to your doctor about [normal effect]"  → redirect → topic
  //   (b) "for the [normal effect], share this with your doctor"  → topic → redirect
  // Word allowance widened to 0-50 chars between verb and clinician to cover
  // "share this with your prescriber" (where "this with" sits in between).
  { pattern: /\b(?:talk to|share|message|reach out to|consult|call)\b[^.?!]{0,50}\b(?:doctor|provider|prescriber|clinician|healthcare provider|gp)\b[^.?!]{0,100}\b(plateau|stall|isn'?t working|stopped working|not working anymore|hair (?:loss|shedding|thinning)|mild nausea|constipation|bloating|gas|fatigue|tiredness|food noise)\b/i, reason: 'Premature medical redirect on a NORMAL GLP-1 effect — answer educationally per H7/H8 in prompt' },
  { pattern: /\b(plateau|stall|isn'?t working|stopped working|hair (?:loss|shedding|thinning)|food noise|fatigue|mild nausea|constipation|bloating)\b[^.?!]{0,100}\b(?:talk to|share|message|consult|call|reach out to)\b[^.?!]{0,50}\b(?:doctor|provider|prescriber|clinician|healthcare provider|gp)\b/i, reason: 'Premature medical redirect on a NORMAL GLP-1 effect — answer educationally' },

  // ── SMS channel format violations (H3, H5, H6 in prompt) ─────────────────
  // Markdown stripping is handled by the format enforcer; these patterns
  // catch what slips through and trigger regen rather than silent stripping.
  { pattern: /^\s*[-•*]\s+\w/m, reason: 'Bullet-list character at line start — SMS does not render markdown, write in prose' },
  { pattern: /^\s*\d+\.\s+\w/m, reason: 'Numbered-list line — SMS does not render markdown, write in prose' },
  { pattern: /^\s*#{1,6}\s+\w/m, reason: 'Markdown header line — SMS does not render, write in prose' },
  { pattern: /\*\*[^*\n]+\*\*/, reason: 'Markdown bold (**text**) — SMS shows the asterisks literally, write in prose' },
  { pattern: /(?<!\w)_[^_\n]+_(?!\w)/, reason: 'Markdown italic (_text_) — SMS shows the underscores literally, write in prose' },
  // Label: description layouts ("Bananas: easy to digest, Eggs: high protein")
  // Match 2+ such label-colons in a row, which is a list disguised as prose.
  { pattern: /^[A-Z][\w\s]{2,30}:\s+[^\n]{5,80}\n[A-Z][\w\s]{2,30}:\s+/m, reason: 'Label:description list pattern — H3 prohibits structured layouts, write continuous prose' },
  // Exclamation mark — any one is a violation per H5.
  { pattern: /!/, reason: 'Exclamation mark — H5 prohibits "!" anywhere in the response, replace with period' },
  // Multi-question response — count of "?" > 1 (excluding rate-this prompt).
  // Pattern matches two question marks anywhere in body.
  { pattern: /\?[^?\n]{0,200}\?/, reason: 'Two question marks in one response — H6 allows a single question only, at the end' },

  // Generic fallback / deflections — generalized
  { pattern: /\bi'?m here (and )?(ready )?to (help|listen|support)\b/i, reason: 'Generic "I\'m here to help" deflection — answer the actual message' },
  { pattern: /\bwhat'?s on your mind\b/i, reason: '"What\'s on your mind" — generic deflection, address the latest message' },
  { pattern: /\bhow can i (help|assist|support) you (today|now)?\b/i, reason: 'Corporate-support tone, banned' },
  { pattern: /\bfeel free to (ask|share|tell)\b/i, reason: '"Feel free to..." — corporate filler, banned' },
  { pattern: /\bis there anything (else|in particular)\b/i, reason: '"Is there anything else" — forced conversation continuation' },
  { pattern: /\blet me know if you (have|need|want)\b/i, reason: '"Let me know if you need..." — passive deflection' },

  // Clarification questions on food logs — Grace must log first, never ask
  { pattern: /\bcould you (tell me|let me know) if that was\b/i, reason: 'Clarification question on food log — log first with best estimate, no questions' },
  { pattern: /\bjust want to make sure i log it correctly\b/i, reason: 'Asking for confirmation before logging — just log it' },
  { pattern: /\bi noticed you mentioned\b/i, reason: '"I noticed you mentioned" — corporate observation tone, banned' },
  { pattern: /\bi remember you'?re (vegetarian|vegan|pescatarian)\b/i, reason: 'Surfacing dietary memory — keep it silent, just log accordingly' },

  // Non-answers / refusals — generalized patterns
  { pattern: /\bi can'?t (tell|give|say|provide|share) you (exactly|the exact)\b/i, reason: 'Refusal to give specific answer — use stored data + tools instead' },
  { pattern: /\bi (don'?t|do not) (know|have) (what you'?ve|what you have|your) /i, reason: 'Refusing using "I don\'t know your X" — that data is in your context, use it' },
  { pattern: /\bi (don'?t|do not) have access to (your |the )/i, reason: '"I don\'t have access" — Grace has access via tools and context' },
  { pattern: /\bwithout knowing (your |the |more )/i, reason: '"Without knowing your X" — use what you have, ask only ONE focused question if truly missing' },
  { pattern: /\bit depends on (your |the |many |several |various )/i, reason: '"It depends on..." — give an actual answer using available data' },
  { pattern: /\bhowever,? i can help you figure out\b/i, reason: 'Listing what Grace "could help with" instead of just answering' },
  { pattern: /\bi'?d need to know more\b/i, reason: '"I\'d need to know more" — use what you have, ask only ONE focused question' },

  // Calorie shame / scolding — Grace never frames calories as judgment
  { pattern: /\byou (only|just|merely) (ate|had|consumed)\b[^.!?]*\b\d+\s*(kcal|calories?)/i, reason: '"You only ate X calories" — calorie shaming language, banned (see ANTI-OBSESSIVE FRAMING rule)' },
  { pattern: /\b(under|over)-?ate (today|this )/i, reason: 'Labelling intake as "under-eating" or "over-eating" as judgment — use neutral framing instead' },
  { pattern: /\byou'?re (way )?(over|above) your (calorie|kcal) (budget|target|limit|goal)\b/i, reason: 'Scolding language about calorie target — use gentle framing ("you went over today, that\'s ok")' },
  { pattern: /\bthat'?s (way )?too many calories\b/i, reason: '"Too many calories" — judgmental, banned' },
  { pattern: /\bthat'?s not enough calories\b/i, reason: '"Not enough calories" — alarming, use gentle framing' },
  { pattern: /\byou should be eating (more|less)\b/i, reason: 'Directive eating instructions — use suggestions, not commands' },
  { pattern: /\b(starvation|starve|deprive yourself)\b/i, reason: 'Diet-culture vocabulary — banned' },

  // Sycophantic praise — Grace is not a corporate cheerleader
  { pattern: /\bthat'?s? (a |an )?(significant|amazing|wonderful|incredible) (accomplishment|achievement|progress)\b/i, reason: '"significant accomplishment" / "amazing achievement" — corporate praise, banned' },
  { pattern: /\b(it'?s |that'?s )?great that you'?ve achieved\b/i, reason: '"Great that you achieved..." — sycophantic opener, banned' },
  { pattern: /\bcongratulations on (your|reaching|achieving)\b/i, reason: '"Congratulations on..." — formal/AI tone, use warmer brief acknowledgment' },
  { pattern: /\bwhat a (great|wonderful|amazing) (achievement|accomplishment|milestone)\b/i, reason: 'sycophantic AI praise, banned' },

  // Nutrition-report formatting — Grace is a friend, not a calculator app
  { pattern: /\b(previous|new|current) daily total\b/i, reason: '"Previous/New/Current Daily Total" — corporate nutrition-report formatting, use plain prose' },
  { pattern: /\bremaining for the day\b/i, reason: '"Remaining for the day" — nutrition-report formatting' },
  { pattern: /\blet'?s (break down|update your daily protein)\b/i, reason: '"Let\'s break down" / "Let\'s update your daily protein" — robotic preamble, just state the number' },
  { pattern: /\bhere'?s (an |the )?estimate for\b/i, reason: '"Here\'s an estimate for..." — robotic preamble' },
  { pattern: /\byou'?re making progress towards your goal\b/i, reason: '"You\'re making progress" — corporate praise, banned' },
  { pattern: /\bdo you want to log (anything|something) else\b/i, reason: 'unsolicited follow-up question after food log' },
  { pattern: /\bare you (curious|interested) (in|about) (the protein in )?other foods\b/i, reason: 'unsolicited follow-up question after food log' },

  // Fabricated technical excuses — Grace never has connection issues
  { pattern: /\b(my |the )?connection (blipped|dropped|cut out|failed|went down)\b/i, reason: '"connection blipped" — fabricated technical excuse, banned' },
  { pattern: /\b(had|having|experienced) a (glitch|hiccup|technical issue|error)\b/i, reason: 'fabricated technical excuse, banned' },
  { pattern: /\blost your message\b/i, reason: '"lost your message" — fabricated technical excuse, banned' },
  { pattern: /\bsomething went wrong on my end\b/i, reason: '"something went wrong on my end" — fabricated technical excuse, banned' },

  // Developer-feedback acknowledgment — Grace is a companion, not a product
  { pattern: /\bthanks for the feedback\b/i, reason: '"thanks for the feedback" — Grace is not a developer receiving feedback' },
  { pattern: /\bi'?ll work on that\b/i, reason: '"I\'ll work on that" — Grace is not a product receiving instructions' },
  { pattern: /\bi'?ll (adjust|improve|update) my responses?\b/i, reason: '"I\'ll adjust my responses" — Grace is not a chatbot acknowledging bugs' },

  // AI-cliché openers
  { pattern: /\bhang in there\b/i, reason: '"hang in there" — banned AI cliché' },
  { pattern: /\byou'?ve got this\b/i, reason: '"you\'ve got this" — banned AI cliché' },
  { pattern: /\btrust the process\b/i, reason: '"trust the process" — banned AI cliché' },
  { pattern: /\bbe kind to yourself\b/i, reason: '"be kind to yourself" — banned AI cliché' },
  { pattern: /\btake it one day at a time\b/i, reason: '"take it one day at a time" — banned AI cliché' },
  { pattern: /\bjust remember\b/i, reason: '"just remember" — banned AI cliché' },

  // Empathy clichés
  { pattern: /\bi understand how you feel\b/i, reason: '"I understand how you feel" — banned phrase' },
  { pattern: /\bthat'?s completely normal\b/i, reason: '"that\'s completely normal" — banned phrase' },
  { pattern: /\bi'?m so glad you shared\b/i, reason: '"I\'m so glad you shared" — banned phrase' },
  { pattern: /\bi hear you\b/i, reason: '"I hear you" — banned phrase' },
  { pattern: /\bthinking of you\b/i, reason: '"thinking of you" — banned phrase' },
  { pattern: /\byou'?re in my thoughts\b/i, reason: '"you\'re in my thoughts" — banned phrase' },

  // Sycophantic acknowledgments
  { pattern: /\bgreat question!?\b/i, reason: '"great question" — banned sycophancy' },
  { pattern: /\boh,?\s*that'?s a great question\b/i, reason: '"that\'s a great question" — banned sycophancy' },
  // 2026-06-04 production failure: Grace replied to "What should I eat for
  // breakfast?" with "I'm asking 'why' because I need more information..." +
  // "Think of it this way if you asked a friend..." + "Here's why I need
  // more info and what kind of things would be helpful". These are
  // META-COMMENTARY patterns — Grace explaining WHAT SHE WOULD DO instead
  // of answering the user's actual question. ANSWER THE QUESTION rule.
  { pattern: /\bi'?m asking ['"]?why['"]?\b/i, reason: '"I\'m asking why" — meta-commentary, banned. Just answer the user\'s question.' },
  { pattern: /\bthink of it this way\b/i, reason: '"Think of it this way" — preamble / framing, banned. State the answer directly.' },
  { pattern: /\bhere'?s why i need (?:more|some|the) info(?:rmation)?\b/i, reason: 'Meta-commentary about needing info — banned. Either answer with available data or ask ONE specific question, not both.' },
  { pattern: /\bif you asked a friend\b/i, reason: 'Hypothetical framing ("if you asked a friend") — banned. Answer the question Grace actually received.' },
  { pattern: /\bwhat kind of things would be helpful\b/i, reason: 'Meta-commentary about what info would help — banned. Ask the specific question OR answer with what you have.' },
  { pattern: /\blet me explain why\b/i, reason: '"Let me explain why" — preamble. Just explain.' },
  // 2026-06-04 production failure: Grace replied to "What should I eat for
  // breakfast?" with "Okay, to give you the best breakfast recommendation,
  // I need a little more information. Tell me about: 1. Your Goals... 2."
  // — multi-question numbered list AS the response (vs prose answer).
  { pattern: /\bto give you the best (?:\w+\s+)?recommendation,?\s*i need (?:a |little |bit |some )?more (?:info|information|details?)\b/i, reason: 'Meta-commentary preamble — banned. Either answer with available info OR ask ONE concrete question, never both.' },
  { pattern: /\btell me about:\s*\d+\./i, reason: 'Numbered list of questions — banned. Ask ONE specific question or answer the original.' },
  { pattern: /\bi need (?:a |little |bit |some )?more (?:info|information)\s+(?:to\s+|so\s+)/i, reason: '"I need more info to / so..." — meta-commentary preamble, banned.' },
  { pattern: /^absolutely!/im, reason: '"Absolutely!" opener — banned' },
  { pattern: /^of course!/im, reason: '"Of course!" opener — banned' },
  { pattern: /^hi there!/im, reason: '"Hi there!" opener — banned' },
  { pattern: /^sure thing!?/im, reason: '"Sure thing" opener — banned' },

  // Capability denials Grace must not say
  { pattern: /\bi can'?t recommend specific meals\b/i, reason: '"I can\'t recommend specific meals" — Grace CAN recommend meals' },
  { pattern: /\bi don'?t keep track of\b/i, reason: '"I don\'t keep track of" — say "I don\'t have that logged" instead' },
  { pattern: /\bi'?m just an assistant\b/i, reason: '"I\'m just an assistant" — denies Grace\'s identity' },
  { pattern: /\bi don'?t store personal details\b/i, reason: '"I don\'t store personal details" — Grace does remember' },

  // Profile-recall language
  { pattern: /\baccording to your profile\b/i, reason: '"according to your profile" — banned profile-recall language' },
  { pattern: /\byour (profile|history) (shows|indicates)\b/i, reason: '"your profile/history shows" — banned profile-recall language' },
  { pattern: /\bbased on your (profile|previous data)\b/i, reason: '"based on your profile" — banned profile-recall language' },

  // Group normalization
  { pattern: /\ba lot of (people|women) (mention|describe|experience)\b/i, reason: 'normalizing via "a lot of people/women" — banned' },

  // Tag-line / app-voice phrases
  { pattern: /\balways respect your own rhythm\b/i, reason: '"respect your own rhythm" — app tagline, not a friend' },
  { pattern: /\bmy goal is to\b/i, reason: '"my goal is to" — banned corporate voice' },
  { pattern: /\bi'?m here to (support|help) you\b/i, reason: '"I\'m here to support you" — banned corporate voice' },
  { pattern: /\bi want you to know\b/i, reason: '"I want you to know" — banned filler' },

  // List-intro openers — H3 PROSE ONLY bans these (production failure 2026-06-03:
  // "Here are a few more vegetarian dinner ideas... : Food Name: description, Food Name:...")
  // The format-enforcer strips the colon; this bans the phrase so regen writes
  // direct prose instead: "Lentil soup is easy, edamame is quick, yogurt is filling."
  { pattern: /\bhere are a few more\b/i, reason: '"Here are a few more" — list-intro opener. Write in direct flowing prose without an intro sentence.' },
  // "Here are X ideas/options/tips/foods/meals:" — broadened to catch the
  // free-form-adjective pattern ("Here are a few vegetarian dinner ideas that
  // are high in protein and tend to sit well on GLP-1:") that the previous
  // narrow regex missed. Up to 6 words may sit between "are" and the noun.
  { pattern: /\bhere are (?:[^\n.:!?]{0,80}?)(?:points?|tips?|things?|options?|suggestions?|ideas?|steps?|reasons?|causes?|ways?|meals?|dinners?|lunches|breakfasts|snacks|foods?|recipes?|examples?)\b[^.:!?\n]{0,120}:/i, reason: '"Here are some/a few X:" — list intro. Write as direct prose, no intro sentence with colon.' },

  // Corporate / AI-generated tone markers (section 14 of behavioral spec)
  { pattern: /\bhere'?s the thing\s*[—–-]/i, reason: '"Here\'s the thing —" — em-dash AI tell' },
  { pattern: /\bthe goal is\s*[—–-]/i, reason: '"The goal is —" — corporate em-dash structure' },
  { pattern: /\bhigh.quality (conversational|tracking|experience)\b/i, reason: 'corporate quality jargon' },
  { pattern: /\b(check.in|message|tracking)\s+cadence\b/i, reason: '"cadence" — corporate jargon, not how people talk' },
  { pattern: /\b(account|settings)\s+(is\s+)?(now\s+)?configured\b/i, reason: '"configured" — corporate support language' },
  { pattern: /\byour (account|profile)\s+(has been|is)\s+(updated|set up)\s+to\s+ensure\b/i, reason: 'corporate update-confirmation template' },
  // 2026-06-04 production failures from the 4-screenshot review:
  { pattern: /\b(really|very|quite|so) (understandable|common)\b/i, reason: '"really understandable" / "really common" — generic empty validation; replace with specific reflection of what the user said' },
  { pattern: /\b(it'?s|that'?s|so) smart (to|that you'?re|of you)\b/i, reason: '"smart to think" / "smart of you" — sycophantic teacher language' },
  { pattern: /\bit'?s great you'?re thinking\b/i, reason: '"it\'s great you\'re thinking about..." — sycophantic compliment, drop and answer directly' },
  { pattern: /\byou'?re right to ask\b/i, reason: '"you\'re right to ask" — sycophantic opener; answer the question directly' },
  { pattern: /\bthank you for letting me know\b/i, reason: 'robotic acknowledgment; just respond to what they shared' },
  { pattern: /\bi'?ve (made a note|noted that|recorded that|saved that)\b/i, reason: 'database-receipt phrasing; respond like a human, not a CRM' },
  { pattern: /\bit takes a lot of courage\b/i, reason: 'self-help-book phrasing; speak plainly' },
  { pattern: /\b(healthier you|a healthier version of you)\b/i, reason: 'wellness-brand phrasing; talk about the actual goal' },
  // Tool / capability hallucination — Grace cannot set scheduled reminders
  // for specific times, cannot edit profile data via chat (settings URL only),
  // cannot save bidirectional notes back to the user (no notes-to-user tool).
  // Saying she can creates a broken promise the user notices on the next turn.
  { pattern: /\b(would you like|want) me to send you a (message|reminder|notification) at\b/i, reason: 'Grace cannot schedule one-off reminders for a specific clock time; never offer this' },
  { pattern: /\bi (can|will|could) (send you a reminder|remind you) at\b/i, reason: 'same — no clock-time reminder tool exists' },
  { pattern: /\bi (can|will) set (a |an )?(reminder|alarm|alert) for\b/i, reason: 'no reminder-setting tool; do not promise this' },
  { pattern: /\bjust tell me the new date\b.{0,30}(treatment|start)/i, reason: 'no natural-language date-edit tool; direct user to graceglp.com/settings' },
];

export function checkBannedPhrases(text: string): ContentViolation[] {
  const hits: ContentViolation[] = [];
  for (const { pattern, reason } of BANNED_PHRASES) {
    const m = pattern.exec(text);
    if (m) {
      hits.push({
        code: 'banned_phrase',
        message: reason,
        match: m[0],
      });
    }
  }
  return hits;
}

/**
 * Detects the literal "[link]" placeholder, "<link>", "[settings link]", etc.
 * The prompt requires Grace to emit the real URL (https://graceglp.com/settings).
 */
export function checkLinkPlaceholder(text: string): ContentViolation[] {
  if (/\[(link|settings link|url|here)\]/i.test(text)) {
    return [{
      code: 'link_placeholder',
      message: 'emitted a "[link]" placeholder instead of the real URL https://graceglp.com/settings',
      match: text.match(/\[[^\]]+\]/)?.[0],
    }];
  }
  if (/<link>/i.test(text)) {
    return [{
      code: 'link_placeholder',
      message: 'emitted a "<link>" placeholder instead of the real URL https://graceglp.com/settings',
      match: '<link>',
    }];
  }
  return [];
}

/**
 * Detects privacy leaks — Grace explicitly says she has (or doesn't have)
 * information about another named user. Even denying knowledge of a person
 * accidentally confirms Grace has contacts.
 */
export function checkPrivacyLeak(text: string): ContentViolation[] {
  const patterns = [
    /\bi don'?t have a user named\b/i,
    /\bi don'?t have any user(s)? (named|called)\b/i,
    /\bin (my|the) contacts?\b/i,
    /\bi don'?t see (anyone|a user) (named|called)\b/i,
    /\b(yes|no),?\s+i (have|don'?t have) (a|that) user\b/i,
  ];
  for (const p of patterns) {
    const m = p.exec(text);
    if (m) {
      return [{
        code: 'privacy_leak',
        message: 'response references presence/absence of other users — must respond "I only know about you and your journey."',
        match: m[0],
      }];
    }
  }
  return [];
}

/**
 * Treat the user's food_dislikes list as a mini dietary restriction. Same
 * matching logic as checkDietaryViolations: whole-word, longest-match wins,
 * sentence-level negation.
 *
 * Each dislike is normalized to strip the natural-language prefix users tend
 * to write at signup ("I don't like rice", "no mushrooms", "avoid dairy").
 */
export function checkFoodDislikes(text: string, dislikes: string[]): ContentViolation[] {
  const cleaned = dislikes
    .map((d) => d.replace(/^(i\s+(don'?t|do\s+not|hate|can'?t\s+stand|dislike)\s+(like\s+)?|no\s+|avoid\s+)/i, '').trim().toLowerCase())
    .filter((d) => d.length >= 2 && d.length <= 40);
  if (cleaned.length === 0) return [];

  const lower = text.toLowerCase();
  const rawHits: Array<{ word: string; start: number; end: number }> = [];
  for (const word of cleaned) {
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`\\b${escaped}\\b`, 'gi');
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(lower)) !== null) {
      rawHits.push({ word, start: m.index, end: m.index + m[0].length });
      if (m.index === pattern.lastIndex) pattern.lastIndex += 1;
    }
  }

  rawHits.sort((a, b) => (b.end - b.start) - (a.end - a.start));
  const taken: Array<[number, number]> = [];
  const deduped: typeof rawHits = [];
  for (const h of rawHits) {
    if (taken.some(([s, e]) => h.start < e && h.end > s)) continue;
    taken.push([h.start, h.end]);
    deduped.push(h);
  }

  const seen = new Set<string>();
  const hits: ContentViolation[] = [];
  for (const h of deduped) {
    if (isNegated(lower, h.start)) continue;
    if (seen.has(h.word)) continue;
    seen.add(h.word);
    hits.push({
      code: 'disliked_food',
      message: `mentioned "${h.word}" but user has it on their food-dislikes list`,
      match: h.word,
    });
  }
  return hits;
}

/**
 * Medication-type contradictions. The user context tells the LLM whether
 * the user is on a weekly injection, daily pill, or daily injection, but
 * Gemini Flash regularly slips and says "your injection day" to a Rybelsus
 * user or "your daily pill" to a Wegovy user.
 *
 * Each medication category has phrases it must NEVER appear with. False
 * positives are minimized by requiring possessive language ("your injection
 * day") so generic statements ("weekly injections are common") don't trip.
 */
const MEDICATION_FORBIDDEN: Record<string, Array<{ pattern: RegExp; reason: string }>> = {
  daily_pill: [
    { pattern: /\b(your|the)\s+injection\s+day\b/i, reason: '"injection day" — user is on a daily pill (Rybelsus), no injection day' },
    { pattern: /\bweekly\s+(injection|shot|dose)\b/i, reason: '"weekly injection/shot" — user is on a daily pill' },
    { pattern: /\b(your|the)\s+(weekly\s+)?shot\b/i, reason: '"your shot" — user is on a daily pill, no shot' },
    { pattern: /\binject(?:ing|ion)\s+(today|tomorrow|yesterday)\b/i, reason: 'injection scheduling — user is on a daily pill' },
  ],
  daily_injection: [
    { pattern: /\bweekly\s+(injection|shot|dose)\b/i, reason: '"weekly injection" — user is on a daily injection (Saxenda/Victoza)' },
    { pattern: /\b(your|the)\s+injection\s+day\b/i, reason: '"injection day" — user injects daily, every day is the same' },
    { pattern: /\bonce\s+a\s+week\s+(injection|shot|dose)\b/i, reason: '"once a week" — user injects daily' },
  ],
  weekly_injection: [
    { pattern: /\b(your|the)\s+(daily\s+)?pill\b/i, reason: '"pill" — user is on a weekly injection, no pill' },
    { pattern: /\bdaily\s+medication\b/i, reason: '"daily medication" — user takes a weekly injection' },
    { pattern: /\bempty\s+stomach\s+(rule|requirement)\b/i, reason: '"empty stomach rule" — user takes a weekly injection (no Rybelsus rules apply)' },
    { pattern: /\btake\s+(it|your\s+pill)\s+(in\s+the\s+)?morning\b/i, reason: '"take it in the morning" — Rybelsus phrasing, user is on an injectable' },
  ],
};

export function checkMedicationContradiction(
  text: string,
  medicationType: 'weekly_injection' | 'daily_pill' | 'daily_injection',
): ContentViolation[] {
  const rules = MEDICATION_FORBIDDEN[medicationType];
  if (!rules) return [];
  const hits: ContentViolation[] = [];
  for (const { pattern, reason } of rules) {
    const m = pattern.exec(text);
    if (m) {
      hits.push({
        code: 'medication_contradiction',
        message: reason,
        match: m[0],
      });
    }
  }
  return hits;
}

/**
 * Body-photo medical-leak guard. The image-analysis pipeline already adds
 * "[Do NOT mention pain, discomfort, injuries…]" to the LLM input, but the
 * LLM still slips into clinical observations on a progress selfie. This
 * regen-trigger forces a rewrite.
 *
 * Tuned for low false-positives: ignore generic words like "good" or
 * "healthy" and match only on explicit medical/symptom vocabulary.
 */
const BODY_PHOTO_MEDICAL_TERMS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\b(pain|painful|ache|aching|sore|soreness)\b/i, reason: 'mentioned pain in a progress-photo response' },
  { pattern: /\b(injur(?:y|ies)|wound|bruis(?:e|ing|ed)|swelling|swollen|inflammation|inflamed)\b/i, reason: 'mentioned injury/swelling in a progress-photo response' },
  { pattern: /\b(symptom|symptoms|diagnos(?:e|is|ed)|condition)\b/i, reason: 'mentioned symptoms/diagnosis in a progress-photo response' },
  { pattern: /\b(rash|hives|lesion|cyst|lump|tumor)\b/i, reason: 'mentioned a skin/medical concern in a progress-photo response' },
  { pattern: /\bsee\s+(a|your)\s+doctor\s+(about|for)\s+(this|that)\b/i, reason: 'redirected to doctor on a progress photo (unnecessary)' },
  { pattern: /\bgaunt|emaciated|underweight|too\s+thin\b/i, reason: 'commented negatively on appearance — banned' },
];

export function checkBodyPhotoLeak(text: string): ContentViolation[] {
  const hits: ContentViolation[] = [];
  for (const { pattern, reason } of BODY_PHOTO_MEDICAL_TERMS) {
    const m = pattern.exec(text);
    if (m) {
      hits.push({
        code: 'body_photo_medical_leak',
        message: reason,
        match: m[0],
      });
    }
  }
  return hits;
}

/**
 * Build a short instruction the orchestrator appends to the regen system
 * prompt so the LLM knows exactly what to fix. Keep this terse — the regen
 * already inherits the full system prompt.
 */
export function buildContentRegenInstruction(
  violations: ContentViolation[],
  restriction?: DietaryRestriction,
): string {
  const parts: string[] = ['\n\nREVIEWER FEEDBACK on your previous draft:'];

  const dietaryHits = violations.filter((v) => v.code === 'forbidden_food');
  if (dietaryHits.length > 0 && restriction) {
    const offending = dietaryHits.map((v) => v.match).filter(Boolean).join(', ');
    parts.push(
      `CRITICAL: Your draft suggested ${offending} to a ${restriction.label} user. ${restriction.label}s cannot eat ${offending}. Rewrite using ONLY these allowed proteins: ${restriction.allowed.join(', ')}. Do NOT mention any of: ${restriction.forbidden.join(', ')}.`,
    );
  }

  const dislikeHits = violations.filter((v) => v.code === 'disliked_food');
  if (dislikeHits.length > 0) {
    const offending = dislikeHits.map((v) => v.match).filter(Boolean).join(', ');
    parts.push(
      `Your draft mentioned ${offending} — the user dislikes these foods. Rewrite without ${offending}; pick alternatives.`,
    );
  }

  const medHits = violations.filter((v) => v.code === 'medication_contradiction');
  if (medHits.length > 0) {
    parts.push(
      `Your draft contradicted the user's medication type: ${medHits.map((v) => v.message).join('; ')}. Rewrite without these phrases.`,
    );
  }

  const bodyHits = violations.filter((v) => v.code === 'body_photo_medical_leak');
  if (bodyHits.length > 0) {
    parts.push(
      `Your draft used medical/symptom language on a progress photo: ${bodyHits.map((v) => `"${v.match}"`).join(', ')}. Progress photos get warmth and encouragement, NEVER medical commentary. Rewrite without any pain/injury/symptom words.`,
    );
  }

  const phraseHits = violations.filter((v) => v.code === 'banned_phrase');
  if (phraseHits.length > 0) {
    const list = phraseHits.map((v) => `"${v.match}"`).join(', ');
    parts.push(
      `Your draft contained banned phrases: ${list}. These are AI clichés and must be removed entirely. Rewrite with natural, varied language.`,
    );
  }

  const linkHits = violations.filter((v) => v.code === 'link_placeholder');
  if (linkHits.length > 0) {
    parts.push(
      `Your draft used a "[link]" placeholder. Replace it with the literal URL https://graceglp.com/settings — never write a placeholder.`,
    );
  }

  const privacyHits = violations.filter((v) => v.code === 'privacy_leak');
  if (privacyHits.length > 0) {
    parts.push(
      `Your draft confirmed or denied knowledge of another user. NEVER do this. Reply only: "I only know about you and your journey. I can't help with that."`,
    );
  }

  const dbRuleHits = violations.filter((v) => v.code.startsWith('db_rule_'));
  if (dbRuleHits.length > 0) {
    const items = dbRuleHits.map((v) => `"${v.match}" — ${v.message}`).join('; ');
    parts.push(
      `Your draft violated these content rules: ${items}. Rewrite without these phrases or claims.`,
    );
  }

  parts.push('Rewrite the response. Keep it warm and brief.');
  return parts.join('\n');
}
