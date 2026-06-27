import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UserMemoryService } from './user-memory.service.js';

function makeDeps(updateRowCount = 0) {
  const updateCalls: Array<{ sql: string; params: unknown[] }> = [];
  const insertCalls: Array<{ sql: string; params: unknown[] }> = [];
  const pool = {
    query: vi.fn().mockImplementation((sql: string, params: unknown[]) => {
      if (sql.includes('UPDATE user_memories')) {
        updateCalls.push({ sql, params });
        return Promise.resolve({ rowCount: updateRowCount, rows: [] });
      }
      if (sql.includes('INSERT INTO user_memories')) {
        insertCalls.push({ sql, params });
        return Promise.resolve({ rowCount: 1, rows: [] });
      }
      return Promise.resolve({ rowCount: 0, rows: [] });
    }),
  } as any;
  const embedder = { embed: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]) } as any;
  const llm = { generate: vi.fn() } as any;
  const logger = { info: vi.fn(), warn: vi.fn() } as any;
  return { pool, embedder, llm, logger, updateCalls, insertCalls };
}

describe('UserMemoryService.supersedeChangedFact', () => {
  let deps: ReturnType<typeof makeDeps>;
  let svc: UserMemoryService;

  beforeEach(() => {
    deps = makeDeps(2);
    svc = new UserMemoryService(deps.pool, deps.embedder, deps.llm, deps.logger);
  });

  it('down-weights memories naming the old value and records a correction', async () => {
    const retired = await svc.supersedeChangedFact(
      'user-1',
      ['Ozempic'],
      'Switched medication to Mounjaro (previously Ozempic)',
    );

    expect(retired).toBe(2);

    // Down-weight uses confidence = 0.0 and a case-insensitive contains match.
    expect(deps.updateCalls).toHaveLength(1);
    expect(deps.updateCalls[0]!.sql).toContain('SET confidence = 0.0');
    expect(deps.updateCalls[0]!.params).toEqual(['user-1', 'ozempic']);

    // A fresh corrective memory is embedded + inserted at high confidence.
    expect(deps.embedder.embed).toHaveBeenCalledOnce();
    expect(deps.insertCalls).toHaveLength(1);
    expect(deps.insertCalls[0]!.params[1]).toBe('Switched medication to Mounjaro (previously Ozempic)');
  });

  it('skips tiny/ambiguous terms (< 3 chars) but still records the correction', async () => {
    const retired = await svc.supersedeChangedFact('user-1', ['rx'], 'corrected');
    expect(retired).toBe(0);
    expect(deps.updateCalls).toHaveLength(0);
    expect(deps.insertCalls).toHaveLength(1); // correction still recorded
  });

  it('does not throw and returns 0 when the DB errors', async () => {
    deps.pool.query.mockRejectedValueOnce(new Error('db down'));
    const retired = await svc.supersedeChangedFact('user-1', ['Ozempic'], 'x');
    expect(retired).toBe(0);
    expect(deps.logger.warn).toHaveBeenCalled();
  });

  it('still returns the retired count when the corrective insert fails', async () => {
    deps.embedder.embed.mockRejectedValueOnce(new Error('embed fail'));
    const retired = await svc.supersedeChangedFact('user-1', ['Ozempic'], 'correction');
    expect(retired).toBe(2); // down-weight succeeded; insert failure is swallowed
    expect(deps.insertCalls).toHaveLength(0);
  });
});
