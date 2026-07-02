import type { GraceUser } from '../user/user.service.js';
import { isEncryptedBlob } from '../crypto/field-encrypt.js';

/**
 * Quiet re-engagement for users who opted OUT of reminders (paused = true).
 *
 * Product rule (2026-07-02): even if a user turned reminders off, if they go
 * quiet for more than a day we still send ONE warm, no-pressure hello — just so
 * they remember Grace is there if they need her. It is NOT a reminder or a nudge
 * to log anything; it explicitly respects that reminders stay off. Heavily
 * throttled by the scheduler (Redis gate) so an opted-out user is never nagged.
 *
 * Deterministic + pure so it's unit-testable and never calls the LLM (these are
 * opt-out users — the safest, cheapest path is a fixed warm rotation).
 */

/** Clean a first name for greeting: drop empty / ciphertext blobs. */
function cleanName(v: string | null | undefined): string | null {
  return v && !isEncryptedBlob(v) && v.trim().length > 0 ? v.trim() : null;
}

/** Small deterministic hash so the same user gets a stable line within a day
 *  but varies day-to-day (avoids sending the identical text every time). */
function hash(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return h;
}

/**
 * Build the friendly "I'm still here" message. Warm, zero pressure, one line,
 * acknowledges reminders are off. `seed` (e.g. phone + local date) picks the
 * rotation deterministically.
 */
export function buildQuietReengagement(
  user: Pick<GraceUser, 'first_name'>,
  seed: string,
): string {
  const name = cleanName(user.first_name);
  const g = name ? ` ${name}` : '';
  const variants = [
    `Hey${g} 🧡 no agenda here — just wanted you to know I'm still around whenever you need me. A meal, a rough day, a quick question... I'm one text away. (Reminders stay off — this was just a little hello.)`,
    `Thinking of you${g} 🧡 I've kept your reminders off like you asked, so this is a one-off wave to say I'm still here anytime something comes up. No pressure at all.`,
    `Hi${g} 🧡 just a gentle hello — I'm still right here if you ever want to talk food, how you're feeling, or anything on your mind. Reminders are staying off; I only wanted you to know I haven't gone anywhere.`,
    `Hey${g} 🧡 checking in with zero pressure — I'm here whenever you need me, even quietly in the background. Text me anytime and I'll pick right back up. (Still keeping reminders off.)`,
  ];
  return variants[hash(seed) % variants.length]!;
}
