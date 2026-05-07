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

const EMERGENCY_RESPONSE =
  'This sounds like an emergency. Please call 911 (or your local emergency number) right now or go to the nearest ER. I\'m here to support you, but you need a clinician immediately.';
const CRISIS_RESPONSE =
  'I hear you, and I\'m glad you told me. Please reach out right now: call or text 988 (Suicide & Crisis Lifeline, US) or your local crisis line. You don\'t have to go through this alone.';
const MEDICAL_ADVICE_RESPONSE =
  'I can\'t give dose-change advice — that\'s a conversation for your prescribing clinician. If something feels off, message them today or call your pharmacy\'s nurse line.';

export function classifyMessage(text: string): SafetyCheck {
  const lower = text.toLowerCase();
  for (const k of EMERGENCY) if (lower.includes(k)) return { class: 'emergency', matched: k, response: EMERGENCY_RESPONSE };
  for (const k of CRISIS) if (lower.includes(k)) return { class: 'crisis', matched: k, response: CRISIS_RESPONSE };
  for (const k of MEDICAL_ADVICE) if (lower.includes(k)) return { class: 'medical_advice', matched: k, response: MEDICAL_ADVICE_RESPONSE };
  return { class: 'safe' };
}
