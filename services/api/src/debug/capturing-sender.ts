import type { MessageSender, OutboundMessage } from '../twilio/sender.js';

/**
 * CapturingSender (2026-07-18) — records would-be outbound instead of sending.
 *
 * Implements the app's single `MessageSender` seam, so injecting it as the
 * sender for a debug run captures every message Grace WOULD deliver (webhook
 * replies, intercept replies, salvage sends) without any real Twilio / Sendblue
 * / iMessage delivery. `AIService.handleMessage` itself never sends — the webhook
 * does — so for a direct `handleMessage` debug run this typically stays empty,
 * but it's the correct seam and is used when a run drives the fuller
 * `processInboundMessage` path.
 */
export class CapturingSender implements MessageSender {
  readonly captured: OutboundMessage[] = [];

  async send(msg: OutboundMessage): Promise<{ sid: string }> {
    this.captured.push(msg);
    return { sid: `debug-capture-${this.captured.length}` };
  }
}
