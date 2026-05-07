import type { FastifyInstance } from 'fastify';
import type { Env } from '../config/env.js';
import type { AIService } from '../services/ai.service.js';
import type { TwilioSender } from '../twilio/sender.js';
import type { UserService } from '../user/user.service.js';
import { isValidTwilioSignature } from '../twilio/signature.js';
import { normalizeTwilio, type RawTwilioPayload } from '../twilio/normalize.js';
import { UnauthorizedError } from '../errors.js';

export interface WebhookDeps {
  env: Env;
  ai: AIService;
  sender: TwilioSender;
  users?: UserService;
}

export function registerWebhookRoutes(app: FastifyInstance, deps: WebhookDeps): void {
  app.post('/webhook/twilio', async (req, reply) => {
    const fullUrl = `${deps.env.PUBLIC_BASE_URL.replace(/\/$/, '')}/webhook/twilio`;
    const signature = req.headers['x-twilio-signature'];
    const sigHeader = Array.isArray(signature) ? signature[0] : signature;
    const params = req.body as Record<string, string>;

    if (deps.env.NODE_ENV === 'production') {
      const ok = isValidTwilioSignature({
        authToken: deps.env.TWILIO_AUTH_TOKEN,
        signatureHeader: sigHeader,
        url: fullUrl,
        params,
      });
      if (!ok) throw new UnauthorizedError('Invalid Twilio signature');
    }

    const normalized = normalizeTwilio(params as unknown as RawTwilioPayload);
    req.log.info(
      { userId: normalized.userId, channel: normalized.channel, type: normalized.type },
      'webhook.received',
    );

    // Reply with empty TwiML immediately; AI work + outbound send happens async.
    reply.header('content-type', 'text/xml');
    void reply.send('<?xml version="1.0" encoding="UTF-8"?><Response/>');

    // Fire-and-forget AI processing.
    void (async () => {
      try {
        // Upsert the user record and update last_reply_at on every inbound message.
        if (deps.users) {
          const user = await deps.users.ensureUser(normalized.userId).catch(() => null);

          // Handle injection "done" reply — advance the state machine.
          if (user && user.injection_flow_stage === 'morning_sent') {
            const trimmed = normalized.text.trim().toLowerCase();
            if (trimmed === 'done' || trimmed === 'done!' || trimmed === 'injected') {
              await deps.users.setInjectionStage(user.phone, 'done_confirmed', {
                injection_done_at: new Date(),
              }).catch(() => null);
            }
          }
        }

        const result = await deps.ai.handleMessage(normalized);
        if (result.text.length > 0) {
          await deps.sender.send({
            to: normalized.userId,
            channel: normalized.channel,
            body: result.text,
          });
        }
      } catch (err) {
        req.log.error({ err }, 'webhook.ai.failed');
      }
    })();
  });
}
