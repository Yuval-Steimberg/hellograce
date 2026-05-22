import type { Pool } from 'pg';
import type { Logger } from 'pino';
import type { RetrievedDoc } from '@grace/shared';
import { RagService, type Embedder } from './rag.service.js';
import type { SparseSearchService } from './sparse-search.service.js';
import type { ReRankerService } from './reranker.service.js';

/**
 * HybridRagService — additive wrapper that extends RagService.
 *
 * - Dense path: inherited `super.retrieve()` (pgvector cosine + feedback bias).
 * - Sparse path: Postgres FTS via SparseSearchService.
 * - Fusion: dedupe by doc id, prefer dense order for ties.
 * - Rerank: optional cross-encoder sidecar — when unreachable, returns the
 *   fused list in original order.
 *
 * Drop-in replacement: extends RagService so it is structurally assignable
 * everywhere the existing code expects a `RagService` (AIService, knowledge_search
 * tool). No existing call site needs to change.
 *
 * Failure mode contract: this class MUST NEVER be worse than dense-only retrieval.
 * Every additive step (sparse, rerank) catches its own errors and degrades to
 * the dense result. Verified by `hybrid-rag.test.ts`.
 */
export class HybridRagService extends RagService {
  private readonly ownLogger: Logger;

  constructor(
    pool: Pool,
    embedder: Embedder,
    logger: Logger,
    private readonly sparse: SparseSearchService,
    private readonly reranker: ReRankerService,
  ) {
    super(pool, embedder, logger);
    this.ownLogger = logger;
  }

  override async retrieve(
    query: string,
    opts: { userId: string; topK?: number } = { userId: '' },
  ): Promise<RetrievedDoc[]> {
    const finalK = opts.topK ?? 5;
    // Over-fetch from both legs so the reranker has a real candidate pool.
    const candidateK = Math.max(finalK * 2, 10);

    const [dense, sparse] = await Promise.all([
      super.retrieve(query, { ...opts, topK: candidateK }).catch((err) => {
        this.ownLogger.warn({ err }, 'rag.dense.failed');
        return [] as RetrievedDoc[];
      }),
      this.sparse.retrieve(query, { ...opts, topK: candidateK }),
    ]);

    // Fuse: dense first to preserve cosine ranking for ties; then sparse-only ids.
    const seen = new Set<string>();
    const merged: RetrievedDoc[] = [];
    for (const d of dense) {
      if (seen.has(d.id)) continue;
      seen.add(d.id);
      merged.push(d);
    }
    for (const s of sparse) {
      if (seen.has(s.id)) continue;
      seen.add(s.id);
      merged.push(s);
    }

    if (merged.length === 0) return [];

    // Rerank is a no-op when the sidecar isn't configured/reachable.
    const reranked = this.reranker.isEnabled()
      ? await this.reranker.rerank(query, merged)
      : merged;

    return reranked.slice(0, finalK);
  }
}
