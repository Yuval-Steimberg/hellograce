import type { Logger } from 'pino';
import { UpstreamError } from '../errors.js';
import {
  EmptyOutboundError,
  rewriteCanonicalLinks,
  ensureLinkScheme,
  sanitizeOutbound,
  type MessageSender,
  type OutboundMessage,
} from '../twilio/sender.js';

/**
 * iMessage outbound via a relay provider (LoopMessage by default).
 *
 * Apple has no official iMessage send API, so a relay provider hosts a
 * dedicated iMessage sender and exposes a REST endpoint. This implements
 * LoopMessage's send contract:
 *   POST {apiUrl}
 *   headers: Authorization: <authKey>, Loop-Secret-Key: <secretKey>
 *   body:    { recipient, text, sender_name }
 *   → { message_id, success }
 *
 * It deliberately mirrors TwilioSender: the SAME sanitizeOutbound +
 * rewriteCanonicalLinks run on every body, so a message looks identical
 * regardless of which channel delivers it. Drop-in via the MessageSender
 * interface (ChannelRouter dispatches by channel).
 */
export interface ImessageSenderConfig {
  /** Provider send endpoint. Default = LoopMessage. */
  apiUrl?: string;
  /** Authorization header value (provider API/auth key). */
  authKey: string;
  /** Loop-Secret-Key header value (provider secret). */
  secretKey: string;
  /** The dedicated iMessage sender name/handle provisioned by the provider. */
  senderName: string;
  /** PUBLIC_WEB_URL — rewrites graceglp.com links to the live host. */
  canonicalWebUrl?: string;
  /** Request timeout (ms). Default 12s. */
  timeoutMs?: number;
}

const DEFAULT_LOOP_SEND_URL = 'https://server.loopmessage.com/api/v1/message/send/';

export class ImessageSender implements MessageSender {
  constructor(private cfg: ImessageSenderConfig, private logger: Logger) {}

  async send(msg: OutboundMessage): Promise<{ sid: string }> {
    let body: string;
    if (msg.raw) {
      body = msg.body;
    } else {
      try {
        body = sanitizeOutbound(msg.body, this.logger);
      } catch (err) {
        if (err instanceof EmptyOutboundError) {
          this.logger.warn({ original: msg.body }, 'imessage.send.empty_after_sanitize');
          body = sanitizeOutbound("I'm here. Tell me what's going on.", this.logger);
        } else {
          throw err;
        }
      }
    }

    // Same canonical-link rewrite + scheme-ensuring as Twilio so settings/
    // upgrade links resolve AND render as tappable links (not bare text).
    body = rewriteCanonicalLinks(body, this.cfg.canonicalWebUrl);
    body = ensureLinkScheme(body, this.cfg.canonicalWebUrl);

    const url = this.cfg.apiUrl ?? DEFAULT_LOOP_SEND_URL;
    // iMessage recipients are phone numbers (E.164) or Apple-ID emails. Strip a
    // stray "imessage:"/"whatsapp:" prefix if one leaked from an inbound id.
    const recipient = msg.to.replace(/^(?:imessage|whatsapp|sms):/i, '').trim();

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.cfg.timeoutMs ?? 12_000);
    try {
      const resp = await fetch(url, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization: this.cfg.authKey,
          'Loop-Secret-Key': this.cfg.secretKey,
        },
        body: JSON.stringify({ recipient, text: body, sender_name: this.cfg.senderName }),
      });
      if (!resp.ok) {
        const errText = await resp.text().catch(() => '');
        this.logger.error({ status: resp.status, body: errText.slice(0, 300) }, 'imessage.send.failed');
        throw new UpstreamError(`iMessage send failed (${resp.status})`);
      }
      const data = (await resp.json().catch(() => ({}))) as { message_id?: string; success?: boolean };
      const sid = data.message_id ?? `imsg_${Date.now()}`;
      this.logger.info({ sid, channel: 'imessage' }, 'imessage.send.ok');
      return { sid };
    } catch (err) {
      if (err instanceof UpstreamError) throw err;
      this.logger.error({ err }, 'imessage.send.failed');
      throw new UpstreamError('Failed to send iMessage', err);
    } finally {
      clearTimeout(timeout);
    }
  }
}
