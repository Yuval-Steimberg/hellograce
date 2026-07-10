/**
 * Device auto-reply detection (Apple "Driving Focus" / "Do Not Disturb While
 * Driving" / generic auto-replies).
 *
 * When a user's phone auto-responds to one of Grace's proactive messages, it
 * sends a canned text like "I'm driving with Focus turned on. I'll see your
 * message when I get where I'm going." That is a DEVICE message, not the user —
 * replying to it is pointless, and Grace was sending the identical "check your
 * Do Not Disturb settings" tip every time it arrived (prod audit 2026-07: the
 * same tip four times). We skip these entirely (no reply, no logged turn).
 *
 * Patterns are deliberately PRECISE — they require the Focus/DND signature or a
 * clear auto-reply tail ("I'll get back to you", "auto-reply:"), so a genuine
 * message that merely mentions driving ("driving now but I had 2 eggs") is NOT
 * filtered and still gets handled.
 */
const AUTO_REPLY_RES: readonly RegExp[] = [
  // Apple Driving Focus / Do Not Disturb While Driving (default + close variants)
  /\bdriving with (?:focus|do not disturb)\b/i,
  /\bdo not disturb while driving\b/i,
  /\b(?:focus|dnd|do not disturb)\b[^.]{0,40}\bi'?ll (?:see|get|read|reply to|respond to)\b/i,
  /\bi'?ll (?:see|read|get back to|respond to|reply to) your (?:message|text)\b[^.]{0,40}\b(?:when i (?:get|can|arrive)|where i'?m going|get to my destination|at my destination)\b/i,
  // "I'm driving …" only when paired with an explicit auto-reply tail.
  /\bi'?m driving\b[^.]{0,40}\b(?:i'?ll (?:get back|reply|respond|text you|see your)|reply (?:later|when i)|get back to you|talk (?:to you )?later)\b/i,
  // Explicit auto-reply prefix.
  /^\s*auto-?reply\s*[:\-]/i,
];

/** True when the text is a device-generated auto-reply (driving/DND/auto-reply). */
export function isDeviceAutoReply(text: string | null | undefined): boolean {
  const t = (text ?? '').trim();
  if (!t) return false;
  return AUTO_REPLY_RES.some((re) => re.test(t));
}
