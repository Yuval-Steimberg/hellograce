import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryService } from './memory.service.js';

function makePool(turns: any[] = [], convId = 'conv-1') {
  return {
    query: vi.fn().mockImplementation((sql: string) => {
      if (sql.includes('FROM messages')) return Promise.resolve({ rows: turns });
      if (sql.includes('INSERT INTO conversations')) return Promise.resolve({ rows: [{ id: convId }] });
      if (sql.includes('INSERT INTO messages')) return Promise.resolve({ rowCount: 1, rows: [] });
      return Promise.resolve({ rows: [] });
    }),
  } as any;
}

describe('MemoryService.ensureConversation caching', () => {
  let pool: any;
  let svc: MemoryService;
  beforeEach(() => {
    pool = makePool([], 'conv-abc');
    svc = new MemoryService(pool);
  });

  it('second call returns cached conversation id without hitting DB', async () => {
    const a = await svc.ensureConversation('+15551234');
    const b = await svc.ensureConversation('+15551234');
    expect(a).toBe('conv-abc');
    expect(b).toBe('conv-abc');
    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  it('different users do not share the conversation cache', async () => {
    await svc.ensureConversation('+15551111');
    await svc.ensureConversation('+15552222');
    expect(pool.query).toHaveBeenCalledTimes(2);
  });
});

describe('MemoryService.getRecentTurns caching', () => {
  let pool: any;
  let svc: MemoryService;
  beforeEach(() => {
    pool = makePool([
      { role: 'user', content: 'hi', created_at: new Date('2026-06-03T10:00:00Z') },
      { role: 'assistant', content: 'hey there', created_at: new Date('2026-06-03T10:00:01Z') },
    ]);
    svc = new MemoryService(pool);
  });

  it('second call within TTL serves from cache', async () => {
    const a = await svc.getRecentTurns('+15551234', 6);
    const b = await svc.getRecentTurns('+15551234', 6);
    expect(a).toEqual(b);
    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  it('different limit forces a fresh read', async () => {
    await svc.getRecentTurns('+15551234', 6);
    await svc.getRecentTurns('+15551234', 12);
    expect(pool.query).toHaveBeenCalledTimes(2);
  });

  it('appendTurn invalidates the recent-turns cache for that user', async () => {
    await svc.getRecentTurns('+15551234', 6);
    await svc.appendTurn({ userId: '+15551234', role: 'user', content: 'new msg', conversationId: 'conv-1' });
    await svc.getRecentTurns('+15551234', 6);
    // 1 SELECT + 1 INSERT + 1 SELECT
    expect(pool.query).toHaveBeenCalledTimes(3);
  });

  it('appendTurn does NOT invalidate other users', async () => {
    await svc.getRecentTurns('+15551111', 6);
    await svc.getRecentTurns('+15552222', 6);
    await svc.appendTurn({ userId: '+15551111', role: 'user', content: 'msg', conversationId: 'c1' });
    await svc.getRecentTurns('+15552222', 6);
    // user2's cache stays warm → 4th call is served from cache, no DB hit
    // Total: 2 initial SELECTs + 1 INSERT (for u1) = 3 pool.query calls
    expect(pool.query).toHaveBeenCalledTimes(3);
  });
});
