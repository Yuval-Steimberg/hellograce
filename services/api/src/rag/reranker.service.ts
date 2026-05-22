import type { Logger } from 'pino';
import type { RetrievedDoc } from '@grace/shared';

/**
 * ReRankerService — TypeScript client for the Python cross-encoder sidecar.
 *
 * Sidecar contract:
 *   POST {url}/rerank
 *     body: { query: string, documents: string[] }
 *     resp: { scores: number[] }   // one float per document, higher = more relevant
 *
 * If `url` is undefined OR the sidecar is unreachable, `rerank()` returns the
 * input documents in the order they were supplied. This makes the whole feature
 * safe to deploy without the sidecar running — callers see no behavior change
 * compared to dense-only retrieval.
 */
export class ReRankerService {
  private readonly enabled: boolean;

  constructor(
    private readonly url: string | undefined,
    private readonly logger: Logger,
    private readonly timeoutMs: number = 1500,
  ) {
    this.enabled = !!url;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  async rerank(query: string, documents: RetrievedDoc[]): Promise<RetrievedDoc[]> {
    if (!this.enabled || !this.url || documents.length === 0) return documents;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.url.replace(/\/$/, '')}/rerank`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query, documents: documents.map((d) => d.content) }),
        signal: controller.signal,
      });

      if (!res.ok) {
        this.logger.warn({ status: res.status }, 'rag.rerank.http_error');
        return documents;
      }

      const data = (await res.json()) as { scores?: number[] };
      const scores = data.scores;
      if (!Array.isArray(scores) || scores.length !== documents.length) {
        this.logger.warn({ got: scores?.length, expected: documents.length }, 'rag.rerank.bad_payload');
        return documents;
      }

      const paired = documents.map((doc, i) => ({ doc, score: scores[i] ?? 0 }));
      paired.sort((a, b) => b.score - a.score);
      return paired.map((p) => ({ ...p.doc, score: p.score }));
    } catch (err) {
      this.logger.warn({ err }, 'rag.rerank.failed');
      return documents;
    } finally {
      clearTimeout(timer);
    }
  }
}
