import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { GRACE_SYSTEM_PROMPT } from '@grace/ai-core';
import { UnauthorizedError, ValidationError } from '../errors.js';
import type { Cache } from '../cache/cache.js';
import type { LLMProvider } from '@grace/shared';
import type { PromptOptimizer } from '../scheduler/prompt-optimizer.js';
import type { MessageTemplatesService } from '../services/message-templates.service.js';

export interface AdminDeps {
  pool: Pool;
  cache?: Cache;
  adminToken?: string;
  llm?: LLMProvider;
  promptOptimizer?: PromptOptimizer;
  /** Hot-reload callback wired in server.ts — pushes the active prompt to AIService and MessageGenerator. */
  reloadActivePrompt?: () => Promise<void>;
  redis?: unknown;
  templates?: MessageTemplatesService;
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

  app.get('/admin/feedback', async (req) => {
    const q = (req.query ?? {}) as {
      userId?: string;
      date?: string;       // 'today' | '7d' | '30d' | 'all'
      signalType?: string; // 'rating' | 'comment' | ...
      rating?: string;     // '1' | '-1'
      limit?: string;
      offset?: string;
    };

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (q.userId) {
      params.push(q.userId);
      conditions.push(`f.user_id = $${params.length}`);
    }

    if (q.date && q.date !== 'all') {
      const interval = q.date === 'today' ? '1 day' : q.date === '7d' ? '7 days' : '30 days';
      conditions.push(`f.created_at > NOW() - INTERVAL '${interval}'`);
    }

    if (q.signalType) {
      params.push(q.signalType);
      conditions.push(`f.signal_type = $${params.length}`);
    }

    if (q.rating) {
      params.push(parseInt(q.rating, 10));
      conditions.push(`f.rating = $${params.length}`);
    }

    const limit = Math.min(parseInt(q.limit ?? '1000', 10), 1000);
    const offset = parseInt(q.offset ?? '0', 10);

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const { rows } = await deps.pool.query(
      `SELECT f.id, f.user_id, f.message_id, f.signal_type, f.rating, f.comment,
              f.created_at, m.content AS assistant_message
       FROM feedback f
       LEFT JOIN messages m ON m.id = f.message_id
       ${where}
       ORDER BY f.created_at DESC
       LIMIT ${limit} OFFSET ${offset}`,
      params,
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

  /**
   * Analyse recent RLHF feedback and negatively-rated messages, then ask Gemini
   * to produce an improved system prompt. Saves it as a new inactive draft so the
   * admin can review and activate it.
   */
  app.post('/admin/prompts/auto-improve', async (_req, reply) => {
    if (!deps.llm) {
      reply.status(503).send({ error: 'LLM_UNAVAILABLE', message: 'LLM not configured' });
      return;
    }

    // 1. Current active prompt
    const { rows: promptRows } = await deps.pool.query<{ content: string }>(
      `SELECT content FROM prompts WHERE active = TRUE ORDER BY version DESC LIMIT 1`,
    );
    const currentPrompt = promptRows[0]?.content;
    if (!currentPrompt) throw new ValidationError('No active prompt to improve. Create and activate one first.');

    // 2. Feedback summary (last 14 days)
    const { rows: feedbackRows } = await deps.pool.query<{
      signal_type: string; rating: number | null; comment: string | null; created_at: Date;
    }>(
      `SELECT signal_type, rating, comment, created_at
       FROM feedback
       WHERE created_at > now() - interval '14 days'
       ORDER BY created_at DESC
       LIMIT 100`,
    );

    const positive = feedbackRows.filter((f) => (f.rating ?? 0) > 0).length;
    const negative = feedbackRows.filter((f) => (f.rating ?? 0) < 0).length;
    const total = feedbackRows.length;
    const approvalRate = total > 0 ? Math.round((positive / total) * 100) : null;
    const comments = feedbackRows
      .filter((f) => f.comment)
      .map((f) => `- ${f.comment}`)
      .join('\n') || '(none)';

    // 3. Sample of negatively-rated assistant messages for context
    const { rows: badMessages } = await deps.pool.query<{ content: string; comment: string | null }>(
      `SELECT m.content, f.comment
       FROM feedback f
       JOIN messages m ON m.id = f.message_id
       WHERE f.rating = -1
         AND f.created_at > now() - interval '14 days'
         AND m.role = 'assistant'
       ORDER BY f.created_at DESC
       LIMIT 8`,
    );

    const badMessageText = badMessages.length > 0
      ? badMessages.map((m, i) =>
          `[${i + 1}] Response: ${m.content.slice(0, 300)}${m.content.length > 300 ? '…' : ''}` +
          (m.comment ? `\n    Admin note: "${m.comment}"` : '')
        ).join('\n\n')
      : '(no negatively-rated messages yet)';

    // 4. Sample of positively-rated messages
    const { rows: goodMessages } = await deps.pool.query<{ content: string }>(
      `SELECT m.content
       FROM feedback f
       JOIN messages m ON m.id = f.message_id
       WHERE f.rating = 1
         AND f.created_at > now() - interval '14 days'
         AND m.role = 'assistant'
       ORDER BY f.created_at DESC
       LIMIT 5`,
    );

    const goodMessageText = goodMessages.length > 0
      ? goodMessages.map((m, i) =>
          `[${i + 1}] ${m.content.slice(0, 200)}${m.content.length > 200 ? '…' : ''}`
        ).join('\n\n')
      : '(no positively-rated messages yet)';

    // 5. Call Gemini to produce the improved prompt
    const metaPrompt = `You are an expert AI prompt engineer. Your task is to improve the system prompt for Grace, an AI companion for people on GLP-1 medications (Ozempic, Wegovy, Mounjaro, Zepbound, compounded semaglutide/tirzepatide).

CURRENT SYSTEM PROMPT:
---
${currentPrompt}
---

FEEDBACK SUMMARY (last 14 days):
- Total ratings: ${total}
- Positive (👍): ${positive}
- Negative (👎): ${negative}${approvalRate !== null ? `\n- Approval rate: ${approvalRate}%` : ''}

USER AND ADMIN COMMENTS (from negative feedback):
${comments}

EXAMPLES OF RESPONSES THAT RECEIVED NEGATIVE RATINGS:
${badMessageText}

EXAMPLES OF RESPONSES THAT RECEIVED POSITIVE RATINGS:
${goodMessageText}

INSTRUCTIONS:
Based on the feedback above, identify the specific weaknesses in the current prompt and generate an improved version that:
1. Directly addresses each pattern of negative feedback
2. Reinforces the qualities that earned positive ratings
3. Keeps Grace's warm, empathetic, GLP-1-focused persona intact
4. Is complete and self-contained (no references to this analysis)
5. Maintains all medical safety guardrails

Return ONLY the improved system prompt text. No explanations, no headers, no markdown — just the prompt itself.`;

    const response = await deps.llm.generate({
      messages: [{ role: 'user', content: metaPrompt }],
      temperature: 0.4,
      maxOutputTokens: 4096,
    });

    const improvedContent = response.text.trim();
    if (improvedContent.length < 50) throw new ValidationError('LLM returned an unusable response');

    // 6. Save as new inactive draft
    const { rows: newRows } = await deps.pool.query<{ id: string; version: number }>(
      `INSERT INTO prompts (version, content, active)
       SELECT COALESCE(MAX(version), 0) + 1, $1, FALSE
       FROM prompts
       RETURNING id, version`,
      [improvedContent],
    );

    return {
      ok: true,
      prompt: { ...newRows[0], content: improvedContent, active: false, created_at: new Date() },
      stats: { total, positive, negative, approvalRate },
    };
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
    age: z.number().int().min(13).max(120).nullable().optional(),
    protein_goal_grams: z.number().int().min(1).max(500).nullable().optional(),
    glp1_start_date: z.string().nullable().optional(),
    checkin_count_per_day: z.number().int().min(1).max(4).optional(),
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

  /** List today's food log entries for a user (admin view + debug tool). */
  app.get('/admin/users/:phone/food-logs', async (req) => {
    const { phone } = req.params as { phone: string };
    const dateParam = (req.query as Record<string, string>)['date']; // YYYY-MM-DD or omit for today
    const { rows } = await deps.pool.query(
      `WITH user_tz AS (
         SELECT COALESCE(NULLIF(timezone, ''), 'UTC') AS tz
         FROM users WHERE phone = $1
       )
       SELECT fl.id, fl.food, fl.protein_g, fl.calories, fl.confidence,
              fl.source, fl.raw_text, fl.created_at,
              (fl.created_at AT TIME ZONE user_tz.tz)::text AS created_at_local
       FROM food_logs fl, user_tz
       WHERE fl.user_id = $1
         AND CASE
           WHEN $2::date IS NOT NULL
             THEN (fl.created_at AT TIME ZONE user_tz.tz - INTERVAL '5 hours')::date = $2::date
           ELSE (fl.created_at AT TIME ZONE user_tz.tz - INTERVAL '5 hours')::date
                = (now() AT TIME ZONE user_tz.tz - INTERVAL '5 hours')::date
         END
       ORDER BY fl.created_at DESC`,
      [phone, dateParam ?? null],
    );
    const totalProtein = rows.reduce((s: number, r: { protein_g: number }) => s + (r.protein_g ?? 0), 0);
    const totalCalories = rows.reduce((s: number, r: { calories: number }) => s + (r.calories ?? 0), 0);
    return { items: rows, total_protein_g: Math.round(totalProtein), total_calories: Math.round(totalCalories) };
  });

  /** Delete a specific food log entry by ID. */
  app.delete('/admin/food-logs/:id', async (req) => {
    const { id } = req.params as { id: string };
    const { rowCount } = await deps.pool.query(`DELETE FROM food_logs WHERE id = $1`, [id]);
    if (!rowCount) throw new ValidationError('Food log entry not found');
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

  /** Manually trigger the RLHF prompt optimizer (normally runs at 4am UTC). */
  app.post('/admin/run-optimizer', async () => {
    if (!deps.promptOptimizer) return { ok: false, message: 'Prompt optimizer not available' };
    // Run in background so the HTTP response returns immediately
    void deps.promptOptimizer.run().catch(() => undefined);
    return { ok: true, message: 'Optimizer started — report will be sent to ADMIN_PHONE when complete' };
  });

  /**
   * Push the canonical GRACE_SYSTEM_PROMPT from packages/ai-core/src/prompts.ts
   * into the prompts table as a new active version. Use this after a prompt
   * rewrite in code that the optimizer hasn't picked up yet, or to bootstrap
   * a fresh DB. Hot-reloads the live AIService + MessageGenerator on success.
   */
  app.post('/admin/prompts/sync-from-code', async () => {
    const content = GRACE_SYSTEM_PROMPT;

    // Ensure all idempotent schema migrations are applied. Bundling them here
    // means a fresh deploy + one curl call brings the DB schema fully up to
    // date alongside the prompt sync — no separate psql step required.
    await deps.pool.query(`
      ALTER TABLE prompts
        ADD COLUMN IF NOT EXISTS notes TEXT,
        ADD COLUMN IF NOT EXISTS auto_generated BOOLEAN NOT NULL DEFAULT FALSE
    `);
    await deps.pool.query(`
      ALTER TABLE food_logs
        ADD COLUMN IF NOT EXISTS source TEXT,
        ADD COLUMN IF NOT EXISTS dedupe_key TEXT
    `);
    await deps.pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS food_logs_user_dedupe_idx
        ON food_logs (user_id, dedupe_key)
        WHERE dedupe_key IS NOT NULL
    `);
    await deps.pool.query(`
      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS sex TEXT,
        ADD COLUMN IF NOT EXISTS dietary_pattern TEXT
    `);
    await deps.pool.query(`
      CREATE TABLE IF NOT EXISTS user_profile_facts (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id TEXT NOT NULL,
        fact TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT 'other',
        confidence TEXT NOT NULL DEFAULT 'medium',
        source_message_id UUID,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await deps.pool.query(`
      CREATE INDEX IF NOT EXISTS user_profile_facts_user_idx
        ON user_profile_facts (user_id, created_at DESC)
    `);
    await deps.pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS user_profile_facts_dedupe_idx
        ON user_profile_facts (user_id, lower(fact))
    `);

    await deps.pool.query('BEGIN');
    let version: number;
    try {
      const { rows } = await deps.pool.query<{ max: number | null }>(
        `SELECT MAX(version) AS max FROM prompts`,
      );
      version = (rows[0]?.max ?? 0) + 1;
      await deps.pool.query(`UPDATE prompts SET active = FALSE WHERE active = TRUE`);
      await deps.pool.query(
        `INSERT INTO prompts (version, content, active, notes, auto_generated)
         VALUES ($1, $2, TRUE, $3, FALSE)`,
        [version, content, `Synced from code (GRACE_SYSTEM_PROMPT, ${content.length} chars)`],
      );
      await deps.pool.query('COMMIT');
    } catch (err) {
      await deps.pool.query('ROLLBACK');
      throw err;
    }
    if (deps.reloadActivePrompt) {
      await deps.reloadActivePrompt().catch(() => undefined);
    }
    return { ok: true, version, contentLength: content.length, message: 'Master prompt synced and activated. Hot-reloaded into AIService.' };
  });

  // ─── Content Rules CRUD ──────────────────────────────────────────────────────

  const ContentRuleCreateSchema = z.object({
    rule_type: z.enum(['banned_phrase', 'medication_safety', 'medical_authority', 'emotional_safety', 'privacy']),
    pattern: z.string().min(1).max(500),
    is_regex: z.boolean().default(true),
    flags: z.string().max(10).default('i'),
    reason: z.string().min(1).max(300),
    severity: z.enum(['log', 'regen', 'block']).default('regen'),
    applies_to: z.enum(['ai', 'scheduler', 'all']).default('all'),
  });

  const ContentRuleUpdateSchema = ContentRuleCreateSchema.partial().extend({
    is_active: z.boolean().optional(),
  });

  app.get('/admin/content-rules', async (req) => {
    const q = req.query as { type?: string; severity?: string; active?: string; limit?: string; offset?: string };
    const limit = Math.min(Number(q.limit ?? 100), 500);
    const offset = Number(q.offset ?? 0);
    const conditions = ['1=1'];
    const params: unknown[] = [];
    if (q.type) { params.push(q.type); conditions.push(`rule_type = $${params.length}`); }
    if (q.severity) { params.push(q.severity); conditions.push(`severity = $${params.length}`); }
    if (q.active !== undefined) { params.push(q.active !== 'false'); conditions.push(`is_active = $${params.length}`); }
    params.push(limit, offset);
    const where = conditions.join(' AND ');
    const [{ rows }, { rows: total }] = await Promise.all([
      deps.pool.query(
        `SELECT * FROM content_rules WHERE ${where} ORDER BY severity, rule_type, id LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      ),
      deps.pool.query(`SELECT count(*)::int AS n FROM content_rules WHERE ${where}`, params.slice(0, -2)),
    ]);
    return { rules: rows, total: total[0]?.n ?? 0, limit, offset };
  });

  app.post('/admin/content-rules', async (req) => {
    const body = ContentRuleCreateSchema.parse(req.body);
    // Validate regex before saving — don't let an invalid pattern reach the cache.
    if (body.is_regex) {
      try { new RegExp(body.pattern, body.flags); }
      catch { throw new ValidationError('pattern', 'Invalid regular expression'); }
    }
    const { rows } = await deps.pool.query(
      `INSERT INTO content_rules (rule_type, pattern, is_regex, flags, reason, severity, applies_to)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [body.rule_type, body.pattern, body.is_regex, body.flags, body.reason, body.severity, body.applies_to],
    );
    return { rule: rows[0] };
  });

  app.put('/admin/content-rules/:id', async (req) => {
    const { id } = req.params as { id: string };
    const body = ContentRuleUpdateSchema.parse(req.body);
    if (body.is_regex && body.pattern && body.flags) {
      try { new RegExp(body.pattern, body.flags); }
      catch { throw new ValidationError('pattern', 'Invalid regular expression'); }
    }
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(body)) {
      if (v !== undefined) { vals.push(v); sets.push(`${k} = $${vals.length}`); }
    }
    if (sets.length === 0) throw new ValidationError('body', 'No fields to update');
    vals.push(id);
    const { rows } = await deps.pool.query(
      `UPDATE content_rules SET ${sets.join(', ')} WHERE id = $${vals.length} RETURNING *`,
      vals,
    );
    if (rows.length === 0) throw new ValidationError('id', 'Rule not found');
    return { rule: rows[0] };
  });

  app.delete('/admin/content-rules/:id', async (req) => {
    const { id } = req.params as { id: string };
    const { rows } = await deps.pool.query(
      `UPDATE content_rules SET is_active = FALSE WHERE id = $1 RETURNING id`,
      [id],
    );
    if (rows.length === 0) throw new ValidationError('id', 'Rule not found');
    return { ok: true, id: rows[0].id, message: 'Rule deactivated (soft-delete)' };
  });

  // Test a piece of text against all active rules for a given channel.
  app.post('/admin/content-rules/test', async (req) => {
    const { text, target } = req.body as { text?: string; target?: string };
    if (!text) throw new ValidationError('text', 'text is required');
    const ch = (target === 'scheduler' ? 'scheduler' : 'ai') as 'ai' | 'scheduler';
    const { rows } = await deps.pool.query<{
      id: number; pattern: string; is_regex: boolean; flags: string; reason: string; severity: string;
    }>(
      `SELECT id, pattern, is_regex, flags, reason, severity
       FROM content_rules
       WHERE is_active = TRUE AND (applies_to = 'all' OR applies_to = $1)
       ORDER BY CASE severity WHEN 'block' THEN 0 WHEN 'regen' THEN 1 ELSE 2 END, id`,
      [ch],
    );
    const violations: Array<{ id: number; severity: string; reason: string; match: string }> = [];
    for (const rule of rows) {
      try {
        const re = rule.is_regex ? new RegExp(rule.pattern, rule.flags) : new RegExp(rule.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), rule.flags);
        const m = re.exec(text);
        if (m) violations.push({ id: rule.id, severity: rule.severity, reason: rule.reason, match: m[0] });
      } catch { /* skip invalid */ }
    }
    return { text, target: ch, violations, clean: violations.length === 0 };
  });

  // ─── Business metrics ────────────────────────────────────────────────────────

  app.get('/admin/business', async () => {
    const STANDARD_PRICE = 9.99;
    const PRO_PRICE = 24.99;

    const [usersRow, weeklyRow, activeRow, retentionRow] = await Promise.all([
      deps.pool.query<{ total: string; paid: string; pro: string; trial_active: string; trial_converted: string }>(`
        SELECT
          COUNT(*)::text AS total,
          SUM(CASE WHEN is_paid AND NOT is_pro THEN 1 ELSE 0 END)::text AS paid,
          SUM(CASE WHEN is_pro THEN 1 ELSE 0 END)::text AS pro,
          SUM(CASE WHEN trial_start IS NOT NULL AND NOT is_paid AND NOT is_pro
                     AND trial_start > NOW() - INTERVAL '3 days' THEN 1 ELSE 0 END)::text AS trial_active,
          SUM(CASE WHEN trial_start IS NOT NULL AND (is_paid OR is_pro) THEN 1 ELSE 0 END)::text AS trial_converted
        FROM users
      `),
      deps.pool.query<{ week: string; count: string }>(`
        SELECT DATE_TRUNC('week', trial_start)::date::text AS week, COUNT(*)::text AS count
        FROM users
        WHERE trial_start > NOW() - INTERVAL '8 weeks'
        GROUP BY 1 ORDER BY 1
      `),
      deps.pool.query<{ active_7d: string; active_30d: string }>(`
        SELECT
          SUM(CASE WHEN last_reply_at > NOW() - INTERVAL '7 days' THEN 1 ELSE 0 END)::text AS active_7d,
          SUM(CASE WHEN last_reply_at > NOW() - INTERVAL '30 days' THEN 1 ELSE 0 END)::text AS active_30d
        FROM users WHERE is_paid OR is_pro
      `),
      deps.pool.query<{ cohort: string; signed_up: string; retained: string }>(`
        SELECT cohort, COUNT(*) AS signed_up,
               SUM(CASE WHEN last_reply_at > trial_start + (cohort_days || ' days')::interval THEN 1 ELSE 0 END) AS retained
        FROM (
          SELECT trial_start, last_reply_at,
                 unnest(ARRAY[1,3,7,30]) AS cohort_days,
                 unnest(ARRAY['D1','D3','D7','D30']) AS cohort
          FROM users WHERE trial_start IS NOT NULL
        ) t
        WHERE trial_start < NOW() - (cohort_days || ' days')::interval
        GROUP BY cohort, cohort_days ORDER BY cohort_days
      `),
    ]);

    const u = usersRow.rows[0]!;
    const totalPaid = parseInt(u.paid, 10) + parseInt(u.pro, 10);
    const trialConverted = parseInt(u.trial_converted, 10);
    const trialTotal = trialConverted + parseInt(u.trial_active, 10) +
      (totalPaid - trialConverted > 0 ? totalPaid - trialConverted : 0);

    return {
      totals: {
        users: parseInt(u.total, 10),
        paid: parseInt(u.paid, 10),
        pro: parseInt(u.pro, 10),
        trial_active: parseInt(u.trial_active, 10),
        mrr: parseFloat(((parseInt(u.paid, 10) * STANDARD_PRICE) + (parseInt(u.pro, 10) * PRO_PRICE)).toFixed(2)),
        conversion_pct: trialTotal > 0 ? Math.round((trialConverted / trialTotal) * 100) : 0,
      },
      active: {
        active_7d: parseInt(activeRow.rows[0]?.active_7d ?? '0', 10),
        active_30d: parseInt(activeRow.rows[0]?.active_30d ?? '0', 10),
      },
      weekly_signups: weeklyRow.rows.map((r) => ({ week: r.week, count: parseInt(r.count, 10) })),
      retention: retentionRow.rows.map((r) => ({
        cohort: r.cohort,
        signed_up: parseInt(String(r.signed_up), 10),
        retained: parseInt(String(r.retained), 10),
        pct: parseInt(String(r.signed_up), 10) > 0
          ? Math.round((parseInt(String(r.retained), 10) / parseInt(String(r.signed_up), 10)) * 100)
          : 0,
      })),
    };
  });

  // ─── Scheduler status ────────────────────────────────────────────────────────

  app.get('/admin/scheduler-status', async () => {
    const { rows } = await deps.pool.query<{
      phone: string; first_name: string | null; timezone: string | null;
      wake_time: number | null; sleep_time: number | null;
      injection_day: string | null; injection_flow_stage: string | null;
      last_morning_sent_at: string | null; last_midday_sent_at: string | null;
      last_evening_sent_at: string | null; last_reply_at: string | null;
      is_paid: boolean; is_pro: boolean; trial_start: string | null;
      checkin_count_per_day: number | null; side_effect_flow: string | null;
    }>(`
      SELECT phone, first_name, timezone, wake_time, sleep_time,
             injection_day, injection_flow_stage,
             last_morning_sent_at, last_midday_sent_at, last_evening_sent_at,
             last_reply_at, is_paid, is_pro, trial_start,
             checkin_count_per_day, side_effect_flow
      FROM users
      ORDER BY last_reply_at DESC NULLS LAST
      LIMIT 200
    `);
    return { users: rows };
  });

  // ─── AI quality metrics ──────────────────────────────────────────────────────

  app.get('/admin/ai-quality', async () => {
    const FALLBACK_SNIPPETS = ['Not sure I got all of that', 'I missed something there', "didn't quite follow", 'make sure I get this right', 'missed part of what you meant'];
    const fallbackConditions = FALLBACK_SNIPPETS.map((_, i) => `content ILIKE $${i + 1}`).join(' OR ');

    const safeQuery = async <T extends Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> => {
      try {
        const r = params
          ? await deps.pool.query<T>(sql, params)
          : await deps.pool.query<T>(sql);
        return r.rows;
      } catch (err) {
        app.log.warn({ err, sql: sql.slice(0, 80) }, 'ai-quality query failed, returning empty');
        return [];
      }
    };

    const [toolRows, fallbackTrendRows, satisfactionTrendRows, latencyRows, promptRows] = await Promise.all([
      safeQuery<{ tool_name: string; calls: string; successes: string; avg_latency: string }>(`
        SELECT tool_name,
               COUNT(*)::text AS calls,
               SUM(CASE WHEN ok THEN 1 ELSE 0 END)::text AS successes,
               ROUND(AVG(latency_ms))::text AS avg_latency
        FROM tool_logs
        WHERE created_at > NOW() - INTERVAL '30 days'
        GROUP BY tool_name ORDER BY COUNT(*) DESC
      `),
      safeQuery<{ day: string; count: string }>(`
        SELECT DATE_TRUNC('day', created_at)::date::text AS day, COUNT(*)::text AS count
        FROM messages
        WHERE role = 'assistant' AND (${fallbackConditions})
          AND created_at > NOW() - INTERVAL '30 days'
        GROUP BY 1 ORDER BY 1
      `, FALLBACK_SNIPPETS.map((s) => `%${s}%`)),
      safeQuery<{ day: string; positive: string; negative: string }>(`
        SELECT DATE_TRUNC('day', created_at)::date::text AS day,
               SUM(CASE WHEN rating = 1 THEN 1 ELSE 0 END)::text AS positive,
               SUM(CASE WHEN rating = -1 THEN 1 ELSE 0 END)::text AS negative
        FROM feedback
        WHERE created_at > NOW() - INTERVAL '30 days'
        GROUP BY 1 ORDER BY 1
      `),
      safeQuery<{ day: string; avg_ms: string }>(`
        SELECT DATE_TRUNC('day', created_at)::date::text AS day,
               ROUND(AVG(latency_ms))::text AS avg_ms
        FROM tool_logs
        WHERE created_at > NOW() - INTERVAL '30 days'
        GROUP BY 1 ORDER BY 1
      `),
      // Try with optimizer columns first; fall back to base columns if migration not applied
      (async () => {
        const withOptimizer = await safeQuery<{ version: number; active: boolean; created_at: string; notes: string | null; auto_generated: boolean | null }>(`
          SELECT version, active, created_at, notes, auto_generated
          FROM prompts ORDER BY version DESC LIMIT 20
        `);
        if (withOptimizer.length > 0) return withOptimizer;
        return safeQuery<{ version: number; active: boolean; created_at: string; notes: string | null; auto_generated: boolean | null }>(`
          SELECT version, active, created_at, NULL::text AS notes, NULL::boolean AS auto_generated
          FROM prompts ORDER BY version DESC LIMIT 20
        `);
      })(),
    ]);

    return {
      tools: toolRows.map((r) => ({
        name: r.tool_name,
        calls: parseInt(r.calls, 10),
        successes: parseInt(r.successes, 10),
        success_rate: parseInt(r.calls, 10) > 0 ? Math.round((parseInt(r.successes, 10) / parseInt(r.calls, 10)) * 100) : 0,
        avg_latency_ms: parseInt(r.avg_latency, 10),
      })),
      fallback_trend: fallbackTrendRows.map((r) => ({ day: r.day, count: parseInt(r.count, 10) })),
      satisfaction_trend: satisfactionTrendRows.map((r) => ({
        day: r.day,
        positive: parseInt(r.positive, 10),
        negative: parseInt(r.negative, 10),
        total: parseInt(r.positive, 10) + parseInt(r.negative, 10),
        pct: (parseInt(r.positive, 10) + parseInt(r.negative, 10)) > 0
          ? Math.round((parseInt(r.positive, 10) / (parseInt(r.positive, 10) + parseInt(r.negative, 10))) * 100)
          : null,
      })),
      latency_trend: latencyRows.map((r) => ({ day: r.day, avg_ms: parseInt(r.avg_ms, 10) })),
      prompts: promptRows,
    };
  });

  // ─── System health ───────────────────────────────────────────────────────────

  app.get('/admin/system-health', async () => {
    const safeRows = async <T extends Record<string, unknown>>(sql: string): Promise<T[]> => {
      try {
        const r = await deps.pool.query<T>(sql);
        return r.rows;
      } catch (err) {
        app.log.warn({ err, sql: sql.slice(0, 80) }, 'system-health query failed, returning empty');
        return [];
      }
    };

    const [dbStatus, messageVolumeRows, fallbackRows, toolHealthRows] = await Promise.all([
      deps.pool.query('SELECT TRUE AS db_ok').then(
        () => ({ ok: true }),
        () => ({ ok: false }),
      ),
      safeRows<{ hour: string; count: string }>(`
        SELECT DATE_TRUNC('hour', created_at)::text AS hour, COUNT(*)::text AS count
        FROM messages
        WHERE created_at > NOW() - INTERVAL '24 hours'
        GROUP BY 1 ORDER BY 1
      `),
      safeRows<{ count: string }>(`
        SELECT COUNT(*)::text AS count FROM messages
        WHERE role = 'assistant' AND created_at > NOW() - INTERVAL '24 hours'
          AND (content ILIKE '%Not sure I got all of that%'
            OR content ILIKE '%I missed something there%'
            OR content ILIKE '%didn''t quite follow%'
            OR content ILIKE '%make sure I get this right%'
            OR content ILIKE '%missed part of what you meant%')
      `),
      safeRows<{ total: string; failed: string; avg_ms: string }>(`
        SELECT COUNT(*)::text AS total,
               SUM(CASE WHEN NOT ok THEN 1 ELSE 0 END)::text AS failed,
               ROUND(AVG(latency_ms))::text AS avg_ms
        FROM tool_logs WHERE created_at > NOW() - INTERVAL '24 hours'
      `),
    ]);

    let redisOk = false;
    let redisLatencyMs: number | null = null;
    try {
      if (deps.redis) {
        const t0 = Date.now();
        await (deps.redis as { ping: () => Promise<unknown> }).ping();
        redisLatencyMs = Date.now() - t0;
        redisOk = true;
      }
    } catch { /* redis down */ }

    const toolH = toolHealthRows[0];
    const totalMessages24h = messageVolumeRows.reduce((s, r) => s + parseInt(r.count, 10), 0);
    const fallbackCount = parseInt(fallbackRows[0]?.count ?? '0', 10);

    return {
      db: { ok: dbStatus.ok },
      redis: { ok: redisOk, latency_ms: redisLatencyMs },
      messages_24h: totalMessages24h,
      fallbacks_24h: fallbackCount,
      fallback_rate_24h: totalMessages24h > 0
        ? Math.round((fallbackCount / totalMessages24h) * 100)
        : 0,
      tool_calls_24h: parseInt(toolH?.total ?? '0', 10),
      tool_failures_24h: parseInt(toolH?.failed ?? '0', 10),
      tool_avg_latency_ms: toolH?.avg_ms ? parseInt(toolH.avg_ms, 10) : null,
      message_volume: messageVolumeRows.map((r) => ({ hour: r.hour, count: parseInt(r.count, 10) })),
    };
  });

  // ─── Subscription message templates ────────────────────────────────────────
  // GET / PUT for the four editable subscription messages (paywall, trial
  // reminder, welcome, upgrade_nudge). Variable substitution is literal
  // {name} replacement; declared variables shown in the response so the
  // admin UI can render hint chips.

  app.get('/admin/message-templates', async () => {
    if (!deps.templates) return { templates: [] };
    const templates = await deps.templates.list();
    return { templates };
  });

  const TemplateUpdateSchema = z.object({
    template: z.string().min(1).max(2000),
  });

  app.put('/admin/message-templates/:key', async (req) => {
    if (!deps.templates) throw new ValidationError('templates service not configured');
    const { key } = req.params as { key: string };
    const parsed = TemplateUpdateSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => i.message).join('; '));

    // Sanity: reject hardcoded role-marker leaks / blank-only updates. The
    // outbound sanitizer would catch these at send time, but failing fast
    // here gives the admin clear feedback at edit time.
    const t = parsed.data.template.trim();
    if (t.length === 0) throw new ValidationError('template cannot be empty');
    if (/^(system|assistant|user|human|model)\s*:/i.test(t)) {
      throw new ValidationError('template cannot start with a role marker');
    }

    await deps.templates.update(key, t);
    const updated = await deps.templates.get(key);
    return { ok: true, template: updated };
  });

  // Render a template with the supplied variables — admin UI uses this to
  // preview the message exactly as the user would see it.
  app.post('/admin/message-templates/:key/preview', async (req) => {
    if (!deps.templates) throw new ValidationError('templates service not configured');
    const { key } = req.params as { key: string };
    const vars = (req.body as { variables?: Record<string, string> })?.variables ?? {};
    const tpl = await deps.templates.get(key);
    if (!tpl) throw new ValidationError(`template "${key}" not found`);
    const rendered = await deps.templates.render(key, vars, tpl.template);
    return { rendered };
  });
}
