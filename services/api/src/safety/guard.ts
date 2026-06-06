// PRE-LAUNCH GATE: legal review required for missed-dose / drug-interaction
// wording before launch. See docs/PRE_LAUNCH_GATES.md.

export type SafetyClass = 'safe' | 'emergency' | 'crisis' | 'medical_advice';

/** Semantic category of an emergency-level symptom. Used by the cross-turn
 *  symptom-stack accumulator so independent symptoms in the same category
 *  ("chest pain" + "racing heart" — both cardio) don't double-count. */
export type SymptomCategory =
  | 'cardio'
  | 'gi_severe'
  | 'neuro'
  | 'allergic'
  | 'dehydration'
  | 'weakness'
  | 'respiratory'
  | 'other_emergency';

export interface SafetyCheck {
  class: SafetyClass;
  matched?: string;
  response?: string;
  /** Set when classification is 'emergency' so callers can record the
   *  category for cross-turn symptom-stacking. */
  symptomCategory?: SymptomCategory;
}

/** EMERGENCY keywords keyed by symptom category. Extends the original flat
 *  list with confusion, allergic-reaction, racing-heart, severe weakness,
 *  and dehydration patterns flagged as missing in the 2026-06-06 coverage
 *  audit. Negation handling and ordering are unchanged from the original
 *  classifier. */
const EMERGENCY_BY_CATEGORY: Array<{ category: SymptomCategory; keywords: string[] }> = [
  {
    category: 'cardio',
    keywords: [
      'chest pain', 'chest pressure', 'heart attack',
      'racing heart', 'heart racing', 'pounding heart', 'heart pounding',
      'palpitations', 'irregular heartbeat',
    ],
  },
  {
    category: 'respiratory',
    keywords: ["can't breathe", 'cant breathe', 'cannot breathe'],
  },
  {
    category: 'neuro',
    keywords: [
      'passing out', 'seizure', 'unconscious',
      // Confusion / disorientation
      "can't think straight", 'cant think straight',
      'disoriented',
      // "confused" / "confusion" added with extra guard for non-emergency
      // mentions ("I'm confused about the schedule") — the classifyMessage
      // function handles this via the CONFUSION_NON_EMERGENCY_RE check.
      'confused', 'confusion',
    ],
  },
  {
    category: 'allergic',
    keywords: [
      'allergic reaction', 'anaphylaxis', 'anaphylactic',
      'throat closing', 'throat tightening', 'throat swelling',
      'swelling face', 'face swelling', 'lips swelling',
      'tongue swelling', 'hives all over',
    ],
  },
  {
    category: 'weakness',
    keywords: [
      'severe weakness', "can't stand up", 'cant stand up',
      'can barely move', 'too weak to',
    ],
  },
  {
    category: 'dehydration',
    keywords: [
      'severely dehydrated', "haven't urinated", 'havent urinated',
      "haven't peed", 'havent peed',
    ],
  },
  {
    category: 'other_emergency',
    keywords: ['ambulance', 'going to er', 'going to the er'],
  },
];

// Phrases that contain "confused" / "confusion" but are NOT medical-emergency
// confusion (cognitive disorientation). Examples: "I'm confused about the
// schedule", "this is confusing." These remain 'safe'.
const CONFUSION_NON_EMERGENCY_RE =
  /\b(?:confused|confusion|confusing)\b[^.!?]*\b(?:about|by|on|over|with|regarding|by the|by your|by the way|by how|by what)\b|\bthis is (?:so )?(?:confusing|confusion)\b|\bsomewhat confused\b|\ba (?:little|bit) confused\b/i;

const CRISIS = [
  'want to die', 'kill myself', 'suicide', 'suicidal', 'self harm', 'self-harm',
  'hurt myself', 'no reason to live', 'better off dead', 'end my life', 'end it all',
];
const MEDICAL_ADVICE = [
  'should i stop taking', 'should i increase my dose', 'should i decrease', 'skip my dose',
  'take extra', 'double dose', 'overdose', 'too much medication',
];

// Unified safety message per master prompt — sent verbatim for both physical
// emergencies and mental health crises. Both 988 (US crisis line) and 911 are
// surfaced together so the user always has the right channel without Grace
// having to disambiguate. Word-for-word per spec.
//
// Exported so the symptom-stack escalator in webhook.ts can ship the exact
// same text on a cross-turn force-escalation.
export const SAFETY_RESPONSE =
  'Please reach out for support right now. Call or text 988 to talk to someone trained to help. They\'re available 24/7. If you\'re in immediate physical danger, call 911. I care about you and want you to get real help immediately.';
const MEDICAL_ADVICE_RESPONSE =
  'That\'s really one for your prescribing clinician — they can give you the right answer for your specific dose and schedule. If something feels off, message them today or call your pharmacy\'s nurse line.';

const NEGATION_RE =
  /\b(don'?t|do not|doesn'?t|does not|didn'?t|did not|won'?t|will not|cannot|can'?t|isn'?t|aren'?t|wasn'?t|weren'?t|never|no (?:thoughts|plan|intention|reason|urge|desire)|not (?:going|planning|thinking)|i'?m not|i am not|no longer|nobody|never had|never want)\b/;

/**
 * True if EVERY occurrence of the keyword in `lower` is preceded by a
 * negation within the same sentence — e.g. "I don't want to die",
 * "no thoughts of suicide". If ANY occurrence is non-negated, the
 * keyword counts as a real match. Substring .includes() alone produces
 * dangerous false positives on phrases like the ones above; the crisis
 * response sends 988 + 911 so a false positive is alarming.
 */
function allOccurrencesNegated(lower: string, keyword: string): boolean {
  let from = 0;
  let found = false;
  while (true) {
    const idx = lower.indexOf(keyword, from);
    if (idx < 0) break;
    found = true;
    // Look at up to 80 chars before this occurrence, scoped to the same
    // sentence (don't carry negation across "." / "!" / "?" / newline).
    const start = Math.max(0, idx - 80);
    const before = lower.slice(start, idx);
    const sentenceStart = Math.max(
      before.lastIndexOf('.'),
      before.lastIndexOf('!'),
      before.lastIndexOf('?'),
      before.lastIndexOf('\n'),
    );
    const window = sentenceStart >= 0 ? before.slice(sentenceStart + 1) : before;
    if (!NEGATION_RE.test(window)) return false;
    from = idx + keyword.length;
  }
  return found; // true only if at least one occurrence existed and all were negated
}

export function classifyMessage(text: string): SafetyCheck {
  const lower = text.toLowerCase();
  for (const group of EMERGENCY_BY_CATEGORY) {
    for (const k of group.keywords) {
      if (!lower.includes(k)) continue;
      if (allOccurrencesNegated(lower, k)) continue;
      // Suppress "confused/confusion/confusing" when it's clearly the
      // cognitive-conversation use ("I'm confused about the schedule"),
      // not the medical-emergency disorientation symptom.
      if ((k === 'confused' || k === 'confusion') && CONFUSION_NON_EMERGENCY_RE.test(text)) {
        continue;
      }
      return {
        class: 'emergency',
        matched: k,
        response: SAFETY_RESPONSE,
        symptomCategory: group.category,
      };
    }
  }
  for (const k of CRISIS) {
    if (lower.includes(k) && !allOccurrencesNegated(lower, k)) {
      return { class: 'crisis', matched: k, response: SAFETY_RESPONSE };
    }
  }
  for (const k of MEDICAL_ADVICE) {
    if (lower.includes(k) && !allOccurrencesNegated(lower, k)) {
      return { class: 'medical_advice', matched: k, response: MEDICAL_ADVICE_RESPONSE };
    }
  }
  return { class: 'safe' };
}

/** Classify a SYMPTOM_SIGNAL-positive but currently-safe message into a
 *  symptom category for stacking. Returns null when the message doesn't
 *  carry a recognized sub-emergency-threshold symptom signal. Used by the
 *  webhook's symptom-stack accumulator to detect cross-turn escalation. */
export function classifySymptomCategory(text: string): SymptomCategory | null {
  const lower = text.toLowerCase();
  // Vomiting / persistent GI distress that didn't trigger emergency directly
  if (
    /\b(throwing up|threw up|vomiting|vomited|cant keep (water|fluid|liquid)|can'?t keep (water|fluid|liquid))\b/.test(lower) ||
    /\b(stomach|tummy|belly|abdom)\w*\b[^.!?]*\b(hurts? badly|severe|killing me|agony|excruciating)\b/.test(lower) ||
    /\b(severe|sharp|stabbing) (abdom|stomach|belly)/.test(lower)
  ) {
    return 'gi_severe';
  }
  // Cardio sub-emergency: "my heart's been racing all day" — covered by
  // EMERGENCY too, but keep this for messages that lean toward "is this
  // normal" without explicit heart-attack language.
  if (/\b(heart\s+(racing|pounding)|racing\s+heart|pounding\s+heart|palpitations)\b/.test(lower)) {
    return 'cardio';
  }
  // Allergic-ish signals that aren't full emergencies on their own
  if (/\b(hives|rash all over|itchy all over|skin reaction|swollen lip|swelling lip)\b/.test(lower)) {
    return 'allergic';
  }
  // Dehydration signals
  if (/\b(dehydrated|haven'?t (peed|urinated)|very dark urine|cant keep water)\b/.test(lower)) {
    return 'dehydration';
  }
  // Severe weakness
  if (/\b(severely weak|too weak to|can barely move|can'?t stand up)\b/.test(lower)) {
    return 'weakness';
  }
  return null;
}
