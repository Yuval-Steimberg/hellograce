import { createHash } from 'crypto';
import { UpstreamError } from '../errors.js';
import type { Embedder } from './rag.service.js';
import type { Cache } from '../cache/cache.js';

const EMBED_TTL_SEC = 5 * 60;
const EMBED_DIMS = 768;

/** gemini-embedding-001 with outputDimensionality=768 → matches existing vector(768) schema. */
export class GeminiEmbedder implements Embedder {
  constructor(
    private apiKey: string,
    private model = 'gemini-embedding-001',
    private cache?: Cache,
  ) {}

  async embed(text: string): Promise<number[]> {
    if (this.cache) {
      const key = createHash('sha256').update(text).digest('hex');
      const cached = await this.cache.get<number[]>('embed', key).catch(() => null);
      if (cached) return cached;

      const vector = await this.callEmbed(text);
      await this.cache.set('embed', key, vector, EMBED_TTL_SEC).catch(() => null);
      return vector;
    }

    return this.callEmbed(text);
  }

  private async callEmbed(text: string): Promise<number[]> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:embedContent?key=${this.apiKey}`;
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          content: { parts: [{ text }] },
          outputDimensionality: EMBED_DIMS,
        }),
      });
    } catch (err) {
      throw new UpstreamError('Embedding generation failed', err);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new UpstreamError(`Embedding generation failed: HTTP ${response.status} ${body}`);
    }

    const data = (await response.json()) as { embedding?: { values?: number[] } };
    const values = data.embedding?.values;
    if (!values || values.length !== EMBED_DIMS) {
      throw new UpstreamError(
        `Embedding generation failed: unexpected response (got ${values?.length ?? 0} dims, want ${EMBED_DIMS})`,
      );
    }
    return values;
  }
}
