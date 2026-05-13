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

export function classifyMessage(text: string): SafetyCheck {
  const lower = text.toLowerCase();
  for (const k of EMERGENCY) if (lower.includes(k)) return { class: 'emergency', matched: k, response: SAFETY_RESPONSE };
  for (const k of CRISIS) if (lower.includes(k)) return { class: 'crisis', matched: k, response: SAFETY_RESPONSE };
  for (const k of MEDICAL_ADVICE) if (lower.includes(k)) return { class: 'medical_advice', matched: k, response: MEDICAL_ADVICE_RESPONSE };
  return { class: 'safe' };
}
