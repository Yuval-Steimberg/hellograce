import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { GRACE_SYSTEM_PROMPT } from '@grace/ai-core';
import { UnauthorizedError, ValidationError } from '../errors.js';
import { encryptField, decryptField } from '../crypto/field-encrypt.js';
import { getBillingSnapshot, cancelSubscriptionAtPeriodEnd, isStripeEnabled, ensureStripeCustomer } from '../services/stripe.service.js';
import type { Cache } from '../cache/cache.js';
import type { LLMProvider } from '@grace/shared';
import type { PromptOptimizer } from '../scheduler/prompt-optimizer.js';
import type { MessageTemplatesService } from '../services/message-templates.service.js';
import type { BanditService } from '../services/bandit.service.js';

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
  /** Phase 5: contextual bandit state read-only endpoint. */
  bandit?: BanditService;
  /** 2026-05-30: FAQ semantic cache for latency telemetry. */
  faqCache?: import('../cache/faq-semantic-cache.js').FaqSemanticCache;
  /** UserService — used by PUT /admin/users/:phone to invalidate the
   *  in-memory user cache after a write. Without this, the next handleMessage
   *  call reads stale data (60s TTL) and a freshly-set dietary_pattern doesn't
   *  apply until cache expiry. Production bug 2026-06-03: vegetarian user got
   *  chicken/fish recommendations even after dietary_pattern was set. */
  users?: import('../user/user.service.js').UserService;
  /** Phase D — memory.md pilot enrollment management. Optional. */
  memoryMd?: import('../memory/memory-md.service.js').MemoryMdService;
}

async function auditLog(pool: Pool, action: string, ip: string, details?: Record<string, unknown>): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO audit_logs (action, admin_ip, details) VALUES ($1, $2, $3)`,
      [action, ip, details ? JSON.stringify(details) : '{}'],
    );
  } catch {
    // audit_logs table may not exist yet — silently skip
  }
}

export function registerAdminRoutes(app: FastifyInstance, deps: AdminDeps): void {
  app.addHook('preHandler', async (req) => {
    if (!req.url.startsWith('/admin/')) return;
    if (req.method === 'OPTIONS') return;
    const auth = req.headers.authorization;
    const expected = deps.adminToken;
    if (!expected) return;
    if (auth === `Bearer ${expected}`) return;
    // Query param token only for SSE endpoints (EventSource can't set headers)
    if (req.url.startsWith('/admin/auto-eval/progress')) {
      const queryToken = (req.query as Record<string, string>)?.token;
      if (queryToken === expected) return;
    }
    throw new UnauthorizedError('Admin token required');
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
      faq_cache: deps.faqCache ? deps.faqCache.stats() : null,
      user_stats: userStatsRows[0] ?? { total: 0, paid: 0, pro: 0, trial: 0, paused: 0, new_this_week: 0 },
    };
  });

  // ─── Latency telemetry ──────────────────────────────────────────────────────
  //
  // Returns P50 / P95 / P99 response latency, overall and grouped by intent,
  // over a configurable window. Backed by messages.latency_ms (populated
  // since migration 20260603000001). Per-stage breakdown comes from
  // messages.stage_timings JSONB so we can see exactly which step in the
  // pipeline is hot — no re-instrumentation needed when investigating a
  // slow-request alert.
  app.get('/admin/latency', async (req) => {
    const q = req.query as { window?: string };
    const windowMap: Record<string, string> = {
      '5m': "interval '5 minutes'",
      '10m': "interval '10 minutes'",
      '15m': "interval '15 minutes'",
      '30m': "interval '30 minutes'",
      '1h': "interval '1 hour'",
      '3h': "interval '3 hours'",
      '6h': "interval '6 hours'",
      '12h': "interval '12 hours'",
      '24h': "interval '24 hours'",
      '7d': "interval '7 days'",
      '30d': "interval '30 days'",
    };
    const win = windowMap[q.window ?? '24h'] ?? windowMap['24h']!;

    const [{ rows: overall }, { rows: byIntent }, { rows: byStage }, { rows: slowSamples }] =
      await Promise.all([
        deps.pool.query<{
          n: string; p50: string; p95: string; p99: string; max: string; avg: string;
        }>(
          `SELECT count(*)::text AS n,
                  percentile_cont(0.50) WITHIN GROUP (ORDER BY latency_ms)::int::text AS p50,
                  percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms)::int::text AS p95,
                  percentile_cont(0.99) WITHIN GROUP (ORDER BY latency_ms)::int::text AS p99,
                  max(latency_ms)::text AS max,
                  avg(latency_ms)::int::text AS avg
           FROM messages
           WHERE role = 'assistant'
             AND latency_ms IS NOT NULL
             AND created_at > now() - ${win}`,
        ),
        deps.pool.query<{
          intent: string; n: string; p50: string; p95: string; p99: string; avg: string;
        }>(
          `SELECT COALESCE(intent, 'unknown') AS intent,
                  count(*)::text AS n,
                  percentile_cont(0.50) WITHIN GROUP (ORDER BY latency_ms)::int::text AS p50,
                  percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms)::int::text AS p95,
                  percentile_cont(0.99) WITHIN GROUP (ORDER BY latency_ms)::int::text AS p99,
                  avg(latency_ms)::int::text AS avg
           FROM messages
           WHERE role = 'assistant'
             AND latency_ms IS NOT NULL
             AND created_at > now() - ${win}
           GROUP BY intent
           ORDER BY count(*) DESC
           LIMIT 50`,
        ),
        // Per-stage breakdown — averages the JSONB stage_timings keys across
        // all messages in the window. Top 12 stages by total time.
        deps.pool.query<{ stage: string; avg_ms: string; p95_ms: string; n: string }>(
          `SELECT key AS stage,
                  avg((value)::int)::int::text AS avg_ms,
                  percentile_cont(0.95) WITHIN GROUP (ORDER BY (value)::int)::int::text AS p95_ms,
                  count(*)::text AS n
           FROM messages, jsonb_each_text(stage_timings)
           WHERE role = 'assistant'
             AND stage_timings IS NOT NULL
             AND created_at > now() - ${win}
           GROUP BY key
           ORDER BY avg((value)::int) DESC
           LIMIT 12`,
        ),
        // Top 10 slow-request samples — show what's hitting the tail.
        deps.pool.query<{
          intent: string; latency_ms: number; created_at: Date; stage_timings: unknown; content: string;
        }>(
          `SELECT COALESCE(intent, 'unknown') AS intent,
                  latency_ms,
                  created_at,
                  stage_timings,
                  left(content, 120) AS content
           FROM messages
           WHERE role = 'assistant'
             AND latency_ms IS NOT NULL
             AND created_at > now() - ${win}
           ORDER BY latency_ms DESC
           LIMIT 10`,
        ),
      ]);

    return {
      window: q.window ?? '24h',
      overall: overall[0] ?? null,
      by_intent: byIntent,
      by_stage: byStage,
      slow_samples: slowSamples,
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
    void auditLog(deps.pool, 'admin.prompt_activate', req.ip, { promptId: id });
    const query = req.query as { run_eval?: string };
    const runEval = query.run_eval === '1' || query.run_eval === 'true';

    // Eval gate: only runs when explicitly requested via ?run_eval=1
    if (runEval && process.env.GEMINI_API_KEY && deps.llm) {
      try {
        const gatePath = new URL('../../auto-eval/feedback-loop.js', import.meta.url).href;
        const mod = await import(gatePath).catch(() => null) as {
          evalGateCheck: (llm: unknown, prompt: string, baseline: number, logger: unknown) => Promise<{ passed: boolean; score: number; details: string }>;
        } | null;
        if (mod) {
          const pino = await import('pino');
          const gateLogger = pino.default({ level: 'warn' });
          const baseline = Number(process.env.EVAL_GATE_BASELINE ?? '2.5');
          const result = await mod.evalGateCheck(deps.llm, '', baseline, gateLogger);
          if (!result.passed) {
            return {
              ok: false,
              error: 'EVAL_GATE_FAILED',
              message: `Prompt activation blocked by eval gate. ${result.details}`,
              score: result.score,
              baseline,
            };
          }
        }
      } catch {
        // Eval gate failure shouldn't block activation — log and continue
      }
    }

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
    // Decrypt encrypted-at-rest fields so the admin sees plaintext, not `enc:...`.
    const decrypted = rows.map((r) => ({
      ...r,
      ...(r.first_name ? { first_name: decryptField(r.first_name) } : {}),
      ...(r.medication ? { medication: decryptField(r.medication) } : {}),
    }));
    return { users: decrypted, total: Number(countRows[0]?.total ?? 0) };
  });

  /** Full user detail with check-in and weight history. */
  app.get('/admin/users/:phone', async (req) => {
    const { phone } = req.params as { phone: string };
    void auditLog(deps.pool, 'admin.view_user', req.ip);
    const { rows: userRows } = await deps.pool.query(
      `SELECT phone, first_name, medication, medication_frequency, injection_day,
              goals, food_dislikes, timezone, wake_time, sleep_time,
              current_weight, goal_weight, height_cm, age, sex, activity_level,
              primary_goal, protein_goal_grams, glp1_start_date, dose_mg,
              dietary_restriction, biggest_challenge, why_started, support_style,
              exercise_habits, medication_time, sms_consent,
              active, paused, blocked, is_paid, is_pro, rlhf_enabled,
              trial_start, created_at, updated_at, last_reply_at,
              checkin_count_per_day, grace_notes
       FROM users WHERE phone = $1 LIMIT 1`,
      [phone],
    );
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
    // Decrypt encrypted-at-rest fields so the admin sees plaintext in the
    // inputs (otherwise first_name and medication show as `enc:...` ciphertext).
    const decryptedUser = {
      ...userRows[0],
      ...(userRows[0].first_name ? { first_name: decryptField(userRows[0].first_name) } : {}),
      ...(userRows[0].medication ? { medication: decryptField(userRows[0].medication) } : {}),
    };
    return {
      user: decryptedUser,
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
    calorie_goal_kcal: z.number().int().min(800).max(5000).nullable().optional(),
    glp1_start_date: z.string().nullable().optional(),
    checkin_count_per_day: z.number().int().min(1).max(4).optional(),
    // Dietary fields — required for admin to set vegetarian/vegan/pescatarian
    // when a user hasn't told Grace directly. Without these, PUT silently
    // strips the field (Zod default) and returns null. Production failure
    // 2026-06-03: vegetarian user kept getting chicken/fish recommendations
    // because their dietary_pattern stayed null after multiple PUT attempts.
    dietary_pattern: z.enum(['vegan', 'vegetarian', 'pescatarian']).nullable().optional(),
    dietary_restriction: z.string().max(120).nullable().optional(),
    primary_goal: z.string().max(120).nullable().optional(),
    activity_level: z.string().max(40).nullable().optional(),
    height_cm: z.number().int().min(80).max(250).nullable().optional(),
    sex: z.enum(['male', 'female', 'other']).nullable().optional(),
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
    // Re-encrypt fields that are stored encrypted at rest. Without this, the
    // admin save would write plaintext to columns that ai.service.ts expects
    // to decrypt, corrupting the row (subsequent reads decrypt a non-cipher).
    if (typeof fields.first_name === 'string' && fields.first_name.length > 0) {
      fields.first_name = encryptField(fields.first_name);
    }
    if (typeof fields.medication === 'string' && fields.medication.length > 0) {
      fields.medication = encryptField(fields.medication);
    }
    const keys = Object.keys(fields);
    if (keys.length === 0) return { ok: true };
    // Prefer UserService.update so the in-memory user cache is invalidated
    // immediately — without this, the very next handleMessage call reads the
    // pre-update user (60s cache TTL) and any freshly-set field like
    // dietary_pattern silently fails to apply for up to a minute. Production
    // bug 2026-06-03: vegetarian user got chicken/fish recommendations even
    // after dietary_pattern was set, because the user-fetch hit cache before
    // the next minute rolled over.
    if (deps.users) {
      await deps.users.update(phone, fields as Parameters<typeof deps.users.update>[1]);
    } else {
      const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
      const { rowCount } = await deps.pool.query(
        `UPDATE users SET ${sets}, updated_at = now() WHERE phone = $1`,
        [phone, ...keys.map((k) => fields[k])],
      );
      if (!rowCount) throw new ValidationError('User not found');
    }
    // Return the updated row so caller can verify the write landed.
    // Production failure 2026-06-03: admin couldn't tell if the dietary
    // PUT had any effect because the response was just { ok: true }.
    const { rows: refreshed } = await deps.pool.query(
      `SELECT phone, first_name, dietary_pattern, dietary_restriction,
              primary_goal, protein_goal_grams, calorie_goal_kcal,
              activity_level, height_cm, sex
         FROM users WHERE phone = $1`,
      [phone],
    );
    return { ok: true, user: refreshed[0] ?? null };
  });

  // ─── Stripe billing (admin) ──────────────────────────────────────────────────

  /** Live Stripe billing snapshot for a user — subscription status, plan,
   *  next billing, payment method on file. */
  app.get('/admin/users/:phone/stripe', async (req, reply) => {
    if (!isStripeEnabled()) {
      reply.code(503);
      return { error: 'Stripe not configured' };
    }
    const { phone } = req.params as { phone: string };
    try {
      const snapshot = await getBillingSnapshot(deps.pool, phone);
      if (!snapshot) {
        reply.code(404);
        return { error: 'User not found' };
      }
      return snapshot;
    } catch (err) {
      // Include the FULL error (stack + Stripe error fields) in the log so
      // we can root-cause. The user-facing message stays short.
      req.log.error({
        err: err instanceof Error ? { message: err.message, stack: err.stack, name: err.name } : err,
        stripeCode: (err as { code?: string })?.code,
        stripeType: (err as { type?: string })?.type,
        phone,
      }, 'admin.stripe_info_failed');
      reply.code(500);
      return { error: `Stripe lookup failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  });

  /** Backfill Stripe customers for all existing users who don't have one yet.
   *  Runs idempotently — users that already exist in Stripe are skipped via
   *  the search step inside ensureStripeCustomer. Use after deploying the
   *  signup-time Stripe sync to bring trial users that pre-date this change
   *  into the Stripe dashboard. */
  app.post('/admin/stripe/backfill-customers', async (req, reply) => {
    if (!isStripeEnabled()) {
      reply.code(503);
      return { error: 'Stripe not configured' };
    }
    const { rows } = await deps.pool.query<{ id: string; phone: string; first_name: string | null; medication: string | null }>(
      `SELECT id, phone, first_name, medication FROM users
       WHERE phone IS NOT NULL AND phone <> ''
       ORDER BY created_at DESC
       LIMIT 1000`,
    );
    let ensured = 0;
    let failed = 0;
    for (const u of rows) {
      try {
        await ensureStripeCustomer({
          graceUserId: u.id,
          phone: u.phone,
          firstName: u.first_name ? decryptField(u.first_name) : undefined,
          medication: u.medication ? decryptField(u.medication) : undefined,
        });
        ensured++;
      } catch (err) {
        req.log.warn({ err: (err as Error).message, phone: u.phone }, 'admin.stripe_backfill.user_failed');
        failed++;
      }
    }
    void auditLog(deps.pool, 'admin.stripe_backfill', req.ip);
    return { ok: true, total: rows.length, ensured, failed };
  });

  /** Cancel the user's active Stripe subscription at period end. Idempotent. */
  app.post('/admin/users/:phone/cancel-subscription', async (req, reply) => {
    if (!isStripeEnabled()) {
      reply.code(503);
      return { error: 'Stripe not configured' };
    }
    const { phone } = req.params as { phone: string };
    try {
      const result = await cancelSubscriptionAtPeriodEnd(deps.pool, phone);
      if (!result) {
        reply.code(404);
        return { error: 'No active subscription to cancel' };
      }
      void auditLog(deps.pool, 'admin.stripe_cancel_subscription', req.ip);
      return { ok: true, ...result };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      req.log.error({ err: msg, phone }, 'admin.stripe_cancel_failed');
      reply.code(500);
      return { error: `Cancel failed: ${msg}` };
    }
  });

  /** Permanently delete a user and all their data. */
  app.delete('/admin/users/:phone', async (req) => {
    const { phone } = req.params as { phone: string };
    await deps.pool.query('DELETE FROM user_memories WHERE user_id = $1', [phone]).catch(() => null);
    await deps.pool.query('DELETE FROM user_profile_facts WHERE user_id = $1', [phone]).catch(() => null);
    await deps.pool.query('DELETE FROM tool_logs WHERE user_id = $1', [phone]).catch(() => null);
    await deps.pool.query('DELETE FROM injections WHERE user_id = $1', [phone]).catch(() => null);
    await deps.pool.query('DELETE FROM check_ins WHERE phone = $1', [phone]).catch(() => null);
    await deps.pool.query('DELETE FROM feedback WHERE user_id = $1', [phone]).catch(() => null);
    await deps.pool.query('DELETE FROM messages WHERE user_id = $1', [phone]).catch(() => null);
    await deps.pool.query('DELETE FROM conversations WHERE user_id = $1', [phone]).catch(() => null);
    await deps.pool.query('DELETE FROM embeddings WHERE user_id = $1', [phone]).catch(() => null);
    await deps.pool.query('DELETE FROM food_logs WHERE user_id = $1', [phone]).catch(() => null);
    await deps.pool.query('DELETE FROM weight_logs WHERE user_id = $1', [phone]).catch(() => null);
    await deps.pool.query('DELETE FROM users WHERE phone = $1', [phone]).catch(() => null);
    void auditLog(deps.pool, 'admin.user_deleted', req.ip);
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
             THEN (fl.created_at AT TIME ZONE user_tz.tz)::date = $2::date
           ELSE (fl.created_at AT TIME ZONE user_tz.tz)::date
                = (now() AT TIME ZONE user_tz.tz)::date
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
  // ─── memory.md pilot (Phase D, 2026-06-07) ────────────────────────────
  // Enroll / unenroll / read for the memory.md narrative memory pilot.
  // Presence of a row in user_memory_md enables the layer for that user;
  // these endpoints manage that gate.

  app.post('/admin/users/:phone/memory-md/enroll', async (req, reply) => {
    if (!deps.memoryMd) {
      reply.status(503).send({ error: 'MEMORY_MD_DISABLED' });
      return;
    }
    const { phone } = req.params as { phone: string };
    const body = (req.body as { initial_content?: string } | null) ?? {};
    await deps.memoryMd.enroll(phone, body.initial_content ?? '');
    await auditLog(deps.pool, 'memory_md.enroll', req.ip ?? '', { phone });
    return { ok: true, phone, enrolled: true };
  });

  app.post('/admin/users/:phone/memory-md/unenroll', async (req, reply) => {
    if (!deps.memoryMd) {
      reply.status(503).send({ error: 'MEMORY_MD_DISABLED' });
      return;
    }
    const { phone } = req.params as { phone: string };
    await deps.memoryMd.unenroll(phone);
    await auditLog(deps.pool, 'memory_md.unenroll', req.ip ?? '', { phone });
    return { ok: true, phone, enrolled: false };
  });

  app.get('/admin/users/:phone/memory-md', async (req, reply) => {
    if (!deps.memoryMd) {
      reply.status(503).send({ error: 'MEMORY_MD_DISABLED' });
      return;
    }
    const { phone } = req.params as { phone: string };
    const content = await deps.memoryMd.get(phone);
    if (content === null) {
      return { phone, enrolled: false, content: null };
    }
    // Also surface the row metadata (chars + rewrite_count) for QA.
    const { rows } = await deps.pool.query<{
      content_chars: number;
      rewrite_count: number;
      updated_at: string;
    }>(
      `SELECT content_chars, rewrite_count, updated_at::text
       FROM user_memory_md WHERE user_id = $1 LIMIT 1`,
      [phone],
    );
    return {
      phone,
      enrolled: true,
      content,
      metadata: rows[0] ?? null,
    };
  });

  app.post('/admin/users/:phone/reset-memory', async (req) => {
    const { phone } = req.params as { phone: string };
    // Best-effort deletes for tables that may not exist yet (pilot/optional
    // migrations) — kept OUTSIDE the transaction so a missing table can't
    // abort the core wipe.
    await deps.pool.query('DELETE FROM user_memories WHERE user_id = $1', [phone]).catch(() => null);
    await deps.pool.query('DELETE FROM user_profile_facts WHERE user_id = $1', [phone]).catch(() => null);
    await deps.pool.query('DELETE FROM user_memory_md WHERE user_id = $1', [phone]).catch(() => null);
    // Core wipe is atomic — a mid-sequence failure must not leave messages
    // deleted but embeddings (or the conversation row) intact.
    const client = await deps.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM messages WHERE user_id = $1', [phone]);
      await client.query('DELETE FROM conversations WHERE user_id = $1', [phone]);
      await client.query('DELETE FROM embeddings WHERE user_id = $1', [phone]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
    // Drop the in-process memory.md cache (5-min TTL) so this machine doesn't
    // keep serving the deleted narrative until expiry.
    deps.memoryMd?.invalidate(phone);
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

  /** Manually trigger the RLHF prompt optimizer (normally runs at 05:30 UTC daily). */
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

  // Generate content rules from auto-eval pattern analysis
  app.post('/admin/content-rules/auto-generate', async (_req, reply) => {
    if (!deps.llm) {
      reply.status(503).send({ error: 'LLM_UNAVAILABLE', message: 'LLM not configured' });
      return;
    }

    try {
      // Paths are constructed at runtime so tsc doesn't resolve auto-eval/ (outside rootDir)
      const storePath = new URL('../../auto-eval/store.js', import.meta.url).href;
      const analyzerPath = new URL('../../auto-eval/analyzer.js', import.meta.url).href;
      const feedbackPath = new URL('../../auto-eval/feedback-loop.js', import.meta.url).href;
      const storeMod = await import(storePath).catch(() => null) as {
        AutoEvalStore: new (dir: string) => { loadAllEvaluations: () => unknown[] };
      } | null;
      const analyzerMod = await import(analyzerPath).catch(() => null) as {
        analyzeResults: (evals: unknown[]) => { patterns: Array<{ pattern: string; frequency: number; avgScoreImpact: number; exampleConversationIds: string[]; suggestedFix: string; category: string }> };
      } | null;
      const feedbackMod = await import(feedbackPath).catch(() => null) as {
        generateContentRulesFromPatterns: (llm: unknown, patterns: unknown[], pool: unknown, logger: unknown) => Promise<Array<{ rule_type: string; pattern: string; is_regex: boolean; reason: string; severity: string }>>;
        insertDraftContentRules: (pool: unknown, rules: unknown[], logger: unknown) => Promise<number>;
      } | null;

      if (!storeMod || !analyzerMod || !feedbackMod) {
        return { ok: false, message: 'Auto-eval modules not available. Ensure the auto-eval directory is present.' };
      }

      const pino = await import('pino');
      const logger = pino.default({ level: 'warn' });

      const resultsDir = new URL('../../auto-eval/results', import.meta.url).pathname;
      const store = new storeMod.AutoEvalStore(resultsDir);

      const evaluations = store.loadAllEvaluations();
      if (evaluations.length === 0) {
        return { ok: false, message: 'No auto-eval results found. Run `pnpm --filter @grace/api auto-eval` first.' };
      }

      const { patterns } = analyzerMod.analyzeResults(evaluations);
      const rules = await feedbackMod.generateContentRulesFromPatterns(deps.llm, patterns, deps.pool, logger);

      if (rules.length === 0) {
        return { ok: true, message: 'No actionable patterns found for content rule generation.', rulesGenerated: 0 };
      }

      const inserted = await feedbackMod.insertDraftContentRules(deps.pool, rules, logger);
      return {
        ok: true,
        rulesGenerated: rules.length,
        rulesInserted: inserted,
        message: `Generated ${rules.length} draft content rules from ${evaluations.length} auto-eval conversations. Rules are inactive — review and activate in the admin dashboard.`,
        rules: rules.map((r: { pattern: string; severity: string; reason: string }) => ({ pattern: r.pattern, severity: r.severity, reason: r.reason })),
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      reply.status(500).send({ error: 'AUTO_GENERATE_FAILED', message: msg });
    }
  });

  // ─── Auto-eval data endpoints ─────────────────────────────────────────────

  // Resolve the auto-eval results directory relative to this file.
  // Uses fileURLToPath + path.join so it works regardless of cwd.
  const __adminDirname = fileURLToPath(new URL('.', import.meta.url));
  const autoEvalResultsDir = join(__adminDirname, '..', '..', 'auto-eval', 'results');

  /** Helper: safely read + parse a JSON file, returning null on any error. */
  function readJsonFile<T>(filePath: string): T | null {
    try {
      if (!existsSync(filePath)) return null;
      return JSON.parse(readFileSync(filePath, 'utf8')) as T;
    } catch {
      return null;
    }
  }

  /** Helper: list JSON files in a subdirectory, returning [] if missing. */
  function listJsonFiles(subdir: string): string[] {
    const dir = join(autoEvalResultsDir, subdir);
    if (!existsSync(dir)) return [];
    try {
      return readdirSync(dir).filter((f) => f.endsWith('.json'));
    } catch {
      return [];
    }
  }

  // 1. GET /admin/auto-eval/reports — list all run reports, newest first
  app.get('/admin/auto-eval/reports', async () => {
    const files = listJsonFiles('reports');
    const reports: unknown[] = [];
    // Sort descending by filename (timestamps)
    for (const file of files.sort().reverse()) {
      const data = readJsonFile<Record<string, unknown>>(join(autoEvalResultsDir, 'reports', file));
      if (data) {
        reports.push({
          runId: data.runId ?? null,
          timestamp: data.timestamp ?? null,
          model: data.model ?? null,
          totalConversations: data.totalConversations ?? 0,
          totalTurns: data.totalTurns ?? 0,
          overallScore: data.overallScore ?? 0,
          passRate: data.passRate ?? 0,
          scoreByCategory: data.scoreByCategory ?? {},
          scoreByDimension: data.scoreByDimension ?? {},
          topPatterns: data.topPatterns ?? [],
          regressions: data.regressions ?? [],
          improvementSuggestions: data.improvementSuggestions ?? [],
          preferencePairsGenerated: data.preferencePairsGenerated ?? 0,
        });
      }
    }
    return { reports };
  });

  // 2. GET /admin/auto-eval/conversations — list all simulated conversations with eval scores
  app.get('/admin/auto-eval/conversations', async () => {
    const convFiles = listJsonFiles('conversations');
    const items: unknown[] = [];
    for (const file of convFiles) {
      const conv = readJsonFile<Record<string, unknown>>(join(autoEvalResultsDir, 'conversations', file));
      if (!conv) continue;
      const convId = (conv.id as string) ?? file.replace('.json', '');
      // Try to load the matching evaluation
      const evalData = readJsonFile<Record<string, unknown>>(join(autoEvalResultsDir, 'evaluations', `${convId}.json`));
      const scenario = conv.scenario as Record<string, unknown> | undefined;
      const persona = conv.persona as Record<string, unknown> | undefined;
      const turns = conv.turns as unknown[] | undefined;
      items.push({
        id: convId,
        scenarioId: conv.scenarioId ?? scenario?.id ?? null,
        personaId: conv.personaId ?? persona?.id ?? null,
        category: scenario?.category ?? evalData?.category ?? null,
        overallScore: evalData?.overallScore ?? null,
        turnCount: turns?.length ?? 0,
        personaName: persona?.name ?? null,
        scenarioDescription: scenario?.description ?? null,
      });
    }
    return { conversations: items };
  });

  // 3. GET /admin/auto-eval/conversations/:id — single conversation with full evaluation
  app.get('/admin/auto-eval/conversations/:id', async (req) => {
    const { id } = req.params as { id: string };
    const conv = readJsonFile<Record<string, unknown>>(join(autoEvalResultsDir, 'conversations', `${id}.json`));
    if (!conv) throw new ValidationError('Conversation not found');
    const evalData = readJsonFile<Record<string, unknown>>(join(autoEvalResultsDir, 'evaluations', `${id}.json`));
    return {
      conversation: conv,
      evaluation: evalData ?? null,
    };
  });

  // 4. GET /admin/auto-eval/preference-pairs — list all preference pairs
  app.get('/admin/auto-eval/preference-pairs', async () => {
    const files = listJsonFiles('preference-pairs');
    const pairs: unknown[] = [];
    for (const file of files) {
      const batch = readJsonFile<Array<Record<string, unknown>>>(join(autoEvalResultsDir, 'preference-pairs', file));
      if (!Array.isArray(batch)) continue;
      for (const pair of batch) {
        pairs.push({
          id: pair.id ?? null,
          conversationId: pair.conversationId ?? null,
          turnIndex: pair.turnIndex ?? null,
          userMessage: pair.userMessage ?? null,
          chosen: pair.chosen ?? null,
          rejected: pair.rejected ?? null,
          chosenScore: pair.chosenScore ?? null,
          rejectedScore: pair.rejectedScore ?? null,
          dimension: pair.dimension ?? null,
          reasoning: pair.reasoning ?? null,
        });
      }
    }
    return { pairs };
  });

  // 5. PUT /admin/auto-eval/evaluations/:conversationId/turns/:turnIndex
  //    Admin edits a turn evaluation with dimension overrides

  const TurnOverrideSchema = z.object({
    overrides: z.array(z.object({
      dimension: z.string().min(1),
      newScore: z.number().min(1).max(5),
      adminNote: z.string().max(1000),
    })).min(1),
    adminApproved: z.boolean().optional(),
  });

  app.put('/admin/auto-eval/evaluations/:conversationId/turns/:turnIndex', async (req) => {
    const { conversationId, turnIndex: turnIndexStr } = req.params as { conversationId: string; turnIndex: string };
    const turnIndex = parseInt(turnIndexStr, 10);
    if (isNaN(turnIndex) || turnIndex < 0) throw new ValidationError('turnIndex must be a non-negative integer');

    const parsed = TurnOverrideSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError(parsed.error.message);
    const { overrides, adminApproved } = parsed.data;

    const evalPath = join(autoEvalResultsDir, 'evaluations', `${conversationId}.json`);
    const evalData = readJsonFile<Record<string, unknown>>(evalPath);
    if (!evalData) throw new ValidationError('Evaluation not found');

    const turnEvaluations = evalData.turnEvaluations as Array<Record<string, unknown>> | undefined;
    if (!turnEvaluations || !turnEvaluations[turnIndex]) {
      throw new ValidationError(`Turn index ${turnIndex} not found in evaluation`);
    }

    const turn = turnEvaluations[turnIndex]!;
    const dimensions = turn.dimensions as Array<{ name: string; score: number; reasoning: string }> | undefined;
    if (!dimensions) throw new ValidationError('Turn has no dimensions data');

    // Track which dimensions were overridden DOWN for preference pair generation
    const downgradedOverrides: Array<{ dimension: string; oldScore: number; newScore: number; adminNote: string }> = [];

    // Apply each override
    for (const override of overrides) {
      const dim = dimensions.find((d) => d.name === override.dimension);
      if (dim) {
        const oldScore = dim.score;
        if (override.newScore < oldScore) {
          downgradedOverrides.push({ dimension: override.dimension, oldScore, newScore: override.newScore, adminNote: override.adminNote });
        }
        dim.score = override.newScore;
      }
    }

    // Recalculate the turn's overall score as mean of all dimension scores
    const totalScore = dimensions.reduce((sum, d) => sum + d.score, 0);
    turn.overallScore = parseFloat((totalScore / dimensions.length).toFixed(2));

    // Mark the turn as admin-reviewed
    turn.adminReviewed = true;
    turn.adminOverrides = overrides;
    if (adminApproved !== undefined) {
      turn.adminApproved = adminApproved;
    }

    // Save the updated evaluation
    try {
      writeFileSync(evalPath, JSON.stringify(evalData, null, 2), 'utf8');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new ValidationError(`Failed to save evaluation: ${msg}`);
    }

    // Generate preference pairs for downgraded dimensions
    let preferencePairsGenerated = 0;
    if (downgradedOverrides.length > 0) {
      const convPath = join(autoEvalResultsDir, 'conversations', `${conversationId}.json`);
      const conv = readJsonFile<Record<string, unknown>>(convPath);
      const turns = conv?.turns as Array<{ role: string; text: string }> | undefined;
      const userMessage = (turn.userMessage as string) ?? turns?.[turnIndex * 2]?.text ?? '';
      const graceResponse = (turn.graceResponse as string) ?? turns?.[turnIndex * 2 + 1]?.text ?? '';

      const newPairs: Array<Record<string, unknown>> = downgradedOverrides.map((dg) => ({
        id: `admin-${conversationId}-${turnIndex}-${dg.dimension}-${Date.now()}`,
        conversationId,
        turnIndex,
        context: '',
        userMessage,
        chosen: '', // Empty — admin flagged this as bad, the "better" response is not yet generated
        rejected: graceResponse,
        chosenScore: 0,
        rejectedScore: dg.newScore,
        dimension: dg.dimension,
        reasoning: `[admin-override] ${dg.adminNote} (score ${dg.oldScore} → ${dg.newScore})`,
      }));

      // Append to a preference pairs file
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const pairsPath = join(autoEvalResultsDir, 'preference-pairs', `admin-${ts}.json`);
      try {
        writeFileSync(pairsPath, JSON.stringify(newPairs, null, 2), 'utf8');
        preferencePairsGenerated = newPairs.length;
      } catch {
        // Non-fatal — the override was still saved
      }
    }

    return {
      ok: true,
      conversationId,
      turnIndex,
      newOverallScore: turn.overallScore,
      overridesApplied: overrides.length,
      preferencePairsGenerated,
    };
  });

  // 6. POST /admin/auto-eval/learn — trigger learning from admin-reviewed evaluations
  app.post('/admin/auto-eval/learn', async (_req, reply) => {
    if (!deps.llm) {
      reply.status(503).send({ error: 'LLM_UNAVAILABLE', message: 'LLM not configured' });
      return;
    }

    try {
      // Dynamic imports to avoid tsc rootDir issues
      const storePath = new URL('../../auto-eval/store.js', import.meta.url).href;
      const analyzerPath = new URL('../../auto-eval/analyzer.js', import.meta.url).href;
      const feedbackPath = new URL('../../auto-eval/feedback-loop.js', import.meta.url).href;

      const storeMod = await import(storePath).catch(() => null) as {
        AutoEvalStore: new (dir: string) => {
          loadAllEvaluations: () => Array<Record<string, unknown>>;
          loadAllPreferencePairs: () => unknown[];
        };
      } | null;
      const analyzerMod = await import(analyzerPath).catch(() => null) as {
        analyzeResults: (evals: unknown[]) => {
          patterns: Array<{ pattern: string; frequency: number; avgScoreImpact: number; exampleConversationIds: string[]; suggestedFix: string; category: string }>;
        };
      } | null;
      const feedbackMod = await import(feedbackPath).catch(() => null) as {
        loadPreferencePairs: (dir: string) => unknown[];
        pairsToSyntheticFeedback: (pairs: unknown[]) => unknown[];
        generateContentRulesFromPatterns: (llm: unknown, patterns: unknown[], pool: unknown, logger: unknown) => Promise<Array<{ rule_type: string; pattern: string; is_regex: boolean; reason: string; severity: string }>>;
        insertDraftContentRules: (pool: unknown, rules: unknown[], logger: unknown) => Promise<number>;
      } | null;

      if (!storeMod || !analyzerMod || !feedbackMod) {
        return { ok: false, message: 'Auto-eval modules not available. Ensure the auto-eval directory is present.' };
      }

      const pino = await import('pino');
      const logger = pino.default({ level: 'warn' });

      const store = new storeMod.AutoEvalStore(autoEvalResultsDir);

      // Load all evaluations and filter to admin-reviewed ones
      const allEvaluations = store.loadAllEvaluations();
      const reviewedEvaluations = allEvaluations.filter((ev) => {
        const turnEvals = (ev as Record<string, unknown>).turnEvaluations as Array<Record<string, unknown>> | undefined;
        return turnEvals?.some((t) => t.adminReviewed === true);
      });

      if (reviewedEvaluations.length === 0) {
        return {
          ok: true,
          message: 'No admin-reviewed evaluations found. Review turn evaluations first.',
          evaluationsProcessed: 0,
          preferencePairsGenerated: 0,
          contentRulesGenerated: 0,
        };
      }

      // Load preference pairs and inject into optimizer
      const pairs = store.loadAllPreferencePairs();
      let preferencePairsCount = pairs.length;

      if (deps.promptOptimizer && pairs.length > 0) {
        const syntheticFeedback = feedbackMod.pairsToSyntheticFeedback(pairs);
        // The prompt optimizer will pick these up on its next run
        if (typeof (deps.promptOptimizer as unknown as Record<string, unknown>).injectSyntheticFeedback === 'function') {
          (deps.promptOptimizer as unknown as { injectSyntheticFeedback: (fb: unknown[]) => void }).injectSyntheticFeedback(syntheticFeedback);
        }
      }

      // Analyze patterns from reviewed evaluations and generate content rules
      const { patterns } = analyzerMod.analyzeResults(reviewedEvaluations);
      let contentRulesGenerated = 0;

      if (patterns.length > 0) {
        const rules = await feedbackMod.generateContentRulesFromPatterns(deps.llm, patterns, deps.pool, logger);
        if (rules.length > 0) {
          contentRulesGenerated = await feedbackMod.insertDraftContentRules(deps.pool, rules, logger);
        }
      }

      return {
        ok: true,
        evaluationsProcessed: reviewedEvaluations.length,
        preferencePairsGenerated: preferencePairsCount,
        contentRulesGenerated,
        message: `Processed ${reviewedEvaluations.length} admin-reviewed evaluations. ${preferencePairsCount} preference pairs injected. ${contentRulesGenerated} draft content rules generated.`,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      reply.status(500).send({ error: 'LEARN_FAILED', message: msg });
    }
  });

  // Debug: check auto-eval file resolution
  app.get('/admin/auto-eval/debug', async () => {
    const url = new URL('../../auto-eval/streaming-runner.js', import.meta.url);
    const { existsSync: fsExists } = await import('fs');
    const { fileURLToPath } = await import('url');
    let filePath = '';
    let exists = false;
    try {
      filePath = fileURLToPath(url);
      exists = fsExists(filePath);
    } catch (e) {
      filePath = `error: ${e instanceof Error ? e.message : String(e)}`;
    }
    let importError = '';
    try {
      await import(url.href);
    } catch (e) {
      importError = e instanceof Error ? e.stack ?? e.message : String(e);
    }
    return {
      importMetaUrl: import.meta.url,
      resolvedUrl: url.href,
      resolvedPath: filePath,
      fileExists: exists,
      autoEvalResultsDir,
      resultsExists: fsExists(autoEvalResultsDir),
      importError: importError || 'none',
    };
  });

  // 7. POST /admin/auto-eval/run — start a new auto-eval run in the background
  app.post('/admin/auto-eval/run', async (req, reply) => {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      reply.status(503).send({ error: 'NO_API_KEY', message: 'GEMINI_API_KEY not configured' });
      return;
    }

    const body = (req.body ?? {}) as {
      scenarioCount?: number;
      concurrency?: number;
      categories?: string[];
      generatePreferencePairs?: boolean;
    };

    try {
      const runnerUrl = new URL('../../auto-eval/streaming-runner.js', import.meta.url).href;
      const mod = await import(runnerUrl).catch((err: unknown) => {
        app.log.error({ err: err instanceof Error ? err.message : String(err), runnerUrl }, 'auto_eval.streaming_runner_import_failed');
        return null;
      }) as {
        runAutoEvalStreaming: (opts: Record<string, unknown>) => Promise<unknown>;
        getRunState: () => { running: boolean } | null;
      } | null;

      if (!mod) {
        reply.status(503).send({ error: 'MODULE_UNAVAILABLE', message: 'Auto-eval streaming runner not available' });
        return;
      }

      const state = mod.getRunState();
      if (state?.running) {
        reply.status(409).send({ error: 'ALREADY_RUNNING', message: 'An auto-eval run is already in progress' });
        return;
      }

      if (!existsSync(autoEvalResultsDir)) {
        mkdirSync(autoEvalResultsDir, { recursive: true });
      }

      // Fire and forget — client monitors progress via SSE
      void mod.runAutoEvalStreaming({
        apiKey,
        model: process.env.GEMINI_MODEL ?? 'gemini-2.5-flash',
        scenarioCount: body.scenarioCount ?? 10,
        concurrency: body.concurrency ?? 2,
        categories: body.categories,
        generatePreferencePairs: body.generatePreferencePairs ?? true,
        outDir: autoEvalResultsDir,
        verbose: false,
      }).catch(() => { /* error state is tracked in the runner */ });

      return { ok: true, message: 'Auto-eval run started. Connect to /admin/auto-eval/progress for live updates.' };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      reply.status(500).send({ error: 'RUN_FAILED', message: msg });
    }
  });

  // 8. GET /admin/auto-eval/status — get current run status (non-streaming)
  app.get('/admin/auto-eval/status', async () => {
    try {
      const runnerUrl = new URL('../../auto-eval/streaming-runner.js', import.meta.url).href;
      const mod = await import(runnerUrl).catch(() => null) as {
        getRunState: () => { running: boolean; phase: string; progress: number; total: number; completed: number; startedAt: string; error?: string } | null;
      } | null;

      if (!mod) return { running: false, state: null };
      const state = mod.getRunState();
      return { running: state?.running ?? false, state };
    } catch {
      return { running: false, state: null };
    }
  });

  // 9. GET /admin/auto-eval/progress — SSE stream of live progress events
  app.get('/admin/auto-eval/progress', async (req, reply) => {
    const raw = reply.raw;
    raw.setHeader('Content-Type', 'text/event-stream');
    raw.setHeader('Cache-Control', 'no-cache');
    raw.setHeader('Connection', 'keep-alive');
    raw.setHeader('X-Accel-Buffering', 'no');
    raw.flushHeaders();

    let closed = false;
    req.raw.on('close', () => { closed = true; });

    const send = (event: string, data: unknown) => {
      if (closed) return;
      raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    try {
      const runnerUrl = new URL('../../auto-eval/streaming-runner.js', import.meta.url).href;
      const mod = await import(runnerUrl).catch(() => null) as {
        getRunState: () => { running: boolean; phase: string; progress: number; total: number; completed: number } | null;
        addProgressListener: (cb: (event: unknown) => void) => () => void;
      } | null;

      if (!mod) {
        send('error', { message: 'Auto-eval module not available' });
        raw.end();
        return;
      }

      // Send current state immediately
      const state = mod.getRunState();
      send('status', state ?? { running: false });

      // Subscribe to progress events
      const unsubscribe = mod.addProgressListener((event) => {
        if (closed) { unsubscribe(); return; }
        send('progress', event);
        const evt = event as { phase?: string };
        if (evt.phase === 'done' || evt.phase === 'error') {
          setTimeout(() => { if (!closed) raw.end(); }, 100);
        }
      });

      // Cleanup on disconnect
      req.raw.on('close', () => { unsubscribe(); });
    } catch {
      send('error', { message: 'Failed to connect to progress stream' });
      raw.end();
      return;
    }

    await new Promise<void>((resolve) => {
      req.raw.on('close', resolve);
    });
  });

  // ─── Regression suite ─────────────────────────────────────────────────────
  // Replays each known production bug with its exact trigger message and
  // scores deterministically against banned phrases + LLM-judged required
  // behaviors. Fast, focused, reliable signal — pass rate should be 100%
  // after every deploy.

  app.post('/admin/regression/run', async (_req, reply) => {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      reply.status(503).send({ error: 'NO_API_KEY', message: 'GEMINI_API_KEY not configured' });
      return;
    }
    try {
      const runnerUrl = new URL('../../auto-eval/regression-runner.js', import.meta.url).href;
      const mod = await import(runnerUrl).catch((err: unknown) => {
        app.log.error({ err: err instanceof Error ? err.message : String(err), runnerUrl }, 'regression.import_failed');
        return null;
      }) as {
        runRegressionSuite: (opts: { llm: unknown; invokeGrace: (input: unknown) => Promise<unknown>; dbScenarios?: unknown[] }) => Promise<unknown>;
      } | null;
      if (!mod) {
        reply.status(503).send({ error: 'MODULE_UNAVAILABLE', message: 'Regression runner not available' });
        return;
      }

      // invokeGrace: runs each scenario through the FULL production pipeline
      // (sandbox replay → real orchestrator + classifier-forced tool calls +
      // protein/calorie context block + content checker + relevance/behavioral
      // guards). The previous direct llm.generate path bypassed all of that,
      // so scenarios like reg_protein_left_today failed because Grace literally
      // didn't have protein_goal_grams in scope. See replay/sandbox.ts.
      const { runSandboxReplay } = await import('../replay/sandbox.js');

      // Load the active system prompt — the rules (PRIVACY, EMOTION-BEFORE-DATA,
      // protein-from-CURRENT-weight, clinical-redirect template, etc.) are what
      // most regression scenarios are actually testing.
      let regressionSystemPrompt = 'You are Grace, a WhatsApp companion for GLP-1 users.';
      try {
        const { rows } = await deps.pool.query<{ content: string }>(
          `SELECT content FROM prompts WHERE active = TRUE ORDER BY created_at DESC LIMIT 1`,
        );
        if (rows[0]?.content) regressionSystemPrompt = rows[0].content;
      } catch {
        /* fall through with default */
      }

      const invokeGrace = async (input: unknown): Promise<{ text: string; latencyMs: number }> => {
        const inp = input as {
          persona: {
            name?: string;
            medication?: string;
            goals?: string[];
            foodDislikes?: string[];
            dietaryRestriction?: string;
            weekOnGlp1?: number;
          };
          userMessage: string;
        };
        if (!deps.llm) throw new Error('LLM provider not configured');

        // Extract protein target from the persona's goals string (e.g.
        // "hit 80g protein daily"). Falls back to 80g — Grace's default.
        let proteinGoalGrams = 80;
        for (const g of inp.persona.goals ?? []) {
          const m = /(\d{2,3})\s*g\s*(of\s+)?protein/i.exec(g);
          if (m && m[1]) {
            proteinGoalGrams = parseInt(m[1], 10);
            break;
          }
        }

        const restrictionLabel = inp.persona.dietaryRestriction?.toUpperCase();
        const dietaryRestriction =
          restrictionLabel === 'VEGAN' || restrictionLabel === 'VEGETARIAN' || restrictionLabel === 'PESCATARIAN'
            ? { label: restrictionLabel as 'VEGAN' | 'VEGETARIAN' | 'PESCATARIAN', forbidden: [], allowed: [] }
            : undefined;

        const t0 = Date.now();
        const result = await runSandboxReplay({
          messages: [inp.userMessage],
          persona: {
            ...(inp.persona.name ? { firstName: inp.persona.name } : {}),
            ...(inp.persona.medication ? { medication: inp.persona.medication } : {}),
            ...(dietaryRestriction ? { dietaryRestriction } : {}),
            ...(inp.persona.foodDislikes ? { foodDislikes: inp.persona.foodDislikes } : {}),
            proteinGoalGrams,
            ...(inp.persona.weekOnGlp1 ? { glp1WeekNumber: inp.persona.weekOnGlp1 } : {}),
          },
          systemPrompt: regressionSystemPrompt,
          llm: deps.llm,
        });
        const lastGrace = [...result.turns].reverse().find((t) => t.role === 'grace');
        return {
          text: lastGrace?.text ?? '',
          latencyMs: Date.now() - t0,
        };
      };

      // Fetch dynamic DB scenarios (if migration applied) and merge with static
      let dbScenarios: unknown[] = [];
      try {
        const { rows } = await deps.pool.query(
          `SELECT id, bug_description, trigger_message, banned_phrases, required_behavior,
                  setup, persona_id, category
           FROM regression_scenarios WHERE active = TRUE`,
        );
        dbScenarios = rows.map((r) => ({
          id: r.id,
          bugDescription: r.bug_description,
          triggerMessage: r.trigger_message,
          bannedInResponse: r.banned_phrases ?? [],
          requiredBehavior: r.required_behavior ?? [],
          setup: r.setup ?? undefined,
          personaId: r.persona_id ?? 'sarah_new',
          category: r.category ?? 'edge_case',
          turnCount: 1,
          challenges: [],
          fixedAt: 'dynamic',
        }));
      } catch {
        /* migration not applied — silently fall through */
      }
      const report = await mod.runRegressionSuite({ llm: deps.llm, invokeGrace, dbScenarios });
      return report;
    } catch (err) {
      app.log.error({ err }, 'regression.run_failed');
      reply.status(500).send({ error: 'RUN_FAILED', message: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get('/admin/regression/scenarios', async () => {
    // Merge static (code) scenarios with dynamic (DB) scenarios
    let staticScenarios: unknown[] = [];
    try {
      const modUrl = new URL('../../auto-eval/regression-scenarios.js', import.meta.url).href;
      const mod = await import(modUrl) as { REGRESSION_SCENARIOS: unknown[] };
      staticScenarios = mod.REGRESSION_SCENARIOS.map((s) => ({ ...(s as object), source: 'static' }));
    } catch (err) {
      app.log.error({ err }, 'regression.scenarios_import_failed');
    }
    let dbScenarios: unknown[] = [];
    try {
      const { rows } = await deps.pool.query(
        `SELECT id, bug_description, trigger_message, banned_phrases, required_behavior,
                setup, persona_id, category, source, created_at
         FROM regression_scenarios WHERE active = TRUE ORDER BY created_at DESC`,
      );
      dbScenarios = rows.map((r) => ({
        id: r.id,
        bugDescription: r.bug_description,
        triggerMessage: r.trigger_message,
        bannedInResponse: r.banned_phrases,
        requiredBehavior: r.required_behavior,
        setup: r.setup,
        personaId: r.persona_id ?? 'sarah_new',
        category: r.category ?? 'edge_case',
        source: r.source,
        fixedAt: r.created_at,
      }));
    } catch (err) {
      app.log.warn({ err }, 'regression.db_scenarios_unavailable');
    }
    return { scenarios: [...staticScenarios, ...dbScenarios] };
  });

  // Save a new dynamic regression scenario (from Replay UI or manual entry).
  app.post('/admin/regression/scenarios', async (req, reply) => {
    const body = (req.body ?? {}) as {
      id?: string;
      bugDescription?: string;
      triggerMessage?: string;
      bannedPhrases?: string[];
      requiredBehavior?: string[];
      setup?: string;
      personaId?: string;
      category?: string;
      source?: string;
      sourceMeta?: Record<string, unknown>;
    };
    if (!body.bugDescription || !body.triggerMessage) {
      reply.status(400).send({ error: 'INVALID', message: 'bugDescription and triggerMessage are required' });
      return;
    }
    const id = body.id ?? `dyn_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    try {
      await deps.pool.query(
        `INSERT INTO regression_scenarios
           (id, bug_description, trigger_message, banned_phrases, required_behavior,
            setup, persona_id, category, source, source_meta)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (id) DO UPDATE SET
           bug_description = EXCLUDED.bug_description,
           trigger_message = EXCLUDED.trigger_message,
           banned_phrases = EXCLUDED.banned_phrases,
           required_behavior = EXCLUDED.required_behavior,
           setup = EXCLUDED.setup,
           persona_id = EXCLUDED.persona_id,
           category = EXCLUDED.category`,
        [
          id,
          body.bugDescription,
          body.triggerMessage,
          body.bannedPhrases ?? [],
          body.requiredBehavior ?? [],
          body.setup ?? null,
          body.personaId ?? null,
          body.category ?? null,
          body.source ?? 'manual',
          body.sourceMeta ? JSON.stringify(body.sourceMeta) : null,
        ],
      );
      return { ok: true, id };
    } catch (err) {
      app.log.error({ err }, 'regression.scenario_save_failed');
      reply.status(500).send({ error: 'SAVE_FAILED', message: err instanceof Error ? err.message : String(err) });
    }
  });

  // Delete (deactivate) a dynamic scenario
  app.delete('/admin/regression/scenarios/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      await deps.pool.query('UPDATE regression_scenarios SET active = FALSE WHERE id = $1', [id]);
      return { ok: true };
    } catch (err) {
      reply.status(500).send({ error: 'DELETE_FAILED', message: err instanceof Error ? err.message : String(err) });
    }
  });

  // Auto-generate regression scenarios from recent 👎 RLHF feedback.
  // Uses LLM to extract: bug description, banned phrases, required behaviors.
  // Returns DRAFT scenarios (not auto-saved) — admin reviews before persisting.
  app.post('/admin/regression/generate-from-feedback', async (req, reply) => {
    const body = (req.body ?? {}) as { days?: number; limit?: number };
    const days = Math.min(Math.max(body.days ?? 14, 1), 90);
    const limit = Math.min(Math.max(body.limit ?? 10, 1), 30);
    if (!deps.llm) {
      reply.status(503).send({ error: 'NO_LLM', message: 'LLM provider not configured' });
      return;
    }
    try {
      const since = new Date(Date.now() - days * 24 * 3_600_000);
      // Fetch 👎 feedback with the user message and grace response
      const { rows } = await deps.pool.query<{
        feedback_id: string;
        comment: string | null;
        user_message: string | null;
        assistant_message: string;
      }>(
        `SELECT
           f.id AS feedback_id,
           f.comment,
           u.content AS user_message,
           a.content AS assistant_message
         FROM feedback f
         JOIN messages a ON a.id = f.message_id
         LEFT JOIN LATERAL (
           SELECT content FROM messages
           WHERE conversation_id = a.conversation_id AND role = 'user' AND created_at < a.created_at
           ORDER BY created_at DESC LIMIT 1
         ) u ON TRUE
         WHERE f.rating = -1 AND f.created_at > $1
         ORDER BY f.created_at DESC
         LIMIT $2`,
        [since, limit],
      );
      if (rows.length === 0) return { scenarios: [], message: 'No 👎 feedback in this period' };

      // Ask LLM to extract scenario fields from each 👎
      const drafts: Array<Record<string, unknown>> = [];
      for (const r of rows) {
        if (!r.user_message || !r.assistant_message) continue;
        const prompt = `A user gave 👎 feedback on this Grace response. Extract a regression test scenario.

USER MESSAGE: "${r.user_message.slice(0, 400)}"
GRACE RESPONSE: "${r.assistant_message.slice(0, 600)}"
USER COMMENT: ${r.comment ? `"${r.comment.slice(0, 200)}"` : '(no comment)'}

Return ONLY a JSON object:
{
  "bugDescription": "<one sentence explaining what Grace did wrong>",
  "bannedPhrases": ["<2-5 short literal phrases from Grace's response that should never appear in similar situations>"],
  "requiredBehavior": ["<2-4 semantic behaviors Grace SHOULD have demonstrated>"]
}

Banned phrases must be exact lowercase substrings from Grace's actual response. Required behaviors are short imperatives like "states a specific number" or "logs the food without asking".`;
        try {
          const resp = await deps.llm.generate({
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.0,
            maxOutputTokens: 600,
            responseFormat: 'json',
            model: 'gemini-2.0-flash',
          });
          const cleaned = resp.text.trim().replace(/^```json\s*/i, '').replace(/```$/, '').trim();
          const parsed = JSON.parse(cleaned) as { bugDescription?: string; bannedPhrases?: string[]; requiredBehavior?: string[] };
          if (parsed.bugDescription && (parsed.bannedPhrases?.length || parsed.requiredBehavior?.length)) {
            drafts.push({
              id: `fb_${r.feedback_id}`,
              bugDescription: parsed.bugDescription,
              triggerMessage: r.user_message.trim(),
              bannedPhrases: parsed.bannedPhrases ?? [],
              requiredBehavior: parsed.requiredBehavior ?? [],
              source: 'feedback',
              sourceMeta: { feedback_id: r.feedback_id, original_response: r.assistant_message.slice(0, 600) },
            });
          }
        } catch {
          /* skip on parse failure */
        }
      }
      return { scenarios: drafts, message: `Generated ${drafts.length} drafts from ${rows.length} 👎 feedback entries` };
    } catch (err) {
      app.log.error({ err }, 'regression.generate_from_feedback_failed');
      reply.status(500).send({ error: 'GENERATE_FAILED', message: err instanceof Error ? err.message : String(err) });
    }
  });

  // ─── Conversation replay (sandbox mode) ──────────────────────────────────
  // Replays user messages through the REAL AIOrchestrator with in-memory mock
  // tools (log_food, get_food_summary, get_user_profile). Output is what
  // production WhatsApp would send: post format-enforcer, content checker,
  // relevance check, quality guard, regen loops.
  //
  // The in-memory food state persists across turns within a single replay,
  // so "I ate X" then "how much protein left" actually works correctly.
  app.post('/admin/replay', async (req, reply) => {
    const body = (req.body ?? {}) as {
      messages?: string[];
      personaContext?: {
        firstName?: string;
        medication?: string;
        dietaryRestriction?: string;
        foodDislikes?: string[];
        proteinGoalGrams?: number;
        calorieGoalKcal?: number;
        glp1WeekNumber?: number;
        preloadedFoods?: Array<{ food: string; protein_g: number; calories: number }>;
      };
      systemPromptOverride?: string;
    };
    const messages = Array.isArray(body.messages)
      ? body.messages.filter((m) => typeof m === 'string' && m.trim().length > 0)
      : [];
    if (messages.length === 0) {
      reply.status(400).send({ error: 'NO_MESSAGES', message: 'Provide a non-empty messages array' });
      return;
    }
    if (messages.length > 20) {
      reply.status(400).send({ error: 'TOO_MANY', message: 'Max 20 messages per replay' });
      return;
    }
    if (!deps.llm) {
      reply.status(503).send({ error: 'NO_LLM', message: 'LLM provider not configured' });
      return;
    }

    let systemPrompt = body.systemPromptOverride;
    if (!systemPrompt) {
      try {
        const { rows } = await deps.pool.query<{ content: string }>(
          `SELECT content FROM prompts WHERE active = TRUE ORDER BY created_at DESC LIMIT 1`,
        );
        systemPrompt = rows[0]?.content ?? 'You are Grace, a WhatsApp companion for GLP-1 users.';
      } catch {
        systemPrompt = 'You are Grace, a WhatsApp companion for GLP-1 users.';
      }
    }

    const ctx = body.personaContext ?? {};
    const restrictionLabel = ctx.dietaryRestriction?.toUpperCase();
    const dietaryRestriction: { label: 'VEGAN' | 'VEGETARIAN' | 'PESCATARIAN'; forbidden: string[]; allowed: string[] } | undefined =
      restrictionLabel === 'VEGAN' || restrictionLabel === 'VEGETARIAN' || restrictionLabel === 'PESCATARIAN'
        ? { label: restrictionLabel, forbidden: [], allowed: [] }
        : undefined;

    try {
      const { runSandboxReplay } = await import('../replay/sandbox.js');
      const result = await runSandboxReplay({
        messages,
        persona: {
          ...(ctx.firstName ? { firstName: ctx.firstName } : {}),
          ...(ctx.medication ? { medication: ctx.medication } : {}),
          ...(dietaryRestriction ? { dietaryRestriction } : {}),
          ...(ctx.foodDislikes ? { foodDislikes: ctx.foodDislikes } : {}),
          ...(ctx.proteinGoalGrams ? { proteinGoalGrams: ctx.proteinGoalGrams } : {}),
          ...(ctx.calorieGoalKcal ? { calorieGoalKcal: ctx.calorieGoalKcal } : {}),
          ...(ctx.glp1WeekNumber ? { glp1WeekNumber: ctx.glp1WeekNumber } : {}),
          ...(ctx.preloadedFoods ? { preloadedFoods: ctx.preloadedFoods } : {}),
        },
        systemPrompt,
        llm: deps.llm,
      });
      const totalLatencyMs = result.turns.reduce((s, t) => s + t.latencyMs, 0);
      return { turns: result.turns, totalLatencyMs };
    } catch (err) {
      app.log.error({ err }, 'replay.failed');
      reply.status(500).send({ error: 'REPLAY_FAILED', message: err instanceof Error ? err.message : String(err) });
    }
  });

  // ─── Prompt-version diff: replay same messages against two prompt versions
  app.post('/admin/replay/diff', async (req, reply) => {
    const body = (req.body ?? {}) as {
      messages?: string[];
      promptVersionA?: number;
      promptVersionB?: number;
      personaContext?: Record<string, unknown>;
    };
    const messages = Array.isArray(body.messages) ? body.messages : [];
    if (messages.length === 0 || !body.promptVersionA || !body.promptVersionB) {
      reply.status(400).send({ error: 'INVALID', message: 'Provide messages, promptVersionA, promptVersionB' });
      return;
    }

    const fetchPrompt = async (version: number): Promise<string | null> => {
      const { rows } = await deps.pool.query<{ content: string }>(
        `SELECT content FROM prompts WHERE version = $1 LIMIT 1`,
        [version],
      );
      return rows[0]?.content ?? null;
    };

    const [promptA, promptB] = await Promise.all([fetchPrompt(body.promptVersionA), fetchPrompt(body.promptVersionB)]);
    if (!promptA || !promptB) {
      reply.status(404).send({ error: 'PROMPT_NOT_FOUND', message: 'One or both prompt versions not found' });
      return;
    }

    const replayOne = async (systemPromptOverride: string) => {
      const r = await app.inject({
        method: 'POST',
        url: '/admin/replay',
        headers: { authorization: req.headers.authorization ?? '' },
        payload: { messages, systemPromptOverride, personaContext: body.personaContext },
      });
      return JSON.parse(r.payload);
    };

    const [a, b] = await Promise.all([replayOne(promptA), replayOne(promptB)]);
    return {
      versionA: body.promptVersionA,
      versionB: body.promptVersionB,
      replayA: a,
      replayB: b,
    };
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

  // ─── Phase 4: behavioral anomalies ─────────────────────────────────────
  // Open (unresolved) anomalies detected by the nightly job. Joins to users
  // for phone + first_name so admins can act on them.
  app.get('/admin/anomalies', async (req) => {
    const q = req.query as Record<string, string>;
    const limit = Math.min(Number(q['limit'] ?? 100), 500);
    const resolved = q['resolved'] === 'true';
    const { rows } = await deps.pool.query(
      `SELECT a.id, a.user_id, a.kind, a.severity, a.details, a.resolved,
              a.created_at, a.resolved_at,
              u.phone, u.first_name
         FROM user_anomalies a
         JOIN users u ON u.id = a.user_id
        WHERE a.resolved = $1
        ORDER BY a.created_at DESC
        LIMIT $2`,
      [resolved, limit],
    );
    return { anomalies: rows };
  });

  app.put('/admin/anomalies/:id/resolve', async (req) => {
    const { id } = req.params as { id: string };
    await deps.pool.query(
      `UPDATE user_anomalies
          SET resolved = TRUE, resolved_at = now()
        WHERE id = $1`,
      [Number(id)],
    );
    return { ok: true };
  });

  // ─── Phase 5: contextual bandit ────────────────────────────────────────
  // Inspect per-user arm pulls + win rates. Use this to spot under-explored
  // arms and confirm the bandit is converging.
  app.get('/admin/users/:phone/bandit', async (req) => {
    if (!deps.bandit) throw new ValidationError('bandit service not configured');
    const { phone } = req.params as { phone: string };
    const { rows } = await deps.pool.query<{ id: string }>(
      `SELECT id FROM users WHERE phone = $1 LIMIT 1`,
      [phone],
    );
    if (!rows[0]) throw new ValidationError('User not found');
    const states = await deps.bandit.getStates(rows[0].id);
    return {
      arms: states.map((s) => ({
        ...s,
        win_rate: s.pulls > 0 ? Number((s.successes / s.pulls).toFixed(3)) : null,
      })),
    };
  });

  // ─── Coverage suite (Phase 3 — intent-library stress test) ─────────────────
  // Loads services/api/coverage/intents.json + runs every variation through
  // runSandboxReplay (full production pipeline with mocked tools). Each case
  // is graded deterministically against expected intent, tool calls, must-
  // include / must-not-include phrases. Reports include per-domain + per-
  // safety-level pass rates, regression deltas vs the previous run.

  app.get('/admin/coverage/intents', async (req, reply) => {
    void reply;
    void req;
    try {
      const suiteUrl = new URL('../../coverage/suite.js', import.meta.url).href;
      const suiteMod = await import(suiteUrl) as { loadIntents: () => { version: number; intents: Array<{ id: string; domain: string; subtopic: string; expected_intent: string; safety_level: string; variations: string[]; source: string }> } };
      const file = suiteMod.loadIntents();
      return {
        version: file.version,
        total: file.intents.length,
        by_domain: file.intents.reduce<Record<string, number>>((acc, i) => {
          acc[i.domain] = (acc[i.domain] ?? 0) + 1;
          return acc;
        }, {}),
        intents: file.intents.map((i) => ({
          id: i.id,
          domain: i.domain,
          subtopic: i.subtopic,
          expected_intent: i.expected_intent,
          safety_level: i.safety_level,
          variation_count: i.variations.length,
          source: i.source,
        })),
      };
    } catch (err) {
      app.log.error({ err: err instanceof Error ? err.message : String(err) }, 'coverage.intents.load_failed');
      reply.status(500).send({ error: 'LOAD_FAILED', message: err instanceof Error ? err.message : String(err) });
      return;
    }
  });

  app.post('/admin/coverage/run', async (req, reply) => {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      reply.status(503).send({ error: 'NO_API_KEY', message: 'GEMINI_API_KEY not configured' });
      return;
    }
    if (!deps.llm) {
      reply.status(503).send({ error: 'NO_LLM', message: 'LLM provider not configured' });
      return;
    }
    const body = (req.body ?? {}) as {
      domains?: string[];
      journey_stages?: string[];
      safety_levels?: ('informational' | 'clinical_redirect' | 'emergency')[];
      limit?: number;
      concurrency?: number;
    };

    try {
      // Coverage modules live outside src/ — use dynamic URL imports so
      // TypeScript doesn't try to compile them under the main rootDir.
      // Same pattern as the regression-runner / auto-eval imports above.
      const suiteUrl = new URL('../../coverage/suite.js', import.meta.url).href;
      const runnerUrl = new URL('../../coverage/runner.js', import.meta.url).href;
      const reporterUrl = new URL('../../coverage/reporter.js', import.meta.url).href;
      const suiteMod = await import(suiteUrl) as {
        buildSuite: (opts: { domains?: string[]; journeyStages?: string[]; safetyLevels?: string[]; limit?: number }) => Array<unknown>;
      };
      const runnerMod = await import(runnerUrl) as {
        runCoverage: (opts: { cases: unknown[]; llm: unknown; systemPrompt: string; concurrency?: number; filters?: unknown; systemPromptVersion?: number | null }) => Promise<{ run_id: string; stats: Record<string, unknown>; cases: unknown[] }>;
      };
      const reporterMod = await import(reporterUrl) as {
        saveReport: (r: unknown) => string;
        listReports: () => Array<{ run_id: string; started_at: string; pass_rate: number; total: number }>;
        loadReport: (id: string) => unknown | null;
        reportDelta: (prev: unknown, curr: unknown) => unknown;
      };

      const cases = suiteMod.buildSuite({
        ...(body.domains ? { domains: body.domains } : {}),
        ...(body.journey_stages ? { journeyStages: body.journey_stages } : {}),
        ...(body.safety_levels ? { safetyLevels: body.safety_levels } : {}),
        ...(body.limit ? { limit: body.limit } : {}),
      });

      // Pull active system prompt for the run.
      let systemPrompt = 'You are Grace, a WhatsApp companion for GLP-1 users.';
      let promptVersion: number | null = null;
      try {
        const { rows } = await deps.pool.query<{ content: string; version: number }>(
          `SELECT content, version FROM prompts WHERE active = TRUE ORDER BY created_at DESC LIMIT 1`,
        );
        if (rows[0]) {
          systemPrompt = rows[0].content;
          promptVersion = rows[0].version;
        }
      } catch (err) {
        app.log.warn({ err: err instanceof Error ? err.message : String(err) }, 'coverage.run.prompt_load_failed');
      }

      const report = await runnerMod.runCoverage({
        cases,
        llm: deps.llm,
        systemPrompt,
        concurrency: body.concurrency,
        filters: {
          ...(body.domains ? { domains: body.domains } : {}),
          ...(body.journey_stages ? { journey_stages: body.journey_stages } : {}),
          ...(body.safety_levels ? { safety_levels: body.safety_levels } : {}),
          ...(body.limit != null ? { limit: body.limit } : {}),
        },
        systemPromptVersion: promptVersion,
      });

      const path = reporterMod.saveReport(report);
      app.log.info(
        { runId: report.run_id, total: report.stats.total, passed: report.stats.passed, passRate: report.stats.pass_rate },
        'coverage.run.completed',
      );

      // Optionally compute delta vs the previous run.
      const past = reporterMod.listReports();
      const previous = past.find((p) => p.run_id !== report.run_id);
      const prevReport = previous ? reporterMod.loadReport(previous.run_id) : null;
      const delta = prevReport ? reporterMod.reportDelta(prevReport, report) : null;

      return {
        ok: true,
        run_id: report.run_id,
        stats: report.stats,
        path,
        delta,
      };
    } catch (err) {
      app.log.error({ err }, 'coverage.run.failed');
      reply.status(500).send({ error: 'RUN_FAILED', message: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get('/admin/coverage/runs', async () => {
    const reporterUrl = new URL('../../coverage/reporter.js', import.meta.url).href;
    const reporterMod = await import(reporterUrl) as {
      listReports: () => Array<{ run_id: string; started_at: string; pass_rate: number; total: number }>;
    };
    return { runs: reporterMod.listReports() };
  });

  app.get('/admin/coverage/runs/:runId', async (req, reply) => {
    const { runId } = req.params as { runId: string };
    const reporterUrl = new URL('../../coverage/reporter.js', import.meta.url).href;
    const reporterMod = await import(reporterUrl) as { loadReport: (id: string) => unknown | null };
    const report = reporterMod.loadReport(runId);
    if (!report) {
      reply.status(404).send({ error: 'NOT_FOUND', message: `No run with id ${runId}` });
      return;
    }
    return report;
  });

  // Production message ingestion (Phase 4) — accepts a list of real user
  // messages (e.g. from a prod log scrape or CSV export) and classifies each,
  // mapping to the closest existing intent in intents.json. Used to:
  //   1. Verify our taxonomy covers real-world phrasings (>= 95% should map)
  //   2. Discover NEW question shapes that need new intents added
  //
  // Does NOT mutate intents.json — output is a report you eyeball, then
  // manually add to intents.json (or run the generator on the uncovered set).
  app.post('/admin/coverage/ingest', async (req, reply) => {
    const body = (req.body ?? {}) as {
      messages?: Array<string | { text: string; metadata?: Record<string, unknown> }>;
    };
    const rawMessages = Array.isArray(body.messages) ? body.messages : [];
    const messages = rawMessages
      .map((m) => (typeof m === 'string' ? { text: m, metadata: undefined } : m))
      .filter((m) => m && typeof m.text === 'string' && m.text.trim().length > 0);

    if (messages.length === 0) {
      reply.status(400).send({ error: 'NO_MESSAGES', message: 'Provide a non-empty messages array' });
      return;
    }
    if (messages.length > 2000) {
      reply.status(400).send({ error: 'TOO_MANY', message: 'Max 2000 messages per ingest call' });
      return;
    }

    try {
      // Pure classifier-only ingestion — no LLM cost, deterministic, ~50µs/msg.
      const aiCoreUrl = new URL('@grace/ai-core', import.meta.url).href;
      const { classifyMessage } = await import(aiCoreUrl) as typeof import('@grace/ai-core');
      const suiteUrl = new URL('../../coverage/suite.js', import.meta.url).href;
      const suiteMod = await import(suiteUrl) as {
        loadIntents: () => { intents: Array<{ id: string; domain: string; subtopic: string; expected_intent: string; safety_level: string; variations: string[] }> };
      };
      const intentsFile = suiteMod.loadIntents();

      const classified = messages.map((m) => {
        const intent = classifyMessage(m.text).type;
        // Find candidate intents for this MessageType — they cover this
        // question shape. If none match, flag as "uncovered taxonomy gap".
        const candidates = intentsFile.intents
          .filter((i) => i.expected_intent === intent)
          .map((i) => ({ id: i.id, domain: i.domain, subtopic: i.subtopic }));
        return {
          text: m.text.slice(0, 280),
          classified_intent: intent,
          candidate_intent_ids: candidates.slice(0, 5).map((c) => c.id),
          covered: candidates.length > 0,
        };
      });

      const total = classified.length;
      const covered = classified.filter((c) => c.covered).length;
      const byClassifiedIntent = classified.reduce<Record<string, number>>((acc, c) => {
        acc[c.classified_intent] = (acc[c.classified_intent] ?? 0) + 1;
        return acc;
      }, {});
      const uncovered = classified.filter((c) => !c.covered);

      return {
        total,
        covered,
        coverage_pct: total > 0 ? Math.round((covered / total) * 1000) / 10 : 0,
        by_classified_intent: byClassifiedIntent,
        uncovered_examples: uncovered.slice(0, 30).map((u) => ({
          text: u.text,
          classified_intent: u.classified_intent,
        })),
        classified,
      };
    } catch (err) {
      app.log.error({ err }, 'coverage.ingest.failed');
      reply.status(500).send({ error: 'INGEST_FAILED', message: err instanceof Error ? err.message : String(err) });
    }
  });

  // ─── Research corpus (Phase 17 — real-world data) ─────────────────────────
  // Pipeline: scrape Reddit → ingest → classify → replay → grade → LLM-eval
  //           failures only → admin review → promote to intents.json
  // Storage: real_data_corpus table (migration 20260601000001).

  /** Manual trigger for the full pipeline (same code path as the weekly cron). */
  app.post('/admin/research/scrape', async (req, reply) => {
    const body = (req.body ?? {}) as {
      subreddits?: string[];
      limit?: number;
      sort?: 'top' | 'new' | 'hot';
      time?: 'hour' | 'day' | 'week' | 'month' | 'year' | 'all';
      concurrency?: number;
      skip_eval?: boolean;
    };
    if (!deps.llm) {
      reply.status(503).send({ error: 'NO_LLM', message: 'LLM provider not configured' });
      return;
    }
    try {
      const { scrapeMultiple, DEFAULT_SUBREDDITS } = await import('../research/reddit-scraper.js');
      const { CorpusService, scrapedPostToIngestInput } = await import('../research/corpus.service.js');

      const subs = body.subreddits && body.subreddits.length > 0
        ? body.subreddits
        : [...DEFAULT_SUBREDDITS];
      const scraped = await scrapeMultiple(subs, {
        limit: body.limit ?? 50,
        sort: body.sort ?? 'top',
        time: body.time ?? 'week',
      });
      const allPosts = scraped.flatMap((s) => s.posts);
      const scrapeErrors = scraped
        .filter((s) => s.error)
        .map((s) => ({ subreddit: s.subreddit, error: s.error }));

      const corpus = new CorpusService({ pool: deps.pool, llm: deps.llm, logger: app.log as never });
      const ingest = await corpus.ingestPosts(allPosts.map(scrapedPostToIngestInput));
      // The pipeline only processes NEW rows; if nothing was inserted we
      // still re-run classify/replay on any rows that haven't been processed
      // yet (rowIds = undefined → "all rows that match the WHERE filter").
      const newRowIds = ingest.insertedIds.length > 0 ? ingest.insertedIds : undefined;
      const classified = await corpus.classifyAndCheckCoverage(newRowIds);
      const replayed = await corpus.replayAndGrade(newRowIds, { concurrency: body.concurrency ?? 3 });
      const evaluated = body.skip_eval ? { evaluated: 0 } : await corpus.evaluateFailures(newRowIds);

      return {
        ok: true,
        scraped_subreddits: subs,
        scrape_errors: scrapeErrors,
        scraped_posts: allPosts.length,
        inserted: ingest.insertedIds.length,
        deduped: ingest.deduped,
        classified: classified.classified,
        replayed: replayed.replayed,
        evaluated: evaluated.evaluated,
      };
    } catch (err) {
      app.log.error({ err }, 'research.scrape.failed');
      reply.status(500).send({ error: 'SCRAPE_FAILED', message: err instanceof Error ? err.message : String(err) });
    }
  });

  /** Manual upload — FB / forum / app-review CSV that the admin pastes in. */
  app.post('/admin/research/upload', async (req, reply) => {
    const body = (req.body ?? {}) as {
      messages?: Array<{
        text: string;
        source_url?: string;
        source_subreddit?: string;
        source_type?: 'csv_upload' | 'manual';
      }>;
      skip_eval?: boolean;
    };
    const msgs = body.messages ?? [];
    if (msgs.length === 0) {
      reply.status(400).send({ error: 'NO_MESSAGES' });
      return;
    }
    if (msgs.length > 1_000) {
      reply.status(400).send({ error: 'TOO_MANY', message: 'Max 1000 messages per upload' });
      return;
    }
    if (!deps.llm) {
      reply.status(503).send({ error: 'NO_LLM' });
      return;
    }
    try {
      const { CorpusService } = await import('../research/corpus.service.js');
      const { createHash } = await import('node:crypto');
      const corpus = new CorpusService({ pool: deps.pool, llm: deps.llm, logger: app.log as never });
      const inputs = msgs
        .filter((m) => typeof m.text === 'string' && m.text.trim().length > 30)
        .map((m) => {
          const normalized = m.text.toLowerCase().replace(/\s+/g, ' ').trim();
          const content_hash = createHash('sha256').update(normalized).digest('hex');
          return {
            raw_text: m.text.trim(),
            content_hash,
            source_type: m.source_type ?? ('csv_upload' as const),
            ...(m.source_url ? { source_url: m.source_url } : {}),
            ...(m.source_subreddit ? { source_subreddit: m.source_subreddit } : {}),
          };
        });
      const ingest = await corpus.ingestPosts(inputs);
      const rowIds = ingest.insertedIds.length > 0 ? ingest.insertedIds : undefined;
      const classified = await corpus.classifyAndCheckCoverage(rowIds);
      const replayed = await corpus.replayAndGrade(rowIds);
      const evaluated = body.skip_eval ? { evaluated: 0 } : await corpus.evaluateFailures(rowIds);
      return {
        ok: true,
        received: msgs.length,
        inserted: ingest.insertedIds.length,
        deduped: ingest.deduped,
        classified: classified.classified,
        replayed: replayed.replayed,
        evaluated: evaluated.evaluated,
      };
    } catch (err) {
      app.log.error({ err }, 'research.upload.failed');
      reply.status(500).send({ error: 'UPLOAD_FAILED', message: err instanceof Error ? err.message : String(err) });
    }
  });

  /** Paginated corpus browse. */
  app.get('/admin/research/corpus', async (req) => {
    const q = (req.query ?? {}) as {
      subreddit?: string;
      intent?: string;
      covered?: string;
      status?: string;
      limit?: string;
      offset?: string;
    };
    const { CorpusService } = await import('../research/corpus.service.js');
    const corpus = new CorpusService({ pool: deps.pool, llm: deps.llm as never, logger: app.log as never });
    return corpus.listCorpus({
      ...(q.subreddit ? { subreddit: q.subreddit } : {}),
      ...(q.intent ? { intent: q.intent } : {}),
      ...(q.covered !== undefined ? { covered: q.covered === 'true' } : {}),
      ...(q.status ? { status: q.status } : {}),
      ...(q.limit ? { limit: parseInt(q.limit, 10) } : {}),
      ...(q.offset ? { offset: parseInt(q.offset, 10) } : {}),
    });
  });

  /** Single-row detail with full replay + eval data. */
  app.get('/admin/research/corpus/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const rowId = parseInt(id, 10);
    if (!Number.isFinite(rowId)) {
      reply.status(400).send({ error: 'BAD_ID' });
      return;
    }
    const { CorpusService } = await import('../research/corpus.service.js');
    const corpus = new CorpusService({ pool: deps.pool, llm: deps.llm as never, logger: app.log as never });
    const row = await corpus.getCorpusRow(rowId);
    if (!row) {
      reply.status(404).send({ error: 'NOT_FOUND' });
      return;
    }
    return row;
  });

  /** Promote a row: marks status + returns a suggested intents.json entry. */
  app.post('/admin/research/corpus/:id/promote', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { notes?: string };
    const rowId = parseInt(id, 10);
    if (!Number.isFinite(rowId)) {
      reply.status(400).send({ error: 'BAD_ID' });
      return;
    }
    const { CorpusService } = await import('../research/corpus.service.js');
    const corpus = new CorpusService({ pool: deps.pool, llm: deps.llm as never, logger: app.log as never });
    const row = await corpus.getCorpusRow(rowId);
    if (!row) {
      reply.status(404).send({ error: 'NOT_FOUND' });
      return;
    }
    await corpus.setAdminStatus(rowId, 'promoted_to_intent', body.notes);
    // Suggest a new intents.json entry shape — admin reviews and commits.
    const text = (row.raw_text as string) ?? '';
    const intent = (row.classified_intent as string) ?? 'general';
    const subtopic = (row.intent_id_match as string) ?? 'unknown';
    return {
      ok: true,
      suggested_entry: {
        id: `prod.${intent}.${rowId}`,
        domain: intent,
        subtopic,
        variations: [text.slice(0, 200)],
        expected_intent: intent,
        expected_tool_calls: [],
        must_include: [],
        must_not_include: ['absolutely critical', 'i apologize for the confusion'],
        safety_level: 'informational',
        journey_stages: [],
        source: 'production_log',
        source_url: row.source_url ?? null,
      },
    };
  });

  /** Reject a row (spam / off-topic / not-actionable). */
  app.post('/admin/research/corpus/:id/reject', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { notes?: string };
    const rowId = parseInt(id, 10);
    if (!Number.isFinite(rowId)) {
      reply.status(400).send({ error: 'BAD_ID' });
      return;
    }
    const { CorpusService } = await import('../research/corpus.service.js');
    const corpus = new CorpusService({ pool: deps.pool, llm: deps.llm as never, logger: app.log as never });
    await corpus.setAdminStatus(rowId, 'rejected', body.notes);
    return { ok: true };
  });

  /** The prioritized improvement roadmap. */
  app.get('/admin/research/coverage-gaps', async () => {
    const { CorpusService } = await import('../research/corpus.service.js');
    const corpus = new CorpusService({ pool: deps.pool, llm: deps.llm as never, logger: app.log as never });
    return corpus.coverageGaps();
  });

  /**
   * GET /admin/production-issues/clusters
   * 2026-06-05 Phase C: cluster pending production_issues by user-message
   * similarity. Returns the top recurring failure patterns so we can grow
   * fast-path coverage without manual log diving.
   *
   * Query params:
   *   ?window=14         days back to include (default 14, max 90)
   *   ?threshold=0.35    Jaccard similarity threshold (default 0.35)
   *   ?max=20            max clusters returned (default 20)
   *   ?min=2             min cluster size to surface (default 2)
   */
  app.get('/admin/production-issues/clusters', async (req) => {
    const query = (req.query ?? {}) as Record<string, string | undefined>;
    const windowDays = Math.min(90, Math.max(1, parseInt(query['window'] ?? '14', 10) || 14));
    const threshold = (() => {
      const t = parseFloat(query['threshold'] ?? '0.35');
      return Number.isFinite(t) && t > 0 && t < 1 ? t : 0.35;
    })();
    const maxClusters = Math.min(100, Math.max(1, parseInt(query['max'] ?? '20', 10) || 20));
    const minClusterSize = Math.max(1, parseInt(query['min'] ?? '2', 10) || 2);

    const { ProductionIssuesClusterer } = await import('../services/production-issues-clusterer.js');
    const clusterer = new ProductionIssuesClusterer(deps.pool, app.log as never);
    const clusters = await clusterer.cluster({
      windowDays,
      similarityThreshold: threshold,
      maxClusters,
      minClusterSize,
    });
    return { window_days: windowDays, threshold, count: clusters.length, clusters };
  });

  /**
   * POST /admin/research/auto-fix
   * Manual trigger for the auto-fix pipeline.
   * Same engine as the every-3-days cron — useful for on-demand runs.
   * Body: { sample_size?: number, dry_run?: boolean }
   */
  app.post('/admin/research/auto-fix', async (req) => {
    const body = (req.body ?? {}) as { sample_size?: number; dry_run?: boolean };
    const sampleSize = Math.max(1, Math.min(200, body.sample_size ?? 60));
    const dryRun = body.dry_run ?? false;
    const { ResearchAutoFix } = await import('../research/auto-fix.js');
    const autoFix = new ResearchAutoFix({
      pool: deps.pool,
      llm: deps.llm as never,
      logger: app.log as never,
      redis: deps.redis as never,
      promptOptimizer: deps.promptOptimizer as never,
    });
    const report = await autoFix.run({ sampleSize, dryRun });
    return report;
  });
}
