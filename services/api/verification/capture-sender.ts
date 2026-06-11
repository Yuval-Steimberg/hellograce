// Drop-in TwilioSender replacement that records outbound messages instead of
// calling Twilio. Runs the SAME sanitizeOutbound pass production applies, so
// captured bodies are byte-identical to what WhatsApp users would receive.
import type { Logger } from 'pino';
import { sanitizeOutbound, type OutboundMessage } from '../src/twilio/sender.js';

export interface CapturedMessage {
  to: string;
  channel: 'whatsapp' | 'sms';
  body: string;
  at: number;
}

export class CaptureSender {
  sent: CapturedMessage[] = [];
  constructor(private logger?: Logger) {}

  async send(msg: OutboundMessage): Promise<{ sid: string }> {
    const body = msg.raw ? msg.body : sanitizeOutbound(msg.body, this.logger);
    this.sent.push({ to: msg.to, channel: msg.channel, body, at: Date.now() });
    return { sid: `capture-${this.sent.length}` };
  }

  reset(): void {
    this.sent = [];
  }

  /** Wait until a message newer than `since` arrives for `to` (or time out). */
  async waitForReply(to: string, since: number, timeoutMs = 25_000): Promise<CapturedMessage | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const hit = this.sent.find((m) => m.to === to && m.at >= since);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 50));
    }
    return null;
  }

  /** Index-based wait — immune to same-millisecond attribution races: only
   *  messages recorded at array index >= fromIndex count. */
  async waitForReplyAfterIndex(to: string, fromIndex: number, timeoutMs = 25_000): Promise<CapturedMessage | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const hit = this.sent.slice(fromIndex).find((m) => m.to === to);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 50));
    }
    return null;
  }
}
