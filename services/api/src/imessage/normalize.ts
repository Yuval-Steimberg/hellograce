import type { InboundMessage, MessageMedia } from '@grace/shared';

/**
 * Raw inbound payload from the iMessage relay provider (LoopMessage shape).
 * LoopMessage posts JSON for several alert types; we act on `message_inbound`.
 *   {
 *     alert_type: "message_inbound",
 *     recipient: "+15551234567",      // the user's iMessage handle
 *     text: "had eggs for breakfast",
 *     message_id: "abc-123",
 *     message_type: "text",
 *     attachments?: ["https://...jpg"],
 *     ...
 *   }
 */
export interface RawImessagePayload {
  alert_type?: string;
  recipient?: string;
  text?: string;
  message_id?: string;
  message_type?: string;
  attachments?: string[];
  sandbox?: boolean;
  [key: string]: unknown;
}

/** Alert types that carry an actual user message we should reply to. */
export function isInboundMessageAlert(payload: RawImessagePayload): boolean {
  // Default to treating a payload with text + recipient as inbound, but only
  // explicitly act on the inbound alert type when one is present.
  const t = (payload.alert_type ?? '').toLowerCase();
  if (t) return t === 'message_inbound';
  return !!(payload.recipient && (payload.text || (payload.attachments?.length ?? 0) > 0));
}

function classifyMediaKind(url: string): MessageMedia['kind'] {
  const u = url.toLowerCase();
  if (/\.(jpe?g|png|gif|webp|heic|heif|bmp)(?:\?|$)/.test(u)) return 'image';
  if (/\.(mp3|m4a|aac|ogg|opus|wav|caf|amr)(?:\?|$)/.test(u)) return 'audio';
  if (/\.(mp4|mov|m4v|3gp|webm)(?:\?|$)/.test(u)) return 'video';
  return 'other';
}

/**
 * Normalize a raw iMessage relay payload into Grace's canonical InboundMessage,
 * identical in shape to normalizeTwilio's output but with channel 'imessage'.
 * Downstream (processInboundMessage) is fully channel-agnostic.
 */
export function normalizeImessage(raw: RawImessagePayload): InboundMessage {
  const userId = (raw.recipient ?? '').replace(/^imessage:/i, '').trim();

  const media: MessageMedia[] = [];
  for (const url of raw.attachments ?? []) {
    if (typeof url === 'string' && url.length > 0) {
      media.push({ url, contentType: '', kind: classifyMediaKind(url) });
    }
  }

  const text = (raw.text ?? '').trim();
  // Any attached media makes this a MEDIA turn — never 'text'. LoopMessage/Apple
  // attachment URLs are often signed CDN links with NO file extension, so
  // classifyMediaKind returns 'other'; that must still be treated as media (default
  // to 'image', since analyzeMedia re-resolves the true kind from the sniffed bytes
  // anyway). Collapsing it to 'text' let a no-caption selfie enter the coalesce
  // buffer and get silently dropped (prod: photo sent, zero response).
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
    providerMessageId: raw.message_id ?? `imsg_${Date.now()}`,
    receivedAt: new Date(),
  };
}
