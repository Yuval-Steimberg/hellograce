/**
 * Active-topic tracker.
 *
 * Stores the current conversation topic (from the deterministic classifier)
 * on `conversations.active_topic` + a timestamp. When the same topic persists
 * across consecutive turns, Grace can refer to it as "the current thread".
 * When the user pivots, the column updates. Stale topics (over 2 hours of
 * silence) are treated as closed at read time.
 *
 * Read-side injects an "Active topic: X" line into the runtime context so
 * Grace knows what is currently 'live' vs. closed.
 *
 * Purely additive — no existing logic depends on these columns.
 */

import type { Pool } from 'pg';
import type { Logger } from 'pino';

const TOPIC_STALE_MS = 2 * 60 * 60 * 1000; // 2 hours

export interface ActiveTopic {
  topic: string;
  /** Minutes since the topic was last touched. */
  ageMinutes: number;
}

export class TopicTrackerService {
  constructor(
    private pool: Pool,
    private logger: Logger,
  ) {}

  /**
   * Update the active topic for a conversation. Fire-and-forget — caller
   * never needs the result. Skips no-op writes for 'general' / 'gibberish'
   * since they don't represent a real topic.
   */
  async record(conversationId: string, topic: string): Promise<void> {
    if (topic === 'general' || topic === 'gibberish') return;
    try {
      await this.pool.query(
        `UPDATE conversations
            SET active_topic = $1,
                active_topic_at = now()
          WHERE id = $2`,
        [topic, conversationId],
      );
    } catch (err) {
      this.logger.warn({ err, conversationId, topic }, 'topic_tracker.record.failed');
    }
  }

  /**
   * Returns the active topic if it was touched in the last 2 hours; else null.
   * Stale topics decay silently — we never clear the column.
   */
  async get(conversationId: string): Promise<ActiveTopic | null> {
    try {
      const { rows } = await this.pool.query<{ active_topic: string | null; active_topic_at: Date | null }>(
        `SELECT active_topic, active_topic_at FROM conversations WHERE id = $1 LIMIT 1`,
        [conversationId],
      );
      const row = rows[0];
      if (!row || !row.active_topic || !row.active_topic_at) return null;
      const ageMs = Date.now() - new Date(row.active_topic_at).getTime();
      if (ageMs > TOPIC_STALE_MS) return null;
      return { topic: row.active_topic, ageMinutes: Math.floor(ageMs / 60000) };
    } catch (err) {
      this.logger.warn({ err, conversationId }, 'topic_tracker.get.failed');
      return null;
    }
  }
}
