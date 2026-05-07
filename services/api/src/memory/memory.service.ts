import type { Pool } from 'pg';
import type { ChatTurn } from '@grace/shared';

/**
 * MemoryService — short-term recall via Postgres.
 * Long-term semantic recall is in RagService (pgvector).
 */
export class MemoryService {
  constructor(private pool: Pool) {}

  async getRecentTurns(userId: string, limit = 12): Promise<ChatTurn[]> {
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
    return rows
      .map((r) => ({ role: r.role, content: r.content, createdAt: r.created_at }))
      .reverse();
  }

  async appendTurn(turn: { userId: string; role: 'user' | 'assistant'; content: string; conversationId: string }): Promise<void> {
    await this.pool.query(
      `INSERT INTO messages (user_id, conversation_id, role, content)
       VALUES ($1, $2, $3, $4)`,
      [turn.userId, turn.conversationId, turn.role, turn.content],
    );
  }

  async ensureConversation(userId: string): Promise<string> {
    const { rows } = await this.pool.query<{ id: string }>(
      `INSERT INTO conversations (user_id)
       VALUES ($1)
       ON CONFLICT (user_id) WHERE active = true
       DO UPDATE SET updated_at = now()
       RETURNING id`,
      [userId],
    );
    return rows[0]!.id;
  }
}
