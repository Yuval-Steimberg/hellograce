/**
 * Grace identity / "what can you do" handling + onboarding side-questions.
 *
 * Two jobs:
 *   1. Guarantee a capability question ("what can you do", "who are you") is
 *      answered AS GRACE — the GLP-1 companion — never as a generic assistant
 *      ("I can write code, explain quantum physics…"), which happened in prod
 *      when the system prompt failed to load.
 *   2. During onboarding, let the user ask a side-question ("what can you do",
 *      "why do you need this", "how does this work") and get a SHORT Grace-voice
 *      answer, then continue the setup — never derail the flow.
 */

// Anchored to the WHOLE message (with optional trailing punctuation) so a real
// topic question — "how can you help me with nausea" — is NOT caught here.
const CAPABILITY_RE =
  /^(what can (you|u|ya) do|what do you do|what are you( able to do)?|who are you|what('?s| is) (your name|grace)|how (do|does|can) (you|this|grace) help( me)?|what (can|do) you help( me)? with|tell me (about|what) (you|yourself|grace) (do|are|can do)|what is this( app| service)?|what'?s this( app| service)?)\s*[?.!]*$/i;

const WHY_RE =
  /\bwhy (do|does|are|d'?) ?(you|u)\b|\bwhy (this|that|is this|do i|are you asking)\b|what('?s| is) (this|that) for\b/i;

const HOW_RE =
  /\b(how (does|do|will) (this|it|you|grace) work|how does this work|what happens (next|after)|what'?s next|is this an? (app|bot|ai))\b/i;

const SKIP_ASK_RE =
  /\b(can i skip|do i (have|need) to|is this (required|optional|necessary)|rather not (say|share)|do i need to answer)\b/i;

/** True when the message is asking about Grace's identity / capabilities. */
export function detectCapabilityQuestion(text: string): boolean {
  const t = (text ?? '').trim();
  if (t.length === 0 || t.length > 80) return false; // a long message isn't a bare "what can you do"
  return CAPABILITY_RE.test(t);
}

export type OnboardingSideQuestion = 'capability' | 'why' | 'how' | 'skip' | null;

/**
 * Classify an onboarding interruption. Returns null when the message is a normal
 * answer (the caller then parses it as the slot's value). Short messages only —
 * a long message is treated as an answer, not a side-question.
 */
export function detectOnboardingSideQuestion(text: string): OnboardingSideQuestion {
  const t = (text ?? '').trim();
  if (t.length === 0 || t.length > 80) return null;
  if (SKIP_ASK_RE.test(t)) return 'skip';
  if (detectCapabilityQuestion(t)) return 'capability';
  if (WHY_RE.test(t)) return 'why';
  if (HOW_RE.test(t)) return 'how';
  return null;
}

/**
 * SHORT Grace-voice answer to a side-question, to be followed by re-posing the
 * current onboarding question. SMS-friendly (1–2 sentences), always in persona.
 */
export function buildSideAnswer(kind: Exclude<OnboardingSideQuestion, null>): string {
  switch (kind) {
    case 'capability':
      return "Totally 😊 I'm Grace — your GLP-1 companion. I help with protein, meals, side effects, injection-day tips, reminders, and little daily check-ins. Let's finish your quick setup so I can make it personal.";
    case 'why':
      return "Good question — it just helps me personalize everything for you 😊";
    case 'how':
      return "I'm Grace, your GLP-1 companion — I check in and help with food, protein, side effects, and more. Quick setup first so it's all tailored to you.";
    case 'skip':
      return "Of course, we can skip that.";
  }
}

/**
 * Grace's full capability answer for a POST-onboarding "what can you do" — warm,
 * concrete, SMS-short, ending with an easy invitation. Plain prose (no lists) so
 * it survives the outbound formatter.
 */
export function buildCapabilityReply(firstName?: string | null): string {
  const hi = firstName ? `${firstName}, ` : '';
  return (
    `${hi}I'm Grace — your GLP-1 companion 🧡 Text me what you eat (or snap a photo) and ` +
    `I'll track your protein and calories, ask me anything about your meds or side effects, ` +
    `log your weight, and I'll check in through the week. Want to start? Tell me what you've ` +
    `eaten today, or how you're feeling.`
  );
}
