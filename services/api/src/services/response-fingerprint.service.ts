/**
 * Response fingerprinting via Redis n-gram sets.
 *
 * For every outbound Grace message we hash 5-word n-grams and store them in a
 * per-user Redis SET with a 90-day TTL. Before sending a new reply we measure
 * the n-gram overlap against that set; high overlap means Grace is repeating
 * herself (verbatim or near-verbatim) across messages.
 *
 * Mode is currently OBSERVE-ONLY — we log overlap metrics but never block. The
 * data lets us see how repetitive Grace is per-user before deciding whether to
 * enable regen on high overlap.
 *
 * Cost: ~0.5ms per record + ~1ms per overlap check. No LLM calls.
 */

import type { Redis } from 'ioredis';
import type { Logger } from 'pino';

const FP_TTL_SECONDS = 60 * 60 * 24 * 90; // 90 days
const NGRAM_SIZE = 5;
const FP_KEY_PREFIX = 'fp:'; // fp:{userId}
const MIN_TEXT_LEN = 30; // skip ultra-short replies — "ok 🤍" can't be meaningfully repetitive

export interface FingerprintOverlap {
  /** Jaccard similarity 0–1: |A ∩ B| / |A ∪ B|. */
  jaccard: number;
  /** Total n-grams in the candidate text. */
  totalNgrams: number;
  /** Of those, how many were already in the user's history. */
  matchingNgrams: number;
}

export class ResponseFingerprintService {
  constructor(
    private redis: Redis,
    private logger: Logger,
  ) {}

  /**
   * Add fingerprints from `text` to the user's Redis set. Fire-and-forget by
   * callers — never blocks the response path.
   */
  async record(userId: string, text: string): Promise<void> {
    try {
      const clean = text.trim();
      if (clean.length < MIN_TEXT_LEN) return;
      const hashes = ngramHashes(clean, NGRAM_SIZE);
      if (hashes.length === 0) return;
      const key = FP_KEY_PREFIX + userId;
      const pipe = this.redis.pipeline();
      pipe.sadd(key, ...hashes);
      pipe.expire(key, FP_TTL_SECONDS);
      await pipe.exec();
    } catch (err) {
      this.logger.warn({ err, userId }, 'fingerprint.record.failed');
    }
  }

  /**
   * Compute n-gram overlap between `text` and the user's stored fingerprints.
   * Returns 0 for users with no history yet, or short candidate text.
   */
  async checkOverlap(userId: string, text: string): Promise<FingerprintOverlap> {
    const empty: FingerprintOverlap = { jaccard: 0, totalNgrams: 0, matchingNgrams: 0 };
    try {
      const clean = text.trim();
      if (clean.length < MIN_TEXT_LEN) return empty;
      const candidateHashes = ngramHashes(clean, NGRAM_SIZE);
      if (candidateHashes.length === 0) return empty;

      const key = FP_KEY_PREFIX + userId;
      // SMISMEMBER returns array of 0|1, one per member tested — single round-trip.
      const flags = (await this.redis.smismember(key, ...candidateHashes)) as number[];
      const matchingNgrams = flags.filter((f) => f === 1).length;

      const storedSize = await this.redis.scard(key);
      // Jaccard = |A ∩ B| / |A ∪ B| = matching / (candidate + stored - matching)
      const union = candidateHashes.length + storedSize - matchingNgrams;
      const jaccard = union > 0 ? matchingNgrams / union : 0;

      return { jaccard, totalNgrams: candidateHashes.length, matchingNgrams };
    } catch (err) {
      this.logger.warn({ err, userId }, 'fingerprint.check.failed');
      return empty;
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Tokenize → lowercase → strip non-alphanumerics → emit fixed-size word n-grams,
 * hashed to 32-bit unsigned ints (FNV-1a). String storage keeps Redis SET cheap.
 */
function ngramHashes(text: string, size: number): string[] {
  const tokens = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 0);
  if (tokens.length < size) return [];
  const out: string[] = [];
  for (let i = 0; i + size <= tokens.length; i++) {
    const gram = tokens.slice(i, i + size).join(' ');
    out.push(fnv1a32(gram).toString(36));
  }
  return out;
}

function fnv1a32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    // 32-bit FNV prime multiply, kept unsigned.
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
