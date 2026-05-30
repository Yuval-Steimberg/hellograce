import twilio from 'twilio';
import type { Logger } from 'pino';
import { UpstreamError } from '../errors.js';

export interface TwilioSenderConfig {
  accountSid: string;
  authToken: string;
  fromSms?: string;
  fromWhatsapp?: string;
}

export interface OutboundMessage {
  to: string;
  channel: 'whatsapp' | 'sms';
  body: string;
  /** Skip the AI-text sanitizer. Use for hardcoded admin/report messages. */
  raw?: boolean;
}

/**
 * Last-line-of-defense sanitizer applied to EVERY outbound message,
 * regardless of source (AI orchestrator, scheduler, hardcoded webhook
 * replies, safety guard, etc).
 *
 * Catches recurring failure modes that users complain about:
 *  1. Em-dashes / en-dashes / double-dashes — AI-tell punctuation that
 *     slips through when a message bypasses the orchestrator's enforceFormat.
 *  2. Mid-sentence truncation — message ends in a hyphen, single letter,
 *     or stranded preposition/article with no terminal punctuation.
 *  3. Unfilled template placeholders ({first_name}, [link], <url>) that
 *     escape the LLM or template substitution and would be shipped raw.
 *  4. Hallucinated role markers ("System:", "Assistant:", "User:") that
 *     occasionally leak when the LLM mimics its own prompt structure.
 *  5. Empty / whitespace-only bodies — never ship a blank message.
 */
export class EmptyOutboundError extends Error {
  constructor() { super('Outbound body is empty after sanitization'); }
}

export function sanitizeOutbound(input: string): string {
  let text = input;

  // ─── Markdown strip (Bug 4 remediation, 2026-05-30) ────────────────────
  // Last-line defense: format-enforcer already strips these earlier in the
  // pipeline, but messages can reach the sender via paths that skip the
  // orchestrator (scheduler welcome, hardcoded webhook replies, scope-guard
  // canned responses). SMS/WhatsApp render markdown literally, so any of
  // these characters reaching the user would appear as garbage punctuation.
  //
  // Done BEFORE em-dash collapse so a "**bold**" with em-dash inside is
  // unwrapped first then its content gets the dash treatment.
  text = text.replace(/\*\*([^*\n]+)\*\*/g, '$1');           // **bold** → bold
  text = text.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '$1');  // *italic* → italic
  text = text.replace(/(?<![\w_])_([^_\n]+)_(?![\w_])/g, '$1'); // _italic_ → italic
  text = text.replace(/^#{1,6}\s+/gm, '');                    // # header → header
  text = text.replace(/^\s*[-*•]\s+/gm, '');                  // - bullet → bullet
  text = text.replace(/^\s*\d+\.\s+/gm, '');                  // 1. item → item
  // Backticks for inline code — strip wrapping, keep content.
  text = text.replace(/`([^`\n]+)`/g, '$1');

  // Replace em-dash, en-dash, and 2+ hyphens with comma (preserves words).
  text = text.replace(/\s*[—–]\s*/g, ', ');
  text = text.replace(/\s*--+\s*/g, ', ');
  // " - " used as a dash on one line → comma.
  text = text.replace(/(\S)[ \t]+-[ \t]+(\S)/g, '$1, $2');

  // Strip hallucinated role markers (LLM occasionally echoes its own prompt
  // structure: "Assistant: blah" / "System: blah" / "User: blah"). Only at
  // line start — words like "User:" mid-sentence are legitimate prose.
  text = text.replace(/^(System|Assistant|User|Human|Model)\s*:\s*/gim, '');

  // Strip unfilled template placeholders. Two patterns:
  //   {snake_case_var}  — common from string substitution failures
  //   [bracketed]       — common from LLM "[link]" / "[settings link]"
  //   <angle_var>       — common from prompt template leakage
  // For [bracketed]: only strip ones that look like placeholders (lowercase,
  // 2-30 chars, no spaces) — keep legitimate uses like "[laughs]" / "[2/5]".
  text = text.replace(/\{[a-z_][a-z0-9_]{0,30}\}/g, '');
  text = text.replace(/<[a-z_][a-z0-9_]{0,30}>/g, '');
  text = text.replace(/\[(link|settings link|url|here|first_name|name|phone)\]/gi, '');

  // Collapse double spaces left behind by placeholder strips.
  text = text.replace(/[ \t]{2,}/g, ' ').replace(/\s+([.,!?])/g, '$1');

  // Mid-sentence truncation repair.
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    // After sanitization the body is empty. Signal so the caller can pick a
    // safe fallback instead of shipping whitespace to the user.
    throw new EmptyOutboundError();
  }

  const endsMidWord =
    /[-–—]$/.test(trimmed) ||
    /\s(the|a|an|of|on|in|to|for|with|and|or|but|so|by|at|as|is|are|was|were|be)$/i.test(trimmed) ||
    !/[.!?…)_]$|[\p{Extended_Pictographic}]$/u.test(trimmed);

  if (endsMidWord) {
    // Find the last complete sentence terminator and trim everything after it.
    const lastTerminator = Math.max(
      trimmed.lastIndexOf('.'),
      trimmed.lastIndexOf('!'),
      trimmed.lastIndexOf('?'),
      trimmed.lastIndexOf('…'),
    );
    if (lastTerminator > 0) {
      text = trimmed.slice(0, lastTerminator + 1);
    } else {
      // No complete sentence at all — append a period rather than ship a stub.
      text = trimmed.replace(/[-–—\s]+$/, '') + '.';
    }
  }

  return text;
}

export class TwilioSender {
  private client: twilio.Twilio;
  constructor(private cfg: TwilioSenderConfig, private logger: Logger) {
    this.client = twilio(cfg.accountSid, cfg.authToken);
  }

  async send(msg: OutboundMessage): Promise<{ sid: string }> {
    const useWhatsapp = msg.channel === 'whatsapp' && !!this.cfg.fromWhatsapp;
    const from = useWhatsapp ? `whatsapp:${this.cfg.fromWhatsapp!.replace(/^whatsapp:/, '')}` : this.cfg.fromSms;
    if (!from) throw new UpstreamError('No Twilio sender configured for channel');
    const to = useWhatsapp && !msg.to.startsWith('whatsapp:') ? `whatsapp:${msg.to}` : msg.to;

    let body: string;
    if (msg.raw) {
      body = msg.body;
    } else {
      try {
        body = sanitizeOutbound(msg.body);
      } catch (err) {
        if (err instanceof EmptyOutboundError) {
          // Sanitizer produced an empty body — log and substitute a neutral
          // fallback so the user is not left with silence.
          this.logger.warn({ original: msg.body }, 'twilio.send.empty_after_sanitize');
          body = "I'm here — what's on your mind?";
        } else {
          throw err;
        }
      }
    }

    try {
      const result = await this.client.messages.create({ from, to, body });
      this.logger.info({ sid: result.sid, channel: useWhatsapp ? 'whatsapp' : 'sms' }, 'twilio.send.ok');
      return { sid: result.sid };
    } catch (err) {
      this.logger.error({ err }, 'twilio.send.failed');
      throw new UpstreamError('Failed to send Twilio message', err);
    }
  }
}
