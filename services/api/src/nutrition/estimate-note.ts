/**
 * Medium-confidence estimate disclosure (2026-06-15).
 *
 * When Grace LOGS a recognizable food that carries no explicit portion
 * ("greek yogurt", "yogurt and berries", "turkey sandwich"), the macros are a
 * standard-serving estimate. Per the confidence-logging spec, the confirmation
 * must SAY it's an estimate and invite a correction — never present a guessed
 * portion as exact. (High-confidence logs with an explicit amount get a clean
 * confirmation; low-confidence meals ask before logging — handled upstream in
 * vague-food.ts.)
 */

import { hasExplicitQuantity } from '../safety/vague-food.js';

/** Should the confirmation for a just-logged food carry an estimate note? */
export function shouldDiscloseEstimate(text: string): boolean {
  return !hasExplicitQuantity(text);
}

const ESTIMATE_NOTES: readonly string[] = [
  'That\'s a standard-serving estimate, tell me the portion if you want it exact.',
  'I estimated a standard portion, let me know the amount and I\'ll tighten it.',
  'That\'s an estimate based on a typical serving, send the portion to adjust it.',
];

/** A short estimate-disclosure sentence, rotated by a stable seed so the same
 *  user doesn't see the identical line back to back. */
export function estimateNote(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  return ESTIMATE_NOTES[Math.abs(h) % ESTIMATE_NOTES.length]!;
}
