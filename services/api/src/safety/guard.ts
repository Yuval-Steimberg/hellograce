export type SafetyClass = 'safe' | 'emergency' | 'crisis' | 'medical_advice';

export interface SafetyCheck {
  class: SafetyClass;
  matched?: string;
  response?: string;
}

const EMERGENCY = [
  'chest pain', "can't breathe", 'cant breathe', 'cannot breathe', 'passing out',
  'heart attack', 'seizure', 'unconscious', 'ambulance', '911', 'going to er',
];
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
const SAFETY_RESPONSE =
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
  for (const k of EMERGENCY) {
    if (lower.includes(k) && !allOccurrencesNegated(lower, k)) {
      return { class: 'emergency', matched: k, response: SAFETY_RESPONSE };
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
