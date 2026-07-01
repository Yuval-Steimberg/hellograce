import { describe, it, expect } from 'vitest';
import { normalizeSendblue, isSendblueInbound, type RawSendbluePayload } from './sendblue-normalize.js';

describe('isSendblueInbound', () => {
  it('accepts an inbound text message (number + content)', () => {
    expect(isSendblueInbound({ number: '+15551234567', content: 'had eggs' })).toBe(true);
  });

  it('accepts an inbound media-only message (number + media_url)', () => {
    expect(isSendblueInbound({ number: '+1', media_url: 'https://x/a.jpg' })).toBe(true);
  });

  it('rejects an outbound delivery-status callback (is_outbound:true)', () => {
    expect(isSendblueInbound({ number: '+1', content: 'sent', is_outbound: true, status: 'DELIVERED' })).toBe(false);
  });

  it('rejects a payload with no number', () => {
    expect(isSendblueInbound({ content: 'hi' } as RawSendbluePayload)).toBe(false);
  });

  it('rejects an empty/whitespace content with no media', () => {
    expect(isSendblueInbound({ number: '+1', content: '   ' })).toBe(false);
  });
});

describe('normalizeSendblue', () => {
  it('maps number→userId, content→text, message_handle→providerMessageId', () => {
    const msg = normalizeSendblue({ number: '+15551234567', content: 'had eggs', message_handle: 'h-9' });
    expect(msg.userId).toBe('+15551234567');
    expect(msg.text).toBe('had eggs');
    expect(msg.channel).toBe('imessage');
    expect(msg.type).toBe('text');
    expect(msg.providerMessageId).toBe('h-9');
    expect(msg.media).toEqual([]);
  });

  it('classifies an image attachment and sets type=image', () => {
    const msg = normalizeSendblue({ number: '+1', content: '', media_url: 'https://x/food.jpeg' });
    expect(msg.type).toBe('image');
    expect(msg.media[0]!.kind).toBe('image');
    expect(msg.media[0]!.url).toBe('https://x/food.jpeg');
  });

  it('classifies an audio attachment and sets type=audio', () => {
    const msg = normalizeSendblue({ number: '+1', media_url: 'https://x/note.m4a' });
    expect(msg.type).toBe('audio');
    expect(msg.media[0]!.kind).toBe('audio');
  });

  it('an EXTENSIONLESS media URL with no caption is still a media turn (type=image, never text)', () => {
    // Regression: a no-caption selfie over iMessage has a signed CDN URL with no
    // file extension → classifyMediaKind='other'. It must NOT become type:'text'
    // (that let it enter coalesce and get silently dropped — photo, zero response).
    const msg = normalizeSendblue({ number: '+1', content: '', media_url: 'https://media.sendblue.co/abc123XYZ' });
    expect(msg.type).toBe('image');
    expect(msg.media.length).toBe(1);
    expect(msg.text).toBe('');
  });

  it('strips a stray imessage: prefix from the number', () => {
    const msg = normalizeSendblue({ number: 'imessage:+15550001111', content: 'hi' });
    expect(msg.userId).toBe('+15550001111');
  });

  it('synthesizes a providerMessageId when message_handle is absent', () => {
    const msg = normalizeSendblue({ number: '+1', content: 'hi' });
    expect(msg.providerMessageId).toMatch(/^imsg_/);
  });
});
