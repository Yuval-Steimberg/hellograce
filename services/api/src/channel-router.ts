import type { Logger } from 'pino';
import type { MessageSender, OutboundMessage } from './twilio/sender.js';

/**
 * Multi-channel outbound router (2026-06-17).
 *
 * Grace runs on WhatsApp/SMS (Twilio) AND iMessage (relay) at the same time.
 * Every caller (webhook replies, scheduler, admin, settings, onboarding) sends
 * through this one MessageSender; the router picks the transport from
 * msg.channel:
 *   - 'imessage'        → ImessageSender (when configured)
 *   - 'whatsapp'|'sms'  → TwilioSender
 *
 * Safety: if an 'imessage' message is requested but iMessage isn't configured,
 * it falls back to Twilio WhatsApp rather than dropping the message — a
 * misconfigured channel should never cause silence.
 */
export class ChannelRouter implements MessageSender {
  constructor(
    private deps: { twilio: MessageSender; imessage?: MessageSender | undefined },
    private logger: Logger,
  ) {}

  async send(msg: OutboundMessage): Promise<{ sid: string }> {
    if (msg.channel === 'imessage') {
      if (this.deps.imessage) {
        return this.deps.imessage.send(msg);
      }
      // iMessage requested but not configured — fall back to WhatsApp so the
      // user still gets the message. Log loudly so the misconfig is visible.
      this.logger.warn({ to: msg.to }, 'channel_router.imessage_unconfigured_fallback_whatsapp');
      return this.deps.twilio.send({ ...msg, channel: 'whatsapp' });
    }
    return this.deps.twilio.send(msg);
  }
}
