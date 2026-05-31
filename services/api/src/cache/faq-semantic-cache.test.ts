import { describe, it, expect, beforeEach } from 'vitest';
import type { Logger } from 'pino';
import type { Embedder } from '../rag/rag.service.js';
import { FaqSemanticCache } from './faq-semantic-cache.js';
import { FAQ_SEEDS } from './faq-seeds.js';

const logger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  fatal: () => undefined,
  trace: () => undefined,
  child: () => logger,
  level: 'info',
} as unknown as Logger;

// Deterministic in-memory embedder. Same input → same vector. Different
// inputs → orthogonal-ish vectors (so cosine ≈ 0). Identical inputs → cosine 1.
//
// To exercise "near-similar" matches, we hash the text into a base vector and
// optionally inject extra signal from a known similarity-mapping (e.g. all
// strings containing "nausea" share a common direction).
class FakeEmbedder implements Embedder {
  constructor(private similarityMap: Record<string, number[]> = {}) {}
  async embed(text: string): Promise<number[]> {
    // If an exact key matches, return that vector. Otherwise produce a
    // pseudo-random but stable 16-dim vector from a string hash so tests run
    // deterministically.
    if (this.similarityMap[text]) return this.similarityMap[text]!;
    const vec = new Array(16).fill(0).map((_, i) => {
      let h = 0;
      for (let j = 0; j < text.length; j++) h = (h * 31 + text.charCodeAt(j) + i) | 0;
      return Math.sin(h);
    });
    return vec;
  }
}

describe('FaqSemanticCache', () => {
  let cache: FaqSemanticCache;
  let embedder: FakeEmbedder;

  beforeEach(() => {
    embedder = new FakeEmbedder();
    cache = new FaqSemanticCache(embedder, logger, 0.99);
  });

  it('initializes by embedding every seed', async () => {
    expect(cache.isReady()).toBe(false);
    await cache.initialize();
    expect(cache.isReady()).toBe(true);
    expect(cache.stats().lookups).toBe(0);
  });

  it('returns null when the cache is not initialized', async () => {
    const hit = await cache.lookup("I'm so constipated. What do I do?");
    expect(hit).toBeNull();
    expect(cache.stats().misses).toBe(1);
  });

  it('returns the canonical response on an exact-query lookup (cosine = 1)', async () => {
    await cache.initialize();
    // Embedding for the exact query is the same vector as the seed → cosine 1.
    const query = "I'm so constipated. What do I do?";
    const hit = await cache.lookup(query);
    expect(hit).not.toBeNull();
    expect(hit!.matchedQuery).toBe(query);
    expect(hit!.category).toBe('constipation');
    expect(hit!.similarity).toBeCloseTo(1, 5);
    expect(hit!.response.toLowerCase()).toContain('25-30g fiber');
  });

  it('returns null when the similarity is below the threshold', async () => {
    await cache.initialize();
    // FakeEmbedder produces orthogonal-ish vectors for unrelated text → cosine
    // far below 0.99 threshold.
    const hit = await cache.lookup('Pick me a random topic to read about online.');
    expect(hit).toBeNull();
    expect(cache.stats().hits).toBe(0);
    expect(cache.stats().misses).toBeGreaterThan(0);
  });

  it('tracks per-category hits in stats', async () => {
    await cache.initialize();
    await cache.lookup('How much water should I drink?');     // water
    await cache.lookup('Am I losing muscle on this medication?'); // muscle
    await cache.lookup('Am I losing muscle on this medication?'); // muscle (repeat)
    const stats = cache.stats();
    expect(stats.hits).toBe(3);
    expect(stats.hitsByCategory.water).toBe(1);
    expect(stats.hitsByCategory.muscle).toBe(2);
  });

  it('FAQ_SEEDS contain no personalization tokens', () => {
    // Hard invariant — never seed something user-specific. If a seed contains
    // a name placeholder, target number, or week count it must be rewritten.
    for (const seed of FAQ_SEEDS) {
      expect(seed.response).not.toMatch(/\{[a-z_]+\}/i);          // {first_name}
      expect(seed.response).not.toMatch(/\[.*?\]/);                // [link]
      expect(seed.response).not.toMatch(/\d+g\/day\b/);            // dynamic targets
      expect(seed.response).not.toMatch(/\bweek\s+\d+\b/i);        // week number
      expect(seed.response).not.toMatch(/\byour current weight\b/i);
    }
  });

  it('FAQ_SEEDS responses all end with terminal punctuation', () => {
    // The sender's mid-sentence-truncation repair would fire otherwise.
    for (const seed of FAQ_SEEDS) {
      expect(seed.response).toMatch(/[.?]$/);
    }
  });

  it('FAQ_SEEDS responses contain no markdown / bullet / exclamation', () => {
    // Per the H3 + H5 SMS rules (2026-05-30 clinical report).
    for (const seed of FAQ_SEEDS) {
      expect(seed.response).not.toContain('!');
      expect(seed.response).not.toMatch(/\*\*[^*]+\*\*/);
      expect(seed.response).not.toMatch(/^\s*[-*•]\s/m);
      expect(seed.response).not.toMatch(/^\s*\d+\.\s/m);
    }
  });

  it('FAQ_SEEDS responses contain no production-banned phrases', () => {
    // The ai.service.ts cache-safety-check runs checkContent against the
    // cached response. These banned phrases would cause every cache hit on
    // the entry to be rejected (silent latency regression). Catch them at
    // test time so any future seed addition is vetted up-front.
    const BANNED_IN_CACHE = [
      /\babsolutely critical\b/i,
      /\byou must discuss\b/i,
      /\bwithout their explicit guidance\b/i,
      /\bholistic approach\b/i,
      /\blayers of complexity\b/i,
      /\bhope it hit the spot\b/i,
      /\bi only know about you\b/i,
      /\*\*/,                       // markdown bold
      /^\s*here'?s a breakdown:/im, // list intro
    ];
    for (const seed of FAQ_SEEDS) {
      for (const banned of BANNED_IN_CACHE) {
        expect(seed.response, `Seed "${seed.query}" contains banned: ${banned}`).not.toMatch(banned);
      }
    }
  });

  it('new mechanism / comparison / dose_error / drug_interaction entries are present and short', () => {
    // Guard against accidental removal of the session-3 latency-pass entries.
    const mustHave = [
      'How does Ozempic actually work?',
      'How is Mounjaro different from Ozempic?',
      'Why did my food obsession just disappear?',
      'I think I injected too much.',
      'Can I take another medication with my injection?',
      'My face is looking saggy on Ozempic.',
    ];
    for (const q of mustHave) {
      const found = FAQ_SEEDS.find((s) => s.query === q);
      expect(found, `Missing FAQ seed: ${q}`).toBeDefined();
      // SMS-length sanity check: each response stays well under WhatsApp's
      // soft 1000-char ceiling. The cache exists to be fast AND tight.
      expect(found!.response.length).toBeLessThan(500);
    }
  });
});
