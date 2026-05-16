/**
 * Deterministic content-rule violations that warrant a regeneration.
 *
 * Unlike format-enforcer (silent auto-fix), these are semantic violations
 * that cannot be fixed by string replacement — they require the LLM to
 * actually pick different words.
 *
 * Currently checks:
 *   - Forbidden foods given a dietary restriction (chicken in a vegetarian
 *     reply, eggs in a vegan reply, etc.)
 *
 * Extending: add new check functions and return their violations alongside
 * the existing ones. The orchestrator force-regens once if any violation
 * is found.
 */

import type { DietaryRestriction } from '@grace/shared';

export interface ContentViolation {
  /** Short code for telemetry: 'forbidden_food', 'banned_phrase', etc. */
  code: string;
  /** Human-readable description for the regen instruction. */
  message: string;
  /** The specific offending token (e.g. "chicken"). */
  match?: string;
}

export interface ContentCheckOpts {
  dietaryRestriction?: DietaryRestriction;
}

export function checkContent(text: string, opts: ContentCheckOpts): ContentViolation[] {
  const violations: ContentViolation[] = [];

  if (opts.dietaryRestriction) {
    violations.push(...checkDietaryViolations(text, opts.dietaryRestriction));
  }

  return violations;
}

/**
 * Scan a response for any forbidden food words. We match on whole words
 * to avoid false positives ("turkey" in "Turkey the country" — vanishingly
 * unlikely in a GLP-1 chat but cheap to guard). Negation handling: if the
 * forbidden word appears right after "no ", "not ", "without ", "skip ",
 * "avoid ", or "no more " — Grace is excluding it, which is fine.
 */
export function checkDietaryViolations(
  text: string,
  restriction: DietaryRestriction,
): ContentViolation[] {
  const lower = text.toLowerCase();
  const hits: ContentViolation[] = [];

  for (const word of restriction.forbidden) {
    // Whole-word match. Multi-word entries ("cottage cheese") are also fine
    // because the regex anchors at word boundaries on each end.
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`\\b${escaped}\\b`, 'i');
    const match = pattern.exec(lower);
    if (!match) continue;

    // Skip if it's a negation ("no chicken", "avoid fish", "without meat").
    const start = match.index;
    const lookback = lower.slice(Math.max(0, start - 20), start);
    if (/\b(no|not|without|skip|avoid|never|except|no\s+more|other\s+than|aside\s+from|besides)\s+(any\s+)?$/i.test(lookback)) {
      continue;
    }

    hits.push({
      code: 'forbidden_food',
      message: `mentioned "${word}" but user is ${restriction.label}`,
      match: word,
    });
  }

  // Deduplicate by match — same word triggered twice is still one violation.
  const seen = new Set<string>();
  const unique: ContentViolation[] = [];
  for (const h of hits) {
    const key = h.match ?? h.code;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(h);
  }
  return unique;
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
      `CRITICAL: Your draft suggested ${offending} to a ${restriction.label} user. ${restriction.label}s cannot eat ${offending}. Rewrite the response using ONLY these allowed proteins: ${restriction.allowed.join(', ')}. Do NOT mention any of: ${restriction.forbidden.join(', ')}.`,
    );
  }

  parts.push('Rewrite the response. Keep it warm and brief.');
  return parts.join('\n');
}
