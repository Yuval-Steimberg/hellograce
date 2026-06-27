import type { Logger } from 'pino';
import { UpstreamError } from '../errors.js';
import {
  EmptyOutboundError,
  rewriteCanonicalLinks,
  sanitizeOutbound,
  type MessageSender,
  type OutboundMessage,
} from '../twilio/sender.js';

/**
 * iMessage outbound via Sendblue (the alternative relay to LoopMessage).
 *
 * Sendblue's send contract differs from LoopMessage's, so it needs its own
 * sender rather than just a different IMESSAGE_API_URL:
 *   POST {apiUrl}                         (default https://api.sendblue.co/api/send-message)
 *   headers: sb-api-key-id: <apiKeyId>
 *            sb-api-secret-key: <apiSecret>
 *   body:    { number, content }
 *   → { message_handle, status }
 *
 * Sends from the line/number provisioned on the Sendblue account — there is no
 * "sender name" concept like LoopMessage, so that field is intentionally absent.
 * It mirrors ImessageSender otherwise: the SAME sanitizeOutbound +
 * rewriteCanonicalLinks run on every body, so a reply reads identically no
 * matter which channel/provider delivers it. Drop-in via the MessageSender
 * interface (ChannelRouter dispatches by channel).
 */
export interface SendblueSenderConfig {
  /** Provider send endpoint. Default = Sendblue. */
  apiUrl?: string;
  /** sb-api-key-id header value. */
  apiKeyId: string;
  /** sb-api-secret-key header value. */
  apiSecret: string;
  /** PUBLIC_WEB_URL — rewrites graceglp.com links to the live host. */
  canonicalWebUrl?: string;
  /** Request timeout (ms). Default 12s. */
  timeoutMs?: number;
}

const DEFAULT_SENDBLUE_SEND_URL = 'https://api.sendblue.co/api/send-message';

export class SendblueSender implements MessageSender {
  constructor(private cfg: SendblueSenderConfig, private logger: Logger) {}

  async send(msg: OutboundMessage): Promise<{ sid: string }> {
    let body: string;
    if (msg.raw) {
      body = msg.body;
    } else {
      try {
        body = sanitizeOutbound(msg.body, this.logger);
      } catch (err) {
        if (err instanceof EmptyOutboundError) {
          this.logger.warn({ original: msg.body }, 'sendblue.send.empty_after_sanitize');
          body = sanitizeOutbound("I'm here. Tell me what's going on.", this.logger);
        } else {
          throw err;
        }
      }
    }

    // Same canonical-link rewrite as Twilio/LoopMessage so links resolve.
    body = rewriteCanonicalLinks(body, this.cfg.canonicalWebUrl);

    const url = this.cfg.apiUrl ?? DEFAULT_SENDBLUE_SEND_URL;
    // iMessage recipients are phone numbers (E.164) or Apple-ID emails. Strip a
    // stray "imessage:"/"whatsapp:" prefix if one leaked from an inbound id.
    const number = msg.to.replace(/^(?:imessage|whatsapp|sms):/i, '').trim();

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.cfg.timeoutMs ?? 12_000);
    try {
      const resp = await fetch(url, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          'sb-api-key-id': this.cfg.apiKeyId,
          'sb-api-secret-key': this.cfg.apiSecret,
        },
        body: JSON.stringify({ number, content: body }),
      });
      if (!resp.ok) {
        const errText = await resp.text().catch(() => '');
        this.logger.error({ status: resp.status, body: errText.slice(0, 300) }, 'sendblue.send.failed');
        throw new UpstreamError(`iMessage send failed (${resp.status})`);
      }
      const data = (await resp.json().catch(() => ({}))) as { message_handle?: string; status?: string };
      const sid = data.message_handle ?? `imsg_${Date.now()}`;
      this.logger.info({ sid, channel: 'imessage', provider: 'sendblue' }, 'sendblue.send.ok');
      return { sid };
    } catch (err) {
      if (err instanceof UpstreamError) throw err;
      this.logger.error({ err }, 'sendblue.send.failed');
      throw new UpstreamError('Failed to send iMessage', err);
    } finally {
      clearTimeout(timeout);
    }
  }
}
