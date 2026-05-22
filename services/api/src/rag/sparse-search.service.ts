import type { Pool } from 'pg';
import type { Logger } from 'pino';
import type { RetrievedDoc } from '@grace/shared';

/**
 * SparseSearchService — Postgres full-text keyword search over `embeddings.content`.
 *
 * Additive companion to RagService: catches exact terminology (drug names, dose
 * numbers, medical terms) that pure semantic search can miss when query and KB
 * use slightly different phrasings.
 *
 * Fully defensive — any DB error returns []. Pairs with the
 * `20260522000003_hybrid_rag_fts.sql` migration; if that hasn't run, the query
 * fails and we silently return []. The host (HybridRagService) keeps the dense
 * results so the user never sees a regression.
 */
export class SparseSearchService {
  constructor(
    private pool: Pool,
    private logger: Logger,
  ) {}

  async retrieve(
    query: string,
    opts: { userId: string; topK?: number } = { userId: '' },
  ): Promise<RetrievedDoc[]> {
    const topK = opts.topK ?? 10;
    const trimmed = query.trim();
    if (!trimmed) return [];

    try {
      const { rows } = await this.pool.query<{
        id: string;
        source: 'history' | 'knowledge' | 'web';
        content: string;
        metadata: Record<string, unknown> | null;
        score: number;
      }>(
        `SELECT id, source, content, metadata,
                ts_rank(content_tsv, websearch_to_tsquery('english', $1)) AS score
         FROM public.embeddings
         WHERE content_tsv @@ websearch_to_tsquery('english', $1)
           AND (user_id = $2 OR user_id IS NULL)
         ORDER BY score DESC
         LIMIT $3`,
        [trimmed, opts.userId, topK],
      );

      return rows.map((r) => ({
        id: r.id,
        source: r.source,
        content: r.content,
        score: Number(r.score),
        ...(r.metadata ? { metadata: r.metadata } : {}),
      }));
    } catch (err) {
      this.logger.warn({ err }, 'rag.sparse.failed');
      return [];
    }
  }
}
