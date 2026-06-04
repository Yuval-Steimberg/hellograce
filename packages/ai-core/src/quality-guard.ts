// Final quality guard — the LAST check before a response is sent.
// Deterministic detector for common AI-generated tells that slip past
// content rules and the LLM relevance check: too many sentences, too
// many numbers, structured formatting, repeated phrases, walls of text.
// Returns null when the response passes; returns a regen reason when it fails.

import type { MessageType } from './classify.js';

// Per-context maximum sentence count. Anything longer triggers regen.
const SENTENCE_LIMITS: Record<MessageType, number> = {
  greeting: 2,
  gibberish: 2,
  food_log: 2,
  weight_log: 2,
  mood_log: 2,
  scheduling: 2,
  emotional: 3,
  general: 4,
  food_question: 5,
  knowledge: 6,
  appointment_prep: 8, // 4-6 questions + brief framing
  // Phase 1 coverage expansion intents
  exercise_log: 2,           // log acks are short
  injection_log: 2,          // confirmation acks are short
  medication_question: 4,    // dose / timing / storage answers
  social_situation: 4,       // practical strategies + warmth
  pause_request: 2,          // confirmation only
};

export interface QualityIssue {
  code: string;
  message: string;
}

export function checkResponseQuality(text: string, type: MessageType): QualityIssue | null {
  const clean = text.trim();
  if (clean.length === 0) return null;

  // ─── Sentence count ────────────────────────────────────────────────────
  // Split on ., !, ? followed by space or end. Don't count Y/M/W abbreviations.
  const sentences = clean
    .split(/(?<=[.!?])\s+/)
    .filter((s) => s.trim().length > 3);
  const limit = SENTENCE_LIMITS[type] ?? 4;
  if (sentences.length > limit) {
    return {
      code: 'too_many_sentences',
      message: `Response has ${sentences.length} sentences for ${type} type (limit: ${limit}). Make it shorter — most replies should be 1-2 sentences. Cut everything except the direct answer.`,
    };
  }

  // ─── Paragraph count ────────────────────────────────────────────────────
  // More than 2 paragraphs = wall of text. WhatsApp users skip these.
  const paragraphs = clean.split(/\n\s*\n/).filter((p) => p.trim().length > 0);
  if (paragraphs.length > 2 && type !== 'greeting') {
    return {
      code: 'too_many_paragraphs',
      message: `Response has ${paragraphs.length} paragraphs. WhatsApp users skip walls of text. Collapse into 1-2 short paragraphs max.`,
    };
  }

  // ─── Numeric clutter ────────────────────────────────────────────────────
  // Count standalone numbers (e.g. "30g", "114g", "30/114g"). More than 4
  // unique numbers in a single short reply = nutrition-report formatting.
  const numbers = (clean.match(/\b\d+(?:\.\d+)?(?:g|kg|lbs?|kcal|cal|%)?\b/gi) ?? [])
    .map((n) => n.toLowerCase());
  const uniqueNumbers = new Set(numbers);
  if (uniqueNumbers.size > 4 && type !== 'knowledge') {
    return {
      code: 'numeric_clutter',
      message: `Response cites ${uniqueNumbers.size} different numbers — overwhelming and report-like. Pick the 1-2 most important and drop the rest.`,
    };
  }

  // ─── Repeated number (e.g. total stated 3 times) ────────────────────────
  const numberFreq = new Map<string, number>();
  for (const n of numbers) {
    numberFreq.set(n, (numberFreq.get(n) ?? 0) + 1);
  }
  for (const [num, count] of numberFreq) {
    if (count >= 3 && num.length > 1) {
      return {
        code: 'number_repeated',
        message: `Number "${num}" appears ${count} times. State each number once.`,
      };
    }
  }

  // ─── Excessive question marks ───────────────────────────────────────────
  const questionCount = (clean.match(/\?/g) ?? []).length;
  if (questionCount > 1) {
    return {
      code: 'too_many_questions',
      message: `Response asks ${questionCount} questions. Ask AT MOST one — and only if genuinely needed.`,
    };
  }

  // ─── Total length ───────────────────────────────────────────────────────
  // Hard cap on character count by type to catch verbose responses that
  // somehow stayed within sentence limits.
  // Bumped food_question 450 → 600 (2026-06-04): production failure showed
  // model exceeding 450 chars → too_long regen → retry stripped the actual
  // food recommendation, leaving only "You're at 0g protein today — your
  // goal is 60g." (no answer to "what should I eat for breakfast?"). 600
  // matches knowledge — both intents need enough room to provide 2-3
  // specific recommendations with brief context.
  const charLimit: Record<MessageType, number> = {
    greeting: 120,
    gibberish: 120,
    food_log: 200,
    weight_log: 180,
    mood_log: 180,
    scheduling: 200,
    emotional: 280,
    general: 350,
    food_question: 600,
    knowledge: 600,
    appointment_prep: 800,
    // Phase 1 coverage expansion intents
    exercise_log: 200,
    injection_log: 180,
    medication_question: 400,
    social_situation: 400,
    pause_request: 180,
  };
  const maxChars = charLimit[type] ?? 350;
  if (clean.length > maxChars) {
    return {
      code: 'too_long',
      message: `Response is ${clean.length} characters (limit ${maxChars} for ${type}). Trim it — most WhatsApp replies should fit on one screen without scrolling.`,
    };
  }

  return null;
}
