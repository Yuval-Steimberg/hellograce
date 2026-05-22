import { describe, it, expect, vi } from 'vitest';
import type { Logger } from 'pino';
import type { RetrievedDoc } from '@grace/shared';
import { HybridRagService } from './hybrid-rag.service.js';
import { SparseSearchService } from './sparse-search.service.js';
import { ReRankerService } from './reranker.service.js';

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  trace: () => {},
  fatal: () => {},
} as unknown as Logger;

function doc(id: string, content = `content-${id}`, score = 0): RetrievedDoc {
  return { id, source: 'knowledge', content, score };
}

function makeHybrid(opts: {
  dense: RetrievedDoc[];
  sparse?: RetrievedDoc[];
  rerankerUrl?: string;
  rerankerResponse?: { scores: number[] };
  rerankerThrows?: boolean;
  denseThrows?: boolean;
}): HybridRagService {
  const pool = {} as never;
  const embedder = {
    embed: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]),
  };

  const sparse = new SparseSearchService(pool, silentLogger);
  vi.spyOn(sparse, 'retrieve').mockResolvedValue(opts.sparse ?? []);

  const reranker = new ReRankerService(opts.rerankerUrl, silentLogger);
  if (opts.rerankerUrl) {
    if (opts.rerankerThrows) {
      vi.spyOn(global, 'fetch' as never).mockRejectedValue(new Error('boom'));
    } else if (opts.rerankerResponse) {
      vi.spyOn(global, 'fetch' as never).mockResolvedValue({
        ok: true,
        json: async () => opts.rerankerResponse,
      } as never);
    }
  }

  const hybrid = new HybridRagService(pool, embedder, silentLogger, sparse, reranker);
  // Stub the dense path by overriding the inherited super.retrieve via the prototype.
  const dense = opts.dense;
  vi.spyOn(Object.getPrototypeOf(HybridRagService.prototype), 'retrieve').mockImplementation(
    opts.denseThrows
      ? () => Promise.reject(new Error('dense down'))
      : () => Promise.resolve(dense),
  );
  return hybrid;
}

describe('HybridRagService', () => {
  it('returns dense-only result when reranker URL unset and sparse is empty', async () => {
    const hybrid = makeHybrid({ dense: [doc('d1'), doc('d2'), doc('d3')], sparse: [] });
    const out = await hybrid.retrieve('q', { userId: 'u', topK: 2 });
    expect(out.map((d) => d.id)).toEqual(['d1', 'd2']);
  });

  it('dedupes dense + sparse by id, preserving dense order first', async () => {
    const hybrid = makeHybrid({
      dense: [doc('a'), doc('b')],
      sparse: [doc('b'), doc('c')],
    });
    const out = await hybrid.retrieve('q', { userId: 'u', topK: 10 });
    expect(out.map((d) => d.id)).toEqual(['a', 'b', 'c']);
  });

  it('falls back to fused order when reranker errors', async () => {
    const hybrid = makeHybrid({
      dense: [doc('a'), doc('b')],
      sparse: [doc('c')],
      rerankerUrl: 'http://reranker:8081',
      rerankerThrows: true,
    });
    const out = await hybrid.retrieve('q', { userId: 'u', topK: 3 });
    expect(out.map((d) => d.id)).toEqual(['a', 'b', 'c']);
  });

  it('reorders by reranker scores when sidecar responds', async () => {
    const hybrid = makeHybrid({
      dense: [doc('a'), doc('b')],
      sparse: [doc('c')],
      rerankerUrl: 'http://reranker:8081',
      // a=0.1, b=0.9, c=0.5 → expected order b, c, a
      rerankerResponse: { scores: [0.1, 0.9, 0.5] },
    });
    const out = await hybrid.retrieve('q', { userId: 'u', topK: 3 });
    expect(out.map((d) => d.id)).toEqual(['b', 'c', 'a']);
  });

  it('survives total dense failure by returning sparse-only', async () => {
    const hybrid = makeHybrid({
      dense: [],
      sparse: [doc('s1'), doc('s2')],
      denseThrows: true,
    });
    const out = await hybrid.retrieve('q', { userId: 'u', topK: 5 });
    expect(out.map((d) => d.id)).toEqual(['s1', 's2']);
  });

  it('returns [] when both legs are empty', async () => {
    const hybrid = makeHybrid({ dense: [], sparse: [] });
    const out = await hybrid.retrieve('q', { userId: 'u' });
    expect(out).toEqual([]);
  });
});
