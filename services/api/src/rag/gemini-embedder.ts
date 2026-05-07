import { createHash } from 'crypto';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { UpstreamError } from '../errors.js';
import type { Embedder } from './rag.service.js';
import type { Cache } from '../cache/cache.js';

const EMBED_TTL_SEC = 5 * 60; // 5 min

/** text-embedding-004 → 768-dim vectors. */
export class GeminiEmbedder implements Embedder {
  private client: GoogleGenerativeAI;
  constructor(
    apiKey: string,
    private model = 'text-embedding-004',
    private cache?: Cache,
  ) {
    this.client = new GoogleGenerativeAI(apiKey);
  }

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
    try {
      const m = this.client.getGenerativeModel({ model: this.model });
      const result = await m.embedContent(text);
      return result.embedding.values;
    } catch (err) {
      throw new UpstreamError('Embedding generation failed', err);
    }
  }
}
