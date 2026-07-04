/**
 * Deterministic guardrail for unsafe DIY-injectable / research-peptide requests.
 *
 * Grace tracks APPROVED GLP-1 medications, symptoms, and (soon) dose history, and
 * helps users prep questions for a clinician. She must NEVER guide:
 *   - reconstitution / mixing a vial yourself (BAC water, dry powder, "how much
 *     water", drawing up units),
 *   - dosing / unit math for self-prepared injectables,
 *   - stacking / combining multiple compounds,
 *   - sourcing or using research / grey-market peptides ("research chem").
 * Those carry real safety, legal, and medical risk and belong with a licensed
 * clinician.
 *
 * This fires ONLY on guidance-seeking about those specific unsafe activities — NOT
 * on legitimate tracking ("I take tirzepatide", "log my dose", "my doctor moved me
 * to 5mg"), and NOT on balanced-plate food talk ("combine protein with carbs"),
 * which must flow through normally. Ambiguous action words (stack/combine/run-with)
 * only fire when a medication/injectable context is also present; unambiguous
 * DIY-prep vocabulary (reconstitute, bacteriostatic water, research peptide) fires
 * on its own.
 *
 * Note: overdose / "take an extra/double dose" is already handled by the
 * SafetyGuard (safety/guard.ts MEDICAL_ADVICE). This module is complementary and
 * covers the reconstitution/stacking/research-peptide class that had no guardrail.
 */
export interface PeptideSafetyResult {
  flagged: boolean;
  response?: string;
  matched?: string;
}

// Unambiguous DIY-preparation / research-peptide vocabulary — safe to fire alone
// because none of these appear in ordinary food/medication-tracking messages.
const UNSAFE_UNAMBIGUOUS_RE =
  /\b(reconstitut\w*|bacteriostatic\s+water|bac\s+water|lyophili\w*|dry\s+powder|research\s+(?:peptide|chem\w*|grade)|for\s+research\s+(?:use\s+)?only|not\s+for\s+human|grey\s*market|gray\s*market|retatrutide|cagrilintide|survodutide|peptide\s+(?:vendor|seller|source|site|calculator)|reconstitution)\b/i;

// Mixing a vial/powder/peptide yourself (the object word keeps food "mixing" out).
const MIX_VIAL_RE = /\bmix(?:ing|ed)?\s+(?:the\s+|my\s+|a\s+|up\s+)?(?:vial|powder|peptide|compound|bac|solution)\b/i;

// DIY dosing math ("how many units to draw", "how much bac water", "draw up 20 units").
const DIY_DOSING_RE =
  /\b(how\s+many\s+units?\b|how\s+much\s+(?:bac|bacteriostatic)\b|draw(?:ing)?\s+(?:up\s+)?\d+\s*(?:units?|iu|ml)|units?\s+(?:to|do\s+i|should\s+i)\s+(?:draw|inject|take|pull))\b/i;

// Ambiguous action words — only unsafe in a medication/injectable context.
const AMBIGUOUS_ACTION_RE =
  /\b(stack(?:ing|ed)?\b|combin\w*|alongside|run(?:ning)?\s+(?:\w+\s+){0,3}(?:with|alongside|together)|add(?:ing)?\s+\w+\s+to\s+my)\b/i;

// Medication / injectable context that qualifies an ambiguous action as unsafe.
const MED_CONTEXT_RE =
  /\b(peptide|compound(?:ed)?|vial|injectable|reta|cagri|semaglutide|tirzepatide|liraglutide|ozempic|wegovy|mounjaro|zepbound|saxenda|rybelsus|dose|doses|mg\b|shots?\b|inject\w*)\b/i;

/**
 * Detect a request for unsafe DIY-injectable / research-peptide guidance.
 * Cheap regex; no history needed.
 */
export function detectPeptideSafety(text: string): PeptideSafetyResult {
  const t = (text || '').toLowerCase();
  if (!t.trim()) return { flagged: false };

  let matched: string | null = null;
  if (UNSAFE_UNAMBIGUOUS_RE.test(t)) matched = 'diy_or_research_peptide';
  else if (MIX_VIAL_RE.test(t)) matched = 'mix_vial';
  else if (DIY_DOSING_RE.test(t)) matched = 'diy_dosing_math';
  else if (AMBIGUOUS_ACTION_RE.test(t) && MED_CONTEXT_RE.test(t)) matched = 'stacking';

  if (!matched) return { flagged: false };
  return { flagged: true, matched, response: PEPTIDE_SAFETY_RESPONSE };
}

/** Warm, non-judgmental refusal that still offers the safe, in-scope help. */
export const PEPTIDE_SAFETY_RESPONSE =
  "I can help you track what you're taking and how you feel, and pull together " +
  "questions for your next appointment — but I can't guide mixing, reconstitution, " +
  "dosing math, stacking, or research peptides. That's genuinely one for a licensed " +
  "clinician who can do it safely. Want me to note this to raise with them?";
