/**
 * Message understanding layer (2026-06-27).
 *
 * Real users write messy, multi-topic messages: "I had chicken and rice for
 * lunch, I feel a little nauseous, also how much protein do I still need
 * today?" — a food log + a symptom + a progress question, all at once. Grace
 * must address EVERY important part in one warm reply, not just the first or
 * last sentence.
 *
 * This is a DETERMINISTIC pre-pass (no LLM — consistent with the codebase's
 * TRUST_GEMINI stance: the understanding step is deterministic; Gemini still
 * writes the natural reply). It splits a message into the set of meaningful
 * intents present, then the caller injects a structured note into the single
 * Gemini call so the model covers all of them. Pure string functions — easy to
 * unit-test, no I/O.
 *
 * It is intentionally CONSERVATIVE about what counts as a distinct part, so a
 * plain one-topic message ("I had 2 eggs") yields a single part and the normal
 * fast paths handle it — the multi-part note only fires when ≥2 meaningful
 * kinds are genuinely present.
 */

import { mentionsFood } from './meal-lifecycle.js';

export type MessagePartKind =
  | 'food'
  | 'symptom'
  | 'progress_question'
  | 'question'
  | 'emotion'
  | 'injection'
  | 'weight';

export interface MessagePart {
  kind: MessagePartKind;
  /** Short human label for the structured note. */
  label: string;
}

export interface MessageUnderstanding {
  parts: MessagePart[];
  /** True when ≥2 DISTINCT meaningful kinds are present → needs combined handling. */
  hasMultiple: boolean;
  kinds: MessagePartKind[];
}

// ── Detectors (lean, self-contained regexes) ────────────────────────────────

// Eating/drinking report or a meal-time + a named food.
const ATE_RE =
  /\b(?:i\s+(?:ate|had|grabbed|made|drank|got|finished)|just\s+(?:ate|had|drank)|for\s+(?:breakfast|lunch|dinner|brunch|a\s+snack)\b)/i;

// GLP-1 symptom vocabulary (the common side effects + acute warning signs).
const SYMPTOM_RE =
  /\b(naus(?:ea|eous|eated)|vomit\w*|throw(?:ing)?\s+up|constipat\w*|diarrh\w*|reflux|heartburn|indigest\w*|bloat\w*|gas(?:sy)?|cramp\w*|stomach\s*(?:ache|pain|cramps?)|tummy\s*(?:ache|pain)|headache|migraine|dizz\w*|lighthead\w*|fatigue\w*|exhaust\w*|tired|drained|wiped\s+out|sluggish|weak|shaky|sweaty|palpitation\w*|blurry|sick|unwell|queasy|burp\w*|food\s+noise|acid)\b/i;

// Protein / calorie / weight + a "how much / left / today" framing → progress Q.
const PROGRESS_Q_RE =
  /\b(?:protein|calorie|calories|cals?|weight|macros?)\b/i;
const PROGRESS_Q_FRAMING_RE =
  /\b(?:how\s+much|how\s+many|left|remaining|still\s+need|so\s+far|today|hit\s+my|over|under|reach|on\s+track|enough)\b/i;

// Injection / dose mentions.
const INJECTION_RE =
  /\b(?:shot|inject\w*|jab|pen|dose|dosing|my\s+(?:ozempic|wegovy|mounjaro|zepbound|semaglutide|tirzepatide))\b/i;

// Weight / progress UPDATE (not a question) — "I'm down 3 lbs", "weighed 180".
const WEIGHT_UPDATE_RE =
  /\b(?:i'?m\s+down|lost\s+\d|weighed?\s+\d|down\s+\d+\s*(?:lbs?|pounds?|kg)|scale\s+(?:said|read|showed))\b/i;

// Emotional content — "I feel <emotion>", or bare emotion words.
const EMOTION_RE =
  /\b(?:i\s+feel|i'?m\s+feeling|feeling)\s+(?:good|great|happy|excited|proud|hopeful|ok(?:ay)?|fine|down|sad|low|anxious|nervous|worried|scared|frustrated|stressed|overwhelmed|discouraged|defeated|lonely|tired\s+of|exhausted|hopeless|stuck)\b|\b(?:so\s+(?:proud|happy|frustrated|anxious|discouraged))\b|\b(?:struggling|i\s+give\s+up|can'?t\s+do\s+this)\b/i;

function hasQuestion(text: string): boolean {
  if (text.includes('?')) return true;
  return /\b(?:how|what|when|where|which|why|who|can|could|should|would|will|do|does|did|is|are|am)\b[^.?!]*$/i.test(
    text.trim(),
  );
}

/**
 * Split a message into the set of meaningful intents it contains. The result
 * drives a structured note for the LLM; `hasMultiple` gates whether the
 * multi-part handling is needed at all.
 */
export function analyzeMessage(text: string): MessageUnderstanding {
  const t = (text ?? '').trim();
  const parts: MessagePart[] = [];
  const add = (kind: MessagePartKind, label: string) => {
    if (!parts.some((p) => p.kind === kind)) parts.push({ kind, label });
  };

  if (t.length === 0) return { parts, hasMultiple: false, kinds: [] };

  const foodish = mentionsFood(t) && (ATE_RE.test(t) || /\band\b/.test(t));
  if (foodish) add('food', 'food they ate (log it if the amount is clear; otherwise ask one short question)');

  if (SYMPTOM_RE.test(t)) add('symptom', 'a symptom / how they feel physically (acknowledge + apply safety rules)');

  const isProgressQ =
    PROGRESS_Q_RE.test(t) && (hasQuestion(t) || PROGRESS_Q_FRAMING_RE.test(t)) && !WEIGHT_UPDATE_RE.test(t);
  if (isProgressQ) add('progress_question', "a question about today's protein/calories/weight (answer from the totals in context)");

  if (WEIGHT_UPDATE_RE.test(t)) add('weight', 'a weight / progress update');

  if (INJECTION_RE.test(t)) add('injection', 'an injection / dose mention');

  if (EMOTION_RE.test(t)) add('emotion', 'an emotional note (respond to the feeling FIRST, warmly)');

  // A general question that is NOT already the progress question.
  if (!isProgressQ && hasQuestion(t)) add('question', 'a question to answer directly');

  const kinds = parts.map((p) => p.kind);
  return { parts, hasMultiple: parts.length >= 2, kinds };
}

/**
 * Build the structured note injected into the single Gemini call so it covers
 * every part of a multi-topic message in ONE short, warm reply. Returns '' when
 * the message isn't multi-part (caller skips injection).
 */
export function buildMultiPartNote(understanding: MessageUnderstanding): string {
  if (!understanding.hasMultiple) return '';
  const lines = understanding.parts.map((p, i) => `${i + 1}) ${p.label}`);
  return (
    `\n\n[MULTI-PART MESSAGE — the user said several things at once. Address EVERY part below in ONE short, warm, natural reply (not a checklist, not separate stitched-together answers). Do NOT drop any part, and do NOT answer only the first or last one. Use the user's profile + today's totals already in context; only ask a clarification if a detail is genuinely needed (e.g. an unclear food amount). Parts:\n` +
    lines.join('\n') +
    `]`
  );
}
