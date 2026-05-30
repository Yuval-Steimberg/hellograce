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
  category: 'greeting' | 'brief_positive' | 'brief_ack' | 'thanks';
}

// Pure greeting — no question, no follow-up content
const GREETING_RE = /^(hi|hey|hello|hii+|heyy+|helloo+|good\s+morning|good\s+afternoon|good\s+evening|morning|evening|hey\s+grace|hi\s+grace|hello\s+grace|sup|yo|howdy|whats?\s+up)\s*[.!?]?\s*$/i;

// Brief positive feeling — e.g. "I'm feeling strong", "I'm good", "feeling great"
// Must not contain a question mark, must be short. Negative feelings are
// excluded — they need real empathy, not a canned reply.
const BRIEF_POSITIVE_RE = /^(i'?m\s+)?(feeling\s+|doing\s+)?(strong|great|good|amazing|wonderful|fantastic|awesome|excellent|fine|okay|ok|alright|well|happy|grateful|blessed|energized|motivated|focused|positive)\s*[.!]?\s*$/i;

// Brief ack — "ok", "got it", "noted", "cool", "thanks", "thx"
const BRIEF_ACK_RE = /^(ok|okay|kk|k|got\s+it|noted|cool|sweet|solid|nice|alright|sure|yep|yup|yes|will\s+do|sounds?\s+good|👍|👌|🤍|🧡|❤️)\s*[.!]?\s*$/i;

const THANKS_RE = /^(thanks|thank\s+you|thx|ty|appreciate\s+it|appreciate\s+you|thank\s+u|🙏)\s*[.!]?\s*$/i;

// Response pools — rotated by deterministic hash of (userId + text) so the
// same user doesn't get the same line twice in a row but two different users
// sending "hi" don't both get the identical reply.
const GREETING_REPLIES: readonly string[] = [
  'Hey there.',
  'Hi 🤍',
  'Hey. Good to hear from you.',
  'Hey. How are you doing today?',
  'Hi there. How are you feeling?',
  'Hey. What\'s on your mind today?',
  'Hi. How\'s your day going?',
] as const;

const BRIEF_POSITIVE_REPLIES: readonly string[] = [
  'Love hearing that.',
  'Really glad to hear it.',
  'That\'s great to hear.',
  'Good to hear 🤍',
  'Happy to hear that.',
  'Glad you\'re feeling that way.',
] as const;

const BRIEF_ACK_REPLIES: readonly string[] = [
  'Got it 👍',
  'Noted.',
  'Cool.',
  'Sounds good.',
  '🤍',
] as const;

const THANKS_REPLIES: readonly string[] = [
  'Anytime.',
  'Of course.',
  'Glad it helped.',
  'No worries.',
  'Always 🤍',
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
export function tryFastPath(text: string, userId: string): FastPathResult | null {
  const trimmed = text.trim();
  // Hard length cap — anything longer than 40 chars almost certainly needs
  // real processing (the longest match here is ~35 chars).
  if (trimmed.length === 0 || trimmed.length > 40) return null;
  // Any question mark → real pipeline (user is asking something)
  if (trimmed.includes('?')) return null;
  // Any digit → could be a weight/food/dose log → real pipeline
  if (/\d/.test(trimmed)) return null;

  const seed = `${userId}|${trimmed.toLowerCase()}`;

  if (GREETING_RE.test(trimmed)) {
    return { text: pickFromPool(GREETING_REPLIES, seed), category: 'greeting' };
  }
  if (BRIEF_POSITIVE_RE.test(trimmed)) {
    return { text: pickFromPool(BRIEF_POSITIVE_REPLIES, seed), category: 'brief_positive' };
  }
  if (THANKS_RE.test(trimmed)) {
    return { text: pickFromPool(THANKS_REPLIES, seed), category: 'thanks' };
  }
  if (BRIEF_ACK_RE.test(trimmed)) {
    return { text: pickFromPool(BRIEF_ACK_REPLIES, seed), category: 'brief_ack' };
  }
  return null;
}
