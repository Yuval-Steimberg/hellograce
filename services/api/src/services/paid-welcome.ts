import type { Redis } from 'ioredis';
import type { MessageSender } from '../twilio/sender.js';
import { isEncryptedBlob } from '../crypto/field-encrypt.js';

/** Minimal structural logger so both pino and Fastify's req.log satisfy it. */
type MiniLogger = { info: (obj: unknown, msg?: string) => void; warn: (obj: unknown, msg?: string) => void };

/**
 * Post-payment "welcome back" message (2026-07-02).
 *
 * When a user upgrades from trial → paid (or pro), Grace should NOT re-introduce
 * herself ("Hi, I'm Grace") — they already know her. Instead she warmly
 * celebrates that they've decided to keep going with her, greets them by name,
 * and reminds them of everything they can do. Sent once per user (Redis-deduped)
 * on the not-paid → paid transition, from the Stripe webhook and the admin
 * paid-toggle.
 */

const cleanName = (v: string | null | undefined): string | null =>
  v && !isEncryptedBlob(v) && v.trim().length > 0 ? v.trim() : null;

/** The message. No self-introduction, excited they're continuing, by name,
 *  reminds every option. `medication` is woven in only when known + plaintext. */
export function buildPaidWelcome(user: { first_name?: string | null; medication?: string | null }): string {
  const name = cleanName(user.first_name);
  const opener = name
    ? `${name} 🧡 I'm so glad you're staying with me.`
    : `I'm so glad you're staying with me 🧡`;
  return (
    `${opener} This means we keep going together on your GLP-1 journey — I'm right here for it. ` +
    `Anytime, just text me: what you ate (or snap a photo) and I'll track your protein and calories, ` +
    `how you're feeling after your shot and I'll learn what settles YOUR body, ` +
    `your weight or mood whenever you want to log them. ` +
    `And text me "dashboard" anytime to see your whole progress. Let's keep going 🧡`
  );
}

/**
 * Send the paid-welcome once per user. Redis SET NX guards against duplicates
 * (a year TTL). Best-effort: any failure is swallowed so it never breaks the
 * payment/admin flow. Sends on the user's own channel.
 */
export async function sendPaidWelcomeOnce(
  deps: { redis?: Redis; sender: MessageSender; logger: MiniLogger },
  user: { phone: string; first_name?: string | null; medication?: string | null; channel?: string | null },
): Promise<void> {
  try {
    if (deps.redis) {
      const first = await deps.redis.set(`paid:welcomed:${user.phone}`, '1', 'EX', 31_536_000, 'NX');
      if (first === null) return; // already sent
    }
    const body = buildPaidWelcome(user);
    await deps.sender.send({
      to: user.phone,
      channel: (user.channel as 'whatsapp' | 'sms' | 'imessage' | undefined) ?? 'imessage',
      body,
    });
    deps.logger.info({ phone: user.phone }, 'paid_welcome.sent');
  } catch (err) {
    deps.logger.warn({ err: err instanceof Error ? err.message : String(err), phone: user.phone }, 'paid_welcome.send_failed');
  }
}
