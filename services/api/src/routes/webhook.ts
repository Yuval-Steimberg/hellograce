import type { FastifyInstance } from 'fastify';
import type { Env } from '../config/env.js';
import type { AIService } from '../services/ai.service.js';
import type { TwilioSender } from '../twilio/sender.js';
import type { UserService, GraceUser } from '../user/user.service.js';
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
        let user: GraceUser | null = null;
        // Upsert the user record and update last_reply_at on every inbound message.
        if (deps.users) {
          user = await deps.users.ensureUser(normalized.userId).catch(() => null);

          // Handle injection "done" reply — advance the state machine.
          if (user && user.injection_flow_stage === 'morning_sent') {
            const trimmed = normalized.text.trim().toLowerCase();
            if (trimmed === 'done' || trimmed === 'done!' || trimmed === 'injected') {
              await deps.users.setInjectionStage(user.phone, 'done_confirmed', {
                injection_done_at: new Date(),
              }).catch(() => null);
            }
          }

          // RLHF feedback signal — intercept before AI for opted-in users.
          if (user?.rlhf_enabled) {
            const fbResult = parseFeedbackSignal(normalized.text);
            if (fbResult) {
              await deps.users.recordUserFeedback(user.phone, fbResult.rating, fbResult.comment).catch(() => null);
              const ack = fbResult.rating > 0
                ? 'Thanks for the thumbs up — I\'ll keep that in mind! 💪'
                : fbResult.comment
                  ? 'Thanks for the feedback — I\'ll work on that!'
                  : 'Thanks for letting me know. Feel free to tell me more about what could be better.';
              await deps.sender.send({ to: normalized.userId, channel: normalized.channel, body: ack });
              return;
            }
          }

          // Subscription gate — users with an expired trial and no active subscription
          // get a soft paywall nudge instead of the AI response.
          if (user && !isAccessAllowed(user)) {
            const name = user.first_name ?? 'there';
            await deps.sender.send({
              to: normalized.userId,
              channel: normalized.channel,
              body: `Hi ${name} — your Grace trial has ended 🧡 To keep your daily check-ins going, subscribe at grace.com. Questions? Reply HELP.`,
            });
            return;
          }
        }

        const result = await deps.ai.handleMessage(normalized);
        if (result.text.length > 0) {
          const isRlhfUser = user?.rlhf_enabled ?? false;
          const body = isRlhfUser
            ? `${result.text}\n\n_Rate this response: reply 👍 or 👎, or reply FEEDBACK: your comment_`
            : result.text;
          await deps.sender.send({
            to: normalized.userId,
            channel: normalized.channel,
            body,
          });
        }
      } catch (err) {
        req.log.error({ err }, 'webhook.ai.failed');
      }
    })();
  });
}

const TRIAL_DAYS = 3;

function isAccessAllowed(user: { is_paid: boolean; is_pro: boolean; trial_start: Date | null }): boolean {
  if (user.is_paid || user.is_pro) return true;
  if (!user.trial_start) return true; // no trial_start = not yet onboarded via v2, allow
  const msElapsed = Date.now() - new Date(user.trial_start).getTime();
  return msElapsed < TRIAL_DAYS * 24 * 3_600_000;
}

/** Returns { rating, comment? } when the message is a recognised feedback signal, null otherwise. */
function parseFeedbackSignal(text: string): { rating: number; comment?: string } | null {
  const t = text.trim();
  if (t === '👍' || /^(thumbs[\s-]?up|good|helpful|great|yes|positive)$/i.test(t)) {
    return { rating: 1 };
  }
  if (t === '👎' || /^(thumbs[\s-]?down|bad|not helpful|no|negative)$/i.test(t)) {
    return { rating: -1 };
  }
  const commentMatch = t.match(/^feedback:\s*(.+)/is);
  if (commentMatch?.[1]) {
    return { rating: -1, comment: commentMatch[1].trim() };
  }
  return null;
}
