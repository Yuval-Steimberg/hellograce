import { describe, it, expect } from 'vitest';
import { createHmac } from 'crypto';
import { isValidImessageSignature } from './signature.js';

const SECRET = 'super-secret-webhook-key';

describe('isValidImessageSignature', () => {
  it('accepts a matching shared-secret Authorization header', () => {
    expect(
      isValidImessageSignature({ secret: SECRET, rawBody: '{}', authHeader: SECRET }),
    ).toBe(true);
  });

  it('accepts a Bearer-prefixed shared secret', () => {
    expect(
      isValidImessageSignature({ secret: SECRET, rawBody: '{}', authHeader: `Bearer ${SECRET}` }),
    ).toBe(true);
  });

  it('accepts a valid HMAC-SHA256 signature (hex and base64)', () => {
    const body = '{"alert_type":"message_inbound"}';
    const hex = createHmac('sha256', SECRET).update(body).digest('hex');
    const b64 = createHmac('sha256', SECRET).update(body).digest('base64');
    expect(isValidImessageSignature({ secret: SECRET, rawBody: body, signatureHeader: hex })).toBe(true);
    expect(isValidImessageSignature({ secret: SECRET, rawBody: body, signatureHeader: `sha256=${b64}` })).toBe(true);
  });

  it('rejects a wrong secret, wrong signature, or missing secret', () => {
    expect(isValidImessageSignature({ secret: SECRET, rawBody: '{}', authHeader: 'nope' })).toBe(false);
    expect(isValidImessageSignature({ secret: SECRET, rawBody: '{}', signatureHeader: 'deadbeef' })).toBe(false);
    expect(isValidImessageSignature({ secret: '', rawBody: '{}', authHeader: SECRET })).toBe(false);
    expect(isValidImessageSignature({ secret: SECRET, rawBody: '{}' })).toBe(false);
  });
});
