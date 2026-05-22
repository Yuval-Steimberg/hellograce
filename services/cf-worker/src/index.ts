/**
 * Grace Edge Safety Filter — Cloudflare Worker
 *
 * Deployed on the Cloudflare network, this Worker intercepts POST /webhook/twilio
 * BEFORE traffic reaches the Fly.io origin. Runs in < 5ms globally.
 *
 * Actions:
 *   1. If message matches an emergency pattern:
 *      - Returns 200 TwiML immediately (closes Twilio webhook)
 *      - Fires a Twilio REST API call to send the 988/911 message
 *      - Origin server never receives the request (saves API budget)
 *
 *   2. If message is safe:
 *      - Adds x-grace-edge: 1 header
 *      - Proxies to origin unchanged
 *
 * Deploy:
 *   cd services/cf-worker && pnpm deploy
 *
 * Required secrets (set via `wrangler secret put <NAME>`):
 *   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_WHATSAPP_FROM
 */

interface Env {
  UPSTREAM_URL: string;
  TWILIO_ACCOUNT_SID: string;
  TWILIO_AUTH_TOKEN: string;
  TWILIO_WHATSAPP_FROM: string;
}

// ── Edge safety patterns ───────────────────────────────────────────────────
// Only the highest-confidence, zero-false-positive emergency phrases.
// The API's SafetyGuard handles the nuanced cases.

const EMERGENCY_PATTERNS: RegExp[] = [
  /\b(suicide|suicidal|kill\s+myself|end\s+my\s+life)\b/i,
  /\b(self.?harm|cut\s+myself)\b/i,
  /\b(can'?t\s*breath|chest\s+pain|heart\s+attack)\b/i,
  /\b(anaphyla|allergic\s+reaction.*throat)\b/i,
  /\b(overdos(e|ing)|took\s+too\s+many\s+pills)\b/i,
  /\b(call\s+911|call\s+an?\s+ambulance)\b/i,
];

const EMPTY_TWIML =
  '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

const EMERGENCY_BODY =
  'This sounds serious. Please reach out for immediate support:\n\n' +
  '🆘 Crisis line: 988 (call or text, 24/7)\n' +
  '🚨 Emergency: Call 911 or go to your nearest ER\n\n' +
  'You are not alone. Help is available right now.';

// ── Handler ────────────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Only intercept Twilio webhook path; pass everything else through
    if (request.method !== 'POST' || !url.pathname.endsWith('/webhook/twilio')) {
      return fetch(request);
    }

    // Parse Twilio form body
    const rawBody = await request.text();
    const params = new URLSearchParams(rawBody);
    const messageBody = params.get('Body') ?? '';
    const from = params.get('From') ?? '';

    // Edge safety check
    const isEmergency = EMERGENCY_PATTERNS.some((p) => p.test(messageBody));

    if (isEmergency) {
      // Fire-and-forget: send emergency message via Twilio REST
      if (from && env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN) {
        const ctx = (globalThis as unknown as { waitUntil?: (p: Promise<unknown>) => void });
        const sendPromise = sendTwilioMessage(
          env.TWILIO_ACCOUNT_SID,
          env.TWILIO_AUTH_TOKEN,
          env.TWILIO_WHATSAPP_FROM,
          from,
          EMERGENCY_BODY,
        );
        // waitUntil keeps the promise alive after the response is sent
        if (typeof ctx.waitUntil === 'function') {
          ctx.waitUntil(sendPromise);
        }
      }

      return new Response(EMPTY_TWIML, {
        status: 200,
        headers: { 'Content-Type': 'text/xml' },
      });
    }

    // Safe: proxy to origin with edge marker header
    const upstreamUrl = `${env.UPSTREAM_URL.replace(/\/$/, '')}${url.pathname}${url.search}`;
    const proxied = new Request(upstreamUrl, {
      method: 'POST',
      headers: {
        ...Object.fromEntries(request.headers.entries()),
        'x-grace-edge': '1',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: rawBody,
    });

    return fetch(proxied);
  },
} satisfies ExportedHandler<Env>;

// ── Twilio REST helper ─────────────────────────────────────────────────────

async function sendTwilioMessage(
  sid: string,
  token: string,
  from: string,
  to: string,
  body: string,
): Promise<void> {
  const endpoint = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`;
  const params = new URLSearchParams({ From: from, To: to, Body: body });
  const credentials = btoa(`${sid}:${token}`);

  await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  });
}
