// Fast-path responder for trivial messages — bypasses the full pipeline
// (no LLM call, no RAG, no tools, no guards). Used for greetings, brief
// positive feelings, brief acks, and simple thanks where a warm one-liner
// is both the best response and the right tradeoff for speed.
//
// 2026-05-30 latency pass: simple greetings were going through the full
// pipeline (~2-4s including coalesce + LLM). This brings them down to
// ~50-150ms (just Twilio send time + DB write).
//
// Safety: this fires ONLY on short, unambiguous messages. Anything that
// could reasonably need personalization, education, or tool use falls
// through to the normal pipeline.

export interface FastPathResult {
  text: string;
  category:
    | 'greeting'
    | 'brief_positive'
    | 'brief_negative'
    | 'brief_ack'
    | 'thanks'
    | 'goodnight'
    | 'farewell'
    | 'laughter'
    | 'apology'
    | 'reaction'
    | 'appreciation'
    | 'love_it'
    | 'denial'
    | 'confirmation';
}

// Pure greeting — no question, no follow-up content
const GREETING_RE = /^(hi|hey|hello|hii+|heyy+|helloo+|good\s+morning|good\s+afternoon|good\s+evening|morning|evening|hey\s+grace|hi\s+grace|hello\s+grace|sup|yo|howdy|whats?\s+up|whats?up|hiya)\s*[.!?]?\s*$/i;

// Brief positive feeling — e.g. "I'm feeling strong", "I'm good", "feeling great"
// Must not contain a question mark, must be short. Negative feelings are
// excluded — they need real empathy, not a canned reply.
const BRIEF_POSITIVE_RE = /^(i'?m\s+)?(feeling\s+|doing\s+)?(strong|great|good|amazing|wonderful|fantastic|awesome|excellent|fine|okay|ok|alright|well|happy|grateful|blessed|energized|motivated|focused|positive|chill|calm|peaceful|content|relaxed|refreshed|hopeful|optimistic|proud)\s*[.!]?\s*$/i;

// Brief negative feeling — short emotional states that get a one-sentence
// warm acknowledgment per the prompt's BRIEF REPLY RULE. EXCLUDES medical
// states (nauseous, sick, dizzy, in pain) — those need real personalization
// + tool calls + medical guidance. Also excludes "hungry" / "no appetite"
// which need food suggestions.
const BRIEF_NEGATIVE_RE = /^(i'?m\s+)?(feeling\s+|been\s+|so\s+)?(tired|exhausted|drained|wiped|spent|done|knackered|rough|stressed|anxious|overwhelmed|frustrated|sad|down|low|blue|lonely|defeated|burned\s+out|burnt\s+out|meh|blah|off|not\s+great|not\s+good|not\s+okay|not\s+ok|rough\s+day|long\s+day|hard\s+day|tough\s+day|rough\s+night|terrible|awful|the\s+worst)\s*[.!]?\s*$/i;

// Brief ack — "ok", "got it", "noted", "cool"
const BRIEF_ACK_RE = /^(ok|okay|kk|k|got\s+it|noted|cool|sweet|solid|nice|alright|sure|will\s+do|sounds?\s+good|copy\s+that|gotcha|👍|👌|🤍|🧡|❤️|💛|💚|💙|💜)\s*[.!]?\s*$/i;

// Confirmation — short "yes" style
const CONFIRMATION_RE = /^(yes|yeah|yep|yup|absolutely|definitely|for\s+sure|of\s+course|certainly|right|exactly|true|correct|indeed|100%|💯)\s*[.!]?\s*$/i;

// Brief denial — short "no" style. No medical / contextual content.
const DENIAL_RE = /^(no|nope|nah|not\s+really|no\s+thanks|i'?m\s+good|i'?m\s+ok|i'?m\s+okay|i'?m\s+fine\s+thanks|no\s+thank\s+you)\s*[.!]?\s*$/i;

const THANKS_RE = /^(thanks|thank\s+you|thank\s+u|thx|ty|tysm|appreciate\s+it|appreciate\s+you|appreciate\s+that|thanks\s+so\s+much|thank\s+you\s+so\s+much|much\s+appreciated|🙏)\s*[.!]?\s*$/i;

// Goodnight / heading to bed
const GOODNIGHT_RE = /^(goodnight|good\s+night|night|nighty|nite|gn|nighty\s+night|sweet\s+dreams|heading\s+to\s+bed|going\s+to\s+bed|off\s+to\s+bed|going\s+to\s+sleep|going\s+to\s+rest|gotta\s+sleep|need\s+sleep|time\s+for\s+bed|bedtime)\s*[.!]?\s*$/i;

// General farewell (not necessarily bedtime)
const FAREWELL_RE = /^(bye|byee+|goodbye|see\s+you|see\s+ya|see\s+you\s+later|see\s+you\s+tomorrow|talk\s+later|talk\s+tomorrow|catch\s+you\s+later|ttyl|ttys|later|peace|cya|gtg|gotta\s+go|have\s+to\s+go|i'?ll\s+be\s+back|brb)\s*[.!]?\s*$/i;

// Laughter
const LAUGHTER_RE = /^(lol|lolol|lololol|haha+|hehe+|hahah+a*|lmao+|lmfao+|rofl|hah|heh|🤣|😂|😆|😅|😄|😹|😊\s*😂)\s*[.!]?\s*$/i;

// Apology
const APOLOGY_RE = /^(sorry|sry|i'?m\s+sorry|im\s+sorry|so\s+sorry|my\s+bad|my\s+apologies|apologies|sorry\s+about\s+that|sorry\s+about\s+it|oops|oof|mb)\s*[.!]?\s*$/i;

// Reaction — short non-question reactions like "wow", "omg", "hmm"
const REACTION_RE = /^(wow|woah|whoa|woww+|omg|oh\s+my|gosh|oh\s+gosh|huh|hmm+|interesting|oh|oh\s+wow|oh\s+okay|oh\s+ok|geez|sheesh|dang|damn|noted)\s*[.!]?\s*$/i;

// Appreciation — "you're the best", "love you", "you rock"
const APPRECIATION_RE = /^(love\s+you|love\s+ya|i\s+love\s+you|you'?re\s+the\s+best|you\s+rock|you'?re\s+amazing|you'?re\s+great|you'?re\s+awesome|youre\s+the\s+best|best\s+ever|amazing|you'?re\s+helpful|so\s+helpful)\s*[.!]?\s*$/i;

// Generic positive reaction to Grace's previous message
const LOVE_IT_RE = /^(love\s+it|love\s+that|love\s+this|like\s+it|like\s+that|that'?s\s+helpful|that'?s\s+great|that\s+helps|helpful|thats\s+great|that'?s\s+perfect|perfect)\s*[.!]?\s*$/i;

// ── Response pools ──────────────────────────────────────────────────────────
// Rotated by deterministic hash of (userId + text) so the same user doesn't
// see identical replies repeatedly, but variety still exists across users.

const GREETING_REPLIES: readonly string[] = [
  'Hey there.',
  'Hi 🤍',
  'Hey. Good to hear from you.',
  'Hey. How are you doing today?',
  'Hi there. How are you feeling?',
  'Hey. What\'s on your mind today?',
  'Hi. How\'s your day going?',
  'Hey 🧡',
  'Hey. How\'s today treating you?',
] as const;

const BRIEF_POSITIVE_REPLIES: readonly string[] = [
  'Love hearing that.',
  'Really glad to hear it.',
  'That\'s great to hear.',
  'Good to hear 🤍',
  'Happy to hear that.',
  'Glad you\'re feeling that way.',
  'That makes me happy 🧡',
  'Solid.',
] as const;

const BRIEF_NEGATIVE_REPLIES: readonly string[] = [
  'Ugh. I\'m here.',
  'That sounds rough.',
  'Heavy day.',
  'Rest when you can.',
  'Sending you something gentle 🤍',
  'I\'m here. No pressure.',
  'That stings.',
  'Yeah, that one lands.',
  'Of course you\'re feeling that way.',
] as const;

const BRIEF_ACK_REPLIES: readonly string[] = [
  'Got it 👍',
  'Noted.',
  'Cool.',
  'Sounds good.',
  '🤍',
  'On it.',
  'Heard.',
] as const;

const CONFIRMATION_REPLIES: readonly string[] = [
  'Good.',
  'Cool.',
  'Glad we\'re on the same page.',
  'Nice.',
  'Got it 👍',
] as const;

const DENIAL_REPLIES: readonly string[] = [
  'All good.',
  'No worries.',
  'Sounds good.',
  'Got it.',
  'Cool.',
] as const;

const THANKS_REPLIES: readonly string[] = [
  'Anytime.',
  'Of course.',
  'Glad it helped.',
  'No worries.',
  'Always 🤍',
  'Really glad it landed.',
  'That\'s what I\'m here for.',
] as const;

const GOODNIGHT_REPLIES: readonly string[] = [
  'Sleep well 🤍',
  'Goodnight. Rest up.',
  'Night. Talk tomorrow.',
  'Rest well 🧡',
  'Sleep tight.',
  'Sweet dreams.',
  'Goodnight 🤍',
] as const;

const FAREWELL_REPLIES: readonly string[] = [
  'Talk soon.',
  'Catch you later 🤍',
  'See you 🧡',
  'Take care.',
  'Later.',
  'Anytime you need me.',
] as const;

const LAUGHTER_REPLIES: readonly string[] = [
  '😄',
  'Right?',
  'Hehe.',
  'Right 😄',
  'Haha.',
  '😆',
] as const;

const APOLOGY_REPLIES: readonly string[] = [
  'No worries.',
  'All good.',
  'Nothing to apologize for.',
  'It\'s okay 🤍',
  'Don\'t worry about it.',
  'All good — really.',
] as const;

const REACTION_REPLIES: readonly string[] = [
  'Right?',
  'Yeah, I know.',
  'I hear you.',
  'Mhm.',
  'Yeah.',
] as const;

const APPRECIATION_REPLIES: readonly string[] = [
  'That means a lot 🤍',
  'Right back at you.',
  'You\'re the kind one 🧡',
  'Thank you for saying that.',
  'Made my day.',
] as const;

const LOVE_IT_REPLIES: readonly string[] = [
  'Really glad 🤍',
  'Good.',
  'Happy that landed.',
  'Glad it helped.',
  'Awesome.',
] as const;

function pickFromPool(pool: readonly string[], seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  return pool[Math.abs(h) % pool.length]!;
}

/**
 * Try to match the message against a fast-path category and return a
 * deterministic warm reply. Returns null if the message doesn't qualify —
 * in which case the caller runs the full pipeline.
 *
 * @param text the user's inbound message
 * @param userId stable per-user identifier — used to vary the picked reply
 *               so the same user doesn't see identical greetings repeatedly
 */
// ── Hard exclusions — never fast-path these even if a regex matches ─────────
// Medical / symptom states need real personalization + medical guidance.
// Food / hunger states need food suggestions. Risk/crisis content is caught
// by the safety classifier upstream but double-check defensively here.
const NEVER_FAST_PATH_RE = /\b(nauseous|nausea|sick|throwing up|vomit|dizzy|faint|chest pain|hurts|hurting|in pain|pain|cramp|cramping|diarrhea|constipated|bleeding|fever|swollen|allergic|injection|shot|dose|dosage|hungry|starving|appetite|eat|ate|had|drank|drink|breakfast|lunch|dinner|snack|meal|food|protein|weight|lbs|kg|kilo|pound|scale|workout|exercise|reminder|stop|cancel|unsubscribe|pause|kill|die|suicide|hurt myself|harm)\b/i;

export function tryFastPath(text: string, userId: string): FastPathResult | null {
  const trimmed = text.trim();
  // Hard length cap — anything longer than 40 chars almost certainly needs
  // real processing.
  if (trimmed.length === 0 || trimmed.length > 40) return null;
  // Any question mark → real pipeline (user is asking something)
  if (trimmed.includes('?')) return null;
  // Any digit → could be a weight/food/dose log → real pipeline
  if (/\d/.test(trimmed)) return null;
  // Hash prefix is RLHF feedback comment — handled upstream
  if (trimmed.startsWith('#')) return null;
  // Defensive double-check — never fast-path medical/food/crisis content
  if (NEVER_FAST_PATH_RE.test(trimmed)) return null;

  const seed = `${userId}|${trimmed.toLowerCase()}`;

  // Order matters: more specific patterns first so a generic word doesn't
  // shadow a more meaningful match.
  if (GREETING_RE.test(trimmed)) {
    return { text: pickFromPool(GREETING_REPLIES, seed), category: 'greeting' };
  }
  if (THANKS_RE.test(trimmed)) {
    return { text: pickFromPool(THANKS_REPLIES, seed), category: 'thanks' };
  }
  if (GOODNIGHT_RE.test(trimmed)) {
    return { text: pickFromPool(GOODNIGHT_REPLIES, seed), category: 'goodnight' };
  }
  if (FAREWELL_RE.test(trimmed)) {
    return { text: pickFromPool(FAREWELL_REPLIES, seed), category: 'farewell' };
  }
  if (LAUGHTER_RE.test(trimmed)) {
    return { text: pickFromPool(LAUGHTER_REPLIES, seed), category: 'laughter' };
  }
  if (APOLOGY_RE.test(trimmed)) {
    return { text: pickFromPool(APOLOGY_REPLIES, seed), category: 'apology' };
  }
  if (APPRECIATION_RE.test(trimmed)) {
    return { text: pickFromPool(APPRECIATION_REPLIES, seed), category: 'appreciation' };
  }
  if (LOVE_IT_RE.test(trimmed)) {
    return { text: pickFromPool(LOVE_IT_REPLIES, seed), category: 'love_it' };
  }
  if (BRIEF_POSITIVE_RE.test(trimmed)) {
    return { text: pickFromPool(BRIEF_POSITIVE_REPLIES, seed), category: 'brief_positive' };
  }
  if (BRIEF_NEGATIVE_RE.test(trimmed)) {
    return { text: pickFromPool(BRIEF_NEGATIVE_REPLIES, seed), category: 'brief_negative' };
  }
  if (REACTION_RE.test(trimmed)) {
    return { text: pickFromPool(REACTION_REPLIES, seed), category: 'reaction' };
  }
  if (DENIAL_RE.test(trimmed)) {
    return { text: pickFromPool(DENIAL_REPLIES, seed), category: 'denial' };
  }
  if (CONFIRMATION_RE.test(trimmed)) {
    return { text: pickFromPool(CONFIRMATION_REPLIES, seed), category: 'confirmation' };
  }
  if (BRIEF_ACK_RE.test(trimmed)) {
    return { text: pickFromPool(BRIEF_ACK_REPLIES, seed), category: 'brief_ack' };
  }
  return null;
}
