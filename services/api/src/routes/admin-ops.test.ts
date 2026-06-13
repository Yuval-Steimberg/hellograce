import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { registerAdminRoutes } from './admin.js';
import { AppError } from '../errors.js';

// Exercises the manual-ops / notes / flags / audit-log endpoints end-to-end
// through Fastify (routing, validation, audit writes, sender + memory wiring).
// The Stripe service logic itself is covered in stripe.service.test.ts.

function makeApp(over: {
  query?: (sql: string, params: unknown[]) => { rows: unknown[] };
  sender?: { send: ReturnType<typeof vi.fn> };
  memory?: { ensureConversation: ReturnType<typeof vi.fn>; appendTurn: ReturnType<typeof vi.fn> };
} = {}) {
  const calls: { sql: string; params: unknown[] }[] = [];
  const queryImpl = over.query ?? (() => ({ rows: [] }));
  const pool = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      return queryImpl(sql, params);
    }),
  } as unknown as Pool;

  const sender = over.sender ?? { send: vi.fn().mockResolvedValue({ sid: 'SM123' }) };
  const memory = over.memory ?? {
    ensureConversation: vi.fn().mockResolvedValue('conv-1'),
    appendTurn: vi.fn().mockResolvedValue(undefined),
  };

  const app: FastifyInstance = Fastify();
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) {
      reply.status(err.statusCode).send({ error: err.code, message: err.message });
      return;
    }
    reply.status(500).send({ error: 'INTERNAL', message: err.message });
  });
  // No adminToken → preHandler auth is skipped, so we test the handlers directly.
  registerAdminRoutes(app, {
    pool,
    sender: sender as never,
    memory: memory as never,
  });
  return { app, calls, pool, sender, memory };
}

beforeEach(() => vi.clearAllMocks());

describe('POST /admin/users/:phone/send-message', () => {
  it('sends via the sender, persists the turn, and audits', async () => {
    const { app, calls, sender, memory } = makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/admin/users/+15551112222/send-message',
      headers: { 'x-admin-actor': 'yuval@grace' },
      payload: { text: 'Hey, checking in on you today.' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, sid: 'SM123' });
    expect(sender.send).toHaveBeenCalledWith(
      expect.objectContaining({ to: '+15551112222', channel: 'whatsapp', raw: true }),
    );
    expect(memory.appendTurn).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'assistant', intent: 'admin_manual' }),
    );
    const audit = calls.find((c) => /INSERT INTO audit_logs/.test(c.sql));
    expect(audit).toBeDefined();
    expect(audit!.params[2]).toBe('yuval@grace'); // actor
    expect(audit!.params[3]).toBe('+15551112222'); // target_user
  });

  it('rejects an empty message', async () => {
    const { app } = makeApp();
    const res = await app.inject({ method: 'POST', url: '/admin/users/+1/send-message', payload: { text: '' } });
    expect(res.statusCode).toBe(400);
  });

  it('503s when no sender is configured', async () => {
    const calls: { sql: string; params: unknown[] }[] = [];
    const pool = { query: vi.fn(async (sql: string, params: unknown[] = []) => { calls.push({ sql, params }); return { rows: [] }; }) } as unknown as Pool;
    const app = Fastify();
    registerAdminRoutes(app, { pool }); // no sender
    const res = await app.inject({ method: 'POST', url: '/admin/users/+1/send-message', payload: { text: 'hi there' } });
    expect(res.statusCode).toBe(503);
  });
});

describe('internal notes', () => {
  it('adds a note (RETURNING) and audits with the actor', async () => {
    const { app, calls } = makeApp({
      query: (sql) => (/RETURNING id, target_user/.test(sql)
        ? { rows: [{ id: 7, target_user: '+1', author: 'support', note: 'called back', created_at: 'now' }] }
        : { rows: [] }),
    });
    const res = await app.inject({
      method: 'POST',
      url: '/admin/users/+1/notes',
      headers: { 'x-admin-actor': 'support' },
      payload: { note: 'called back' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().note).toMatchObject({ id: 7, note: 'called back' });
    const insert = calls.find((c) => /INSERT INTO admin_notes/.test(c.sql));
    expect(insert!.params).toEqual(['+1', 'support', 'called back']);
  });

  it('lists notes', async () => {
    const { app } = makeApp({
      query: (sql) => (/FROM admin_notes/.test(sql) ? { rows: [{ id: 1, note: 'x' }] } : { rows: [] }),
    });
    const res = await app.inject({ method: 'GET', url: '/admin/users/+1/notes' });
    expect(res.json().notes).toHaveLength(1);
  });
});

describe('flagged responses', () => {
  it('flags a message and records the reason', async () => {
    const { app, calls } = makeApp({
      query: (sql) => (/RETURNING id, message_id/.test(sql) ? { rows: [{ id: 3, status: 'open' }] } : { rows: [] }),
    });
    const res = await app.inject({
      method: 'POST',
      url: '/admin/messages/msg-uuid/flag',
      payload: { user_id: '+1', reason: 'hallucinated dose advice' },
    });
    expect(res.statusCode).toBe(200);
    const insert = calls.find((c) => /INSERT INTO flagged_responses/.test(c.sql));
    expect(insert!.params[0]).toBe('msg-uuid');
    expect(insert!.params[2]).toBe('hallucinated dose advice');
  });

  it('resolves a flag', async () => {
    const { app, calls } = makeApp({
      query: (sql) => (/UPDATE flagged_responses SET status = 'reviewed'/.test(sql) ? { rows: [{ user_id: '+1' }] } : { rows: [] }),
    });
    const res = await app.inject({ method: 'PUT', url: '/admin/flagged/3/resolve', headers: { 'x-admin-actor': 'qa' } });
    expect(res.statusCode).toBe(200);
    const upd = calls.find((c) => /UPDATE flagged_responses/.test(c.sql));
    expect(upd!.params).toEqual(['3', 'qa']);
  });
});

describe('GET /admin/audit-logs', () => {
  it('filters by action + date and returns rows', async () => {
    const { app, calls } = makeApp({
      query: (sql) => (/FROM audit_logs/.test(sql) ? { rows: [{ id: 1, action: 'admin.user_update' }] } : { rows: [] }),
    });
    const res = await app.inject({ method: 'GET', url: '/admin/audit-logs?action=admin.user_update&date=7d' });
    expect(res.statusCode).toBe(200);
    expect(res.json().logs).toHaveLength(1);
    const sel = calls.find((c) => /FROM audit_logs/.test(c.sql));
    expect(sel!.sql).toMatch(/action = \$1/);
    expect(sel!.sql).toMatch(/interval '7 days'/);
  });
});

describe('pause / resume', () => {
  it('pauses a user (DB update) and audits', async () => {
    const { app, calls } = makeApp();
    const res = await app.inject({ method: 'POST', url: '/admin/users/+1/pause' });
    expect(res.json()).toEqual({ ok: true, paused: true });
    const upd = calls.find((c) => /UPDATE users SET paused = \$2/.test(c.sql));
    expect(upd!.params).toEqual(['+1', true]);
    expect(calls.some((c) => /INSERT INTO audit_logs/.test(c.sql))).toBe(true);
  });

  it('resumes a user', async () => {
    const { app, calls } = makeApp();
    const res = await app.inject({ method: 'POST', url: '/admin/users/+1/resume' });
    expect(res.json()).toEqual({ ok: true, paused: false });
    const upd = calls.find((c) => /UPDATE users SET paused = \$2/.test(c.sql));
    expect(upd!.params).toEqual(['+1', false]);
  });
});
