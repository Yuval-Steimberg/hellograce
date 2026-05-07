import { GoogleGenerativeAI } from '@google/generative-ai';
import { UpstreamError } from '../errors.js';
import type { Embedder } from './rag.service.js';

/** text-embedding-004 → 768-dim vectors. */
export class GeminiEmbedder implements Embedder {
  private client: GoogleGenerativeAI;
  constructor(apiKey: string, private model = 'text-embedding-004') {
    this.client = new GoogleGenerativeAI(apiKey);
  }

  async embed(text: string): Promise<number[]> {
    try {
      const m = this.client.getGenerativeModel({ model: this.model });
      const result = await m.embedContent(text);
      return result.embedding.values;
    } catch (err) {
      throw new UpstreamError('Embedding generation failed', err);
    }
  }
}
