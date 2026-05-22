/**
 * Edge safety filter — runs in < 1ms before the request reaches the API.
 * Returns an immediate hardcoded TwiML response for genuine emergencies so the
 * user gets 988/911 information even if the API is down.
 *
 * IMPORTANT: This is a belt-and-suspenders layer only. The API's SafetyGuard
 * is still the authoritative crisis handler. Any pattern added here should
 * be a clear-cut emergency phrase with zero false-positive risk.
 */

const BLOCK_PATTERNS: RegExp[] = [
  /\b(suicide|suicidal|kill\s+myself|end\s+my\s+life|take\s+my\s+life)\b/i,
  /\b(self.?harm|hurt\s+myself|cut\s+myself)\b/i,
  /\b(can'?t\s+breath|difficulty\s+breath|chest\s+pain|heart\s+attack)\b/i,
  /\b(anaphyla|allergic\s+reaction.*throat|throat.*clos)\b/i,
  /\b(overdos(e|ing)|took\s+too\s+many|too\s+much\s+medication)\b/i,
  /\b(unconscious|pass(ed|ing)\s+out|can'?t\s+wake)\b/i,
];

// Hardcoded TwiML — no AI, no network call, always available
const EMERGENCY_TWIML = `<?xml version="1.0" encoding="UTF-8"?>
<Response></Response>`;

// Companion outbound message sent via Twilio API (not TwiML) after 200 OK
export const EMERGENCY_MESSAGE =
  'This sounds serious. Please reach out for immediate support:\n\n' +
  '🆘 *Crisis line*: 988 (call or text, 24/7)\n' +
  '🚨 *Emergency*: Call 911 or go to your nearest ER\n\n' +
  'You are not alone. Help is available right now.';

export interface FilterResult {
  blocked: boolean;
  twiml: string;
}

export function filterMessage(body: string): FilterResult {
  const text = (body ?? '').trim();
  for (const pattern of BLOCK_PATTERNS) {
    if (pattern.test(text)) {
      return { blocked: true, twiml: EMERGENCY_TWIML };
    }
  }
  return { blocked: false, twiml: '' };
}

/**
 * Splits a long message into WhatsApp-safe chunks at sentence or paragraph
 * boundaries. WhatsApp has no hard character limit but messages > ~1500 chars
 * can be rendered poorly. Max chunk: 1000 chars.
 */
export function chunkMessage(text: string, maxChars = 1000): string[] {
  if (text.length <= maxChars) return [text];

  const chunks: string[] = [];
  // Split at double-newlines first (paragraph breaks)
  const paragraphs = text.split(/\n\n+/);
  let current = '';

  for (const para of paragraphs) {
    if ((current + '\n\n' + para).length <= maxChars) {
      current = current ? `${current}\n\n${para}` : para;
    } else {
      if (current) chunks.push(current.trim());
      if (para.length <= maxChars) {
        current = para;
      } else {
        // Split long paragraph at sentence boundaries
        const sentences = para.split(/(?<=[.!?])\s+/);
        current = '';
        for (const sentence of sentences) {
          if ((current + ' ' + sentence).length <= maxChars) {
            current = current ? `${current} ${sentence}` : sentence;
          } else {
            if (current) chunks.push(current.trim());
            current = sentence;
          }
        }
      }
    }
  }

  if (current) chunks.push(current.trim());
  return chunks.filter(Boolean);
}
