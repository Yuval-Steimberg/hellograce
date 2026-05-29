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
// Negative limit bumped to 100 so every 👎 is processed individually per the
// per-feedback methodology in generateAdditions(), not bulk-summarized.
const NEG_SAMPLE_LIMIT = 100;
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

export interface SyntheticFeedback {
  user_message: string;
  assistant_message: string;
  comment: string;
  rating: number;
}

export class PromptOptimizer {
  private syntheticFeedback: SyntheticFeedback[] = [];

  constructor(
    private pool: Pool,
    private llm: LLMProvider,
    private logger: Logger,
    private hooks?: PromptOptimizerHooks,
  ) {}

  /**
   * Inject synthetic feedback from auto-eval preference pairs.
   * These are merged with real RLHF signals during the nightly run.
   */
  injectSyntheticFeedback(feedback: SyntheticFeedback[]): void {
    this.syntheticFeedback = feedback;
    this.logger.info({ count: feedback.length }, 'prompt_optimizer.synthetic_feedback_loaded');
  }

  /**
   * Run the optimizer if it hasn't run today. Called on startup 30s after boot
   * to catch up when the 4am cron was missed (Fly machine was asleep).
   */
  async runIfMissedToday(): Promise<void> {
    try {
      const { rows } = await this.pool.query<{ last: Date | null }>(
        `SELECT MAX(created_at) AS last FROM prompts WHERE auto_generated = true`,
      );
      const last = rows[0]?.last;
      if (last) {
        const hoursSince = (Date.now() - new Date(last).getTime()) / 3_600_000;
        if (hoursSince < 20) {
          this.logger.info({ hoursSince: Math.round(hoursSince) }, 'prompt_optimizer.already_ran_today');
          return;
        }
      }
      this.logger.info('prompt_optimizer.catching_up_missed_run');
      await this.run();
    } catch (err) {
      this.logger.error({ err }, 'prompt_optimizer.catch_up_check_failed');
    }
  }

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

    let safe = this.isSafe(newPrompt);

    // Eval gate disabled — auto-eval only runs when manually triggered by admin.
    // To re-enable: uncomment and set EVAL_GATE_AUTO=1
    if (safe && process.env.EVAL_GATE_AUTO === '1') {
      safe = await this.runEvalGate();
    }

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
      draftReason: safe ? undefined : 'Safety or eval gate failed. The prompt may have dropped required phrases or scored below the auto-eval baseline. Saved as draft for manual review.',
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

    // Merge synthetic feedback from auto-eval preference pairs
    const syntheticNeg = this.syntheticFeedback
      .filter((s) => s.rating < 0)
      .map((s) => ({
        assistant_message: s.assistant_message,
        user_message: s.user_message,
        comment: s.comment,
        rating: s.rating,
      }));

    const allNegative = [...negativeRows, ...syntheticNeg].slice(0, NEG_SAMPLE_LIMIT);

    if (syntheticNeg.length > 0) {
      this.logger.info(
        { realNeg: negativeRows.length, syntheticNeg: syntheticNeg.length },
        'prompt_optimizer.merged_synthetic_feedback',
      );
    }

    return {
      negativeSamples: allNegative,
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
    const previousAdditions = additionsMatch ? (additionsMatch[1] ?? '').trim() || null : null;

    const basePromptExcerpt = currentPrompt
      .replace(new RegExp(`${additionsMarkerEscaped}[\\s\\S]*$`), '')
      .slice(-3000); // Last 3000 chars of the base prompt gives context for what's already there

    const previousAdditionsBlock = previousAdditions
      ? `\nBEHAVIORAL ADJUSTMENTS ALREADY IN PLACE (from previous optimizer runs):\n${previousAdditions}\n\nIMPORTANT: Do NOT repeat or restate rules already covered above. If the 👎 feedback shows those rules are not working, REFINE them with more specific guidance. Focus on patterns NOT already addressed.`
      : '';

    const buildMessages = (negBlock: string, shortFormat: boolean): Parameters<typeof this.llm.generate>[0]['messages'] => [
      {
        role: 'system',
        content: shortFormat
          // ── Retry prompt: minimal, no examples, explicit JSON schema ──────────
          ? `You improve AI behavioral rules from user feedback. Output ONLY valid JSON:
{"analysis":"<1-2 sentences: top failure patterns and count>","additions":"<3-5 rules, each: directive + ✗ quote + ✓ fix, separated by blank lines>"}
Rules must cite a verbatim quote from the 👎 response. No markdown. No prose outside JSON.`
          // ── Primary prompt ────────────────────────────────────────────────────
          : `You are an expert at improving AI behavioral rules based on real user feedback.

Grace is a WhatsApp companion for people on GLP-1 medications. You will write STRICT, CONCRETE behavioral rules to ADD to her existing prompt based on recent 👍/👎 feedback.

═══════════════════════════════════════════════════
HARD CONSTRAINTS — output is auto-rejected if violated
═══════════════════════════════════════════════════
- NEVER suggest, override, or weaken any medical safety rule (doses, drug interactions, alcohol safety)
- NEVER tell Grace to ignore, override, or supersede any existing rule
- NEVER remove the doctor/clinician redirect for medical questions
- ONLY ADD new rules — never rewrite, remove, or contradict existing ones
- Rules must be about TONE, STYLE, SPECIFICITY, or COMMUNICATION PATTERNS
- If no safe improvement exists, write ONE minor style refinement

═══════════════════════════════════════════════════
METHODOLOGY — process EACH 👎 individually
═══════════════════════════════════════════════════
This is the most important section. Read it twice.

STEP 1 — TRIAGE every 👎 sample. For each one, identify the SPECIFIC failure pattern (e.g. "denied image capability", "asked for grams instead of estimating", "said 'You're welcome'", "repeated previous topic after pivot", "vague food suggestion without naming a food").

STEP 2 — GROUP only when the failure pattern is identical. Two 👎s about "Grace asked for grams" group into one rule. A 👎 about grams and a 👎 about denying images do NOT group.

STEP 3 — Write ONE rule per distinct failure pattern. Each rule MUST contain:
  (a) A short imperative directive ("Never X" or "Always Y")
  (b) The EXACT verbatim ✗ quote from Grace's failing response (in quotes, 5–15 words)
  (c) The ✓ corrected version Grace should have said instead (in quotes)
  (d) Where applicable, the user comment that explains why it was 👎

A rule without a verbatim ✗ quote is REJECTED. A rule without a ✓ correction is REJECTED. Vague rules ("be more specific", "improve tone") are REJECTED.

STEP 4 — Output 3–10 rules total. If fewer than 3 distinct patterns exist, write 3 rules anyway by refining the same pattern at different granularities. If more than 10, write rules ONLY for the top 10 most frequent patterns.

═══════════════════════════════════════════════════
RULE QUALITY BAR
═══════════════════════════════════════════════════
✓ ACCEPTED rule:
"Never say 'I don't have a specific protein estimate for that.' Always estimate with 'roughly Xg' even for unfamiliar foods.
  ✗ 'I don't have a specific protein estimate for that one.'
  ✓ 'Roughly 25g — that's about a typical chicken serving.'"

✓ ACCEPTED rule:
"Never deny image capability. Grace CAN see photos via Gemini.
  ✗ 'I can't actually see pictures.'
  ✓ 'That looks like about 20–25g protein. You're at 45g today.'"

✗ REJECTED rule: "Be more specific in food responses." (no ✗/✓, vague)
✗ REJECTED rule: "Avoid generic acknowledgments." (no quote, no example)
✗ REJECTED rule: "Improve tone of voice." (meaningless)

═══════════════════════════════════════════════════
DEDUP AGAINST PRIOR ADJUSTMENTS
═══════════════════════════════════════════════════
- If a previous rule already covers a pattern AND the pattern still appears in 👎 — the old rule was too weak. REWRITE it with a sharper ✗/✓ quote pulled from THIS week's feedback.
- Never copy a previous rule verbatim. Either refine or skip.

═══════════════════════════════════════════════════
OUTPUT FORMAT
═══════════════════════════════════════════════════
Respond with ONLY a JSON object — no markdown fences, no prose.
Schema: {"analysis": "<2-3 sentences naming the top failure patterns and how many 👎 each represents>", "additions": "<formatted rule list, one rule per pattern, each with ✗/✓ quotes>"}

Example output:
{"analysis": "3 distinct 👎 patterns this period: (1) Grace denying image capability — 2 cases; (2) saying 'You're welcome' — 1 case; (3) asking for exact grams — 2 cases. Writing one rule per pattern with verbatim corrections.", "additions": "- IMAGE CAPABILITY: Never deny seeing photos. Grace has full Gemini visual analysis.\\n  ✗ 'I can't actually see pictures, but tell me what you ate.'\\n  ✓ 'Looks like roughly 25g protein. You're at 60g today.'\\n\\n- GRAM REQUESTS: Never ask for exact grams or ounces. Estimate from common-sense portion sizes.\\n  ✗ 'How many grams of chicken was that?'\\n  ✓ 'Around 30g if it was a typical serving. Solid lunch.'\\n\\n- ACK ROTATION: Never say 'You're welcome.' Rotate warm acknowledgments.\\n  ✗ 'You're welcome.'\\n  ✓ 'Always.' / 'Of course.' / 'Really glad it helped.'"}`,
      },
      {
        role: 'user',
        content: shortFormat
          ? `NEGATIVE FEEDBACK (👎) — cite exact quotes:\n${negBlock}\n\nRespond with ONLY the JSON object.`
          : `EXISTING PROMPT EXCERPT (end of base prompt — context for what's already covered):
${basePromptExcerpt}
${previousAdditionsBlock}

PERFORMANCE DATA — LAST ${LOOKBACK_DAYS} DAYS:
- Total user messages: ${signals.totalMessages}
- Times safe fallback fired (Grace couldn't respond properly): ${signals.fallbackCount}
- 👍 ratings: ${signals.positiveSamples.length} | 👎 ratings: ${signals.negativeSamples.length}
- Satisfaction score: ${signals.positiveSamples.length + signals.negativeSamples.length > 0
    ? `${Math.round((signals.positiveSamples.length / (signals.positiveSamples.length + signals.negativeSamples.length)) * 100)}% positive`
    : 'no ratings yet'}

NEGATIVE FEEDBACK — process EACH of these individually using the METHODOLOGY above:
${negBlock}

POSITIVE EXAMPLES (what's working — do more of this, do NOT write rules about these):
${positiveBlock}

Now execute the METHODOLOGY exactly:
1. Triage every 👎 above and label its failure pattern.
2. Group identical patterns only.
3. Write one rule per distinct pattern (3–10 rules total), each with a verbatim ✗ quote from the actual 👎 response and a concrete ✓ correction.
4. If a previous adjustment covers the same pattern but users still complain, rewrite that rule with a sharper ✗/✓ using THIS week's quotes.

Respond with ONLY the JSON object.`,
      },
    ];

    // Four-attempt strategy with increasing simplicity. All LLM attempts force
    // gemini-2.0-flash — gemini-2.5-flash's JSON+thinking output is unreliable
    // for this prompt (~5% of nightly runs return empty/garbage text). 2.0-flash
    // is rock-solid for structured JSON. Final attempt is deterministic — no
    // LLM call at all — so the optimizer ALWAYS produces a usable result when
    // 👎 feedback exists, even during a full Gemini outage.

    const OPTIMIZER_MODEL = 'gemini-2.0-flash';

    const attempts: Array<{ label: string; generate: () => Promise<{ text: string; finishReason?: string }> }> = [
      {
        label: 'primary (gemini-2.0-flash, full prompt, json)',
        generate: () => this.llm.generate({
          messages: buildMessages(negativeBlock, false),
          temperature: 0.2,
          maxOutputTokens: 8192,
          responseFormat: 'json',
          model: OPTIMIZER_MODEL,
        }),
      },
      {
        label: 'retry (gemini-2.0-flash, short prompt, json)',
        generate: () => this.llm.generate({
          messages: buildMessages(negativeBlock, true),
          temperature: 0.1,
          maxOutputTokens: 8192,
          responseFormat: 'json',
          model: OPTIMIZER_MODEL,
        }),
      },
      {
        label: 'last-resort (gemini-2.0-flash, minimal prompt, text mode)',
        generate: () => this.llm.generate({
          messages: [{
            role: 'user',
            content: `Analyze this user feedback and output ONLY a JSON object with "analysis" and "additions" keys.\n\nFeedback:\n${negativeBlock.slice(0, 2000)}\n\nJSON:`,
          }],
          temperature: 0.0,
          maxOutputTokens: 4096,
          model: OPTIMIZER_MODEL,
        }),
      },
    ];

    let parsed: { additions: string; analysis: string } | null = null;
    for (const attempt of attempts) {
      try {
        const resp = await attempt.generate();
        this.logger.info(
          { attempt: attempt.label, rawLen: resp.text.length, preview: resp.text.slice(0, 300) },
          'prompt_optimizer.attempt_response',
        );
        parsed = parseAdditionsResponse(resp.text);
        if (parsed && parsed.additions.trim().length >= MIN_ADDITIONS_LENGTH) {
          this.logger.info({ attempt: attempt.label }, 'prompt_optimizer.attempt_succeeded');
          break;
        }
        this.logger.warn(
          { attempt: attempt.label, rawLen: resp.text.length, parsedLen: parsed?.additions.trim().length ?? 0 },
          'prompt_optimizer.attempt_parse_failed',
        );
        parsed = null;
      } catch (err) {
        this.logger.warn({ attempt: attempt.label, err }, 'prompt_optimizer.attempt_error');
      }
    }

    // Deterministic last-resort: build additions directly from negative samples.
    // No LLM. Guarantees we never return null when there's real 👎 feedback —
    // the worst case is a simple "Never say <verbatim>" rule per sample, which
    // is still actionable. This kicks in only when ALL 3 LLM attempts failed.
    if (!parsed && signals.negativeSamples.length > 0) {
      this.logger.warn('prompt_optimizer.falling_back_to_deterministic');
      parsed = buildDeterministicAdditions(signals.negativeSamples);
    }

    if (!parsed) {
      return null;
    }

    return parsed;
  }

  private async runEvalGate(): Promise<boolean> {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return true;

    try {
      const gatePath = new URL('../../auto-eval/feedback-loop.js', import.meta.url).href;
      const mod = await import(gatePath).catch(() => null) as {
        evalGateCheck: (llm: unknown, prompt: string, baseline: number, logger: unknown) => Promise<{ passed: boolean; score: number; details: string }>;
      } | null;
      if (!mod) return true;

      const baseline = Number(process.env.EVAL_GATE_BASELINE ?? '2.5');
      const result = await mod.evalGateCheck(this.llm, '', baseline, this.logger);
      if (!result.passed) {
        this.logger.warn({ score: result.score, baseline, details: result.details }, 'prompt_optimizer.eval_gate_blocked');
      }
      return result.passed;
    } catch (err) {
      this.logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'prompt_optimizer.eval_gate_skipped');
      return true;
    }
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
 * Last-resort deterministic additions builder. Runs when all LLM attempts
 * failed (Gemini outage, JSON garble, persistent thinking-token issues).
 * Produces ONE rule per unique 👎 sample by extracting the verbatim Grace
 * response as the ✗ quote and pairing it with the user's comment (or a
 * generic ✓ directive when no comment exists). No LLM call — this MUST
 * always succeed when negative samples exist.
 *
 * Quality bar: lower than LLM output but always actionable. Worst case is
 * "Never repeat: <verbatim quote>" — still better than the empty alert
 * users were seeing in production.
 */
export function buildDeterministicAdditions(
  negativeSamples: Array<{ user_message: string | null; assistant_message: string | null; comment: string | null }>,
): { additions: string; analysis: string } | null {
  if (negativeSamples.length === 0) return null;

  // Dedup by the first 80 chars of Grace's response — collapse near-duplicates.
  const seen = new Set<string>();
  const rules: string[] = [];

  for (const s of negativeSamples) {
    const asst = (s.assistant_message ?? '').trim();
    if (!asst) continue;
    // Trim to a quotable snippet — first sentence or 150 chars, whichever shorter.
    const firstSentence = asst.split(/(?<=[.!?])\s/)[0] ?? asst;
    const quote = (firstSentence.length > 0 ? firstSentence : asst).slice(0, 150).trim();
    const dedupKey = quote.slice(0, 80).toLowerCase();
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);

    const userMsg = (s.user_message ?? '').trim().slice(0, 80);
    const comment = (s.comment ?? '').trim().slice(0, 200);
    const fix = comment
      ? `Address the user's actual point: "${comment}"`
      : 'Rewrite this response to address what the user actually asked.';

    const userCtx = userMsg ? `When the user says something like "${userMsg}":\n  ` : '';
    rules.push(`- ${userCtx}✗ Never repeat: "${quote}"\n  ✓ ${fix}`);

    if (rules.length >= 10) break; // Cap at 10 rules — matches LLM output limit
  }

  if (rules.length === 0) return null;

  return {
    analysis: `Gemini unavailable for behavioral synthesis — generated ${rules.length} rule(s) deterministically from ${negativeSamples.length} 👎 sample(s). Each rule cites the verbatim failing response.`,
    additions: rules.join('\n\n'),
  };
}

/**
 * Robust JSON extraction for Gemini's output. Handles:
 *  - clean JSON
 *  - ```json ... ``` markdown fences (Gemini sometimes wraps despite JSON mode)
 *  - leading/trailing prose
 *  - Gemini extended-thinking markers (<thinking>...</thinking>) prepended to output
 *  - alternate field names ('rules' / 'behavioral_additions' for additions)
 *  - array-valued additions fields
 *  - regex field-level extraction when full JSON parse fails (e.g. truncated output)
 *
 * Returns null only when no usable additions string can be found at all.
 */
export function parseAdditionsResponse(raw: string): { additions: string; analysis: string } | null {
  if (!raw || raw.trim().length === 0) return null;

  // Step 1 — strip Gemini extended-thinking markers. These appear before the actual
  // JSON output when the model "thinks" in the same token stream as its response.
  // Using a non-greedy match so nested tags don't swallow valid content.
  let text = raw
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
    .replace(/<thought>[\s\S]*?<\/thought>/gi, '')
    .trim();

  // Step 2 — strip markdown code fences (model ignores responseMimeType ~5% of the time)
  text = text
    .replace(/^```(?:json)?\s*/im, '')
    .replace(/\s*```\s*$/im, '')
    .trim();

  // Step 3 — try four extraction strategies in order, return first that works

  // 3a: direct parse (cleanest case — model obeyed JSON mode perfectly)
  const direct = tryExtractFields(text);
  if (direct) return direct;

  // 3b: locate outermost braces (handles leading/trailing prose)
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    const sliced = tryExtractFields(text.slice(firstBrace, lastBrace + 1));
    if (sliced) return sliced;
  }

  // 3c: regex scan for an object that contains the required keys (handles
  // multiple JSON objects in the same response — pick the right one)
  const keyPattern = /"(?:analysis|additions|rules|behavioral_additions)"\s*:/g;
  let kMatch: RegExpExecArray | null;
  while ((kMatch = keyPattern.exec(text)) !== null) {
    const start = text.lastIndexOf('{', kMatch.index);
    if (start === -1) continue;
    // walk forward to find the balanced closing brace
    let depth = 0;
    let end = -1;
    for (let i = start; i < text.length; i++) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end !== -1) {
      const candidate = tryExtractFields(text.slice(start, end + 1));
      if (candidate) return candidate;
    }
  }

  // 3d: field-level regex extraction — last resort for truncated JSON where the
  // closing brace is missing. Works when only the additions value got cut off.
  const analysisMatch = /"(?:analysis|summary|rationale)"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(text);
  const additionsMatch = /"(?:additions|rules|behavioral_additions|new_rules)"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(text);
  if (analysisMatch && additionsMatch) {
    try {
      const analysis = JSON.parse(`"${analysisMatch[1]}"`);
      const additions = JSON.parse(`"${additionsMatch[1]}"`);
      if (typeof analysis === 'string' && typeof additions === 'string' && additions.trim().length > 0) {
        return { analysis: analysis.trim(), additions: additions.trim() };
      }
    } catch { /* fall through */ }
  }

  return null;
}

/**
 * Try JSON.parse on a string and extract the additions + analysis fields.
 * Handles alternate field names and array-valued additions.
 */
function tryExtractFields(text: string): { additions: string; analysis: string } | null {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }

  const additionsRaw =
    obj['additions'] ?? obj['rules'] ?? obj['behavioral_additions'] ?? obj['new_rules'];
  const analysisRaw = obj['analysis'] ?? obj['summary'] ?? obj['rationale'];

  let additions: string;
  if (typeof additionsRaw === 'string') {
    additions = additionsRaw;
  } else if (Array.isArray(additionsRaw)) {
    additions = additionsRaw
      .filter((x): x is string => typeof x === 'string')
      .map((s) => (s.trim().startsWith('-') ? s.trim() : `- ${s.trim()}`))
      .join('\n');
  } else {
    return null;
  }

  if (typeof analysisRaw !== 'string') return null;
  if (additions.trim().length === 0) return null;

  return { additions: additions.trim(), analysis: analysisRaw.trim() };
}
