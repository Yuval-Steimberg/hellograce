/**
 * Follow-up resolution layer (2026-06-18).
 *
 * Short, context-dependent replies ("yes", "do it", "make it specific",
 * "shorter", "the second one", "why?") have NO meaning classified in isolation
 * — they refine, confirm, reject, reference, or question whatever Grace said
 * last. The intent classifier runs on the latest message alone, so these were
 * landing in the generic `general` fallback ("I'm with you. What's on your
 * mind?") instead of continuing the active workflow.
 *
 * This module is the reusable PRIMITIVE: it labels a message as a follow-up
 * (and how it modifies the prior turn) WITHOUT knowing the domain. Each
 * workflow (doctor questions, meal recs, settings, reminders, …) decides what
 * to do with the label against its own active context. It deliberately does NOT
 * try to be a full dialogue-state engine — it's a cheap, deterministic
 * classifier that the existing per-domain continuation handlers plug into.
 */

export type FollowUpKind = 'confirm' | 'reject' | 'refine' | 'reference' | 'clarify';

export type RefineModifier =
  | 'more_specific'
  | 'more_detail'
  | 'shorter'
  | 'longer'
  | 'simpler'
  | 'examples'
  | 'add'
  | 'remove'
  | 'rewrite';

export interface FollowUp {
  kind: FollowUpKind;
  /** Present on refinements (and on confirmations that also carry a tweak,
   *  e.g. "yes, make it specific" → confirm + more_specific). */
  modifier?: RefineModifier;
}

// A follow-up is short and leans on prior context. Cap length so a full
// sentence stating a new topic isn't swept up. Tunable; 60 chars comfortably
// covers "yes do it but make it more specific please".
const MAX_FOLLOWUP_LEN = 64;

const CONFIRM_RE =
  /^(?:yes|yep|yeah|yup|ya|sure|ok|okay|k|kk|do it|go ahead|go for it|please(?:\s+do)?|continue|carry on|keep going|sounds?\s+(?:good|great|nice|right)|that works|works for me|exactly|right|correct|perfect|great|awesome|love it|let'?s do it|yes\s+please|for sure|absolutely|definitely|affirmative|👍|👌)\b/i;

const REJECT_RE =
  /^(?:no|nope|nah|not\s+that|not\s+really|never\s?mind|nevermind|skip(?:\s+it)?|cancel|stop|forget\s+it|leave\s+it|don'?t(?:\s+bother)?|that'?s\s+(?:not|wrong)|wrong)\b/i;

const CLARIFY_RE =
  /^(?:why|how|how\s+come|what\s+do\s+you\s+mean|what'?s\s+that\s+mean|explain|huh|meaning|come\s+again|what\??)\s*\??$/i;

const REFERENCE_RE =
  /\b(?:the\s+)?(?:first|second|third|last|that|this)\s+(?:one|option|plan|suggestion|idea|choice)\b|\b(?:this\s+one|that\s+one|both|either|neither|the\s+other\s+one)\b/i;

// Refinement modifiers, in priority order (most specific first).
const MODIFIER_PATTERNS: Array<{ mod: RefineModifier; re: RegExp }> = [
  { mod: 'more_specific', re: /\b(?:more\s+)?specific(?:s|ally)?\b|\bbe\s+specific\b|\bin\s+detail\b|\bexact\b|\bprecise\b|\btailor(?:ed)?\b/i },
  { mod: 'more_detail', re: /\bmore\s+detail|\belaborate\b|\bexpand\b|\bgo\s+deeper\b|\bin\s+depth\b|\bflesh\s+(?:it|that)\s+out\b|\bmore\s+(?:info|context)\b/i },
  { mod: 'examples', re: /\bexamples?\b|\bfor\s+instance\b|\blike\s+what\b/i },
  { mod: 'shorter', re: /\bshorter\b|\bbrief(?:er)?\b|\bconcise\b|\btl;?dr\b|\btoo\s+long\b|\bcut\s+(?:it|that)\s+down\b|\btrim\b/i },
  { mod: 'simpler', re: /\bsimpl(?:e|er|ify)\b|\bplain(?:er)?\b|\beasier\b|\bdumb\s+it\s+down\b|\bin\s+plain\s+(?:english|terms)\b/i },
  { mod: 'longer', re: /\blonger\b|\bmore\s+of\s+(?:it|them)\b|\ba\s+few\s+more\b|\bkeep\s+going\b/i },
  { mod: 'rewrite', re: /\brewrite\b|\bredo\b|\btry\s+again\b|\bdifferent(?:ly)?\b|\banother\s+way\b|\breword\b/i },
  { mod: 'add', re: /^(?:also\s+)?add\b|\binclude\b|\bplus\b|\band\s+also\b/i },
  { mod: 'remove', re: /^(?:remove|drop|delete)\b|\btake\s+(?:it|that)\s+out\b|\bwithout\b|\bget\s+rid\s+of\b/i },
];

function detectModifier(t: string): RefineModifier | undefined {
  for (const { mod, re } of MODIFIER_PATTERNS) {
    if (re.test(t)) return mod;
  }
  return undefined;
}

/**
 * Classify a message as a context-dependent follow-up, or null when it reads
 * as a standalone request. Cheap (regex only) — safe to call on every turn.
 *
 *   "yes"                  → { kind: 'confirm' }
 *   "yes do it specific"   → { kind: 'confirm', modifier: 'more_specific' }
 *   "make it specific"     → { kind: 'refine',  modifier: 'more_specific' }
 *   "shorter"              → { kind: 'refine',  modifier: 'shorter' }
 *   "no, not that"         → { kind: 'reject' }
 *   "the second one"       → { kind: 'reference' }
 *   "why?"                 → { kind: 'clarify' }
 *   "I had eggs for lunch" → null (standalone)
 */
export function detectFollowUp(text: string): FollowUp | null {
  const t = (text || '').trim();
  if (!t) return null;
  if (t.length > MAX_FOLLOWUP_LEN) return null;

  const modifier = detectModifier(t);

  // Rejection wins over everything — never execute when the user said no.
  if (REJECT_RE.test(t)) return { kind: 'reject' };

  // Confirmation, possibly carrying a refinement ("yes, make it specific").
  if (CONFIRM_RE.test(t)) return modifier ? { kind: 'confirm', modifier } : { kind: 'confirm' };

  // A bare refinement instruction ("make it specific", "shorter", "add that").
  if (modifier) return { kind: 'refine', modifier };

  // Pure "why?/how?/explain" — modifies the previous response, never a new topic.
  if (CLARIFY_RE.test(t)) return { kind: 'clarify' };

  // A reference to a prior option ("the second one", "this plan", "both").
  if (REFERENCE_RE.test(t)) return { kind: 'reference' };

  return null;
}

/** True when the message reads as a refinement/confirmation that should
 *  produce a MORE detailed/specific version of the prior output. */
export function wantsMoreDetail(fu: FollowUp | null): boolean {
  if (!fu) return false;
  return (
    fu.modifier === 'more_specific' ||
    fu.modifier === 'more_detail' ||
    fu.modifier === 'longer' ||
    fu.modifier === 'examples'
  );
}
