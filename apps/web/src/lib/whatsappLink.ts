/**
 * WhatsApp "open the conversation with grace" deeplink builder.
 *
 * So the user never lands in an EMPTY chat unsure what to type, the Get Started
 * / Start chatting CTAs open WhatsApp with a ready-to-send message prefilled:
 *   - Sandbox (Twilio): the REQUIRED `join <code>` — it must be the first
 *     message to join the sandbox, so that stays the prefill there.
 *   - Production: a warm, human getting-started opener the user can just tap-send.
 *
 * Single source of truth for every chat-open CTA in the onboarding flow.
 */

const WHATSAPP_NUMBER = (import.meta.env.VITE_WHATSAPP_NUMBER as string | undefined) ?? "";
const WHATSAPP_JOIN_CODE = (import.meta.env.VITE_WHATSAPP_JOIN_CODE as string | undefined) ?? "";

/** Warm, ready-to-send opener so starting the conversation feels effortless. */
export const GRACE_GETTING_STARTED_MESSAGE = "Hi grace, I'm ready to get started 🙂";

/** Twilio sandbox is active when a join code is configured. */
export const isSandboxMode = WHATSAPP_JOIN_CODE.length > 0;

export { WHATSAPP_JOIN_CODE };

/**
 * Build the wa.me deeplink that opens the grace conversation with a ready-to-send
 * message prefilled. Returns "" when no WhatsApp number is configured so callers
 * can hide (or fall back) the CTA exactly as before.
 */
export function buildGraceChatHref(message: string = GRACE_GETTING_STARTED_MESSAGE): string {
  if (!WHATSAPP_NUMBER) return "";
  const num = WHATSAPP_NUMBER.replace(/\D/g, "");
  const text = isSandboxMode ? `join ${WHATSAPP_JOIN_CODE}` : message;
  return `https://wa.me/${num}?text=${encodeURIComponent(text)}`;
}
