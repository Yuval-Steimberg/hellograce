import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SendblueSender } from './sendblue-sender.js';
import type { Logger } from 'pino';

const logger = { info() {}, warn() {}, error() {}, debug() {} } as unknown as Logger;

function makeSender() {
  return new SendblueSender(
    { apiKeyId: 'key-id', apiSecret: 'secret', canonicalWebUrl: 'https://grace-admin-silk.vercel.app' },
    logger,
  );
}

describe('SendblueSender', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ message_handle: 'h-123', status: 'QUEUED' }),
      text: async () => '',
    }));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('POSTs the Sendblue send contract with sb headers + number/content', async () => {
    const s = makeSender();
    const res = await s.send({ to: '+15551234567', channel: 'imessage', body: 'Logged that.' });
    expect(res.sid).toBe('h-123');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toContain('api.sendblue.co/api/send-message');
    expect(init.headers['sb-api-key-id']).toBe('key-id');
    expect(init.headers['sb-api-secret-key']).toBe('secret');
    const payload = JSON.parse(init.body);
    expect(payload.number).toBe('+15551234567');
    expect(payload.content).toBe('Logged that.');
    // Sendblue has no sender_name concept.
    expect(payload.sender_name).toBeUndefined();
  });

  it('runs the shared outbound sanitizer (strips markdown) unless raw', async () => {
    const s = makeSender();
    await s.send({ to: '+1', channel: 'imessage', body: '**Bold** and a list:\n- one\n- two' });
    const payload = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(payload.content).not.toContain('**');
    expect(payload.content).not.toMatch(/^- /m);
  });

  it('rewrites a graceglp.com link to the deployment host', async () => {
    const s = makeSender();
    await s.send({ to: '+1', channel: 'imessage', body: 'Update it here: https://graceglp.com/settings' });
    const payload = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(payload.content).toContain('grace-admin-silk.vercel.app/settings');
    expect(payload.content).not.toContain('graceglp.com');
  });

  it('strips a stray imessage: prefix from the number', async () => {
    const s = makeSender();
    await s.send({ to: 'imessage:+15550001111', channel: 'imessage', body: 'hi there' });
    const payload = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(payload.number).toBe('+15550001111');
  });

  it('includes from_number when configured (Sendblue multi-line requirement)', async () => {
    const s = new SendblueSender({ apiKeyId: 'k', apiSecret: 's', fromNumber: '+13054098546' }, logger);
    await s.send({ to: '+972547722420', channel: 'imessage', body: 'hi' });
    const payload = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(payload.from_number).toBe('+13054098546');
  });

  it('omits from_number when not configured', async () => {
    const s = makeSender();
    await s.send({ to: '+1', channel: 'imessage', body: 'hi' });
    const payload = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(payload.from_number).toBeUndefined();
  });

  it('retries once on a network/timeout abort, then succeeds', async () => {
    fetchMock
      .mockRejectedValueOnce(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }))
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ message_handle: 'h-2' }), text: async () => '' });
    const s = makeSender();
    const res = await s.send({ to: '+1', channel: 'imessage', body: 'hi' });
    expect(res.sid).toBe('h-2');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry a 400 (already reached Sendblue — avoids duplicate send)', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 400, json: async () => ({}), text: async () => 'missing from_number' });
    const s = makeSender();
    await expect(s.send({ to: '+1', channel: 'imessage', body: 'hi' })).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('uses a custom apiUrl when configured', async () => {
    const s = new SendblueSender(
      { apiKeyId: 'k', apiSecret: 's', apiUrl: 'https://sandbox.sendblue.co/api/send-message' },
      logger,
    );
    await s.send({ to: '+1', channel: 'imessage', body: 'hi' });
    expect(fetchMock.mock.calls[0]![0]).toBe('https://sandbox.sendblue.co/api/send-message');
  });

  it('throws UpstreamError on a non-2xx provider response', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({}), text: async () => 'bad key' });
    const s = makeSender();
    await expect(s.send({ to: '+1', channel: 'imessage', body: 'hi' })).rejects.toThrow();
  });

  it('passes raw bodies through without sanitization', async () => {
    const s = makeSender();
    await s.send({ to: '+1', channel: 'imessage', body: '**keep this**', raw: true });
    const payload = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(payload.content).toBe('**keep this**');
  });

  it('falls back to a default handle id when the response omits message_handle', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ status: 'QUEUED' }), text: async () => '' });
    const s = makeSender();
    const res = await s.send({ to: '+1', channel: 'imessage', body: 'hi' });
    expect(res.sid).toMatch(/^imsg_/);
  });
});
