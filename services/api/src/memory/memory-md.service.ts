/**
 * memory.md — per-user narrative memory layer (Phase D, 2026-06-07).
 *
 * ADDITIVE alongside the existing Postgres memory:
 *   - users table:        hard fields (medication, weight, dose, etc.) — source of truth
 *   - user_profile_facts: LLM-extracted facts — kept during pilot
 *   - embeddings:         semantic memory for RAG
 *   - user_memory_md:     this module — narrative markdown per user
 *
 * The markdown lives as a single document per user with sections for
 * profile, recent context, and open threads. The LLM reads it verbatim
 * in the system prompt and rewrites it via the memory-md-updater worker
 * after each response.
 *
 * Pilot gate: a row in `user_memory_md` enables the layer for that user.
 * No row → existing behavior unchanged. To enroll, INSERT. To unenroll,
 * DELETE.
 *
 * Reads are cached for 5 minutes in-memory because:
 *   - The file changes at most once per response (write-after-ship)
 *   - Subsequent reads within a turn (parallel_io + retry paths) hit the
 *     cache for ~free
 *   - Inter-turn writes invalidate the cache to keep the in-memory copy
 *     fresh
 */

import type { Pool } from 'pg';

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface MinimalLogger {
  info: (obj: object, msg?: string) => void;
  warn: (obj: object, msg?: string) => void;
  error: (obj: object, msg?: string) => void;
}

interface CachedEntry {
  value: string;
  expiresAt: number;
}

export class MemoryMdService {
  private cache = new Map<string, CachedEntry>();

  constructor(
    private readonly pool: Pool,
    private readonly logger: MinimalLogger,
  ) {}

  /**
   * Returns the user's memory.md content. Returns null when:
   *   - no row exists for this user (pilot opt-out)
   *   - DB read fails
   *
   * Cached for 5 minutes; cache is invalidated by the updater worker
   * after each write.
   */
  async get(userId: string): Promise<string | null> {
    const cached = this.cache.get(userId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }
    try {
      const { rows } = await this.pool.query<{ content_md: string }>(
        `SELECT content_md FROM user_memory_md WHERE user_id = $1 LIMIT 1`,
        [userId],
      );
      const value = rows[0]?.content_md ?? null;
      // Cache both hits AND misses so opt-out users don't pay the DB
      // round-trip on every turn.
      this.cache.set(userId, {
        value: value ?? '',
        expiresAt: Date.now() + CACHE_TTL_MS,
      });
      // Return the actual value; an empty-string DB value (newly-enrolled
      // user before first write) still counts as "in pilot" so we report
      // empty string, not null.
      return value;
    } catch (err) {
      this.logger.warn(
        { err: err instanceof Error ? err.message : String(err), userId },
        'memory_md.get_failed',
      );
      return null;
    }
  }

  /**
   * Drop the cache entry for this user so the next read picks up the
   * latest write. Called by the updater worker after a successful
   * rewrite.
   */
  invalidate(userId: string): void {
    this.cache.delete(userId);
  }

  /**
   * True if the user is enrolled in the memory.md pilot (i.e. a row
   * exists in `user_memory_md`). Used by callers that need to branch
   * BEFORE the actual content matters (e.g. deciding whether to enqueue
   * the updater worker).
   */
  async isEnrolled(userId: string): Promise<boolean> {
    const value = await this.get(userId);
    return value !== null;
  }

  /**
   * Enroll a user in the pilot by inserting an empty memory.md row.
   * Idempotent: ON CONFLICT DO NOTHING. The updater worker will populate
   * the content on the next turn.
   *
   * For pilot operations (run from admin endpoint or migration script).
   */
  async enroll(userId: string, initialContent: string = ''): Promise<void> {
    const charCount = initialContent.length;
    await this.pool.query(
      `INSERT INTO user_memory_md (user_id, content_md, content_chars)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id) DO NOTHING`,
      [userId, initialContent, charCount],
    );
    this.invalidate(userId);
  }

  /**
   * Remove a user from the pilot.
   */
  async unenroll(userId: string): Promise<void> {
    await this.pool.query(`DELETE FROM user_memory_md WHERE user_id = $1`, [userId]);
    this.invalidate(userId);
  }

  /**
   * Worker-only API: persist a new version of the markdown after the
   * memory-md-updater LLM call. Updates content + char count +
   * rewrite_count, then invalidates the cache.
   */
  async writeFromWorker(userId: string, content: string): Promise<void> {
    const trimmed = content.trim();
    await this.pool.query(
      `UPDATE user_memory_md
       SET content_md = $2,
           content_chars = $3,
           updated_at = now(),
           rewrite_count = rewrite_count + 1
       WHERE user_id = $1`,
      [userId, trimmed, trimmed.length],
    );
    this.invalidate(userId);
  }
}

// Test-only exports
export const __testing = {
  CACHE_TTL_MS,
};
