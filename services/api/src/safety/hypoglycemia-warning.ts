// Hypoglycemia-warning handler (2026-06-16).
//
// The classic adrenergic warning cluster — shaky + sweaty + lightheaded/dizzy/
// weak/confused — on a GLP-1 (especially alongside insulin or a sulfonylurea)
// can be low blood sugar, which is time-sensitive. The SAFE first response is
// empathy + immediate fast sugar (juice / regular soda / glucose tabs) + call
// the doctor right away — while HEDGING the label ("this could be low blood
// sugar", never "your blood sugar IS low"). Quick sugar is safe first aid even
// if the cause turns out to be dehydration or anxiety, and untreated hypo is
// the more dangerous miss.
//
// Why deterministic (not the LLM): production showed Grace either (a) gave a
// hedged-but-useless "you might be experiencing symptoms of low blood sugar or
// dehydration" with NO action, then (b) "stuck" with no reply on the follow-up
// "What should I do?". A deterministic handler guarantees a good, actionable,
// appropriately-hedged answer regardless of Gemini's state, and answers the
// follow-up by reading the prior turn's context.
//
// Relationship to other layers:
//   - SafetyGuard (chest pain / can't breathe / self-harm → 988/911) runs first
//     and is unchanged.
//   - health-concern.ts deliberately EXCLUDES blood sugar; this module owns it.
//   - DIAGNOSTIC CONFIDENCE (prompts H8b) keeps the label hedged everywhere else.

export interface HypoWarningCheck {
  warning: boolean;
  response?: string;
  /** True when this fired off the follow-up ("what should I do?") path. */
  followUp?: boolean;
}

// Adrenergic / neuroglycopenic warning symptoms, grouped so we can require ≥2
// DISTINCT categories (a single "shaky" is too ambiguous — could be emotional).
const SYMPTOM_CATEGORIES: RegExp[] = [
  /\b(shaky|shaking|trembling|tremor(?:s|ing)?|jittery|the\s+shakes)\b/i,
  /\b(sweaty|sweating|clammy|cold\s+sweat|perspiring|drenched\s+in\s+sweat)\b/i,
  /\b(light[\s-]?headed|lightheaded|dizzy|dizziness|woozy|faint|going\s+to\s+pass\s+out|about\s+to\s+pass\s+out)\b/i,
  /\b(weak|weakness|wobbly|legs?\s+(?:are\s+)?(?:weak|jelly|giving\s+out))\b/i,
  /\b(confused|confusion|disoriented|foggy|can'?t\s+think\s+straight|can'?t\s+focus)\b/i,
  /\b(palpitations?|racing\s+heart|heart\s+(?:is\s+)?(?:racing|pounding)|pounding\s+heart|heart\s+racing)\b/i,
  /\b(blurry\s+vision|blurred\s+vision|vision\s+(?:going\s+)?blurry)\b/i,
  /\b(suddenly\s+(?:very\s+)?hungry|ravenous|shaky\s+with\s+hunger)\b/i,
];

/** Cheap pre-gate: does the message mention ANY warning symptom at all? */
export function mightBeHypoSymptom(text: string): boolean {
  return SYMPTOM_CATEGORIES.some((re) => re.test(text));
}

function distinctSymptomCount(text: string): number {
  let n = 0;
  for (const re of SYMPTOM_CATEGORIES) if (re.test(text)) n++;
  return n;
}

// "What should I do?" style follow-up — short, open request for next steps.
const WHAT_DO_RE =
  /^\s*(what\s+should\s+i\s+(?:do|take|eat|have)|what\s+(?:do|can)\s+i\s+do|what\s+now|now\s+what|what\s+do\s+i\s+need\s+to\s+do|help(?:\s+me)?|so\s+what\s+do\s+i\s+do)\b[\s.?!]*$/i;

export function isWhatShouldIDo(text: string): boolean {
  const t = text.trim();
  if (t.split(/\s+/).filter(Boolean).length > 8) return false;
  return WHAT_DO_RE.test(t);
}

// Did the prior turn establish a low-blood-sugar / warning-symptom context, so a
// bare "what should I do?" is about THAT?
const PRIOR_HYPO_CONTEXT_RE =
  /\b(low\s+blood\s+sugar|blood\s+sugar|hypoglycemi\w*|glucose|shaky|sweaty|light[\s-]?headed|lightheaded|dizzy|weak|confused|faint)\b/i;

const INITIAL_RESPONSE =
  "That sounds really scary. Get some quick sugar in you right now — juice, regular (non-diet) soda, or a few glucose tabs — and sit down somewhere safe. Then call your doctor right away to let them know. This can sometimes be low blood sugar, which needs a medical look. If you feel worse, more confused, or faint, call 911.";

const FOLLOWUP_RESPONSE =
  "Get some quick sugar in you right now — like juice or regular soda — and call your doctor immediately. This could be low blood sugar and needs a medical look. If you feel worse or more confused, call 911.";

/**
 * Detect the hypoglycemia-warning cluster (or its "what should I do?" follow-up)
 * and return a deterministic, empathetic, ACTIONABLE, appropriately-hedged
 * response. Returns { warning: false } when it doesn't apply.
 *
 * @param text             the user's current message
 * @param lastGraceMessage Grace's previous message (for follow-up context)
 * @param lastUserMessage  the user's previous message (for follow-up context)
 */
export function detectHypoglycemiaWarning(
  text: string,
  lastGraceMessage?: string,
  lastUserMessage?: string,
): HypoWarningCheck {
  const t = (text ?? '').trim();
  if (t.length === 0 || t.length > 300) return { warning: false };

  // Direct: ≥2 distinct warning symptoms in the current message.
  if (distinctSymptomCount(t) >= 2) {
    return { warning: true, response: INITIAL_RESPONSE };
  }

  // Follow-up: "what should I do?" right after a warning-symptom / low-blood-
  // sugar turn (from either side of the conversation).
  if (isWhatShouldIDo(t)) {
    const priorContext =
      (!!lastGraceMessage && PRIOR_HYPO_CONTEXT_RE.test(lastGraceMessage)) ||
      (!!lastUserMessage && distinctSymptomCount(lastUserMessage) >= 2);
    if (priorContext) {
      return { warning: true, followUp: true, response: FOLLOWUP_RESPONSE };
    }
  }

  return { warning: false };
}
