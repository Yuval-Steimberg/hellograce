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
 * Catches two recurring failure modes that users complain about:
 *  1. Em-dashes / en-dashes / double-dashes — AI-tell punctuation that
 *     slips through when a message bypasses the orchestrator's enforceFormat.
 *  2. Mid-sentence truncation — message ends in a hyphen, single letter,
 *     or stranded preposition/article with no terminal punctuation.
 */
export function sanitizeOutbound(input: string): string {
  let text = input;

  // Replace em-dash, en-dash, and 2+ hyphens with comma (preserves words).
  text = text.replace(/\s*[—–]\s*/g, ', ');
  text = text.replace(/\s*--+\s*/g, ', ');
  // " - " used as a dash on one line → comma.
  text = text.replace(/(\S)[ \t]+-[ \t]+(\S)/g, '$1, $2');

  // Mid-sentence truncation repair.
  const trimmed = text.trim();
  if (trimmed.length === 0) return text;

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

    const body = msg.raw ? msg.body : sanitizeOutbound(msg.body);

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
