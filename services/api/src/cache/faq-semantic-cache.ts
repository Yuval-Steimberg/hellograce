// Semantic FAQ cache — bypasses the full LLM pipeline for very-high-similarity
// matches against a pre-seeded set of educational responses.
//
// This is the latency-optimization layer requested in the 2026-05-30
// improvement plan. Approach:
//   1. On startup, embed every FaqSeed (one-time cost ~2s total).
//   2. On every inbound message, embed the user text and compare against the
//      stored vectors via cosine similarity.
//   3. Return the canonical response only when similarity ≥ threshold AND
//      the user has no conversation history yet (or the gap is large).
//
// CRITICAL CONSTRAINTS:
//   - Cached responses are personalization-free. We never inject a user
//     name, protein target, or today's macros into a cached response.
//   - Cache is OPT-IN via FAQ_CACHE_ENABLED env. Off by default until we
//     confirm correctness in production.
//   - Threshold is conservative (0.92 default — Gemini embeddings have a
//     tighter distribution than other models; tune higher in env if needed).
//   - Cache only triggers for FRESH or near-fresh conversations to avoid
//     replacing a contextually-aware response with a generic one.

import type { Logger } from 'pino';
import type { Embedder } from '../rag/rag.service.js';
import { FAQ_SEEDS, type FaqSeed } from './faq-seeds.js';

interface FaqEntry extends FaqSeed {
  embedding: number[];
}

export interface FaqCacheStats {
  hits: number;
  misses: number;
  lookups: number;
  hitRate: number;
  /** Per-category hit count for telemetry. */
  hitsByCategory: Record<string, number>;
  /** Average lookup latency in ms (rolling 100). */
  avgLookupLatencyMs: number;
}

export interface FaqCacheLookup {
  /** Canonical response text — drop straight into the outbound pipeline. */
  response: string;
  /** Which seed produced the hit (for logging + debugging). */
  matchedQuery: string;
  category: FaqSeed['category'];
  similarity: number;
}

export class FaqSemanticCache {
  private entries: FaqEntry[] = [];
  private ready = false;
  private hits = 0;
  private misses = 0;
  private hitsByCategory: Record<string, number> = {};
  private lookupLatencies: number[] = [];

  constructor(
    private embedder: Embedder,
    private logger: Logger,
    private threshold: number = 0.92,
  ) {}

  /**
   * Embed every seed once at startup. Returns when ready or on hard failure
   * (caller can choose to keep the cache disabled if seed embedding fails).
   */
  async initialize(): Promise<void> {
    if (this.ready) return;
    const t0 = Date.now();
    try {
      const embedded = await Promise.all(
        FAQ_SEEDS.map(async (seed) => ({
          ...seed,
          embedding: await this.embedder.embed(seed.query),
        })),
      );
      this.entries = embedded;
      this.ready = true;
      this.logger.info(
        { count: this.entries.length, ms: Date.now() - t0 },
        'faq_cache.seeded',
      );
    } catch (err) {
      this.logger.error({ err: (err as Error).message }, 'faq_cache.seed_failed');
      // Stay un-ready; lookup() will short-circuit to miss.
    }
  }

  /** True if the cache is ready to serve lookups. */
  isReady(): boolean {
    return this.ready;
  }

  /**
   * Look up the user text against the seeded entries. Returns the canonical
   * response only when cosine similarity ≥ threshold; otherwise null.
   */
  async lookup(text: string): Promise<FaqCacheLookup | null> {
    if (!this.ready || this.entries.length === 0) {
      this.misses++;
      return null;
    }
    const t0 = Date.now();
    let queryVec: number[];
    try {
      queryVec = await this.embedder.embed(text);
    } catch (err) {
      this.logger.warn({ err: (err as Error).message }, 'faq_cache.embed_failed');
      this.misses++;
      this.recordLatency(Date.now() - t0);
      return null;
    }

    let bestSim = -1;
    let best: FaqEntry | null = null;
    for (const entry of this.entries) {
      const sim = cosine(queryVec, entry.embedding);
      if (sim > bestSim) {
        bestSim = sim;
        best = entry;
      }
    }

    this.recordLatency(Date.now() - t0);

    if (!best || bestSim < this.threshold) {
      this.misses++;
      return null;
    }

    this.hits++;
    this.hitsByCategory[best.category] = (this.hitsByCategory[best.category] ?? 0) + 1;
    this.logger.info(
      { matched: best.query.slice(0, 50), similarity: bestSim.toFixed(3), category: best.category },
      'faq_cache.hit',
    );
    return {
      response: best.response,
      matchedQuery: best.query,
      category: best.category,
      similarity: bestSim,
    };
  }

  stats(): FaqCacheStats {
    const lookups = this.hits + this.misses;
    const avg =
      this.lookupLatencies.length > 0
        ? Math.round(this.lookupLatencies.reduce((a, b) => a + b, 0) / this.lookupLatencies.length)
        : 0;
    return {
      hits: this.hits,
      misses: this.misses,
      lookups,
      hitRate: lookups > 0 ? Math.round((this.hits / lookups) * 100) / 100 : 0,
      hitsByCategory: { ...this.hitsByCategory },
      avgLookupLatencyMs: avg,
    };
  }

  private recordLatency(ms: number): void {
    this.lookupLatencies.push(ms);
    if (this.lookupLatencies.length > 100) this.lookupLatencies.shift();
  }
}

// Standard cosine similarity. Both inputs MUST be equal-length numeric
// vectors (Gemini embeddings are 768-dim).
function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i]!;
    const bi = b[i]!;
    dot += ai * bi;
    na += ai * ai;
    nb += bi * bi;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
