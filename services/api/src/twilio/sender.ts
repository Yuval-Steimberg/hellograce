import twilio from 'twilio';
import type { Logger } from 'pino';
import { UpstreamError } from '../errors.js';

export interface TwilioSenderConfig {
  accountSid: string;
  authToken: string;
  fromSms?: string;
  fromWhatsapp?: string;
}

export interface OutboundMessage {
  to: string;
  channel: 'whatsapp' | 'sms';
  body: string;
}

export class TwilioSender {
  private client: twilio.Twilio;
  constructor(private cfg: TwilioSenderConfig, private logger: Logger) {
    this.client = twilio(cfg.accountSid, cfg.authToken);
  }

  async send(msg: OutboundMessage): Promise<{ sid: string }> {
    const useWhatsapp = msg.channel === 'whatsapp' && !!this.cfg.fromWhatsapp;
    const from = useWhatsapp ? `whatsapp:${this.cfg.fromWhatsapp!.replace(/^whatsapp:/, '')}` : this.cfg.fromSms;
    if (!from) throw new UpstreamError('No Twilio sender configured for channel');
    const to = useWhatsapp && !msg.to.startsWith('whatsapp:') ? `whatsapp:${msg.to}` : msg.to;

    try {
      const result = await this.client.messages.create({ from, to, body: msg.body });
      this.logger.info({ sid: result.sid, channel: useWhatsapp ? 'whatsapp' : 'sms' }, 'twilio.send.ok');
      return { sid: result.sid };
    } catch (err) {
      this.logger.error({ err }, 'twilio.send.failed');
      throw new UpstreamError('Failed to send Twilio message', err);
    }
  }
}
