import { describe, it, expect } from 'vitest';
import { isTwilioMediaUrl, sniffMimeFromBytes } from './analyze.js';

/**
 * Regression coverage for the iMessage-photo failure: over iMessage (Sendblue),
 * inbound media arrives on a non-Twilio CDN URL, often with NO file extension
 * and NO declared content-type. The old code (a) attached Twilio Basic auth to
 * every fetch and (b) trusted only the declared MIME, so the fetch/decode failed
 * and Grace replied "I'm unable to process images". These two helpers are the
 * fix: auth is gated to Twilio hosts, and the real MIME is recovered from the
 * magic bytes.
 */

describe('isTwilioMediaUrl — only Twilio hosts get the SID:token auth', () => {
  it('matches Twilio media hosts', () => {
    expect(isTwilioMediaUrl('https://api.twilio.com/2010-04-01/Accounts/AC/Messages/MM/Media/ME')).toBe(true);
    expect(isTwilioMediaUrl('https://media.us1.twiliocdn.com/AC/abcdef')).toBe(true);
    expect(isTwilioMediaUrl('https://mcs.us1.twilio.com/Media/xyz')).toBe(true);
  });
  it('does NOT match iMessage/Sendblue CDN URLs (auth would break the fetch)', () => {
    expect(isTwilioMediaUrl('https://storage.googleapis.com/inbound-mms-attachments/abc123')).toBe(false);
    expect(isTwilioMediaUrl('https://cdn.sendblue.co/media/abc.jpg')).toBe(false);
    expect(isTwilioMediaUrl('https://example.com/twilio.com.evil/photo')).toBe(false); // not the real host
    expect(isTwilioMediaUrl('not a url')).toBe(false);
  });
});

describe('sniffMimeFromBytes — recover the MIME when the webhook gave none', () => {
  // Build a 12+ byte buffer starting with the given signature.
  const withSig = (bytes: number[]): Buffer => Buffer.concat([Buffer.from(bytes), Buffer.alloc(16)]);
  const withAscii = (s: string, pad = 16): Buffer => Buffer.concat([Buffer.from(s, 'latin1'), Buffer.alloc(pad)]);

  it('detects common image types from magic bytes', () => {
    expect(sniffMimeFromBytes(withSig([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg'); // iPhone photo
    expect(sniffMimeFromBytes(withSig([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('image/png');
    expect(sniffMimeFromBytes(withSig([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))).toBe('image/gif');
    expect(sniffMimeFromBytes(withSig([0x42, 0x4d, 0x00, 0x00]))).toBe('image/bmp');
  });

  it('detects WEBP and HEIC (iPhone default) via container brand', () => {
    // RIFF....WEBP
    expect(sniffMimeFromBytes(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(8)]))).toBe('image/webp');
    // ....ftypheic
    expect(sniffMimeFromBytes(Buffer.concat([Buffer.alloc(4), Buffer.from('ftypheic'), Buffer.alloc(8)]))).toBe('image/heic');
  });

  it('detects audio types (voice notes)', () => {
    expect(sniffMimeFromBytes(withAscii('ID3\x03'))).toBe('audio/mpeg');
    expect(sniffMimeFromBytes(withSig([0xff, 0xfb, 0x90, 0x00]))).toBe('audio/mpeg'); // MP3 frame sync
    expect(sniffMimeFromBytes(withAscii('OggS'))).toBe('audio/ogg');
    expect(sniffMimeFromBytes(Buffer.concat([Buffer.alloc(4), Buffer.from('ftypM4A '), Buffer.alloc(8)]))).toBe('audio/mp4');
    // RIFF....WAVE
    expect(sniffMimeFromBytes(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), Buffer.alloc(8)]))).toBe('audio/wav');
  });

  it('returns empty for too-short or unrecognized data (caller falls back by kind)', () => {
    expect(sniffMimeFromBytes(Buffer.from([0xff, 0xd8]))).toBe(''); // too short (<12)
    expect(sniffMimeFromBytes(withAscii('hello world this is text'))).toBe('');
  });
});
