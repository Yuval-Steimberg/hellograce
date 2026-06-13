// Health-concern detector — catches personal concerns / guidance requests about
// vitals and conditions that sit OUTSIDE Grace's GLP-1 scope (blood pressure,
// heart rate, palpitations, cholesterol). These must never be force-logged or
// answered with generic education — they need a supportive, clarifying, calm
// response that gathers context and points to the user's clinician.
//
// Production failure (2026-06-13):
//   User: "I'm having blood pressure problems what should I do"
//   Grace: "Logged."   ← a health concern routed into a logging workflow.
//   Earlier: "How about my blood pressure?" → generic "GLP-1s can lower BP…"
//            instead of understanding the user is asking about THEMSELVES.
//
// Design:
//   - Deterministic regex, ~0ms, runs before the log / force-log / FAQ paths.
//   - Fires only on PERSONAL / CONCERN framing ("my bp", "I'm having…",
//     "what should I do"), NOT on pure education ("does GLP-1 affect BP?") —
//     those still flow to the educational pipeline.
//   - Crisis/emergency (chest pain, can't breathe) is handled earlier by the
//     SafetyGuard; this layer is for non-emergency concerns.
//   - Follow-up aware: once we've asked, the next message gets a refer-focused
//     reply instead of repeating the same two questions.

export interface HealthConcernCheck {
  concern: boolean;
  vital?: string;
  response?: string;
}

// Cardiovascular / out-of-scope vitals. NB: blood sugar / glucose is
// deliberately excluded — it's central to the GLP-1/diabetes context, so the
// educational pipeline should handle it.
const VITALS: Array<{ re: RegExp; label: string }> = [
  { re: /\bblood\s+pressure\b/i, label: 'blood pressure' },
  { re: /\bbp\b/i, label: 'blood pressure' },
  { re: /\bheart\s*rate\b/i, label: 'heart rate' },
  { re: /\bpulse\b/i, label: 'heart rate' },
  { re: /\b(heart\s+)?palpitations?\b/i, label: 'heart palpitations' },
  { re: /\bcholesterol\b/i, label: 'cholesterol' },
];

// Personal / concern / guidance framing. Distinguishes "my bp is high, what do
// I do" from a detached education question.
const PERSONAL_OR_CONCERN_RE =
  /\b(my|i'?m\s+having|i\s+am\s+having|i\s+have|i'?ve\s+(been\s+)?having|i'?ve\s+had|what\s+should\s+i\s+do|what\s+do\s+i\s+do|what\s+can\s+i\s+do|help|worried|concern(?:ed)?|trouble|problems?|issues?|too\s+high|too\s+low|is\s+high|is\s+low|running\s+(?:high|low)|spiking|dropping|through\s+the\s+roof)\b/i;

// Marker that Grace already asked our clarifying question last turn.
const PRIOR_HEALTH_ASK_RE =
  /(what'?s going on with your|high readings, low readings|tell me a bit more about what'?s)/i;

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// Answer-ish content (readings / symptoms) the user might send in reply to our
// clarifying question without repeating the vital's name ("high readings",
// "feeling dizzy", "150/95").
const ANSWERISH_RE =
  /\b(high|low|readings?|dizzy|dizziness|headaches?|lightheaded|spiking|dropping|fine|normal|elevated|\d{2,3}\s*\/\s*\d{2,3}|\d{2,3}\s*bpm)\b/i;

export function detectHealthConcern(text: string, lastGraceMessage?: string): HealthConcernCheck {
  const t = text.trim();
  if (t.length === 0 || t.length > 300) return { concern: false };

  const priorAsk = !!lastGraceMessage && PRIOR_HEALTH_ASK_RE.test(lastGraceMessage);

  let vital: string | null = null;
  for (const v of VITALS) {
    if (v.re.test(t)) { vital = v.label; break; }
  }
  // Continuity: if this is a reply to our own clarification, the user may not
  // repeat the vital name ("high readings") — recover it from our question.
  if (!vital && priorAsk && lastGraceMessage) {
    const m = /\byour\s+(blood pressure|heart rate|heart palpitations|cholesterol)\b/i.exec(lastGraceMessage);
    if (m) vital = m[1]!.toLowerCase();
  }
  if (!vital) return { concern: false };

  const personal = PERSONAL_OR_CONCERN_RE.test(t);
  // Fire on personal/concern framing, OR on an answer to our prior ask.
  if (!personal && !(priorAsk && ANSWERISH_RE.test(t))) return { concern: false };

  const followUp = priorAsk;

  if (followUp) {
    return {
      concern: true,
      vital,
      response:
        `Thanks for telling me. ${cap(vital)} can be affected by a lot of things, so the safest next step is to check in with your doctor or pharmacist — they can look at your readings alongside your full medication list. ` +
        `I'm here for the GLP-1 side of things and to support you through it, so keep me posted on how you're feeling.`,
    };
  }

  return {
    concern: true,
    vital,
    response:
      `Sorry you're dealing with that. Can you tell me a bit more about what's going on with your ${vital}? ` +
      `Are you noticing high readings, low readings, or symptoms like dizziness, headaches, or feeling lightheaded? ` +
      `${cap(vital)} can have a lot of different causes, so it's a good idea to discuss ongoing concerns with your doctor, especially if anything feels severe or is getting worse.`,
  };
}
