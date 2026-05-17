import type { RetrievedDoc } from '@grace/shared';

/**
 * Deterministic grounding precheck. Runs before (and sometimes instead of)
 * the LLM-critic — cheap, no extra Gemini call, fail-closed.
 *
 * The premise: a GLP-1 companion must never invent specific medical
 * facts. The most dangerous claims are *quantitative* (dose, frequency,
 * duration, percentage) and *interaction-safety* assertions ("it's safe
 * to take X with Y"). If we see one in the response and nothing in the
 * retrieved knowledge base supports it, we treat the response as
 * unsafe-to-send and route it through the regen path with explicit
 * instructions to drop the claim.
 *
 * This is intentionally narrow. Mentioning a drug name alone is not a
 * claim; we don't flag "you're on Wegovy" just because the KB is empty.
 * We only flag the SHAPES of claims that hurt users when wrong.
 */

export type ClaimKind =
  | 'dose'              // "2mg", "1.0 mg", "100 mcg"
  | 'percentage'        // "20% weight loss"
  | 'interaction';      // "safe to take X with Y", "fine to combine"
  // NOTE: 'duration' and 'frequency' were removed — "4 weeks" and "twice a
  // week" appear constantly in nutrition/exercise advice and cause too many
  // false-positive regen cycles. Only drug doses and interaction-safety
  // claims are genuinely dangerous when wrong.

export interface DetectedClaim {
  kind: ClaimKind;
  /** The matched substring from the response. */
  text: string;
}

export interface GroundingResult {
  /** All quantitative/interaction claims detected in the response. */
  detected: DetectedClaim[];
  /** Claims that have no support in any retrieved chunk. Fail-closed: if no
   *  chunks were retrieved at all and any claim was detected, every claim
   *  is unsupported. */
  unsupported: DetectedClaim[];
}

const DOSE_RE = /\b\d+(?:\.\d+)?\s*(?:mg|mcg|µg|ml|units?)\b/gi;
// `%` is non-word, so a trailing `\b` would never match. Use word boundary
// only when the literal token is "percent".
const PERCENT_RE = /\b\d+(?:\.\d+)?\s*(?:%|percent\b)/gi;
const INTERACTION_RE =
  /\b(?:safe|fine|okay|ok|no problem|won't interact|doesn't interact|no interaction)\s+(?:to\s+)?(?:take|combine|mix|drink|use|eat)\b/gi;

const CLAIM_DETECTORS: Array<{ kind: ClaimKind; re: RegExp }> = [
  { kind: 'dose', re: DOSE_RE },
  { kind: 'percentage', re: PERCENT_RE },
  { kind: 'interaction', re: INTERACTION_RE },
];

export function precheckGrounding(
  response: string,
  retrieved: RetrievedDoc[],
): GroundingResult {
  const detected: DetectedClaim[] = [];
  for (const { kind, re } of CLAIM_DETECTORS) {
    // Reset lastIndex — these regexes are global and stateful.
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(response)) !== null) {
      detected.push({ kind, text: m[0] });
    }
  }

  if (detected.length === 0) {
    return { detected: [], unsupported: [] };
  }

  const haystack = retrieved.map((d) => d.content.toLowerCase()).join('\n');

  const unsupported = detected.filter((claim) => !isSupported(claim, haystack));
  return { detected, unsupported };
}

/**
 * A claim is "supported" if the retrieved knowledge contains either the
 * same literal substring (e.g. "2mg") OR — for kind-based claims like
 * `interaction` — at least one term from the same category. We're not
 * doing NLI; this is a soft existence check. Errs on the side of letting
 * claims through if the topic clearly came up in the KB, and blocking
 * them if the KB is silent.
 */
function isSupported(claim: DetectedClaim, haystackLower: string): boolean {
  if (haystackLower.length === 0) return false;
  const lit = claim.text.toLowerCase();
  if (haystackLower.includes(lit)) return true;

  // Soft match: for quantitative claims, require numeric overlap; for
  // interaction claims, require any interaction-related term in the haystack.
  switch (claim.kind) {
    case 'interaction':
      // Match stems (interact*, combin*, contraindic*) — accept inflected forms
      // like "interaction" / "combined" / "contraindicates". No trailing \b.
      return /\b(?:interact|combin|contraindic|avoid taking)/i.test(haystackLower);
    case 'dose':
    case 'percentage': {
      const num = lit.match(/\d+(?:\.\d+)?/)?.[0];
      return num !== undefined && haystackLower.includes(num);
    }
  }
}

/**
 * Render the unsupported claims as a single human-readable summary,
 * usable as a critic "issue" string when we synthesize a CriticReport
 * from the precheck (skipping the LLM critic call).
 */
export function summarizeUnsupported(claims: DetectedClaim[]): string[] {
  if (claims.length === 0) return [];
  return claims.slice(0, 4).map(
    (c) => `unsupported ${c.kind} claim: "${c.text}" — not present in retrieved knowledge`,
  );
}
