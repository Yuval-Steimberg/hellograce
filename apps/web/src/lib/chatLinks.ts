/**
 * "Open the conversation with grace" deeplink builders.
 *
 * Grace is iMessage-first (with WhatsApp/SMS fallback), so the onboarding CTAs
 * open Messages to the grace iMessage line with a ready-to-send opener prefilled
 * — the user never lands in an empty chat unsure what to type. WhatsApp remains
 * available as a fallback link for non-Apple users.
 *
 * Single source of truth for every chat-open CTA in the onboarding flow.
 */

const WHATSAPP_NUMBER = (import.meta.env.VITE_WHATSAPP_NUMBER as string | undefined) ?? "";
const WHATSAPP_JOIN_CODE = (import.meta.env.VITE_WHATSAPP_JOIN_CODE as string | undefined) ?? "";
const IMESSAGE_NUMBER = (import.meta.env.VITE_IMESSAGE_NUMBER as string | undefined) ?? "";

/** Warm, ready-to-send opener so starting the conversation feels effortless. */
export const GRACE_GETTING_STARTED_MESSAGE = "Hi grace, I'm ready to get started 🙂";

/** Twilio sandbox is active when a join code is configured. */
export const isSandboxMode = WHATSAPP_JOIN_CODE.length > 0;

/** True when an iMessage line is configured (VITE_IMESSAGE_NUMBER set). */
export const hasImessage = IMESSAGE_NUMBER.length > 0;

export { WHATSAPP_JOIN_CODE };

/** Pretty US/E.164 display, e.g. "+1 (305) 409-8546"; falls back to the raw value. */
export function formatPhoneDisplay(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) {
    return `+1 (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  if (digits.length === 10) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  return raw;
}

/** The grace iMessage line, formatted for display. */
export const imessageDisplayNumber = formatPhoneDisplay(IMESSAGE_NUMBER);

/**
 * Deeplink that opens Messages to the grace iMessage line with a prefilled
 * opener. Uses the `sms:` scheme — it opens the Messages app on Apple devices
 * and sends as iMessage (blue) when the line supports it. Prefill (`&body=`)
 * support varies by OS/browser, so callers should ALSO show the number to text.
 * Returns "" when no iMessage line is configured.
 */
export function buildGraceImessageHref(message: string = GRACE_GETTING_STARTED_MESSAGE): string {
  if (!IMESSAGE_NUMBER) return "";
  const num = IMESSAGE_NUMBER.replace(/[^\d+]/g, "");
  return `sms:${num}&body=${encodeURIComponent(message)}`;
}

/**
 * Build the WhatsApp wa.me deeplink with a ready-to-send message prefilled
 * (warm opener in production, the required `join <code>` in sandbox). Returns ""
 * when no WhatsApp number is configured. Kept as the fallback channel.
 */
export function buildGraceChatHref(message: string = GRACE_GETTING_STARTED_MESSAGE): string {
  if (!WHATSAPP_NUMBER) return "";
  const num = WHATSAPP_NUMBER.replace(/\D/g, "");
  const text = isSandboxMode ? `join ${WHATSAPP_JOIN_CODE}` : message;
  return `https://wa.me/${num}?text=${encodeURIComponent(text)}`;
}
