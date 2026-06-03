import type { Pool } from 'pg';
import type { ChatTurn } from '@grace/shared';

/**
 * MemoryService — short-term recall via Postgres.
 * Long-term semantic recall is in RagService (pgvector).
 *
 * 2026-06-03 latency cut: two of the four parallel DB queries fired on every
 * inbound turn (ensureConversation + getRecentTurns) are now in-memory cached
 * with short TTLs.
 *
 *   - ensureConversation: 5min TTL. The conversations table has a UNIQUE
 *     constraint on (user_id) WHERE active = true, so the active conversation
 *     ID is stable for a user as long as the row stays active. We cache the
 *     ID; appendTurn does NOT touch this cache (writes go to messages, not
 *     conversations). Worst case on stale cache: a few extra updated_at
 *     bumps skipped, which is harmless.
 *
 *   - getRecentTurns: 5s TTL. Short enough that the next turn (which appends
 *     the user message + reply) always sees fresh history. Invalidated on
 *     appendTurn for the affected user.
 */
export class MemoryService {
  private conversationIdCache = new Map<string, { id: string; expiresAt: number }>();
  private recentTurnsCache = new Map<string, { key: string; value: ChatTurn[]; expiresAt: number }>();
  private readonly CONVERSATION_TTL_MS = 5 * 60_000;
  private readonly RECENT_TURNS_TTL_MS = 5_000;

  constructor(private pool: Pool) {}

  async getRecentTurns(userId: string, limit = 12): Promise<ChatTurn[]> {
    const cacheKey = `${userId}|${limit}`;
    const cached = this.recentTurnsCache.get(userId);
    if (cached && cached.key === cacheKey && cached.expiresAt > Date.now()) {
      return cached.value;
    }
    const { rows } = await this.pool.query<{
      role: 'user' | 'assistant' | 'system';
      content: string;
      created_at: Date;
    }>(
      `SELECT role, content, created_at
       FROM messages
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [userId, limit],
    );
    const value = rows
      .map((r) => ({ role: r.role, content: r.content, createdAt: r.created_at }))
      .reverse();
    this.recentTurnsCache.set(userId, { key: cacheKey, value, expiresAt: Date.now() + this.RECENT_TURNS_TTL_MS });
    return value;
  }

  async appendTurn(turn: {
    userId: string;
    role: 'user' | 'assistant';
    content: string;
    conversationId: string;
    /** End-to-end latency for assistant turns (used by /admin/latency). */
    latencyMs?: number;
    /** Classified intent — drives per-category percentile breakdowns. */
    intent?: string;
    /** Per-stage timing for slow-request diagnosis. */
    stageTimings?: Record<string, number>;
  }): Promise<void> {
    // Backward-compatible: when latency/intent/stages are undefined, the
    // generated SQL uses NULL for those columns so legacy callers keep working.
    await this.pool.query(
      `INSERT INTO messages (user_id, conversation_id, role, content, latency_ms, intent, stage_timings)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        turn.userId,
        turn.conversationId,
        turn.role,
        turn.content,
        turn.latencyMs ?? null,
        turn.intent ?? null,
        turn.stageTimings ? JSON.stringify(turn.stageTimings) : null,
      ],
    );
    // Invalidate the recent-turns cache for this user — the next read should
    // see the row we just inserted. The 5s TTL was the bound; this drops it
    // to ~0 for the user that just wrote.
    this.recentTurnsCache.delete(turn.userId);
  }

  async ensureConversation(userId: string): Promise<string> {
    const cached = this.conversationIdCache.get(userId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.id;
    }
    const { rows } = await this.pool.query<{ id: string }>(
      `INSERT INTO conversations (user_id)
       VALUES ($1)
       ON CONFLICT (user_id) WHERE active = true
       DO UPDATE SET updated_at = now()
       RETURNING id`,
      [userId],
    );
    const id = rows[0]!.id;
    this.conversationIdCache.set(userId, { id, expiresAt: Date.now() + this.CONVERSATION_TTL_MS });
    return id;
  }
}
