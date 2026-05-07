import { describe, it, expect } from 'vitest';
import { normalizeTwilio } from './normalize.js';

describe('normalizeTwilio', () => {
  it('normalizes a WhatsApp text message', () => {
    const msg = normalizeTwilio({
      From: 'whatsapp:+15555550100',
      To: 'whatsapp:+14155238886',
      Body: '  hi grace  ',
      MessageSid: 'SM123',
      NumMedia: '0',
    });
    expect(msg.channel).toBe('whatsapp');
    expect(msg.userId).toBe('+15555550100');
    expect(msg.text).toBe('hi grace');
    expect(msg.type).toBe('text');
    expect(msg.media).toEqual([]);
  });

  it('normalizes an SMS', () => {
    const msg = normalizeTwilio({
      From: '+15555550101',
      To: '+18005551234',
      Body: 'hello',
      MessageSid: 'SM456',
    });
    expect(msg.channel).toBe('sms');
    expect(msg.userId).toBe('+15555550101');
  });

  it('captures image media', () => {
    const msg = normalizeTwilio({
      From: 'whatsapp:+15555550100',
      To: 'whatsapp:+14155238886',
      Body: '',
      MessageSid: 'SM789',
      NumMedia: '1',
      MediaUrl0: 'https://api.twilio.com/media/abc',
      MediaContentType0: 'image/jpeg',
    });
    expect(msg.type).toBe('image');
    expect(msg.media).toHaveLength(1);
    expect(msg.media[0]?.kind).toBe('image');
  });

  it('captures audio media (voice note)', () => {
    const msg = normalizeTwilio({
      From: 'whatsapp:+15555550100',
      To: 'whatsapp:+14155238886',
      Body: '',
      MessageSid: 'SM999',
      NumMedia: '1',
      MediaUrl0: 'https://api.twilio.com/media/voice',
      MediaContentType0: 'audio/ogg',
    });
    expect(msg.type).toBe('audio');
    expect(msg.media[0]?.kind).toBe('audio');
  });
});
