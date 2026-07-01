import type { InboundMessage, MessageMedia } from '@grace/shared';

/**
 * Raw inbound payload from Sendblue. Sendblue posts JSON to the configured
 * webhook for both inbound user messages and outbound delivery-status updates;
 * the discriminator is `is_outbound` (true = a status callback for a message WE
 * sent — ignore it). Field names differ from LoopMessage:
 *   {
 *     number: "+15551234567",        // the user's iMessage handle (LoopMessage: recipient)
 *     content: "had eggs",           // text                       (LoopMessage: text)
 *     media_url?: "https://...jpg",  // single attachment          (LoopMessage: attachments[])
 *     message_handle: "abc-123",     // id                         (LoopMessage: message_id)
 *     is_outbound?: false,
 *     status?: "RECEIVED",
 *     ...
 *   }
 */
export interface RawSendbluePayload {
  number?: string;
  content?: string;
  media_url?: string;
  message_handle?: string;
  is_outbound?: boolean;
  status?: string;
  [key: string]: unknown;
}

/** True when the payload is an inbound user message we should reply to. */
export function isSendblueInbound(payload: RawSendbluePayload): boolean {
  // Outbound delivery-status callbacks carry is_outbound:true — never reply.
  if (payload.is_outbound === true) return false;
  const hasContent = typeof payload.content === 'string' && payload.content.trim().length > 0;
  const hasMedia = typeof payload.media_url === 'string' && payload.media_url.length > 0;
  return !!(payload.number && (hasContent || hasMedia));
}

function classifyMediaKind(url: string): MessageMedia['kind'] {
  const u = url.toLowerCase();
  if (/\.(jpe?g|png|gif|webp|heic|heif|bmp)(?:\?|$)/.test(u)) return 'image';
  if (/\.(mp3|m4a|aac|ogg|opus|wav|caf|amr)(?:\?|$)/.test(u)) return 'audio';
  if (/\.(mp4|mov|m4v|3gp|webm)(?:\?|$)/.test(u)) return 'video';
  return 'other';
}

/**
 * Normalize a raw Sendblue payload into Grace's canonical InboundMessage,
 * identical in shape to normalizeImessage/normalizeTwilio's output (channel
 * 'imessage'). Downstream (processInboundMessage) is fully channel-agnostic.
 */
export function normalizeSendblue(raw: RawSendbluePayload): InboundMessage {
  const userId = (raw.number ?? '').replace(/^imessage:/i, '').trim();

  const media: MessageMedia[] = [];
  if (typeof raw.media_url === 'string' && raw.media_url.length > 0) {
    media.push({ url: raw.media_url, contentType: '', kind: classifyMediaKind(raw.media_url) });
  }

  const text = (raw.content ?? '').trim();
  // Any attached media makes this a MEDIA turn — never 'text'. iMessage/Sendblue
  // media URLs are usually signed CDN links with NO file extension, so
  // classifyMediaKind returns 'other'; that must still be treated as media (default
  // to 'image', since analyzeMedia re-resolves the true kind from the sniffed
  // bytes anyway). Collapsing it to 'text' let a no-caption selfie enter the
  // coalesce buffer and get silently dropped (prod: photo sent, zero response).
  const type: InboundMessage['type'] = media.length > 0
    ? media[0]!.kind === 'audio'
      ? 'audio'
      : 'image'
    : 'text';

  return {
    userId,
    channel: 'imessage',
    text,
    type,
    media,
    providerMessageId: raw.message_handle ?? `imsg_${Date.now()}`,
    receivedAt: new Date(),
  };
}
