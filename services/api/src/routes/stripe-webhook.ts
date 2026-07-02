import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type { Logger } from 'pino';
import type { Redis } from 'ioredis';
import { constructWebhookEvent, handleStripeWebhookEvent, recordStripeEvent } from '../services/stripe.service.js';
import { sendPaidWelcomeOnce } from '../services/paid-welcome.js';
import type { MessageSender } from '../twilio/sender.js';
import type { UserService } from '../user/user.service.js';

export interface StripeWebhookDeps {
  pool: Pool;
  logger: Logger;
  webhookSecret: string;
  proPriceId?: string;
  /** Optional — when present, a trial→paid transition sends the paid-welcome. */
  sender?: MessageSender;
  redis?: Redis;
  users?: UserService;
}

/**
 * v2 Stripe webhook. Registered ONLY when STRIPE_WEBHOOK_SECRET is set.
 *
 * Runs inside its own encapsulated Fastify scope with a raw-buffer JSON parser
 * so signature verification sees the exact bytes Stripe signed — the global
 * JSON parser used everywhere else would re-serialize and break the signature.
 * The parser override is scoped to this child instance only.
 *
 * Every delivery is recorded in stripe_events (idempotent on stripe_event_id),
 * so failures are visible in the admin dashboard and retryable. A signature
 * failure returns 400 (Stripe will retry). A processing failure still returns
 * 200 after recording the error — we don't want Stripe to hammer us for a bug
 * on our side; the admin retries it explicitly from the dashboard.
 */
export function registerStripeWebhookRoutes(app: FastifyInstance, deps: StripeWebhookDeps): void {
  void app.register(async (instance) => {
    instance.addContentTypeParser(
      'application/json',
      { parseAs: 'buffer' },
      (_req, body, done) => {
        // Hand the raw buffer through untouched.
        done(null, body);
      },
    );

    instance.post('/webhook/stripe', async (req, reply) => {
      const sigHeader = req.headers['stripe-signature'];
      const signature = Array.isArray(sigHeader) ? sigHeader[0] : sigHeader;
      const rawBody = req.body as Buffer;

      if (!signature) {
        reply.code(400);
        return { error: 'Missing stripe-signature header' };
      }

      let event;
      try {
        event = constructWebhookEvent(rawBody, signature, deps.webhookSecret);
      } catch (err) {
        deps.logger.warn({ err: (err as Error).message }, 'stripe.webhook.bad_signature');
        reply.code(400);
        return { error: 'Invalid signature' };
      }

      try {
        // Snapshot paid state BEFORE handling so we can detect a genuine
        // trial→paid transition (and greet them) rather than every renewal.
        const custObj = event.data.object as { customer?: string | { id: string } };
        const custId = typeof custObj.customer === 'string' ? custObj.customer : custObj.customer?.id ?? null;
        let wasPaid = false;
        if (custId) {
          const { rows } = await deps.pool.query<{ is_paid: boolean; is_pro: boolean }>(
            `SELECT is_paid, is_pro FROM users WHERE stripe_customer_id = $1 LIMIT 1`, [custId],
          ).catch(() => ({ rows: [] as Array<{ is_paid: boolean; is_pro: boolean }> }));
          wasPaid = !!(rows[0]?.is_paid || rows[0]?.is_pro);
        }

        const result = await handleStripeWebhookEvent(deps.pool, event, { proPriceId: deps.proPriceId });
        await recordStripeEvent(deps.pool, event, result);
        deps.logger.info(
          { type: event.type, status: result.status, target: result.target_user, reason: result.reason },
          'stripe.webhook.handled',
        );

        // On a not-paid → paid transition, send the once-only paid welcome.
        if (result.status === 'processed' && result.target_user && deps.sender && !wasPaid) {
          const u = await deps.users?.getByPhone(result.target_user).catch(() => null);
          if (u?.is_paid || u?.is_pro) {
            void sendPaidWelcomeOnce(
              { redis: deps.redis, sender: deps.sender, logger: deps.logger },
              { phone: result.target_user, first_name: u.first_name ?? null, medication: u.medication ?? null, channel: u.channel ?? null },
            );
          }
        }
        return { received: true, status: result.status };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        deps.logger.error({ err: msg, type: event.type, id: event.id }, 'stripe.webhook.process_failed');
        await recordStripeEvent(deps.pool, event, { status: 'failed', target_user: null, error: msg });
        // 200 so Stripe doesn't retry a bug on our side; admin retries manually.
        return { received: true, status: 'failed' };
      }
    });
  });
}
