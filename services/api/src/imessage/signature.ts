import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Verify an inbound iMessage webhook.
 *
 * Relay providers authenticate webhooks one of two ways; we support both:
 *  1. Shared-secret header — the provider sends our configured secret back in
 *     an `Authorization` / `Loop-Secret-Key` header (LoopMessage default).
 *  2. HMAC signature — the provider signs the raw body with the secret and
 *     sends it in a signature header.
 *
 * Returns true when the request is authenticated. When no secret is configured
 * the caller decides whether to allow (non-prod) — this function only judges a
 * configured secret.
 */
export function isValidImessageSignature(opts: {
  secret: string;
  rawBody: string;
  /** Header(s) that may carry the shared secret or HMAC signature. */
  authHeader?: string | undefined;
  signatureHeader?: string | undefined;
}): boolean {
  const { secret, rawBody, authHeader, signatureHeader } = opts;
  if (!secret) return false;

  // 1. Shared-secret match (constant-time).
  if (authHeader) {
    const provided = authHeader.replace(/^Bearer\s+/i, '').trim();
    if (safeEqual(provided, secret)) return true;
  }

  // 2. HMAC-SHA256 of the raw body, hex or base64.
  if (signatureHeader) {
    const mac = createHmac('sha256', secret).update(rawBody, 'utf8').digest();
    const hex = mac.toString('hex');
    const b64 = mac.toString('base64');
    const provided = signatureHeader.replace(/^sha256=/i, '').trim();
    if (safeEqual(provided, hex) || safeEqual(provided, b64)) return true;
  }

  return false;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  try {
    return timingSafeEqual(ab, bb);
  } catch {
    return false;
  }
}
