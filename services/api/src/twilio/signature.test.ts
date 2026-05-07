import crypto from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { isValidTwilioSignature } from './signature.js';

function sign(authToken: string, url: string, params: Record<string, string>): string {
  const sortedKeys = Object.keys(params).sort();
  let data = url;
  for (const k of sortedKeys) data += k + params[k];
  return crypto.createHmac('sha1', authToken).update(Buffer.from(data, 'utf-8')).digest('base64');
}

describe('isValidTwilioSignature', () => {
  const authToken = 'test-token';
  const url = 'https://api.example.com/webhook/twilio';
  const params = { From: 'whatsapp:+15555550100', Body: 'hi', MessageSid: 'SM123' };

  it('accepts a valid signature', () => {
    const sig = sign(authToken, url, params);
    expect(isValidTwilioSignature({ authToken, signatureHeader: sig, url, params })).toBe(true);
  });

  it('rejects a bad signature', () => {
    expect(isValidTwilioSignature({ authToken, signatureHeader: 'wrong', url, params })).toBe(false);
  });

  it('rejects a missing signature', () => {
    expect(isValidTwilioSignature({ authToken, signatureHeader: undefined, url, params })).toBe(false);
  });

  it('rejects when params have been tampered with', () => {
    const sig = sign(authToken, url, params);
    expect(
      isValidTwilioSignature({
        authToken,
        signatureHeader: sig,
        url,
        params: { ...params, Body: 'tampered' },
      }),
    ).toBe(false);
  });
});
