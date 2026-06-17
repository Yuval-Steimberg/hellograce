import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ImessageSender } from './sender.js';
import type { Logger } from 'pino';

const logger = { info() {}, warn() {}, error() {}, debug() {} } as unknown as Logger;

function makeSender() {
  return new ImessageSender(
    { authKey: 'auth-key', secretKey: 'secret-key', senderName: 'grace@imsg', canonicalWebUrl: 'https://grace-admin-silk.vercel.app' },
    logger,
  );
}

describe('ImessageSender', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ message_id: 'm-123', success: true }),
      text: async () => '',
    }));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('POSTs the LoopMessage send contract with auth headers + recipient/text/sender_name', async () => {
    const s = makeSender();
    const res = await s.send({ to: '+15551234567', channel: 'imessage', body: 'Logged that.' });
    expect(res.sid).toBe('m-123');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toContain('loopmessage.com');
    expect(init.headers.Authorization).toBe('auth-key');
    expect(init.headers['Loop-Secret-Key']).toBe('secret-key');
    const payload = JSON.parse(init.body);
    expect(payload.recipient).toBe('+15551234567');
    expect(payload.sender_name).toBe('grace@imsg');
    expect(payload.text).toBe('Logged that.');
  });

  it('runs the shared outbound sanitizer (strips markdown) unless raw', async () => {
    const s = makeSender();
    await s.send({ to: '+1', channel: 'imessage', body: '**Bold** and a list:\n- one\n- two' });
    const payload = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(payload.text).not.toContain('**');
    expect(payload.text).not.toMatch(/^- /m);
  });

  it('rewrites a graceglp.com link to the deployment host', async () => {
    const s = makeSender();
    await s.send({ to: '+1', channel: 'imessage', body: 'Update it here: https://graceglp.com/settings' });
    const payload = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(payload.text).toContain('grace-admin-silk.vercel.app/settings');
    expect(payload.text).not.toContain('graceglp.com');
  });

  it('strips a stray imessage: prefix from the recipient', async () => {
    const s = makeSender();
    await s.send({ to: 'imessage:+15550001111', channel: 'imessage', body: 'hi there' });
    const payload = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(payload.recipient).toBe('+15550001111');
  });

  it('throws UpstreamError on a non-2xx provider response', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 422, json: async () => ({}), text: async () => 'bad' });
    const s = makeSender();
    await expect(s.send({ to: '+1', channel: 'imessage', body: 'hi' })).rejects.toThrow();
  });

  it('passes raw bodies through without sanitization', async () => {
    const s = makeSender();
    await s.send({ to: '+1', channel: 'imessage', body: '**keep this**', raw: true });
    const payload = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(payload.text).toBe('**keep this**');
  });
});
