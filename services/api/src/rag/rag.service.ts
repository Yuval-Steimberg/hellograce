import type { Pool } from 'pg';
import type { Logger } from 'pino';
import type { RetrievedDoc } from '@grace/shared';

export interface Embedder {
  embed(text: string): Promise<number[]>;
}

/**
 * RagService — pgvector-backed semantic retrieval.
 * Query embedding → top-k cosine similarity over `embeddings` table.
 *
 * Phase 2 hook (RLHF): the `feedback_score` column on `embeddings`
 * is added to the cosine similarity to bias retrieval toward responses
 * that have received positive feedback.
 */
export class RagService {
  constructor(
    private pool: Pool,
    private embedder: Embedder,
    private logger: Logger,
  ) {}

  async retrieve(query: string, opts: { userId: string; topK?: number } = { userId: '' }): Promise<RetrievedDoc[]> {
    const topK = opts.topK ?? 5;
    let queryVec: number[];
    try {
      queryVec = await this.embedder.embed(query);
    } catch (err) {
      this.logger.warn({ err }, 'rag.embed.failed');
      return [];
    }

    const vecLiteral = `[${queryVec.join(',')}]`;
    const { rows } = await this.pool.query<{
      id: string;
      source: 'history' | 'knowledge' | 'web';
      content: string;
      score: number;
      metadata: Record<string, unknown> | null;
    }>(
      // feedback_score is cumulative and unbounded — without the clamp, a
      // chunk with enough accumulated 👍 (score >= ~4) outranks strictly more
      // relevant chunks forever (2026-06-10 verification finding). Clamping to
      // ±5 bounds the bias at ±0.25, a tiebreaker rather than an override.
      `SELECT id, source, content, metadata,
              (1 - (embedding <=> $1::vector)) + GREATEST(LEAST(COALESCE(feedback_score, 0), 5), -5) * 0.05 AS score
       FROM embeddings
       WHERE (user_id = $2 OR user_id IS NULL)
       ORDER BY (1 - (embedding <=> $1::vector)) + GREATEST(LEAST(COALESCE(feedback_score, 0), 5), -5) * 0.05 DESC
       LIMIT $3`,
      [vecLiteral, opts.userId, topK],
    );

    return rows.map((r) => ({
      id: r.id,
      source: r.source,
      content: r.content,
      score: Number(r.score),
      ...(r.metadata ? { metadata: r.metadata } : {}),
    }));
  }
}
