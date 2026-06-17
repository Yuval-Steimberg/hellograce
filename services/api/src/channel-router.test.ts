import { describe, it, expect, vi } from 'vitest';
import { ChannelRouter } from './channel-router.js';
import type { MessageSender, OutboundMessage } from './twilio/sender.js';
import type { Logger } from 'pino';

const logger = { info() {}, warn() {}, error() {}, debug() {} } as unknown as Logger;

function fakeSender(id: string): MessageSender & { calls: OutboundMessage[] } {
  const calls: OutboundMessage[] = [];
  return {
    calls,
    async send(msg: OutboundMessage) {
      calls.push(msg);
      return { sid: `${id}-sid` };
    },
  };
}

describe('ChannelRouter', () => {
  it('routes whatsapp + sms to Twilio', async () => {
    const twilio = fakeSender('tw');
    const imessage = fakeSender('im');
    const router = new ChannelRouter({ twilio, imessage }, logger);
    await router.send({ to: '+1', channel: 'whatsapp', body: 'a' });
    await router.send({ to: '+1', channel: 'sms', body: 'b' });
    expect(twilio.calls).toHaveLength(2);
    expect(imessage.calls).toHaveLength(0);
  });

  it('routes imessage to the ImessageSender when configured', async () => {
    const twilio = fakeSender('tw');
    const imessage = fakeSender('im');
    const router = new ChannelRouter({ twilio, imessage }, logger);
    const res = await router.send({ to: '+1', channel: 'imessage', body: 'c' });
    expect(res.sid).toBe('im-sid');
    expect(imessage.calls).toHaveLength(1);
    expect(twilio.calls).toHaveLength(0);
  });

  it('falls back to Twilio WhatsApp when imessage is requested but unconfigured', async () => {
    const twilio = fakeSender('tw');
    const router = new ChannelRouter({ twilio }, logger);
    const res = await router.send({ to: '+1', channel: 'imessage', body: 'd' });
    expect(res.sid).toBe('tw-sid');
    expect(twilio.calls).toHaveLength(1);
    expect(twilio.calls[0]!.channel).toBe('whatsapp'); // rewritten so Twilio accepts it
  });
});
