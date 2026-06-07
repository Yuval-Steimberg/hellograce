import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryMdService } from './memory-md.service.js';

const noopLogger = { info: () => {}, warn: () => {}, error: () => {} };

function makePool(initialRows: Array<{ user_id: string; content_md: string }> = []) {
  const rows = new Map<string, string>(initialRows.map((r) => [r.user_id, r.content_md]));
  const writes: Array<{ sql: string; params: unknown[] }> = [];
  const pool = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      writes.push({ sql, params });
      const select = /SELECT content_md FROM user_memory_md WHERE user_id = \$1/i;
      if (select.test(sql)) {
        const id = params[0] as string;
        const content = rows.get(id);
        return { rows: content !== undefined ? [{ content_md: content }] : [] };
      }
      const insert = /INSERT INTO user_memory_md/i;
      if (insert.test(sql)) {
        const id = params[0] as string;
        const content = params[1] as string;
        // ON CONFLICT DO NOTHING — only insert if not present
        if (!rows.has(id)) rows.set(id, content);
        return { rows: [] };
      }
      const del = /DELETE FROM user_memory_md/i;
      if (del.test(sql)) {
        rows.delete(params[0] as string);
        return { rows: [] };
      }
      const update = /UPDATE user_memory_md/i;
      if (update.test(sql)) {
        rows.set(params[0] as string, params[1] as string);
        return { rows: [] };
      }
      return { rows: [] };
    }),
  };
  return { pool, rows, writes };
}

describe('MemoryMdService — read path', () => {
  it('returns null when user is not enrolled', async () => {
    const { pool } = makePool();
    const svc = new MemoryMdService(pool as never, noopLogger);
    const result = await svc.get('+15551234567');
    expect(result).toBeNull();
  });

  it('returns the content when user has a row', async () => {
    const { pool } = makePool([{ user_id: '+15551234567', content_md: '# Sam\'s Memory' }]);
    const svc = new MemoryMdService(pool as never, noopLogger);
    const result = await svc.get('+15551234567');
    expect(result).toBe('# Sam\'s Memory');
  });

  it('returns empty string for a freshly-enrolled user (still counts as enrolled)', async () => {
    const { pool } = makePool([{ user_id: '+15551234567', content_md: '' }]);
    const svc = new MemoryMdService(pool as never, noopLogger);
    const result = await svc.get('+15551234567');
    expect(result).toBe('');
  });

  it('caches subsequent reads within TTL window', async () => {
    const { pool } = makePool([{ user_id: '+15551234567', content_md: '# Cached' }]);
    const svc = new MemoryMdService(pool as never, noopLogger);
    await svc.get('+15551234567');
    await svc.get('+15551234567');
    await svc.get('+15551234567');
    // Only one DB read despite 3 calls
    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  it('cache differentiates per-user', async () => {
    const { pool } = makePool([
      { user_id: '+15551234567', content_md: '# Alice' },
      { user_id: '+15559999999', content_md: '# Bob' },
    ]);
    const svc = new MemoryMdService(pool as never, noopLogger);
    const a = await svc.get('+15551234567');
    const b = await svc.get('+15559999999');
    expect(a).toBe('# Alice');
    expect(b).toBe('# Bob');
  });

  it('returns null on DB read failure', async () => {
    const pool = {
      query: vi.fn(async () => { throw new Error('db down'); }),
    };
    const svc = new MemoryMdService(pool as never, noopLogger);
    const result = await svc.get('+15551234567');
    expect(result).toBeNull();
  });
});

describe('MemoryMdService — enrollment', () => {
  it('isEnrolled returns true when row exists', async () => {
    const { pool } = makePool([{ user_id: '+15551234567', content_md: '' }]);
    const svc = new MemoryMdService(pool as never, noopLogger);
    expect(await svc.isEnrolled('+15551234567')).toBe(true);
  });

  it('isEnrolled returns false when no row', async () => {
    const { pool } = makePool();
    const svc = new MemoryMdService(pool as never, noopLogger);
    expect(await svc.isEnrolled('+15551234567')).toBe(false);
  });

  it('enroll inserts an empty row', async () => {
    const { pool, rows } = makePool();
    const svc = new MemoryMdService(pool as never, noopLogger);
    await svc.enroll('+15551234567');
    expect(rows.get('+15551234567')).toBe('');
  });

  it('enroll with initialContent persists the content', async () => {
    const { pool, rows } = makePool();
    const svc = new MemoryMdService(pool as never, noopLogger);
    await svc.enroll('+15551234567', '# Initial');
    expect(rows.get('+15551234567')).toBe('# Initial');
  });

  it('enroll is idempotent (ON CONFLICT DO NOTHING)', async () => {
    const { pool, rows } = makePool([{ user_id: '+15551234567', content_md: '# Existing' }]);
    const svc = new MemoryMdService(pool as never, noopLogger);
    await svc.enroll('+15551234567', '# Overwrite Attempt');
    // Original content preserved
    expect(rows.get('+15551234567')).toBe('# Existing');
  });

  it('unenroll drops the row', async () => {
    const { pool, rows } = makePool([{ user_id: '+15551234567', content_md: '# bye' }]);
    const svc = new MemoryMdService(pool as never, noopLogger);
    await svc.unenroll('+15551234567');
    expect(rows.has('+15551234567')).toBe(false);
  });

  it('invalidate clears the cache so next read hits DB', async () => {
    const { pool } = makePool([{ user_id: '+15551234567', content_md: '# A' }]);
    const svc = new MemoryMdService(pool as never, noopLogger);
    await svc.get('+15551234567');  // populate cache
    svc.invalidate('+15551234567');
    await svc.get('+15551234567');  // should re-read
    // 2 reads (initial + post-invalidate)
    expect(pool.query).toHaveBeenCalledTimes(2);
  });

  it('enroll invalidates the cache', async () => {
    const { pool } = makePool();
    const svc = new MemoryMdService(pool as never, noopLogger);
    await svc.get('+15551234567'); // populate cache with null
    await svc.enroll('+15551234567', '# new');
    const result = await svc.get('+15551234567'); // should re-read
    expect(result).toBe('# new');
  });
});

describe('MemoryMdService — worker write path', () => {
  it('writeFromWorker updates content + invalidates cache', async () => {
    const { pool, rows } = makePool([{ user_id: '+15551234567', content_md: '# old' }]);
    const svc = new MemoryMdService(pool as never, noopLogger);

    await svc.get('+15551234567'); // populate cache
    await svc.writeFromWorker('+15551234567', '# new content');
    expect(rows.get('+15551234567')).toBe('# new content');

    // Next read should pick up the new value
    const result = await svc.get('+15551234567');
    expect(result).toBe('# new content');
  });

  it('writeFromWorker trims the input', async () => {
    const { pool, rows } = makePool([{ user_id: '+15551234567', content_md: '# old' }]);
    const svc = new MemoryMdService(pool as never, noopLogger);
    await svc.writeFromWorker('+15551234567', '\n\n# trimmed\n\n');
    expect(rows.get('+15551234567')).toBe('# trimmed');
  });
});
