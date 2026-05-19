import type { Pool } from 'pg';
import type { LLMProvider } from '@grace/shared';
import type { Logger } from 'pino';

// All safe fallback variants used by getNextSafeFallback() in orchestrator.ts.
// Keep in sync with SAFE_FALLBACK_TEXTS there.
const SAFE_FALLBACK_SNIPPETS = [
  'Not sure I got all of that',
  'I missed something there',
  "didn't quite follow",
  'make sure I get this right',
  'missed part of what you meant',
];
const MIN_ADDITIONS_LENGTH = 20;

// Phrases that must remain in the COMBINED prompt.
// In practice additions are appended to the base, so these always survive from the base.
const REQUIRED_SAFETY_PHRASES = ['988', '911', 'doctor'];
const REQUIRED_BEHAVIOR_PHRASES = [
  'BANNED',
  'graceglp.com/settings',
  'GLP-1',
];

// Patterns that must NEVER appear in the ADDITIONS text itself.
// These catch the LLM contradicting or overriding critical existing rules.
const FORBIDDEN_ADDITION_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: /suggest.*dose|recommend.*dose|dose.*is.*\d/i, reason: 'dose suggestion override' },
  { re: /ignore.{0,30}(previous|above|existing|rule|instruction)/i, reason: 'ignore-rules injection' },
  { re: /override|disregard|supersede/i, reason: 'override injection' },
  { re: /you (can|may|should) (suggest|recommend|advise).{0,30}(dose|drug|medication|inject)/i, reason: 'medical advice override' },
  { re: /it.{0,10}(is )?(safe|okay|ok|fine) to (take|inject|use|double)/i, reason: 'unsafe safety claim' },
  { re: /no need to.{0,30}(doctor|clinician|prescriber)/i, reason: 'doctor redirect removal' },
  { re: /alcohol.{0,20}(safe|ok|fine|okay|allowed)/i, reason: 'alcohol safety override' },
];

// Samples + lookback window.
const NEG_SAMPLE_LIMIT = 50;
const POS_SAMPLE_LIMIT = 25;
const LOOKBACK_DAYS = 14;

// PostgreSQL advisory lock key — prevents two Fly machines running the optimizer
// simultaneously at 4am UTC. Session-level: held for the life of the DB connection,
// released automatically if the process crashes.
const OPTIMIZER_LOCK_KEY = 987654321;

// Marker used to strip the previous additions block before appending new ones.
const ADDITIONS_MARKER = '\n\n---\n## BEHAVIORAL ADJUSTMENTS (auto-learned from user feedback)\n';

export type OptimizerRunStatus =
  | 'activated'
  | 'draft'
  | 'skipped_lock_held'
  | 'skipped_no_active_prompt'
  | 'skipped_insufficient_data'
  | 'skipped_generation_failed'
  | 'error';

export interface OptimizerRunReport {
  status: OptimizerRunStatus;
  /** True when a new prompt was auto-activated (status === 'activated'). */
  activated: boolean;
  /** Version of the newly-saved prompt. Undefined for skipped/error runs. */
  version?: number;
  /** Free-form explanation of what happened. */
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

    // Use a dedicated DB connection for the advisory lock so it's held for the
    // full duration of the run and released cleanly when we're done.
    const client = await this.pool.connect();
    try {
      // Distributed lock: only one Fly machine runs the optimizer per day.
      // pg_try_advisory_lock returns false immediately if another session holds the key.
      const { rows: lockRows } = await client.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock($1) AS locked',
        [OPTIMIZER_LOCK_KEY],
      );
      if (!lockRows[0]?.locked) {
        this.logger.info('prompt_optimizer.skipped_lock_held_by_other_machine');
        await this.emitReport({
          status: 'skipped_lock_held',
          activated: false,
          analysis: 'Another Grace machine is already running the optimizer this cycle — skipped to avoid duplicate work.',
          stats: emptyStats(),
        });
        return;
      }

      await this.runWithLock(client);
    } catch (err) {
      this.logger.error({ err }, 'prompt_optimizer.failed');
      await this.emitReport({
        status: 'error',
        activated: false,
        analysis: `Optimizer crashed: ${err instanceof Error ? err.message : String(err)}`,
        stats: emptyStats(),
      });
    } finally {
      // Always release the lock and connection, even on crash.
      await client.query('SELECT pg_advisory_unlock($1)', [OPTIMIZER_LOCK_KEY]).catch(() => undefined);
      client.release();
    }
  }

  private async emitReport(report: OptimizerRunReport): Promise<void> {
    if (!this.hooks?.onRunComplete) return;
    try {
      await this.hooks.onRunComplete(report);
    } catch (err) {
      this.logger.error({ err }, 'prompt_optimizer.report_hook_failed');
    }
  }

  private async runWithLock(_client: import('pg').PoolClient): Promise<void> {
    const currentPrompt = await this.getActivePrompt();
    if (!currentPrompt) {
      this.logger.warn('prompt_optimizer.no_active_prompt');
      await this.emitReport({
        status: 'skipped_no_active_prompt',
        activated: false,
        analysis: 'No active prompt in the prompts table. POST /admin/prompts/sync-from-code to seed one.',
        stats: emptyStats(),
      });
      return;
    }

    const { negativeSamples, positiveSamples, fallbackCount, totalMessages } =
      await this.gatherSignals(LOOKBACK_DAYS);

    const stats = {
      totalMessages,
      negativeCount: negativeSamples.length,
      positiveCount: positiveSamples.length,
      fallbackCount,
      satisfactionPct: (positiveSamples.length + negativeSamples.length) > 0
        ? Math.round((positiveSamples.length / (positiveSamples.length + negativeSamples.length)) * 100)
        : null,
    };

    // Skip if there's not enough signal to learn from.
    if (totalMessages < 10 && negativeSamples.length === 0) {
      this.logger.info({ totalMessages }, 'prompt_optimizer.insufficient_data');
      await this.emitReport({
        status: 'skipped_insufficient_data',
        activated: false,
        analysis: `Only ${totalMessages} user message(s) in the last ${LOOKBACK_DAYS} days and zero 👎 ratings — not enough signal to learn from yet. Need ≥10 messages or any 👎 feedback.`,
        stats,
      });
      return;
    }

    this.logger.info(
      { negativeSamples: negativeSamples.length, positiveSamples: positiveSamples.length, fallbackCount, totalMessages },
      'prompt_optimizer.analyzing',
    );

    const result = await this.generateAdditions(currentPrompt, {
      negativeSamples,
      positiveSamples,
      fallbackCount,
      totalMessages,
    });

    if (!result) {
      this.logger.warn('prompt_optimizer.generation_failed');
      await this.emitReport({
        status: 'skipped_generation_failed',
        activated: false,
        analysis: 'Gemini did not return parseable behavioral additions — check Gemini API health and recent logs. The active prompt is unchanged.',
        stats,
      });
      return;
    }

    // Guard: reject additions that contain any forbidden override patterns.
    // This prevents the LLM from contradicting hard safety rules even if the
    // combined prompt still passes the phrase-presence check.
    const forbiddenHit = FORBIDDEN_ADDITION_PATTERNS.find((p) => p.re.test(result.additions));
    if (forbiddenHit) {
      this.logger.warn({ reason: forbiddenHit.reason, additions: result.additions.slice(0, 300) }, 'prompt_optimizer.additions_blocked_forbidden_pattern');
      await this.emitReport({
        status: 'draft',
        activated: false,
        analysis: `Additions blocked — contained a forbidden pattern (${forbiddenHit.reason}). Saved as draft for manual review. The active prompt is unchanged.`,
        stats,
      });
      // Save as draft so it's reviewable but NOT activated.
      await this.saveVersion(`${currentPrompt.replace(new RegExp(`${ADDITIONS_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*$`), '').trimEnd()}${ADDITIONS_MARKER}${result.additions.trim()}`, result.analysis, false);
      return;
    }

    // Strip any previous BEHAVIORAL ADJUSTMENTS block, then append fresh additions.
    const basePrompt = currentPrompt.replace(new RegExp(`${ADDITIONS_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*$`), '').trimEnd();
    const newPrompt = `${basePrompt}${ADDITIONS_MARKER}${result.additions.trim()}`;

    const safe = this.isSafe(newPrompt);
    const version = await this.saveVersion(newPrompt, result.analysis, safe);

    if (safe) {
      this.logger.info('prompt_optimizer.auto_activated_new_prompt');
      if (this.hooks?.onPromptActivated) {
        try {
          await this.hooks.onPromptActivated(newPrompt);
        } catch (err) {
          this.logger.error({ err }, 'prompt_optimizer.hot_reload_failed');
        }
      }
    } else {
      this.logger.warn({ reason: result.analysis }, 'prompt_optimizer.saved_as_draft_failed_safety_check');
    }

    await this.emitReport({
      status: safe ? 'activated' : 'draft',
      activated: safe,
      version,
      analysis: result.analysis,
      stats,
      draftReason: safe ? undefined : 'Safety gate: a required safety or behavior phrase was dropped from the combined prompt. Saved as draft for manual review.',
    });
  }

  private async getActivePrompt(): Promise<string | null> {
    const { rows } = await this.pool.query<{ content: string }>(
      `SELECT content FROM prompts WHERE active = TRUE ORDER BY created_at DESC LIMIT 1`,
    );
    return rows[0]?.content ?? null;
  }

  private async gatherSignals(days: number) {
    const since = new Date(Date.now() - days * 24 * 3_600_000);

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

    const fallbackConditions = SAFE_FALLBACK_SNIPPETS.map((_, i) => `content ILIKE $${i + 2}`).join(' OR ');
    const { rows: fallbackRows } = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM messages
       WHERE role = 'assistant'
         AND (${fallbackConditions})
         AND created_at > $1`,
      [since, ...SAFE_FALLBACK_SNIPPETS.map((s) => `%${s}%`)],
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

  // Generates a SHORT list of behavioral additions (not a full rewrite).
  // The additions are appended to the base prompt, keeping the full prompt
  // length stable and preserving all safety/behavior anchors.
  private async generateAdditions(
    currentPrompt: string,
    signals: {
      negativeSamples: FeedbackRow[];
      positiveSamples: FeedbackRow[];
      fallbackCount: number;
      totalMessages: number;
    },
  ): Promise<{ additions: string; analysis: string } | null> {
    const formatSample = (r: FeedbackRow) => {
      const user = r.user_message ? `User: "${r.user_message.slice(0, 150)}"` : '';
      const asst = r.assistant_message ? `Grace: "${r.assistant_message.slice(0, 200)}"` : '';
      const emojiLabel = (r.rating ?? 0) > 0 ? '👍' : '👎';
      const fb = r.comment ? ` | ${emojiLabel} + comment: "${r.comment}"` : ` | ${emojiLabel} (no comment)`;
      return `${user}\n  ${asst}${fb}`;
    };

    const negativeBlock = signals.negativeSamples.length > 0
      ? signals.negativeSamples.map(formatSample).join('\n\n')
      : 'None in this period.';

    const positiveBlock = signals.positiveSamples.length > 0
      ? signals.positiveSamples.map(formatSample).join('\n\n')
      : 'None in this period.';

    // Extract any previous BEHAVIORAL ADJUSTMENTS that are already in the active
    // prompt. Passing them explicitly as "ALREADY IN PLACE" stops the LLM from
    // re-deriving the same rules every run — it will refine them or focus on
    // genuinely new patterns instead.
    const additionsMarkerEscaped = ADDITIONS_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const additionsMatch = currentPrompt.match(new RegExp(`${additionsMarkerEscaped}([\\s\\S]*)$`));
    const previousAdditions = additionsMatch ? additionsMatch[1].trim() : null;

    const basePromptExcerpt = currentPrompt
      .replace(new RegExp(`${additionsMarkerEscaped}[\\s\\S]*$`), '')
      .slice(-3000); // Last 3000 chars of the base prompt gives context for what's already there

    const previousAdditionsBlock = previousAdditions
      ? `\nBEHAVIORAL ADJUSTMENTS ALREADY IN PLACE (from previous optimizer runs):\n${previousAdditions}\n\nIMPORTANT: Do NOT repeat or restate rules already covered above. If the 👎 feedback shows those rules are not working, REFINE them with more specific guidance. Focus on patterns NOT already addressed.`
      : '';

    const resp = await this.llm.generate({
      messages: [
        {
          role: 'system',
          content: `You are an expert at improving AI behavioral rules based on real user feedback.

Grace is a WhatsApp companion for people on GLP-1 medications. You will write 2–5 SHORT, SPECIFIC behavioral rules to ADD to her existing prompt based on recent 👍/👎 feedback.

HARD CONSTRAINTS — your output will be automatically rejected if violated:
- NEVER suggest, override, or weaken any medical safety rule (doses, drug interactions, alcohol safety)
- NEVER tell Grace to ignore, override, or supersede any existing rule
- NEVER remove the doctor/clinician redirect for medical questions
- ONLY ADD new rules — never rewrite, remove, or contradict existing ones
- Rules must be purely about TONE, STYLE, SPECIFICITY, or COMMUNICATION PATTERNS
- If you cannot find a safe improvement, write 1 minor style improvement

Rules for your output format:
- Each rule should be 1–2 sentences, written as an imperative instruction to Grace
- Rules must directly address patterns visible in the 👎 feedback
- Do NOT repeat rules that are clearly already in the existing prompt excerpt or previous adjustments shown
- If a previous rule covers the same problem but users still complain, rewrite it with more concrete examples
- Write rules in the same style as the existing prompt (direct, specific, WhatsApp-aware)

Respond with ONLY a JSON object — no markdown code fences, no prose, no commentary before or after.
Schema: {"analysis": "<2-3 sentences explaining patterns and rules>", "additions": "<bullet list of new rules>"}

Example output:
{"analysis": "Users complain Grace echoes their food dislikes verbatim and gives generic responses. Adding rules to paraphrase dislikes and reference user-specific context.", "additions": "- Never echo a user's food dislike verbatim — paraphrase naturally (e.g. 'not a rice person' becomes 'rice isn't your thing').\\n- Every response must reference something concrete from the user's message — a word they used, today's protein, their week number."}`,
        },
        {
          role: 'user',
          content: `EXISTING PROMPT EXCERPT (end of base prompt — context for what's already covered):
${basePromptExcerpt}
${previousAdditionsBlock}

PERFORMANCE DATA — LAST ${LOOKBACK_DAYS} DAYS:
- Total user messages: ${signals.totalMessages}
- Times safe fallback fired (Grace couldn't respond properly): ${signals.fallbackCount}
- 👍 ratings: ${signals.positiveSamples.length} | 👎 ratings: ${signals.negativeSamples.length}
- Satisfaction score: ${signals.positiveSamples.length + signals.negativeSamples.length > 0
    ? `${Math.round((signals.positiveSamples.length / (signals.positiveSamples.length + signals.negativeSamples.length)) * 100)}% positive`
    : 'no ratings yet'}

NEGATIVE FEEDBACK (what went wrong — fix these):
${negativeBlock}

POSITIVE EXAMPLES (what's working — do more of this):
${positiveBlock}

Write 2–5 specific new behavioral rules to add to Grace's prompt that fix the patterns you see in the negative feedback. If the same issue appears in both the previous adjustments AND the current feedback, the previous rule wasn't specific enough — rewrite it with a concrete example. Respond with ONLY the JSON object.`,
        },
      ],
      temperature: 0.3,
      // Gemini 2.5 Flash burns tokens on internal thinking BEFORE output —
      // 1024 was too small and produced empty/truncated JSON. 4096 leaves
      // plenty of room for thinking + a multi-bullet additions block.
      maxOutputTokens: 4096,
      responseFormat: 'json',
    });

    const parsed = parseAdditionsResponse(resp.text);
    if (!parsed) {
      this.logger.warn(
        { rawLength: resp.text.length, rawPreview: resp.text.slice(0, 500), finishReason: resp.finishReason },
        'prompt_optimizer.parse_failed',
      );
      return null;
    }
    if (parsed.additions.trim().length < MIN_ADDITIONS_LENGTH) {
      this.logger.warn(
        { additionsLength: parsed.additions.length, rawPreview: resp.text.slice(0, 500) },
        'prompt_optimizer.additions_too_short',
      );
      return null;
    }
    return parsed;
  }

  // Safety gate: check the COMBINED prompt (base + new additions) still has all anchors.
  // Since we're only appending to the base, this should always pass unless the model
  // somehow generated additions that contain conflicting instructions.
  private isSafe(combinedPrompt: string): boolean {
    if (combinedPrompt.length < 500) return false;

    const lower = combinedPrompt.toLowerCase();
    for (const p of REQUIRED_SAFETY_PHRASES) {
      if (!lower.includes(p.toLowerCase())) {
        this.logger.warn({ missing: p }, 'prompt_optimizer.safety_phrase_missing');
        return false;
      }
    }
    for (const p of REQUIRED_BEHAVIOR_PHRASES) {
      if (!combinedPrompt.includes(p)) {
        this.logger.warn({ missing: p }, 'prompt_optimizer.behavior_anchor_missing');
        return false;
      }
    }

    return true;
  }

  private async saveVersion(content: string, analysis: string, autoActivate: boolean): Promise<number> {
    const { rows } = await this.pool.query<{ max: number | null }>(
      `SELECT MAX(version) AS max FROM prompts`,
    );
    const nextVersion = (rows[0]?.max ?? 0) + 1;
    const notes = `Auto-generated by PromptOptimizer v${nextVersion} — ${analysis}`;

    if (autoActivate) {
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
      await this.pool.query(
        `INSERT INTO prompts (version, content, active, notes, auto_generated)
         VALUES ($1, $2, FALSE, $3, TRUE)`,
        [nextVersion, content, notes],
      );
    }

    return nextVersion;
  }
}

function emptyStats(): OptimizerRunReport['stats'] {
  return {
    totalMessages: 0,
    negativeCount: 0,
    positiveCount: 0,
    fallbackCount: 0,
    satisfactionPct: null,
  };
}

/**
 * Robust JSON extraction for Gemini's output. Handles:
 *  - clean JSON
 *  - ```json ... ``` markdown fences (Gemini sometimes wraps despite JSON mode)
 *  - leading/trailing prose
 *  - alternate field names ('rules' / 'behavioral_additions' for additions)
 */
export function parseAdditionsResponse(raw: string): { additions: string; analysis: string } | null {
  if (!raw || raw.trim().length === 0) return null;

  // Strip markdown code fences and surrounding whitespace
  let cleaned = raw.trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();

  // If the cleaned text isn't a pure JSON object, locate the first '{' and last '}'
  if (!cleaned.startsWith('{')) {
    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      cleaned = cleaned.slice(firstBrace, lastBrace + 1);
    }
  }

  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(cleaned) as Record<string, unknown>;
  } catch {
    return null;
  }

  // Field name fallbacks — Gemini sometimes uses 'rules' or 'behavioral_additions'
  const additionsRaw = obj['additions'] ?? obj['rules'] ?? obj['behavioral_additions'] ?? obj['new_rules'];
  const analysisRaw = obj['analysis'] ?? obj['summary'] ?? obj['rationale'];

  let additions: string;
  if (typeof additionsRaw === 'string') {
    additions = additionsRaw;
  } else if (Array.isArray(additionsRaw)) {
    // If model returned an array of strings, join into a bullet list
    additions = additionsRaw
      .filter((x): x is string => typeof x === 'string')
      .map((s) => (s.trim().startsWith('-') ? s.trim() : `- ${s.trim()}`))
      .join('\n');
  } else {
    return null;
  }

  if (typeof analysisRaw !== 'string') return null;

  return { additions: additions.trim(), analysis: analysisRaw.trim() };
}
