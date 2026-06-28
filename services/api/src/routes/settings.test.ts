import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerSettingsRoutes } from './settings.js';
import { AppError } from '../errors.js';

// Minimal in-memory Redis (get/set EX/del/incr/expire) for the code+session store.
function makeRedis() {
  const store = new Map<string, string>();
  return {
    store,
    get: async (k: string) => store.get(k) ?? null,
    set: async (k: string, v: string) => { store.set(k, v); return 'OK'; },
    del: async (k: string) => { store.delete(k); return 1; },
    incr: async (k: string) => { const n = Number(store.get(k) ?? '0') + 1; store.set(k, String(n)); return n; },
    expire: async () => 1,
  };
}

const baseUser = {
  phone: '+15551112222', first_name: 'Sam', medication: 'Ozempic', medication_frequency: 'weekly',
  dose_mg: 0.5, injection_day: 'Monday', timezone: 'America/New_York', wake_time: '07:00', sleep_time: '22:00',
  current_weight: 200, goal_weight: 170, starting_weight: 210, height_cm: 175, age: 40, sex: 'male',
  primary_goal: 'fat_loss', activity_level: 'light', protein_goal_grams: 120, calorie_goal_kcal: 1600,
  dietary_pattern: null, dietary_restriction: null, food_dislikes: [], goals: ['lose weight'],
  checkin_count_per_day: 2, checkin_days_interval: 1, glp1_start_date: null, is_paid: true, is_pro: false, trial_start: null,
} as unknown as Awaited<ReturnType<import('../user/user.service.js').UserService['getByPhone']>>;

function makeApp(opts: { userExists?: boolean; user?: Record<string, unknown> } = {}) {
  const redis = makeRedis();
  const sender = { send: vi.fn().mockResolvedValue({ sid: 'SM1' }) };
  const update = vi.fn().mockResolvedValue(undefined);
  const resolvedUser = opts.userExists === false ? null : (opts.user ?? baseUser);
  const users = {
    getByPhone: vi.fn().mockResolvedValue(resolvedUser),
    update,
  };
  const app: FastifyInstance = Fastify();
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) { reply.status(err.statusCode).send({ error: err.code, message: err.message }); return; }
    reply.status(500).send({ error: 'INTERNAL', message: err.message });
  });
  registerSettingsRoutes(app, { redis: redis as never, sender: sender as never, users: users as never, whatsappEnabled: true });
  return { app, redis, sender, users, update };
}

beforeEach(() => vi.clearAllMocks());

async function getToken(app: FastifyInstance, redis: ReturnType<typeof makeRedis>, phone = '+15551112222') {
  await app.inject({ method: 'POST', url: '/settings/request-code', payload: { phone } });
  const code = redis.store.get(`settings:code:${phone}`)!;
  const res = await app.inject({ method: 'POST', url: '/settings/verify-code', payload: { phone, code } });
  return { token: res.json().token as string, code, res };
}

describe('POST /settings/request-code', () => {
  it('sends a 6-digit code via WhatsApp for a registered user', async () => {
    const { app, redis, sender } = makeApp();
    const res = await app.inject({ method: 'POST', url: '/settings/request-code', payload: { phone: '+1 (555) 111-2222' } });
    expect(res.statusCode).toBe(200);
    const code = redis.store.get('settings:code:+15551112222');
    expect(code).toMatch(/^\d{6}$/);
    expect(sender.send).toHaveBeenCalledWith(expect.objectContaining({ to: '+15551112222', channel: 'whatsapp', raw: true }));
    expect((sender.send.mock.calls[0][0] as { body: string }).body).toContain(code!);
  });

  it('does NOT send (but still returns ok) for an unregistered number — no enumeration', async () => {
    const { app, sender } = makeApp({ userExists: false });
    const res = await app.inject({ method: 'POST', url: '/settings/request-code', payload: { phone: '+19998887777' } });
    expect(res.statusCode).toBe(200);
    expect(sender.send).not.toHaveBeenCalled();
  });

  it('sends the code over iMessage for an iMessage user (honors users.channel)', async () => {
    const { app, sender } = makeApp({ user: { ...baseUser, channel: 'imessage' } });
    const res = await app.inject({ method: 'POST', url: '/settings/request-code', payload: { phone: '+15551112222' } });
    expect(res.statusCode).toBe(200);
    expect(sender.send).toHaveBeenCalledWith(expect.objectContaining({ to: '+15551112222', channel: 'imessage', raw: true }));
  });

  it('sends over SMS for an SMS user', async () => {
    const { app, sender } = makeApp({ user: { ...baseUser, channel: 'sms' } });
    await app.inject({ method: 'POST', url: '/settings/request-code', payload: { phone: '+15551112222' } });
    expect(sender.send).toHaveBeenCalledWith(expect.objectContaining({ channel: 'sms' }));
  });

  it('falls back to WhatsApp when the user has no channel set (legacy)', async () => {
    const { app, sender } = makeApp({ user: { ...baseUser, channel: null } });
    await app.inject({ method: 'POST', url: '/settings/request-code', payload: { phone: '+15551112222' } });
    expect(sender.send).toHaveBeenCalledWith(expect.objectContaining({ channel: 'whatsapp' }));
  });
});

describe('POST /settings/verify-code', () => {
  it('rejects a wrong code (401) and accepts the right one (token + profile)', async () => {
    const { app, redis } = makeApp();
    await app.inject({ method: 'POST', url: '/settings/request-code', payload: { phone: '+15551112222' } });
    const code = redis.store.get('settings:code:+15551112222')!;

    const bad = await app.inject({ method: 'POST', url: '/settings/verify-code', payload: { phone: '+15551112222', code: '000000' } });
    expect(bad.statusCode).toBe(401);

    const ok = await app.inject({ method: 'POST', url: '/settings/verify-code', payload: { phone: '+15551112222', code } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().token).toMatch(/^[0-9a-f]{48}$/);
    expect(ok.json().profile).toMatchObject({ phone: '+15551112222', first_name: 'Sam', protein_goal_grams: 120 });
    // code is consumed
    expect(redis.store.get('settings:code:+15551112222')).toBeUndefined();
  });

  it('locks out after 5 wrong attempts (429)', async () => {
    const { app, redis } = makeApp();
    await app.inject({ method: 'POST', url: '/settings/request-code', payload: { phone: '+15551112222' } });
    for (let i = 0; i < 5; i++) {
      await app.inject({ method: 'POST', url: '/settings/verify-code', payload: { phone: '+15551112222', code: '111111' } });
    }
    const res = await app.inject({ method: 'POST', url: '/settings/verify-code', payload: { phone: '+15551112222', code: redis.store.get('settings:code:+15551112222') ?? '222222' } });
    expect(res.statusCode).toBe(429);
  });
});

describe('GET/PUT /settings/me (session-gated)', () => {
  it('GET requires a valid token', async () => {
    const { app } = makeApp();
    expect((await app.inject({ method: 'GET', url: '/settings/me' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/settings/me', headers: { authorization: 'Bearer nope' } })).statusCode).toBe(401);
  });

  it('GET returns the profile with a valid token', async () => {
    const { app, redis } = makeApp();
    const { token } = await getToken(app, redis);
    const res = await app.inject({ method: 'GET', url: '/settings/me', headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(200);
    expect(res.json().profile.first_name).toBe('Sam');
  });

  it('PUT updates editable fields via UserService.update', async () => {
    const { app, redis, update } = makeApp();
    const { token } = await getToken(app, redis);
    const res = await app.inject({
      method: 'PUT', url: '/settings/me',
      headers: { authorization: `Bearer ${token}` },
      payload: { dietary_pattern: 'vegan', protein_goal_grams: 130, goals: ['build muscle'] },
    });
    expect(res.statusCode).toBe(200);
    expect(update).toHaveBeenCalledWith('+15551112222', expect.objectContaining({ dietary_pattern: 'vegan', protein_goal_grams: 130 }));
  });

  it('PUT rejects an unknown / disallowed field shape', async () => {
    const { app, redis } = makeApp();
    const { token } = await getToken(app, redis);
    const res = await app.inject({
      method: 'PUT', url: '/settings/me',
      headers: { authorization: `Bearer ${token}` },
      payload: { protein_goal_grams: 99999 }, // exceeds max
    });
    expect(res.statusCode).toBe(400);
  });

  it('PUT returns a friendly, human error (field names) — not the raw Zod JSON', async () => {
    const { app, redis } = makeApp();
    const { token } = await getToken(app, redis);
    const res = await app.inject({
      method: 'PUT', url: '/settings/me',
      headers: { authorization: `Bearer ${token}` },
      payload: { protein_goal_grams: 99999 },
    });
    expect(res.statusCode).toBe(400);
    const msg = res.json().message as string;
    expect(msg).toContain('protein_goal_grams');
    expect(msg).not.toContain('"code"'); // no raw Zod issue JSON
    expect(msg).not.toContain('too_big');
  });
});

const ENC_BLOB =
  'enc:ef3fbb2f8ff0583ef4fb5c5ad0:b5b71824ac1e52d715a19:abcdef0123456789abcdef0123456789';

describe('legacy ciphertext blobs (encryption dropped)', () => {
  it('verify-code / GET never return an enc: blob — first_name & medication come back null', async () => {
    const { app, redis } = makeApp({ user: { ...baseUser, first_name: ENC_BLOB, medication: ENC_BLOB } });
    const { res } = await getToken(app, redis);
    expect(res.json().profile.first_name).toBeNull();
    expect(res.json().profile.medication).toBeNull();
  });

  it('PUT silently drops an echoed enc: blob and still saves the rest (no 400)', async () => {
    const { app, redis, update } = makeApp({ user: { ...baseUser, first_name: ENC_BLOB, medication: ENC_BLOB } });
    const { token } = await getToken(app, redis);
    const res = await app.inject({
      method: 'PUT', url: '/settings/me',
      headers: { authorization: `Bearer ${token}` },
      payload: { first_name: ENC_BLOB, medication: ENC_BLOB, protein_goal_grams: 140 },
    });
    expect(res.statusCode).toBe(200);
    const arg = update.mock.calls[0][1] as Record<string, unknown>;
    expect(arg.protein_goal_grams).toBe(140);
    expect(arg).not.toHaveProperty('first_name'); // ciphertext dropped, not saved
    expect(arg).not.toHaveProperty('medication');
  });

  it('PUT still saves a real re-entered name', async () => {
    const { app, redis, update } = makeApp({ user: { ...baseUser, first_name: ENC_BLOB } });
    const { token } = await getToken(app, redis);
    const res = await app.inject({
      method: 'PUT', url: '/settings/me',
      headers: { authorization: `Bearer ${token}` },
      payload: { first_name: 'Yuval' },
    });
    expect(res.statusCode).toBe(200);
    expect(update).toHaveBeenCalledWith('+15551112222', expect.objectContaining({ first_name: 'Yuval' }));
  });
});
