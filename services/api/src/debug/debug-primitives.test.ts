import { describe, it, expect, vi } from 'vitest';
import type { Pool } from 'pg';
import type { Redis } from 'ioredis';
import { DryRunPool, isWriteStatement } from './dry-run-pool.js';
import { makeDryRunRedis } from './dry-run-redis.js';
import { CapturingSender } from './capturing-sender.js';

describe('isWriteStatement', () => {
  it('flags mutations, passes reads', () => {
    expect(isWriteStatement('INSERT INTO food_logs (a) VALUES (1)')).toBe(true);
    expect(isWriteStatement('  update users SET x=1 WHERE id=$1')).toBe(true);
    expect(isWriteStatement('DELETE FROM messages WHERE id=$1')).toBe(true);
    expect(isWriteStatement('WITH t AS (SELECT 1) INSERT INTO x SELECT * FROM t')).toBe(true);
    expect(isWriteStatement('SELECT * FROM users WHERE phone=$1')).toBe(false);
    expect(isWriteStatement('  select content from prompts where active = true')).toBe(false);
    expect(isWriteStatement('WITH t AS (SELECT 1) SELECT * FROM t')).toBe(false);
  });
});

describe('DryRunPool', () => {
  it('forwards reads to the real pool and captures writes without executing', async () => {
    const realQuery = vi.fn().mockResolvedValue({ rows: [{ id: 1 }], rowCount: 1 });
    const real = { query: realQuery, connect: vi.fn(), on: vi.fn() } as unknown as Pool;
    const drp = new DryRunPool(real);

    const read = await drp.query('SELECT * FROM users WHERE phone=$1', ['+1']);
    expect(read.rows).toEqual([{ id: 1 }]);
    expect(realQuery).toHaveBeenCalledTimes(1);

    const write = await drp.query('INSERT INTO food_logs (user_id, food) VALUES ($1,$2)', ['+1', 'eggs']);
    expect(write.rowCount).toBe(0);
    expect(write.rows).toEqual([]);
    // The real pool was NOT asked to run the write.
    expect(realQuery).toHaveBeenCalledTimes(1);

    expect(drp.captures).toHaveLength(1);
    expect(drp.captures[0]).toMatchObject({ op: 'insert', table: 'food_logs' });
    expect(drp.captures[0]!.params).toEqual(['+1', 'eggs']);
  });

  it('truncates long params in captures', async () => {
    const real = { query: vi.fn(), connect: vi.fn(), on: vi.fn() } as unknown as Pool;
    const drp = new DryRunPool(real);
    await drp.query('UPDATE users SET notes=$1 WHERE phone=$2', ['x'.repeat(500), '+1']);
    expect(String(drp.captures[0]!.params[0])).toMatch(/…\[500 chars\]$/);
  });

  it('gates writes inside a checked-out transaction client and no-ops BEGIN/COMMIT/ROLLBACK', async () => {
    const clientQuery = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    const client = { query: clientQuery, release: vi.fn() };
    const real = { query: vi.fn(), connect: vi.fn().mockResolvedValue(client), on: vi.fn() } as unknown as Pool;
    const drp = new DryRunPool(real);

    const c = await drp.connect();
    await c.query('BEGIN');
    await c.query('DELETE FROM messages WHERE user_id=$1', ['+1']);
    await c.query('COMMIT');

    // Neither the transaction control nor the DELETE reached the real client.
    expect(clientQuery).not.toHaveBeenCalled();
    expect(drp.captures.find((w) => w.op === 'delete' && w.table === 'messages')).toBeTruthy();
  });
});

describe('makeDryRunRedis', () => {
  it('passes reads through and no-ops writes', async () => {
    const real = {
      get: vi.fn().mockResolvedValue('cached-value'),
      set: vi.fn().mockResolvedValue('OK'),
      del: vi.fn().mockResolvedValue(1),
      expire: vi.fn().mockResolvedValue(1),
      status: 'ready',
    } as unknown as Redis;
    const dry = makeDryRunRedis(real);

    await expect(dry.get('food:pending:+1')).resolves.toBe('cached-value');
    expect(real.get).toHaveBeenCalledWith('food:pending:+1');

    await expect(dry.set('food:pending:+1', 'x')).resolves.toBeNull();
    await expect(dry.del('food:pending:+1')).resolves.toBeNull();
    await expect(dry.expire('k', 60)).resolves.toBeNull();
    expect(real.set).not.toHaveBeenCalled();
    expect(real.del).not.toHaveBeenCalled();
    expect(real.expire).not.toHaveBeenCalled();
    expect(dry.status).toBe('ready');
  });

  it('returns a no-op pipeline that never executes writes', async () => {
    const real = { set: vi.fn(), pipeline: vi.fn() } as unknown as Redis;
    const dry = makeDryRunRedis(real);
    const pipe = (dry as unknown as { pipeline: () => { set: (...a: unknown[]) => unknown; exec: () => Promise<unknown[]> } }).pipeline();
    const res = await pipe.set('k', 'v').exec();
    expect(res).toEqual([]);
    expect(real.set).not.toHaveBeenCalled();
  });
});

describe('CapturingSender', () => {
  it('records would-be sends instead of delivering', async () => {
    const s = new CapturingSender();
    const r = await s.send({ to: '+1', channel: 'imessage', body: 'hi' });
    expect(r.sid).toMatch(/^debug-capture-/);
    expect(s.captured).toEqual([{ to: '+1', channel: 'imessage', body: 'hi' }]);
  });
});
