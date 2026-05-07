import crypto from 'node:crypto';

/**
 * Validate a Twilio request signature per:
 * https://www.twilio.com/docs/usage/webhooks/webhooks-security
 *
 * The signature is HMAC-SHA1 over (full URL + sorted form param keys+values),
 * base64-encoded, keyed with the Twilio auth token.
 */
export function isValidTwilioSignature(opts: {
  authToken: string;
  signatureHeader: string | undefined;
  url: string;
  params: Record<string, string>;
}): boolean {
  if (!opts.signatureHeader) return false;

  const sortedKeys = Object.keys(opts.params).sort();
  let data = opts.url;
  for (const key of sortedKeys) {
    data += key + opts.params[key];
  }

  const expected = crypto
    .createHmac('sha1', opts.authToken)
    .update(Buffer.from(data, 'utf-8'))
    .digest('base64');

  // Constant-time compare
  const a = Buffer.from(expected);
  const b = Buffer.from(opts.signatureHeader);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
