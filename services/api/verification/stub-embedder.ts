// Deterministic 768-dim bag-of-words embedder. Same-topic texts share tokens
// and therefore score high cosine similarity — good enough to exercise the
// real pgvector retrieval path (SQL, ranking, feedback-score clamp) without
// the Gemini embedding API.
import { createHash } from 'node:crypto';
import type { Embedder } from '../src/rag/rag.service.js';

const DIM = 768;

export class StubEmbedder implements Embedder {
  async embed(text: string): Promise<number[]> {
    const vec = new Array<number>(DIM).fill(0);
    const tokens = text.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [];
    for (const tok of tokens) {
      const h = createHash('sha1').update(tok).digest();
      const idx = h.readUInt32BE(0) % DIM;
      const idx2 = h.readUInt32BE(4) % DIM;
      vec[idx]! += 1;
      vec[idx2]! += 0.5;
    }
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
    return vec.map((v) => v / norm);
  }
}
