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
  if (opts.dbRules && opts.dbRules.length > 0) {
    violations.push(...checkDbRules(text, opts.dbRules));
  }

  return violations;
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

/**
 * Phrases that the master prompt's "BANNED FOREVER" section forbids,
 * narrowed to ones with effectively zero false-positive rate. Every one
 * of these is a literal AI-clich tell.
 *
 * Add to this list as new violations are spotted in production. Test
 * coverage in content-checker.test.ts means additions are cheap.
 */
const BANNED_PHRASES: Array<{ pattern: RegExp; reason: string }> = [
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

  // Corporate / AI-generated tone markers (section 14 of behavioral spec)
  { pattern: /\bhere'?s the thing\s*[—–-]/i, reason: '"Here\'s the thing —" — em-dash AI tell' },
  { pattern: /\bthe goal is\s*[—–-]/i, reason: '"The goal is —" — corporate em-dash structure' },
  { pattern: /\bhigh.quality (conversational|tracking|experience)\b/i, reason: 'corporate quality jargon' },
  { pattern: /\b(check.in|message|tracking)\s+cadence\b/i, reason: '"cadence" — corporate jargon, not how people talk' },
  { pattern: /\b(account|settings)\s+(is\s+)?(now\s+)?configured\b/i, reason: '"configured" — corporate support language' },
  { pattern: /\byour (account|profile)\s+(has been|is)\s+(updated|set up)\s+to\s+ensure\b/i, reason: 'corporate update-confirmation template' },
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
