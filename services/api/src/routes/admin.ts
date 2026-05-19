import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { GRACE_SYSTEM_PROMPT } from '@grace/ai-core';
import { UnauthorizedError, ValidationError } from '../errors.js';
import type { Cache } from '../cache/cache.js';
import type { LLMProvider } from '@grace/shared';
import type { PromptOptimizer } from '../scheduler/prompt-optimizer.js';

export interface AdminDeps {
  pool: Pool;
  cache?: Cache;
  adminToken?: string;
  llm?: LLMProvider;
  promptOptimizer?: PromptOptimizer;
  /** Hot-reload callback wired in server.ts — pushes the active prompt to AIService and MessageGenerator. */
  reloadActivePrompt?: () => Promise<void>;
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
}
