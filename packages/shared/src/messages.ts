export type Channel = 'whatsapp' | 'sms' | 'imessage';

export interface MessageMedia {
  url: string;
  contentType: string;
  kind: 'image' | 'audio' | 'video' | 'other';
}

export interface InboundMessage {
  userId: string;
  channel: Channel;
  text: string;
  type: 'text' | 'image' | 'audio';
  media: MessageMedia[];
  providerMessageId: string;
  profileName?: string;
  receivedAt: Date;
}

export interface ChatTurn {
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: Date;
}
