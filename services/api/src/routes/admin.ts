import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { UnauthorizedError, ValidationError } from '../errors.js';
import type { Cache } from '../cache/cache.js';

export interface AdminDeps {
  pool: Pool;
  cache?: Cache;
  adminToken?: string;
}

export function registerAdminRoutes(app: FastifyInstance, deps: AdminDeps): void {
  app.addHook('preHandler', async (req) => {
    if (!req.url.startsWith('/admin/')) return;
    const auth = req.headers.authorization;
    const expected = deps.adminToken;
    if (!expected) return; // allow when no admin token configured (dev only)
    if (!auth || auth !== `Bearer ${expected}`) throw new UnauthorizedError('Admin token required');
  });

  app.get('/admin/metrics', async () => {
    const [{ rows: msgRows }, { rows: toolRows }, { rows: feedbackRows }] = await Promise.all([
      deps.pool.query<{ count: string }>(
        `SELECT count(*)::text FROM messages WHERE created_at > now() - interval '24 hours'`,
      ),
      deps.pool.query<{ tool_name: string; count: string; ok_rate: string; p95_ms: number }>(
        `SELECT tool_name,
                count(*)::text AS count,
                (sum(CASE WHEN ok THEN 1 ELSE 0 END)::float / count(*))::text AS ok_rate,
                percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) AS p95_ms
         FROM tool_logs
         WHERE created_at > now() - interval '24 hours'
         GROUP BY tool_name`,
      ),
      deps.pool.query<{ signal_type: string; count: string; avg_rating: number | null }>(
        `SELECT signal_type, count(*)::text AS count, avg(rating)::float AS avg_rating
         FROM feedback
         WHERE created_at > now() - interval '7 days'
         GROUP BY signal_type`,
      ),
    ]);
    return {
      messages_last_24h: Number(msgRows[0]?.count ?? 0),
      tools: toolRows,
      feedback_last_7d: feedbackRows,
      cache: deps.cache?.stats() ?? null,
    };
  });

  app.get('/admin/conversations', async () => {
    const { rows } = await deps.pool.query<{
      id: string;
      user_id: string;
      message_count: string;
      last_message_at: Date;
    }>(
      `SELECT c.id, c.user_id,
              count(m.*)::text AS message_count,
              max(m.created_at) AS last_message_at
       FROM conversations c
       LEFT JOIN messages m ON m.conversation_id = c.id
       WHERE c.active = true
       GROUP BY c.id
       ORDER BY last_message_at DESC NULLS LAST
       LIMIT 100`,
    );
    return { conversations: rows };
  });

  app.get('/admin/conversations/:userId/messages', async (req) => {
    const { userId } = req.params as { userId: string };
    const { rows } = await deps.pool.query(
      `SELECT id, role, content, created_at
       FROM messages
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT 200`,
      [userId],
    );
    return { messages: rows };
  });

  const FeedbackSchema = z.object({
    messageId: z.string().uuid().optional(),
    userId: z.string().min(1),
    signalType: z.enum(['rating', 'comment', 'requery', 'dropoff', 'correction']),
    rating: z.number().int().min(-1).max(1).optional(),
    comment: z.string().max(2000).optional(),
    metadata: z.record(z.unknown()).optional(),
  });

  app.post('/admin/feedback', async (req) => {
    const parsed = FeedbackSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError(parsed.error.message);
    const f = parsed.data;
    await deps.pool.query(
      `INSERT INTO feedback (message_id, user_id, signal_type, rating, comment, metadata)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [f.messageId ?? null, f.userId, f.signalType, f.rating ?? null, f.comment ?? null, f.metadata ?? null],
    );
    // Bump the embedding's feedback_score if the rating attaches to a stored response.
    if (f.messageId && typeof f.rating === 'number') {
      await deps.pool.query(
        `UPDATE embeddings
         SET feedback_score = COALESCE(feedback_score, 0) + $1
         WHERE metadata->>'message_id' = $2`,
        [f.rating, f.messageId],
      );
    }
    return { ok: true };
  });
}
