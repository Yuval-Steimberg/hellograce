/**
 * Grace Twilio Proxy — Feature 3
 *
 * Sits upstream of POST /webhook/twilio. Responsibilities:
 *
 *   1. Edge Safety Filter   — regex-matches < 1ms. Genuine emergencies
 *      short-circuit here with hardcoded 988/911 TwiML + outbound Twilio
 *      message. API never touches crisis traffic.
 *
 *   2. Async Webhook Bridge — immediately returns 200 TwiML to Twilio
 *      (closes the 15-second window), then forwards the webhook body to the
 *      real Grace API in the background. Eliminates timeout risk entirely.
 *
 *   3. Message Chunking     — when the proxy itself sends outbound messages
 *      (emergency path), it uses the chunker to stay within WhatsApp limits.
 *
 * Deployment:
 *   - Point Twilio webhook URL at this proxy (port 3020)
 *   - Set UPSTREAM_URL=http://api:3001 to point at the real API
 *   - No Grace API source changes required
 */
import Fastify from 'fastify';
import formbody from '@fastify/formbody';
import rateLimit from '@fastify/rate-limit';
import twilio from 'twilio';
import pino from 'pino';
import { filterMessage, chunkMessage, EMERGENCY_MESSAGE } from './safety-filter.js';

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });

const cfg = {
  port: Number(process.env.PORT ?? 3020),
  upstreamUrl: (process.env.UPSTREAM_URL ?? 'http://localhost:3001').replace(/\/$/, ''),
  twilioSid: process.env.TWILIO_ACCOUNT_SID ?? '',
  twilioToken: process.env.TWILIO_AUTH_TOKEN ?? '',
  twilioFrom: process.env.TWILIO_WHATSAPP_FROM ?? process.env.TWILIO_FROM_NUMBER ?? '',
  rateLimitRpm: Number(process.env.RATE_LIMIT_RPM ?? 30),
  validateTwilioSig: process.env.VALIDATE_TWILIO_SIG !== 'false',
};

const twilioClient = twilio(cfg.twilioSid, cfg.twilioToken);

const app = Fastify({ logger: false });
await app.register(formbody);
await app.register(rateLimit, {
  max: cfg.rateLimitRpm,
  timeWindow: '1 minute',
  // Rate-limit per sender phone number (From field in Twilio form body).
  keyGenerator: (req) => {
    const body = req.body as Record<string, string> | undefined;
    return body?.From ?? req.ip;
  },
});

// ── Health ─────────────────────────────────────────────────────────────────

app.get('/health', async () => ({ ok: true, upstream: cfg.upstreamUrl }));

// ── Twilio webhook intercept ────────────────────────────────────────────────

app.post('/webhook/twilio', async (request, reply) => {
  const body = request.body as Record<string, string> | undefined ?? {};
  const messageBody: string = body.Body ?? '';
  const from: string = body.From ?? '';

  // 1. Edge safety filter — sub-millisecond
  const filterResult = filterMessage(messageBody);

  if (filterResult.blocked) {
    logger.info({ from, pattern: 'emergency' }, 'proxy.safety_filter.blocked');

    // Immediately close Twilio webhook with empty TwiML
    reply.header('Content-Type', 'text/xml');
    void reply.send(filterResult.twiml);

    // Send emergency message via Twilio outbound API asynchronously
    if (from && cfg.twilioFrom) {
      const chunks = chunkMessage(EMERGENCY_MESSAGE);
      for (const chunk of chunks) {
        await twilioClient.messages
          .create({ from: cfg.twilioFrom, to: from, body: chunk })
          .catch((err) => logger.error({ err, from }, 'proxy.emergency_send.failed'));
      }
    }
    return;
  }

  // 2. Respond to Twilio immediately (closes 15s webhook window)
  reply.header('Content-Type', 'text/xml');
  void reply.send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');

  // 3. Forward to real API asynchronously
  setImmediate(() => {
    void forwardToUpstream(body, request.headers as Record<string, string>);
  });
});

async function forwardToUpstream(
  body: Record<string, string>,
  headers: Record<string, string>,
): Promise<void> {
  const url = `${cfg.upstreamUrl}/webhook/twilio`;
  try {
    const params = new URLSearchParams(body);
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        // Forward Twilio signature so the API can still verify it
        ...(headers['x-twilio-signature'] ? { 'x-twilio-signature': headers['x-twilio-signature'] } : {}),
        'x-forwarded-for': headers['x-forwarded-for'] ?? '',
        'x-grace-proxy': '1',
      },
      body: params.toString(),
    });
    if (!resp.ok) {
      logger.warn({ status: resp.status, url }, 'proxy.forward.non2xx');
    }
  } catch (err) {
    logger.error({ err, url }, 'proxy.forward.failed');
  }
}

// ── Boot ───────────────────────────────────────────────────────────────────

app.listen({ port: cfg.port, host: '0.0.0.0' }, (err) => {
  if (err) { logger.error(err); process.exit(1); }
  logger.info({ port: cfg.port, upstream: cfg.upstreamUrl }, 'twilio-proxy.started');
});
