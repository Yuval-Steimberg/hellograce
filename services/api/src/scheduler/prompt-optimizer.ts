import type { Pool } from 'pg';
import type { LLMProvider } from '@grace/shared';
import type { Logger } from 'pino';

const SAFE_FALLBACK_SNIPPET = 'could you share a bit more about what you\'re hoping to learn';
const MIN_PROMPT_LENGTH = 200;

// Phrases the canonical Grace prompt depends on. If the optimizer's output
// drops ANY of these, we reject auto-activation and save as draft only.
// The list reflects non-negotiable behavior contracts surfaced by the
// WhatsApp pilot QA + Phase 8 master-prompt work.
const REQUIRED_SAFETY_PHRASES = ['988', '911', 'doctor'];
const REQUIRED_BEHAVIOR_PHRASES = [
  'BANNED',                       // The banned-phrase list (Phase 7+8 explicit fixes)
  'graceglp.com/settings',        // Settings management URL must remain literal
  'GLP-1',                        // Product identity
];

// Samples + lookback window. Bumped from (20/10/7d) → (50/25/14d) so the
// optimizer sees more of the actual user signal, per user request.
const NEG_SAMPLE_LIMIT = 50;
const POS_SAMPLE_LIMIT = 25;
const LOOKBACK_DAYS = 14;

export interface OptimizerRunReport {
  activated: boolean;
  version: number;
  analysis: string;
  stats: {
    totalMessages: number;
    negativeCount: number;
    positiveCount: number;
    fallbackCount: number;
    satisfactionPct: number | null;
  };
  /** Set when the prompt failed the safety gate and was saved as draft only. */
  draftReason?: string;
}

export interface PromptOptimizerHooks {
  /** Called after a new prompt is auto-activated. Used to hot-reload AIService. */
  onPromptActivated?: (content: string) => void | Promise<void>;
  /** Called at the end of every run with a summary report. Use to send admin notifications. */
  onRunComplete?: (report: OptimizerRunReport) => void | Promise<void>;
}

interface FeedbackRow {
  assistant_message: string | null;
  user_message: string | null;
  comment: string | null;
  rating?: number;
}

export class PromptOptimizer {
  constructor(
    private pool: Pool,
    private llm: LLMProvider,
    private logger: Logger,
    private hooks?: PromptOptimizerHooks,
  ) {}

  async run(): Promise<void> {
    this.logger.info('prompt_optimizer.started');

    try {
      const currentPrompt = await this.getActivePrompt();
      if (!currentPrompt) {
        this.logger.warn('prompt_optimizer.no_active_prompt');
        return;
      }

      const { negativeSamples, positiveSamples, fallbackCount, totalMessages } =
        await this.gatherSignals(LOOKBACK_DAYS);

      // Skip if there's not enough signal to learn from.
      if (totalMessages < 10 && negativeSamples.length === 0) {
        this.logger.info({ totalMessages }, 'prompt_optimizer.insufficient_data');
        return;
      }

      this.logger.info(
        { negativeSamples: negativeSamples.length, positiveSamples: positiveSamples.length, fallbackCount, totalMessages },
        'prompt_optimizer.analyzing',
      );

      const result = await this.generateImprovedPrompt(currentPrompt, {
        negativeSamples,
        positiveSamples,
        fallbackCount,
        totalMessages,
      });

      if (!result) {
        this.logger.warn('prompt_optimizer.generation_failed');
        return;
      }

      const safe = this.isSafe(result.prompt, currentPrompt);
      const version = await this.saveVersion(result.prompt, result.analysis, safe);

      const stats = {
        totalMessages,
        negativeCount: negativeSamples.length,
        positiveCount: positiveSamples.length,
        fallbackCount,
        satisfactionPct: (positiveSamples.length + negativeSamples.length) > 0
          ? Math.round((positiveSamples.length / (positiveSamples.length + negativeSamples.length)) * 100)
          : null,
      };

      if (safe) {
        this.logger.info('prompt_optimizer.auto_activated_new_prompt');
        if (this.hooks?.onPromptActivated) {
          try {
            await this.hooks.onPromptActivated(result.prompt);
          } catch (err) {
            this.logger.error({ err }, 'prompt_optimizer.hot_reload_failed');
          }
        }
      } else {
        this.logger.warn(
          { reason: result.analysis },
          'prompt_optimizer.saved_as_draft_failed_safety_check',
        );
      }

      if (this.hooks?.onRunComplete) {
        try {
          await this.hooks.onRunComplete({
            activated: safe,
            version,
            analysis: result.analysis,
            stats,
            draftReason: safe ? undefined : 'Safety gate: a required safety or behavior phrase was dropped. Saved as draft for manual review.',
          });
        } catch (err) {
          this.logger.error({ err }, 'prompt_optimizer.report_hook_failed');
        }
      }
    } catch (err) {
      this.logger.error({ err }, 'prompt_optimizer.failed');
    }
  }

  private async getActivePrompt(): Promise<string | null> {
    const { rows } = await this.pool.query<{ content: string }>(
      `SELECT content FROM prompts WHERE active = TRUE ORDER BY created_at DESC LIMIT 1`,
    );
    return rows[0]?.content ?? null;
  }

  private async gatherSignals(days: number) {
    const since = new Date(Date.now() - days * 24 * 3_600_000);

    // Negative feedback: join feedback → message (assistant reply) → preceding user message
    const { rows: negativeRows } = await this.pool.query<FeedbackRow>(
      `SELECT
         a.content AS assistant_message,
         u.content AS user_message,
         f.comment,
         f.rating
       FROM feedback f
       JOIN messages a ON a.id = f.message_id
       LEFT JOIN LATERAL (
         SELECT content FROM messages
         WHERE conversation_id = a.conversation_id
           AND role = 'user'
           AND created_at < a.created_at
         ORDER BY created_at DESC LIMIT 1
       ) u ON TRUE
       WHERE f.rating = -1 AND f.created_at > $1
       ORDER BY f.created_at DESC
       LIMIT $2`,
      [since, NEG_SAMPLE_LIMIT],
    );

    const { rows: positiveRows } = await this.pool.query<FeedbackRow>(
      `SELECT
         a.content AS assistant_message,
         u.content AS user_message,
         f.comment,
         f.rating
       FROM feedback f
       JOIN messages a ON a.id = f.message_id
       LEFT JOIN LATERAL (
         SELECT content FROM messages
         WHERE conversation_id = a.conversation_id
           AND role = 'user'
           AND created_at < a.created_at
         ORDER BY created_at DESC LIMIT 1
       ) u ON TRUE
       WHERE f.rating = 1 AND f.created_at > $1
       ORDER BY f.created_at DESC
       LIMIT $2`,
      [since, POS_SAMPLE_LIMIT],
    );

    const { rows: fallbackRows } = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM messages
       WHERE role = 'assistant'
         AND content ILIKE $1
         AND created_at > $2`,
      [`%${SAFE_FALLBACK_SNIPPET}%`, since],
    );

    const { rows: totalRows } = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM messages
       WHERE role = 'user' AND created_at > $1`,
      [since],
    );

    return {
      negativeSamples: negativeRows,
      positiveSamples: positiveRows,
      fallbackCount: parseInt(fallbackRows[0]?.count ?? '0', 10),
      totalMessages: parseInt(totalRows[0]?.count ?? '0', 10),
    };
  }

  private async generateImprovedPrompt(
    currentPrompt: string,
    signals: {
      negativeSamples: FeedbackRow[];
      positiveSamples: FeedbackRow[];
      fallbackCount: number;
      totalMessages: number;
    },
  ): Promise<{ prompt: string; analysis: string } | null> {
    const formatSample = (r: FeedbackRow) => {
      const user = r.user_message ? `User: "${r.user_message.slice(0, 150)}"` : '';
      const asst = r.assistant_message ? `Grace: "${r.assistant_message.slice(0, 200)}"` : '';
      // Show the emoji signal so Gemini knows what the user reacted with,
      // and the written comment when provided.
      const emojiLabel = (r.rating ?? 0) > 0 ? '👍' : '👎';
      const fb = r.comment
        ? ` | ${emojiLabel} + comment: "${r.comment}"`
        : ` | ${emojiLabel} (no comment)`;
      return `${user}\n  ${asst}${fb}`;
    };

    const negativeBlock = signals.negativeSamples.length > 0
      ? signals.negativeSamples.map(formatSample).join('\n\n')
      : 'None in this period.';

    const positiveBlock = signals.positiveSamples.length > 0
      ? signals.positiveSamples.map(formatSample).join('\n\n')
      : 'None in this period.';

    const resp = await this.llm.generate({
      messages: [
        {
          role: 'system',
          content: `You are an expert prompt engineer for Grace, a WhatsApp AI companion for people on GLP-1 medications (Ozempic, Wegovy, Mounjaro, Zepbound).

Your job: analyze real user feedback, identify what's failing and what's working, then rewrite the system prompt to fix the failures while preserving the successes.

Hard rules for the improved prompt:
- Keep responses warm, concise — 1 to 3 short sentences max (WhatsApp/SMS, no markdown)
- MUST keep safety language: always refer to prescribing clinician for dose/medical questions
- MUST NOT change the AI's core identity or make it claim to be human
- Length must be between 80% and 150% of the current prompt length
- Focus on fixing the specific failure patterns you identify

Respond ONLY with valid JSON:
{"analysis": "2-3 sentences identifying the key failure patterns and what you changed", "prompt": "the full improved system prompt text"}`,
        },
        {
          role: 'user',
          content: `CURRENT SYSTEM PROMPT:
${currentPrompt}

PERFORMANCE DATA — LAST ${LOOKBACK_DAYS} DAYS:
- Total user messages: ${signals.totalMessages}
- Times safe fallback fired (Grace couldn't respond properly): ${signals.fallbackCount}
- 👍 ratings: ${signals.positiveSamples.length} | 👎 ratings: ${signals.negativeSamples.length}
- Satisfaction score: ${signals.positiveSamples.length + signals.negativeSamples.length > 0
    ? `${Math.round((signals.positiveSamples.length / (signals.positiveSamples.length + signals.negativeSamples.length)) * 100)}% positive`
    : 'no ratings yet'}

NEGATIVE FEEDBACK (what went wrong — 👎 emoji ratings AND written comments):
${negativeBlock}

POSITIVE EXAMPLES (what's working well — 👍 emoji ratings — preserve these patterns):
${positiveBlock}

The 👎 emoji ratings with no comment mean users were dissatisfied but didn't explain why — look at the Grace response shown and infer what made it feel off (too long, too robotic, wrong tone, irrelevant, etc.).

Analyze the failures and produce an improved prompt that fixes them.`,
        },
      ],
      temperature: 0.3,
      maxOutputTokens: 2048,
      responseFormat: 'json',
    });

    try {
      const parsed = JSON.parse(resp.text) as { analysis?: string; prompt?: string };
      if (!parsed.prompt || parsed.prompt.length < MIN_PROMPT_LENGTH) return null;
      if (!parsed.analysis) return null;
      return { prompt: parsed.prompt, analysis: parsed.analysis };
    } catch {
      this.logger.warn({ raw: resp.text.slice(0, 300) }, 'prompt_optimizer.parse_failed');
      return null;
    }
  }

  // Strict safety gate before auto-activating. Bias is heavily toward
  // saving-as-draft — auto-activation requires every guardrail to survive.
  private isSafe(newPrompt: string, currentPrompt: string): boolean {
    if (newPrompt.length < MIN_PROMPT_LENGTH) return false;

    const lower = newPrompt.toLowerCase();

    // ALL safety phrases must survive — losing any one is grounds for rejection.
    for (const p of REQUIRED_SAFETY_PHRASES) {
      if (!lower.includes(p.toLowerCase())) {
        this.logger.warn({ missing: p }, 'prompt_optimizer.safety_phrase_dropped');
        return false;
      }
    }

    // Non-negotiable behavior anchors must survive too.
    for (const p of REQUIRED_BEHAVIOR_PHRASES) {
      if (!newPrompt.includes(p)) {
        this.logger.warn({ missing: p }, 'prompt_optimizer.behavior_anchor_dropped');
        return false;
      }
    }

    // Reject if it grew more than 1.5x or shrunk to less than 70% of current.
    // Larger drift means a structural rewrite — review manually instead.
    if (newPrompt.length > currentPrompt.length * 1.5) return false;
    if (newPrompt.length < currentPrompt.length * 0.7) return false;

    return true;
  }

  private async saveVersion(content: string, analysis: string, autoActivate: boolean): Promise<number> {
    const { rows } = await this.pool.query<{ max: number | null }>(
      `SELECT MAX(version) AS max FROM prompts`,
    );
    const nextVersion = (rows[0]?.max ?? 0) + 1;
    const notes = `Auto-generated by PromptOptimizer v${nextVersion} — ${analysis}`;

    if (autoActivate) {
      // Deactivate current, insert new active version atomically.
      await this.pool.query('BEGIN');
      try {
        await this.pool.query(`UPDATE prompts SET active = FALSE WHERE active = TRUE`);
        await this.pool.query(
          `INSERT INTO prompts (version, content, active, notes, auto_generated)
           VALUES ($1, $2, TRUE, $3, TRUE)`,
          [nextVersion, content, notes],
        );
        await this.pool.query('COMMIT');
      } catch (err) {
        await this.pool.query('ROLLBACK');
        throw err;
      }
    } else {
      // Save as inactive draft for manual review in admin dashboard.
      await this.pool.query(
        `INSERT INTO prompts (version, content, active, notes, auto_generated)
         VALUES ($1, $2, FALSE, $3, TRUE)`,
        [nextVersion, content, notes],
      );
    }

    return nextVersion;
  }
}
