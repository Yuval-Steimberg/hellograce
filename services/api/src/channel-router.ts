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
 * iMessage-first + fallback: an 'imessage' message falls back to Twilio
 * WhatsApp when (a) iMessage isn't configured, OR (b) the iMessage send FAILS
 * (recipient not on iMessage / not a verified relay contact / relay error). A
 * misconfigured channel or an unreachable recipient should never cause silence.
 */
export class ChannelRouter implements MessageSender {
  constructor(
    private deps: { twilio: MessageSender; imessage?: MessageSender | undefined },
    private logger: Logger,
  ) {}

  async send(msg: OutboundMessage): Promise<{ sid: string }> {
    if (msg.channel === 'imessage') {
      if (this.deps.imessage) {
        try {
          return await this.deps.imessage.send(msg);
        } catch (err) {
          // Configured but the send failed — recipient may be on Android, not a
          // verified Sendblue contact, or the relay errored. Fall back to
          // WhatsApp so the message still lands. A rare duplicate (if the failure
          // was a post-send timeout) beats a dropped message.
          this.logger.warn(
            { to: msg.to, err: err instanceof Error ? err.message : String(err) },
            'channel_router.imessage_send_failed_fallback_whatsapp',
          );
          return this.deps.twilio.send({ ...msg, channel: 'whatsapp' });
        }
      }
      // iMessage requested but not configured — fall back to WhatsApp so the
      // user still gets the message. Log loudly so the misconfig is visible.
      this.logger.warn({ to: msg.to }, 'channel_router.imessage_unconfigured_fallback_whatsapp');
      return this.deps.twilio.send({ ...msg, channel: 'whatsapp' });
    }
    return this.deps.twilio.send(msg);
  }
}
