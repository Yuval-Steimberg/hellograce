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

  // ─── Metrics ────────────────────────────────────────────────────────────────

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

  // ─── Conversations ───────────────────────────────────────────────────────────

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
       ORDER BY created_at ASC
       LIMIT 200`,
      [userId],
    );
    return { messages: rows };
  });

  // ─── Feedback / RLHF ────────────────────────────────────────────────────────

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

  /** Recent feedback for the RLHF dashboard. */
  app.get('/admin/feedback', async () => {
    const { rows } = await deps.pool.query(
      `SELECT id, user_id, message_id, signal_type, rating, comment, created_at
       FROM feedback
       ORDER BY created_at DESC
       LIMIT 200`,
    );
    return { feedback: rows };
  });

  // ─── Prompts ─────────────────────────────────────────────────────────────────

  app.get('/admin/prompts', async () => {
    const { rows } = await deps.pool.query(
      `SELECT id, version, content, active, created_at
       FROM prompts
       ORDER BY version DESC`,
    );
    return { prompts: rows };
  });

  const PromptBodySchema = z.object({ content: z.string().min(20).max(10_000) });

  app.post('/admin/prompts', async (req) => {
    const parsed = PromptBodySchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError(parsed.error.message);

    const { rows } = await deps.pool.query<{ id: string; version: number }>(
      `INSERT INTO prompts (version, content, active)
       SELECT COALESCE(MAX(version), 0) + 1, $1, FALSE
       FROM prompts
       RETURNING id, version`,
      [parsed.data.content],
    );
    return { prompt: rows[0] };
  });

  app.put('/admin/prompts/:id/activate', async (req) => {
    const { id } = req.params as { id: string };
    await deps.pool.query('BEGIN');
    try {
      await deps.pool.query(`UPDATE prompts SET active = FALSE WHERE active = TRUE`);
      const { rowCount } = await deps.pool.query(
        `UPDATE prompts SET active = TRUE WHERE id = $1`,
        [id],
      );
      await deps.pool.query('COMMIT');
      if (!rowCount) throw new ValidationError('Prompt not found');
    } catch (err) {
      await deps.pool.query('ROLLBACK');
      throw err;
    }
    return { ok: true };
  });

  // ─── Tool settings ───────────────────────────────────────────────────────────

  app.get('/admin/tool-settings', async () => {
    const { rows } = await deps.pool.query(
      `SELECT tool_name, enabled, priority, updated_at
       FROM tool_settings
       ORDER BY priority ASC`,
    );
    return { tools: rows };
  });

  const ToolSettingSchema = z.object({
    enabled: z.boolean(),
    priority: z.number().int().min(0).max(1000),
  });

  app.put('/admin/tool-settings/:name', async (req) => {
    const { name } = req.params as { name: string };
    const parsed = ToolSettingSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError(parsed.error.message);
    const { enabled, priority } = parsed.data;
    await deps.pool.query(
      `INSERT INTO tool_settings (tool_name, enabled, priority, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (tool_name) DO UPDATE
         SET enabled = EXCLUDED.enabled,
             priority = EXCLUDED.priority,
             updated_at = now()`,
      [name, enabled, priority],
    );
    return { ok: true };
  });

  // ─── User management ─────────────────────────────────────────────────────────

  app.get('/admin/users', async (req) => {
    const limit = Math.min(Number((req.query as Record<string, string>)['limit'] ?? 100), 500);
    const offset = Number((req.query as Record<string, string>)['offset'] ?? 0);
    const { rows } = await deps.pool.query(
      `SELECT phone, first_name, medication, goals, timezone, active, paused, blocked,
              is_paid, is_pro, rlhf_enabled, injection_day, injection_count,
              last_morning_sent_at, last_reply_at, created_at
       FROM users
       ORDER BY created_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset],
    );
    const { rows: countRows } = await deps.pool.query<{ total: string }>(`SELECT count(*)::text AS total FROM users`);
    return { users: rows, total: Number(countRows[0]?.total ?? 0) };
  });

  /** Permanently delete a user and all their data (GDPR). */
  app.delete('/admin/users/:phone', async (req) => {
    const { phone } = req.params as { phone: string };
    await deps.pool.query('DELETE FROM check_ins WHERE phone = $1', [phone]);
    await deps.pool.query('DELETE FROM messages WHERE user_id = $1', [phone]);
    await deps.pool.query('DELETE FROM conversations WHERE user_id = $1', [phone]);
    await deps.pool.query('DELETE FROM embeddings WHERE user_id = $1', [phone]);
    await deps.pool.query('DELETE FROM food_logs WHERE user_id = $1', [phone]);
    await deps.pool.query('DELETE FROM weight_logs WHERE user_id = $1', [phone]);
    await deps.pool.query('DELETE FROM feedback WHERE user_id = $1', [phone]);
    await deps.pool.query('DELETE FROM users WHERE phone = $1', [phone]);
    return { ok: true };
  });

  /** Reset a user's conversation memory (messages + conversations) without deleting the profile. */
  app.post('/admin/users/:phone/reset-memory', async (req) => {
    const { phone } = req.params as { phone: string };
    await deps.pool.query('DELETE FROM messages WHERE user_id = $1', [phone]);
    await deps.pool.query('DELETE FROM conversations WHERE user_id = $1', [phone]);
    await deps.pool.query('DELETE FROM embeddings WHERE user_id = $1', [phone]);
    return { ok: true };
  });

  /** Toggle RLHF contribution for a user — enables/disables in-chat rating prompts. */
  app.put('/admin/users/:phone/rlhf', async (req) => {
    const { phone } = req.params as { phone: string };
    const { enabled } = req.body as { enabled: boolean };
    const { rowCount } = await deps.pool.query(
      `UPDATE users SET rlhf_enabled = $1, updated_at = now() WHERE phone = $2`,
      [enabled, phone],
    );
    if (!rowCount) throw new ValidationError('User not found');
    return { ok: true };
  });
}
