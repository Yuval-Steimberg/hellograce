import type { InboundMessage, MessageMedia } from '@grace/shared';

export interface RawTwilioPayload {
  From: string;
  To: string;
  Body?: string;
  NumMedia?: string;
  MessageSid: string;
  ProfileName?: string;
  [key: string]: string | undefined;
}

/**
 * Normalize a raw Twilio inbound payload into our canonical InboundMessage.
 * Handles WhatsApp prefix stripping, media collection, and channel detection.
 */
export function normalizeTwilio(raw: RawTwilioPayload): InboundMessage {
  const fromRaw = raw.From ?? '';
  const channel: 'whatsapp' | 'sms' = fromRaw.startsWith('whatsapp:') ? 'whatsapp' : 'sms';
  const userId = fromRaw.replace(/^whatsapp:/, '').trim();

  const numMedia = parseInt(raw.NumMedia ?? '0', 10) || 0;
  const media: MessageMedia[] = [];
  for (let i = 0; i < numMedia; i++) {
    const url = raw[`MediaUrl${i}`];
    const contentType = raw[`MediaContentType${i}`];
    if (url) {
      media.push({
        url,
        contentType: contentType ?? 'application/octet-stream',
        kind: classifyMediaKind(contentType ?? ''),
      });
    }
  }

  const text = (raw.Body ?? '').trim();
  const type: InboundMessage['type'] = media.length > 0
    ? media[0]!.kind === 'audio'
      ? 'audio'
      : media[0]!.kind === 'image'
        ? 'image'
        : 'text'
    : 'text';

  return {
    userId,
    channel,
    text,
    type,
    media,
    providerMessageId: raw.MessageSid,
    profileName: raw.ProfileName,
    receivedAt: new Date(),
  };
}

function classifyMediaKind(contentType: string): MessageMedia['kind'] {
  if (contentType.startsWith('image/')) return 'image';
  if (contentType.startsWith('audio/') || contentType === 'application/ogg') return 'audio';
  if (contentType.startsWith('video/')) return 'video';
  return 'other';
}
