import { describe, it, expect } from 'vitest';
import { normalizeImessage, isInboundMessageAlert } from './normalize.js';

describe('normalizeImessage', () => {
  it('maps a LoopMessage inbound text payload to the canonical shape', () => {
    const out = normalizeImessage({
      alert_type: 'message_inbound',
      recipient: '+15551234567',
      text: '  had eggs for breakfast  ',
      message_id: 'abc-123',
      message_type: 'text',
    });
    expect(out.channel).toBe('imessage');
    expect(out.userId).toBe('+15551234567');
    expect(out.text).toBe('had eggs for breakfast');
    expect(out.type).toBe('text');
    expect(out.providerMessageId).toBe('abc-123');
    expect(out.media).toHaveLength(0);
  });

  it('strips a stray imessage: prefix from the recipient', () => {
    const out = normalizeImessage({ recipient: 'imessage:+15550001111', text: 'hi' });
    expect(out.userId).toBe('+15550001111');
  });

  it('classifies an image attachment and sets type=image', () => {
    const out = normalizeImessage({
      recipient: '+15551234567',
      text: '',
      attachments: ['https://cdn.example.com/food.jpg'],
    });
    expect(out.type).toBe('image');
    expect(out.media[0]!.kind).toBe('image');
    expect(out.media[0]!.url).toContain('food.jpg');
  });

  it('classifies an audio attachment and sets type=audio', () => {
    const out = normalizeImessage({
      recipient: '+15551234567',
      attachments: ['https://cdn.example.com/voice.m4a'],
    });
    expect(out.type).toBe('audio');
    expect(out.media[0]!.kind).toBe('audio');
  });

  it('an EXTENSIONLESS attachment with no caption is still a media turn (type=image, never text)', () => {
    // Regression: a no-caption selfie has a signed CDN URL with no file extension
    // → kind='other'. It must NOT collapse to type:'text' (that let it enter
    // coalesce and get silently dropped — photo sent, zero response in prod).
    const out = normalizeImessage({
      recipient: '+15551234567',
      text: '',
      attachments: ['https://cdn.example.com/attachments/abc123XYZ'],
    });
    expect(out.type).toBe('image');
    expect(out.media.length).toBe(1);
  });

  it('synthesizes a providerMessageId when none is given', () => {
    const out = normalizeImessage({ recipient: '+1', text: 'x' });
    expect(out.providerMessageId).toMatch(/^imsg_/);
  });
});

describe('isInboundMessageAlert', () => {
  it('is true for an explicit message_inbound alert', () => {
    expect(isInboundMessageAlert({ alert_type: 'message_inbound', recipient: '+1', text: 'hi' })).toBe(true);
  });

  it('is false for a non-inbound alert type (delivery receipts, etc.)', () => {
    expect(isInboundMessageAlert({ alert_type: 'message_sent', recipient: '+1', text: 'hi' })).toBe(false);
    expect(isInboundMessageAlert({ alert_type: 'conversation_inited', recipient: '+1' })).toBe(false);
  });

  it('falls back to text/attachment presence when alert_type is absent', () => {
    expect(isInboundMessageAlert({ recipient: '+1', text: 'hi' })).toBe(true);
    expect(isInboundMessageAlert({ recipient: '+1' })).toBe(false);
    expect(isInboundMessageAlert({ text: 'hi' })).toBe(false);
  });
});
