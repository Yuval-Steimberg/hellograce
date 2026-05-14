import type { Pool } from 'pg';
import type { LLMProvider } from '@grace/shared';
import type { Logger } from 'pino';

const SAFE_FALLBACK_SNIPPET = 'could you share a bit more about what you\'re hoping to learn';
const MIN_PROMPT_LENGTH = 200;

// Safety phrases that must survive in any auto-generated prompt.
const REQUIRED_SAFETY_PHRASES = ['clinician', 'prescribing', 'doctor'];

interface FeedbackRow {
  assistant_message: string | null;
  user_message: string | null;
  comment: string | null;
}

export class PromptOptimizer {
  constructor(
    private pool: Pool,
    private llm: LLMProvider,
    private logger: Logger,
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
        await this.gatherSignals(7);

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
      await this.saveVersion(result.prompt, result.analysis, safe);

      if (safe) {
        this.logger.info('prompt_optimizer.auto_activated_new_prompt');
      } else {
        this.logger.warn(
          { reason: result.analysis },
          'prompt_optimizer.saved_as_draft_failed_safety_check',
        );
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
         f.comment
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
       LIMIT 20`,
      [since],
    );

    const { rows: positiveRows } = await this.pool.query<FeedbackRow>(
      `SELECT
         a.content AS assistant_message,
         u.content AS user_message,
         NULL AS comment
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
       LIMIT 10`,
      [since],
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
      const fb = r.comment ? ` | Feedback: "${r.comment}"` : '';
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

PERFORMANCE DATA — LAST 7 DAYS:
- Total user messages: ${signals.totalMessages}
- Times safe fallback fired (Grace couldn't respond properly): ${signals.fallbackCount}
- Negative feedback instances (👎): ${signals.negativeSamples.length}

NEGATIVE FEEDBACK EXAMPLES (what went wrong):
${negativeBlock}

POSITIVE EXAMPLES (what's working well — preserve these patterns):
${positiveBlock}

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

  // Basic safety check before auto-activating.
  private isSafe(newPrompt: string, currentPrompt: string): boolean {
    if (newPrompt.length < MIN_PROMPT_LENGTH) return false;

    // Must contain at least one safety reference.
    const hasSafety = REQUIRED_SAFETY_PHRASES.some((p) =>
      newPrompt.toLowerCase().includes(p),
    );
    if (!hasSafety) return false;

    // Reject if it grew more than 2x (likely hallucinated junk).
    if (newPrompt.length > currentPrompt.length * 2) return false;

    return true;
  }

  private async saveVersion(content: string, analysis: string, autoActivate: boolean): Promise<void> {
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
  }
}
