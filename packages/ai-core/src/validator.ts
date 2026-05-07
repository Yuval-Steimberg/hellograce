import type { Confidence } from '@grace/shared';

export interface ValidationResult {
  text: string;
  confidence: Confidence;
  flags: string[];
}

const RED_FLAGS = [
  /(?:\d+)\s*mg\b.{0,40}\b(?:take|inject|increase|decrease)/i,
  /\bcall\s*9\s*1\s*1\b/i,
];

const HEDGE_PHRASES = [/i'm not sure/i, /i think/i, /probably/i, /maybe/i];

/**
 * Lightweight validator: runs after generation. It does NOT call the LLM —
 * its job is fast, deterministic guardrails + confidence scoring.
 * Phase 2 can plug in an LLM-based critic.
 */
export function validateResponse(text: string): ValidationResult {
  const trimmed = text.trim();
  const flags: string[] = [];

  for (const re of RED_FLAGS) {
    if (re.test(trimmed)) flags.push('possible_medical_advice');
  }
  if (trimmed.length === 0) flags.push('empty_response');
  if (trimmed.length > 1500) flags.push('overlong_response');

  let confidence: Confidence = 'high';
  if (HEDGE_PHRASES.some((re) => re.test(trimmed))) confidence = 'medium';
  if (flags.includes('empty_response')) confidence = 'low';

  return { text: trimmed, confidence, flags };
}
