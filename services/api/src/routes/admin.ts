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
    if (!expected) return;
    if (!auth || auth !== `Bearer ${expected}`) throw new UnauthorizedError('Admin token required');
  });

  // ─── Metrics ────────────────────────────────────────────────────────────────

  app.get('/admin/metrics', async () => {
    const [{ rows: msgRows }, { rows: toolRows }, { rows: feedbackRows }, { rows: userStatsRows }] =
      await Promise.all([
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
        deps.pool.query<{
          total: number; paid: number; pro: number;
          trial: number; paused: number; new_this_week: number;
        }>(
          `SELECT
            count(*)::int AS total,
            count(*) FILTER (WHERE is_paid OR is_pro)::int AS paid,
            count(*) FILTER (WHERE is_pro)::int AS pro,
            count(*) FILTER (WHERE
              NOT is_paid AND NOT is_pro AND
              trial_start IS NOT NULL AND
              trial_start > now() - interval '3 days'
            )::int AS trial,
            count(*) FILTER (WHERE paused)::int AS paused,
            count(*) FILTER (WHERE created_at > now() - interval '7 days')::int AS new_this_week
           FROM users`,
        ),
      ]);
    return {
      messages_last_24h: Number(msgRows[0]?.count ?? 0),
      tools: toolRows,
      feedback_last_7d: feedbackRows,
      cache: deps.cache?.stats() ?? null,
      user_stats: userStatsRows[0] ?? { total: 0, paid: 0, pro: 0, trial: 0, paused: 0, new_this_week: 0 },
    };
  });

  // ─── Conversations ───────────────────────────────────────────────────────────

  app.get('/admin/conversations', async () => {
    const { rows } = await deps.pool.query<{
      id: string; user_id: string; message_count: string; last_message_at: Date;
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
      `SELECT id, version, content, active, created_at FROM prompts ORDER BY version DESC`,
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
        `UPDATE prompts SET active = TRUE WHERE id = $1`, [id],
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
      `SELECT tool_name, enabled, priority, updated_at FROM tool_settings ORDER BY priority ASC`,
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

  /** Full user detail with check-in and weight history. */
  app.get('/admin/users/:phone', async (req) => {
    const { phone } = req.params as { phone: string };
    const { rows: userRows } = await deps.pool.query(`SELECT * FROM users WHERE phone = $1 LIMIT 1`, [phone]);
    if (!userRows[0]) throw new ValidationError('User not found');
    const [{ rows: checkIns }, { rows: weightLogs }, { rows: msgCountRows }] = await Promise.all([
      deps.pool.query(
        `SELECT type, message_sent, user_reply, mood_score, created_at
         FROM check_ins WHERE phone = $1
         ORDER BY created_at DESC LIMIT 15`,
        [phone],
      ),
      deps.pool.query(
        `SELECT weight, created_at FROM weight_logs
         WHERE user_id = $1 ORDER BY created_at ASC LIMIT 30`,
        [phone],
      ),
      deps.pool.query<{ count: string }>(
        `SELECT count(*)::text FROM messages WHERE user_id = $1`, [phone],
      ),
    ]);
    return {
      user: userRows[0],
      check_ins: checkIns,
      weight_logs: weightLogs,
      message_count: Number(msgCountRows[0]?.count ?? 0),
    };
  });

  const UpdateUserSchema = z.object({
    first_name: z.string().trim().min(1).max(120).optional(),
    medication: z.string().trim().min(1).max(120).optional(),
    medication_frequency: z.string().trim().optional(),
    injection_day: z.string().max(20).nullable().optional(),
    wake_time: z.string().regex(/^\d{2}:\d{2}$/).optional(),
    sleep_time: z.string().regex(/^\d{2}:\d{2}$/).optional(),
    goals: z.array(z.string().trim().max(120)).max(10).optional(),
    food_dislikes: z.array(z.string().trim()).optional(),
    current_weight: z.number().positive().nullable().optional(),
    goal_weight: z.number().positive().nullable().optional(),
    timezone: z.string().max(100).optional(),
    active: z.boolean().optional(),
    paused: z.boolean().optional(),
    blocked: z.boolean().optional(),
    is_paid: z.boolean().optional(),
    is_pro: z.boolean().optional(),
    trial_start: z.string().nullable().optional(),
  });

  /** Update any user profile fields. */
  app.put('/admin/users/:phone', async (req) => {
    const { phone } = req.params as { phone: string };
    const parsed = UpdateUserSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError(parsed.error.message);
    const fields = parsed.data as Record<string, unknown>;
    const keys = Object.keys(fields);
    if (keys.length === 0) return { ok: true };
    const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
    const { rowCount } = await deps.pool.query(
      `UPDATE users SET ${sets}, updated_at = now() WHERE phone = $1`,
      [phone, ...keys.map((k) => fields[k])],
    );
    if (!rowCount) throw new ValidationError('User not found');
    return { ok: true };
  });

  /** Permanently delete a user and all their data. */
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

  /** Reset conversation memory without deleting the profile. */
  app.post('/admin/users/:phone/reset-memory', async (req) => {
    const { phone } = req.params as { phone: string };
    await deps.pool.query('DELETE FROM messages WHERE user_id = $1', [phone]);
    await deps.pool.query('DELETE FROM conversations WHERE user_id = $1', [phone]);
    await deps.pool.query('DELETE FROM embeddings WHERE user_id = $1', [phone]);
    return { ok: true };
  });

  /** Toggle RLHF contribution for a user. */
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
