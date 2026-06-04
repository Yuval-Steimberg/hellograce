/**
 * Production issue capture service — Layer 4 of the defense-in-depth model.
 *
 * Every time a guard fires a regen, a safe fallback ships, content gets
 * sanitized at the Twilio sender, or a user reacts 👎, we capture the full
 * turn here. The table is the raw feed for the "promote to regression test"
 * workflow.
 *
 * Why this exists: every fix we ship is reactive — a user reports a bad
 * response, I add a regex, the next failure manifests differently and slips
 * through. To break the cycle, EVERY failure must be captured automatically
 * so we can review and convert to regression tests.
 *
 * Captures are best-effort: a DB failure here NEVER blocks the user-facing
 * response. All inserts are fire-and-forget with .catch logged.
 */

import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import type { Logger } from 'pino';

export type IssueTrigger =
  | 'behavioral_violation'   // behavioral guard fired regen
  | 'safe_fallback'          // pipeline exhausted, canned text shipped
  | 'content_violation_at_sender' // twilio.sanitize caught something
  | 'user_thumbs_down'       // RLHF 👎 reaction
  | 'truncation_cascade'     // generate truncated, regen also truncated
  | 'topic_drift'            // relevance / topic guard fired regen
  | 'phrase_repetition'      // content checker caught repeating phrase
  | 'long_response_chopped'; // quality guard forced regen

export interface CaptureInput {
  userId: string;
  conversationId?: string | null;
  userMessage: string;
  graceResponse?: string | null;
  trigger: IssueTrigger;
  violationCodes?: string[];
  context?: Record<string, unknown>;
}

export interface PendingIssue {
  id: number;
  user_id: string;
  conversation_id: string | null;
  user_message: string;
  grace_response: string | null;
  trigger: IssueTrigger;
  violation_codes: string[] | null;
  context: Record<string, unknown> | null;
  status: 'pending' | 'promoted' | 'dismissed' | 'duplicate';
  promoted_scenario_id: string | null;
  reviewed_by: string | null;
  reviewed_at: Date | null;
  created_at: Date;
}

// 24h dedupe window — the same user hitting the same trigger with the same
// message text within 24h is treated as a single issue. Prevents the issues
// table from filling up when a user retries a failing pattern. Enforced via
// the SELECT query in capture() that looks back 24 hours.

export class ProductionIssuesService {
  constructor(
    private readonly pool: Pool,
    private readonly logger: Logger,
  ) {}

  /**
   * Capture a production issue. Fire-and-forget — the returned promise
   * resolves to true on success, false on any error. NEVER throws so it
   * can be called from anywhere on the hot path.
   */
  async capture(input: CaptureInput): Promise<boolean> {
    try {
      const dedupeHash = this.computeDedupeHash(input);
      // Check the dedupe window first — if there's a matching issue within
      // 24h, skip this insert. Bounded read by index on dedupe_hash.
      const existing = await this.pool.query<{ id: number }>(
        `SELECT id FROM production_issues
         WHERE dedupe_hash = $1
           AND created_at > now() - INTERVAL '24 hours'
         LIMIT 1`,
        [dedupeHash],
      );
      if (existing.rows.length > 0) {
        this.logger.debug(
          { userId: input.userId, trigger: input.trigger, dedupedAgainst: existing.rows[0]!.id },
          'production_issues.deduped',
        );
        return true;
      }
      await this.pool.query(
        `INSERT INTO production_issues
           (user_id, conversation_id, user_message, grace_response, trigger,
            violation_codes, context, dedupe_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          input.userId,
          input.conversationId ?? null,
          input.userMessage,
          input.graceResponse ?? null,
          input.trigger,
          input.violationCodes ?? null,
          input.context ? JSON.stringify(input.context) : null,
          dedupeHash,
        ],
      );
      this.logger.info(
        { userId: input.userId, trigger: input.trigger, codes: input.violationCodes },
        'production_issues.captured',
      );
      return true;
    } catch (err) {
      this.logger.warn(
        { err: err instanceof Error ? err.message : String(err), trigger: input.trigger },
        'production_issues.capture_failed',
      );
      return false;
    }
  }

  /**
   * Wrapped capture for the hot path — returns the promise but caller can
   * safely ignore. Use `void svc.captureFireAndForget(...)`.
   */
  captureFireAndForget(input: CaptureInput): Promise<boolean> {
    return this.capture(input);
  }

  /**
   * List pending issues for human review. Returns most recent first.
   * `limit` defaults to 50.
   */
  async listPending(opts: { limit?: number; trigger?: IssueTrigger } = {}): Promise<PendingIssue[]> {
    const limit = Math.min(opts.limit ?? 50, 200);
    const params: unknown[] = [];
    let sql = `SELECT * FROM production_issues WHERE status = 'pending'`;
    if (opts.trigger) {
      params.push(opts.trigger);
      sql += ` AND trigger = $${params.length}`;
    }
    params.push(limit);
    sql += ` ORDER BY created_at DESC LIMIT $${params.length}`;
    const { rows } = await this.pool.query<PendingIssue>(sql, params);
    return rows;
  }

  /**
   * Aggregate counts per trigger over a window. Drives the admin dashboard
   * "what's failing this week" view.
   */
  async summaryByTrigger(windowHours = 24): Promise<Array<{ trigger: string; count: number }>> {
    const { rows } = await this.pool.query<{ trigger: string; count: string }>(
      `SELECT trigger, count(*)::text
       FROM production_issues
       WHERE created_at > now() - ($1 || ' hours')::interval
       GROUP BY trigger
       ORDER BY count(*) DESC`,
      [String(windowHours)],
    );
    return rows.map((r) => ({ trigger: r.trigger, count: parseInt(r.count, 10) }));
  }

  /**
   * Mark an issue as promoted to a regression test. Records who promoted it
   * and the resulting scenario id so we can trace test cases back to the
   * production failure that motivated them.
   */
  async markPromoted(
    issueId: number,
    scenarioId: string,
    reviewedBy: string,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE production_issues
       SET status = 'promoted',
           promoted_scenario_id = $2,
           reviewed_by = $3,
           reviewed_at = now()
       WHERE id = $1`,
      [issueId, scenarioId, reviewedBy],
    );
  }

  /** Mark as dismissed (not a real issue, or known limitation). */
  async markDismissed(issueId: number, reviewedBy: string): Promise<void> {
    await this.pool.query(
      `UPDATE production_issues
       SET status = 'dismissed', reviewed_by = $2, reviewed_at = now()
       WHERE id = $1`,
      [issueId, reviewedBy],
    );
  }

  /**
   * Stable dedupe hash — same (user, trigger, normalized message) collapse
   * into one issue within the 24h window. Normalizing the message strips
   * whitespace + case so "Hello?" and "hello?" dedupe together.
   */
  private computeDedupeHash(input: CaptureInput): string {
    const normalized = input.userMessage.trim().toLowerCase().replace(/\s+/g, ' ');
    return createHash('sha256')
      .update(`${input.userId}|${input.trigger}|${normalized}`)
      .digest('hex')
      .slice(0, 32);
  }
}
