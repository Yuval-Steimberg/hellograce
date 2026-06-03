/**
 * Research-driven auto-fix engine.
 *
 * Runs every 3 days (cron: "0 1 *\/3 * *") and on startup if overdue.
 *
 * Pipeline:
 *   1. Sample up to `sampleSize` failing/uncovered posts from THREE sources:
 *      a) real_data_corpus (Reddit scrape — may be empty if blocked)
 *      b) feedback table (real 👎 from production)
 *      c) the 51-entry intents.json library (always available as a baseline)
 *      d) Gemini-generated synthetic GLP-1 questions when (a)+(b)+(c) < threshold
 *      The result is the system is ALWAYS self-sufficient — no admin upload
 *      required to bootstrap the loop.
 *   2. Re-replay each through the CURRENT active Grace prompt → fast deterministic
 *      failure check.  Posts that now pass are "already fixed" — we celebrate the
 *      improvement and skip them.
 *   3. For still-failing posts, cluster failures by pattern frequency.
 *   4. Use Gemini to generate targeted `regen` content rules for patterns seen
 *      ≥ cluster_threshold times (default 2 — lowered from 3 so the loop works
 *      with small samples). Rules are inserted as `is_active = true` so they
 *      take effect within 60 s (ContentRulesService refresh interval) — no
 *      deploy required.
 *   5. Convert still-failing (userMessage, graceResponse) pairs into SyntheticFeedback
 *      and inject into the PromptOptimizer in-memory buffer.  The nightly 4am run
 *      picks them up alongside real 👎 signals and generates targeted prompt additions.
 *   6. Store results in Redis, send admin WhatsApp summary.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import type { LLMProvider, DbContentRule } from '@grace/shared';
import type { Logger } from 'pino';
import type { Redis } from 'ioredis';
import type { PromptOptimizer, SyntheticFeedback } from '../scheduler/prompt-optimizer.js';
import { runSandboxReplay, type ReplayPersona } from '../replay/sandbox.js';
import { FAQ_SEEDS } from '../cache/faq-seeds.js';

// Redis keys
const LAST_RUN_KEY = 'research:autofix:last_run';

// Re-use the same mid-journey persona as the weekly scrape for consistency.
const REPLAY_PERSONA: ReplayPersona = {
  firstName: 'Research',
  medication: 'Ozempic 1mg',
  proteinGoalGrams: 80,
  calorieGoalKcal: 1600,
  glp1WeekNumber: 16,
};

/** Minimum run gap in hours before runIfMissedRecently triggers. Daily-ish
 *  cadence — if we haven't run in the last 20 hours, catch up on startup.
 *  Matches the once-per-UTC-day cron schedule. */
const MIN_RUN_INTERVAL_HOURS = 20;

/** Minimum pattern frequency to generate a content rule. Dropped to 1 — any
 *  detected failure pattern is worth asking Gemini for a content rule, with
 *  insertContentRuleIfNew deduping against the existing rule set. Previously
 *  3 (and briefly 2), but small samples never clustered enough to trigger
 *  rule generation. */
const PATTERN_CLUSTER_THRESHOLD = 1;

/** When the live sample (corpus + feedback) is below this size, top up with
 *  synthetic questions from intents.json + Gemini generation. Guarantees
 *  every run sees at least this many items for meaningful clustering. */
const MIN_SAMPLE_FLOOR = 30;

export interface AutoFixDeps {
  pool: Pool;
  llm: LLMProvider;
  logger: Logger;
  redis: Redis;
  promptOptimizer?: PromptOptimizer;
}

export interface AutoFixReport {
  postsAnalyzed: number;
  stillFailing: number;
  alreadyFixed: number;
  contentRulesGenerated: number;
  syntheticFeedbackInjected: number;
  topPatterns: Array<{ pattern: string; count: number; action: string }>;
  weakestDimensions: Array<{ dim: string; avgScore: number }>;
  /** Whether the prompt optimizer was kicked off in the background to consume
   *  the newly injected synthetic feedback. The optimizer runs async — its
   *  outcome (new prompt version, eval gate, activation) appears in the
   *  prompts table within ~1-2 minutes of the auto-fix completing. */
  promptOptimizerKicked: boolean;
  runAt: string;
}

interface FailingPost {
  id: number;
  raw_text: string;
  classified_intent: string | null;
  grade_failures: Array<{ type: string; detail: string }>;
  eval_scores: Record<string, number> | null;
  eval_overall: number | null;
  is_covered: boolean | null;
}

interface GeneratedRule {
  pattern: string;
  is_regex: boolean;
  flags?: string;
  reason: string;
  severity: 'regen' | 'log';
  applies_to: 'ai' | 'scheduler' | 'all';
}

// Quick deterministic failure detectors (no LLM cost).
const FAST_FAIL_PATTERNS: Array<{ re: RegExp; type: string }> = [
  { re: /\bi apologize for (the )?(confusion|mix.?up)\b/i, type: 'unprompted_apology' },
  { re: /\babsolutely critical\b/i, type: 'warning_label_tone' },
  { re: /\byou must discuss\b/i, type: 'warning_label_tone' },
  { re: /\bi only know about you\b/i, type: 'privacy_misfire' },
  { re: /\bi?'?m here (to help|for you|if you need)\b/i, type: 'generic_fallback' },
  { re: /let me know if (you have any|there('?s| are) any)/i, type: 'generic_filler' },
  { re: /\bwhat('?s | is )on your mind\b/i, type: 'generic_fallback' },
  { re: /\bfeel free to (ask|share)\b/i, type: 'generic_filler' },
  { re: /(great|awesome|wonderful|perfect|fantastic|amazing|excellent|brilliant)\s*[!,]/i, type: 'sycophantic_opener' },
  { re: /\bi (don'?t|do not) (know|have) (what you('?ve| have)|your)\b/i, type: 'context_denial' },
  { re: /\bholistic approach\b/i, type: 'vague_framing' },
  { re: /\blayers of complexity\b/i, type: 'vague_framing' },
  { re: /\bincredibly common\b/i, type: 'banned_phrase' },
  { re: /\bcompletely understandable\b/i, type: 'banned_phrase' },
  { re: /\breally important question\b/i, type: 'banned_phrase' },
];

export class ResearchAutoFix {
  constructor(private deps: AutoFixDeps) {}

  /**
   * Main entry point.  Runs the full pipeline and returns a summary report.
   */
  async run(opts: { sampleSize?: number; dryRun?: boolean } = {}): Promise<AutoFixReport> {
    const sampleSize = opts.sampleSize ?? 60;
    const dryRun = opts.dryRun ?? false;
    const runAt = new Date().toISOString();

    this.deps.logger.info({ sampleSize, dryRun }, 'research.auto_fix.start');

    // ── 1. Fetch samples — REAL GLP-1 DATA PRIORITIZED ─────────────────────
    // Source priority (highest → lowest reliability for real-world accuracy):
    //   a) feedback table — REAL production 👎 ratings from actual GLP-1 users.
    //      Gold-standard signal. Try to use up to 50% of the budget.
    //   b) real_data_corpus — REAL Reddit posts from r/Ozempic, r/Mounjaro,
    //      r/Zepbound, etc. The unfiltered voice of GLP-1 users.
    //   c) FAQ seeds — 60 clinically-verified GLP-1 questions from the
    //      2026-05-30 clinical report ("Verified Target Responses" table).
    //      Real medical accuracy — if Grace fails one, that's a true regression.
    //   d) intents.json — 51 hand-curated GLP-1 intent variations across the
    //      10 domains (medication, side effects, food, etc.).
    //   e) Gemini synthetic — bottom-of-stack safety net. Realistic-looking
    //      but generated. Only used to top up to MIN_SAMPLE_FLOOR.
    //
    // Budget allocation prioritizes a/b/c (real data) so the rule
    // generation and synthetic feedback reflect actual GLP-1 user reality.
    const feedbackBudget = Math.ceil(sampleSize * 0.5); // up to 50% real 👎
    const corpusBudget = Math.ceil(sampleSize * 0.25); // up to 25% Reddit
    const faqBudget = Math.ceil(sampleSize * 0.15);    // up to 15% clinical FAQ

    const feedbackPosts = await this.fetchNegativeFeedback(feedbackBudget);
    const corpusPosts = await this.fetchFailingPosts(corpusBudget);
    const faqPosts = this.sampleFromFaqSeeds(faqBudget);
    let posts = [...feedbackPosts, ...corpusPosts, ...faqPosts];

    // Top up from the hand-curated intent library
    const intentBudget = Math.max(0, sampleSize - posts.length);
    const intentPosts = intentBudget > 0
      ? this.sampleFromIntentLibrary(intentBudget)
      : [];
    posts = [...posts, ...intentPosts];

    // Final top-up: synthetic Gemini questions ONLY if still below floor.
    const syntheticBudget = Math.max(0, MIN_SAMPLE_FLOOR - posts.length);
    const syntheticPosts = syntheticBudget > 0
      ? await this.generateSyntheticQuestions(syntheticBudget)
      : [];
    posts = [...posts, ...syntheticPosts];

    const realDataCount = feedbackPosts.length + corpusPosts.length + faqPosts.length;
    this.deps.logger.info(
      {
        feedback: feedbackPosts.length,
        corpus: corpusPosts.length,
        faq_seeds: faqPosts.length,
        intent_library: intentPosts.length,
        synthetic: syntheticPosts.length,
        total: posts.length,
        real_data_pct: posts.length > 0 ? Math.round((realDataCount / posts.length) * 100) : 0,
      },
      'research.auto_fix.sample_loaded',
    );
    if (posts.length === 0) {
      this.deps.logger.info('research.auto_fix.no_failing_posts');
      if (!dryRun) await this.recordRun();
      return this.emptyReport(runAt);
    }

    // ── 2. Re-replay through the CURRENT active Grace ────────────────────
    // Load the currently-active content rules so the sandbox replay matches
    // production exactly. Without this, the replay misses every regen path
    // the content checker would have fired on, so the auto-fix keeps
    // re-detecting banned phrases that production already blocks → tries to
    // insert a rule with the same exact pattern → all marked duplicate →
    // "Content rules added: 0" forever. Loading dbRules lets the replay
    // surface only GENUINELY new failure patterns.
    const systemPrompt = await this.loadActiveSystemPrompt();
    const dbRules = await this.loadActiveContentRules();
    const stillFailing: Array<{ post: FailingPost; freshResponse: string; failTypes: string[] }> = [];

    const queue = [...posts];
    const concurrency = 4;
    const worker = async () => {
      while (queue.length > 0) {
        const post = queue.shift();
        if (!post) return;
        try {
          const result = await runSandboxReplay({
            messages: [post.raw_text.slice(0, 800)],
            persona: REPLAY_PERSONA,
            systemPrompt,
            llm: this.deps.llm,
            ...(dbRules.length > 0 ? { dbRules } : {}),
          });
          const lastGrace = [...result.turns].reverse().find((t) => t.role === 'grace');
          const freshResponse = lastGrace?.text ?? '';
          const failTypes = this.quickFailCheck(freshResponse);
          const lowEval = (post.eval_overall ?? 5) < 3.2;
          if (failTypes.length > 0 || lowEval) {
            stillFailing.push({ post, freshResponse, failTypes });
          }
        } catch (err) {
          this.deps.logger.warn(
            { rowId: post.id, err: (err as Error).message },
            'research.auto_fix.replay_row_failed',
          );
        }
      }
    };
    await Promise.all(Array.from({ length: concurrency }, () => worker()));

    const alreadyFixed = posts.length - stillFailing.length;
    this.deps.logger.info(
      { total: posts.length, stillFailing: stillFailing.length, alreadyFixed },
      'research.auto_fix.replay_done',
    );

    if (stillFailing.length === 0) {
      if (!dryRun) await this.recordRun();
      return { ...this.emptyReport(runAt), postsAnalyzed: posts.length, alreadyFixed };
    }

    // ── 3. Cluster failure patterns ────────────────────────────────────────
    // Bug fix: the previous version had `stillFailing[0]?.post.eval_scores`
    // hardcoded inside the loop — it always read the FIRST post's scores
    // instead of the current iteration's. Fixed below to use the iteration's
    // own post.eval_scores.
    const patternCounts = new Map<string, number>();
    for (const { post, failTypes } of stillFailing) {
      for (const t of failTypes) {
        patternCounts.set(t, (patternCounts.get(t) ?? 0) + 1);
      }
      // Also bucket low-eval dimensions (per-post, not from stillFailing[0])
      if (post.eval_scores) {
        for (const [dim, score] of Object.entries(post.eval_scores)) {
          if (score < 3) {
            patternCounts.set(`low_${dim}`, (patternCounts.get(`low_${dim}`) ?? 0) + 1);
          }
        }
      }
    }
    // Take ALL detected patterns (threshold 1) — even single-occurrence
    // patterns are worth a Gemini-generated rule when the sample is small.
    // Gemini's own dedup + the insertContentRuleIfNew check prevent noise.
    const topPatternEntries = [...patternCounts.entries()]
      .sort(([, a], [, b]) => b - a)
      .filter(([, c]) => c >= PATTERN_CLUSTER_THRESHOLD)
      .slice(0, 8);

    // ── 4. Generate + insert content rules ────────────────────────────────
    let contentRulesGenerated = 0;
    const reportPatterns: AutoFixReport['topPatterns'] = [];

    // Structural patterns can't be fixed by regex content rules — they need
    // prompt + format enforcer changes. They still flow into the optimizer
    // via synthetic feedback, so the action is 'prompt_fix' not 'logged'.
    const STRUCTURAL_PATTERNS = new Set([
      'multiple_questions',
      'too_long',
      'empty_response',
    ]);

    // Phrase-based patterns Gemini CAN convert into specific content rules.
    const contentRulePatterns = topPatternEntries.filter(
      ([p]) => !p.startsWith('low_') && !STRUCTURAL_PATTERNS.has(p),
    );

    // Track structural patterns separately so the report shows the right action.
    const structuralPatterns = topPatternEntries.filter(([p]) => STRUCTURAL_PATTERNS.has(p));

    if (contentRulePatterns.length > 0) {
      // Filter the examples down to ones that actually triggered the phrase-based
      // patterns — gives Gemini focused signal instead of a mixed bag.
      const phrasePatternSet = new Set(contentRulePatterns.map(([p]) => p));
      const phraseExamples = stillFailing
        .filter((f) => f.failTypes.some((t) => phrasePatternSet.has(t)))
        .slice(0, 12)
        .map(({ post, freshResponse, failTypes }) => ({
          user: post.raw_text.slice(0, 300),
          grace: freshResponse.slice(0, 300),
          failTypes: failTypes.filter((t) => phrasePatternSet.has(t)),
        }));

      const generatedRules = phraseExamples.length > 0
        ? await this.generateContentRules(
            contentRulePatterns.map(([p]) => p),
            phraseExamples,
          )
        : [];

      this.deps.logger.info(
        {
          patterns: contentRulePatterns.map(([p, c]) => `${p}:${c}`),
          examples: phraseExamples.length,
          rules_returned_by_gemini: generatedRules.length,
        },
        'research.auto_fix.rule_generation_result',
      );

      let insertedCount = 0;
      let duplicateCount = 0;
      for (const rule of generatedRules) {
        if (!dryRun) {
          const inserted = await this.insertContentRuleIfNew(rule);
          if (inserted) {
            contentRulesGenerated++;
            insertedCount++;
          } else {
            duplicateCount++;
          }
        }
      }

      // Action label semantics — be honest about what happened so admins
      // don't think "logged" means a silent failure:
      //   content_rule      → Gemini returned ≥1 rule AND ≥1 was newly inserted
      //   content_rule_dup  → Gemini returned rules but all are already in the DB
      //   gemini_empty      → Gemini chose not to generate a rule (usually
      //                       because the sample was too sparse to be confident)
      const sharedAction: string =
        generatedRules.length === 0
          ? 'gemini_empty'
          : insertedCount > 0
            ? 'content_rule'
            : duplicateCount > 0
              ? 'content_rule_dup'
              : 'logged';
      for (const [pattern, count] of contentRulePatterns) {
        reportPatterns.push({ pattern, count, action: sharedAction });
      }
    }

    // Structural patterns: synthetic feedback drives the prompt optimizer.
    for (const [pattern, count] of structuralPatterns) {
      reportPatterns.push({ pattern, count, action: 'prompt_fix' });
    }

    // Add low-eval dimension entries to report
    for (const [pattern, count] of topPatternEntries.filter(([p]) => p.startsWith('low_'))) {
      reportPatterns.push({ pattern, count, action: 'synthetic_feedback' });
    }

    // ── 5. Inject synthetic feedback → drives nightly prompt optimizer ────
    let syntheticFeedbackInjected = 0;
    let promptOptimizerKicked = false;
    if (this.deps.promptOptimizer && !dryRun) {
      const synthetic = this.buildSyntheticFeedback(stillFailing);
      if (synthetic.length > 0) {
        this.deps.promptOptimizer.injectSyntheticFeedback(synthetic);
        syntheticFeedbackInjected = synthetic.length;
        this.deps.logger.info(
          { count: synthetic.length },
          'research.auto_fix.synthetic_feedback_injected',
        );

        // Fire the prompt optimizer immediately in the background. This makes
        // the auto-fix loop fully autonomous — within 1-2 minutes of this
        // endpoint returning, a new prompt version is generated, eval-gated,
        // and (if it passes the baseline) activated. No 4am UTC wait, no
        // admin click. Run is fire-and-forget so the HTTP response stays fast.
        const optimizer = this.deps.promptOptimizer;
        const logger = this.deps.logger;
        setImmediate(() => {
          optimizer.run().catch((err: Error) => {
            logger.warn(
              { err: err.message },
              'research.auto_fix.optimizer_background_run_failed',
            );
          });
        });
        promptOptimizerKicked = true;
        this.deps.logger.info('research.auto_fix.optimizer_kicked_background');
      }
    }

    // ── 6. Compute weakest eval dimensions ────────────────────────────────
    const weakestDimensions = this.computeWeakestDims(stillFailing.map((f) => f.post));

    // ── 7. Record run timestamp ────────────────────────────────────────────
    if (!dryRun) await this.recordRun();

    this.deps.logger.info(
      {
        postsAnalyzed: posts.length,
        stillFailing: stillFailing.length,
        alreadyFixed,
        contentRulesGenerated,
        syntheticFeedbackInjected,
      },
      'research.auto_fix.done',
    );

    return {
      postsAnalyzed: posts.length,
      stillFailing: stillFailing.length,
      alreadyFixed,
      contentRulesGenerated,
      syntheticFeedbackInjected,
      topPatterns: reportPatterns,
      weakestDimensions,
      promptOptimizerKicked,
      runAt,
    };
  }

  /**
   * Run the auto-fix if it hasn't run in the last MIN_RUN_INTERVAL_HOURS hours.
   * Called on startup (with a delay) so a missed cron run is caught up when
   * the machine wakes back up (Fly auto-stops idle machines after 5 min).
   */
  async runIfMissedRecently(): Promise<void> {
    try {
      const lastRunMs = await this.deps.redis.get(LAST_RUN_KEY).catch(() => null);
      if (lastRunMs) {
        const hoursSince = (Date.now() - parseInt(lastRunMs, 10)) / 3_600_000;
        if (hoursSince < MIN_RUN_INTERVAL_HOURS) {
          this.deps.logger.info(
            { hoursSince: Math.round(hoursSince * 10) / 10 },
            'research.auto_fix.already_ran_recently',
          );
          return;
        }
      }
      this.deps.logger.info('research.auto_fix.catching_up_missed_run');
      await this.run();
    } catch (err) {
      this.deps.logger.error({ err }, 'research.auto_fix.catch_up_failed');
    }
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  /**
   * Pull recent 👎-rated turns from the feedback table. These are real
   * production failures — the gold-standard signal. We reshape each into a
   * FailingPost so the rest of the pipeline doesn't care where it came from.
   *
   * The `grade_failures` is synthesized from the user's comment when present;
   * eval scores stay null (no LLM eval was run on these in production).
   */
  private async fetchNegativeFeedback(limit: number): Promise<FailingPost[]> {
    if (limit <= 0) return [];
    try {
      const since = new Date(Date.now() - 30 * 24 * 3_600_000); // last 30 days
      const { rows } = await this.deps.pool.query<{
        id: string;
        user_message: string | null;
        comment: string | null;
      }>(
        `SELECT
           f.id::text AS id,
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
         WHERE f.rating = -1
           AND f.created_at > $1
           AND u.content IS NOT NULL
           AND length(u.content) >= 10
         ORDER BY f.created_at DESC
         LIMIT $2`,
        [since, limit],
      );
      return rows.map((r, i) => ({
        // Use a negative pseudo-id so it can't collide with real_data_corpus rows.
        id: -(i + 1),
        raw_text: r.user_message ?? '',
        classified_intent: null,
        grade_failures: r.comment
          ? [{ type: 'user_thumbs_down', detail: r.comment.slice(0, 200) }]
          : [{ type: 'user_thumbs_down', detail: 'No comment — rated 👎' }],
        eval_scores: null,
        eval_overall: 1.5, // Low score so the pipeline treats it as a real failure
        is_covered: null,
      }));
    } catch (err) {
      this.deps.logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'research.auto_fix.feedback_fetch_failed',
      );
      return [];
    }
  }

  /**
   * Sample from the 51-entry intent library (services/api/coverage/intents.json).
   * Each intent has up to ~10 phrasing variations — we sample evenly across
   * domains so the auto-fix exercises Grace on the full coverage matrix even
   * when corpus + feedback are empty.
   *
   * Read the file lazily and cache in memory across runs. Errors degrade
   * gracefully — if the file is missing we just return [].
   */
  private intentLibraryCache: string[] | null = null;
  private sampleFromIntentLibrary(limit: number): FailingPost[] {
    if (limit <= 0) return [];
    try {
      if (!this.intentLibraryCache) {
        // Resolve relative to this compiled file. In dev (tsx) it's src/research/,
        // in production (compiled) it's dist/research/. The coverage dir is
        // two levels up from either.
        const here = dirname(fileURLToPath(import.meta.url));
        const path = resolve(here, '../../coverage/intents.json');
        const raw = readFileSync(path, 'utf8');
        const parsed = JSON.parse(raw) as Array<{ variations?: string[] }>;
        const variations: string[] = [];
        for (const entry of parsed) {
          if (Array.isArray(entry.variations)) {
            for (const v of entry.variations) {
              if (typeof v === 'string' && v.trim().length >= 10) {
                variations.push(v.trim());
              }
            }
          }
        }
        this.intentLibraryCache = variations;
        this.deps.logger.info(
          { variations_loaded: variations.length },
          'research.auto_fix.intent_library_loaded',
        );
      }
      const pool = this.intentLibraryCache;
      if (pool.length === 0) return [];
      // Shuffle then slice — gives a fresh sample each run.
      const shuffled = [...pool].sort(() => Math.random() - 0.5);
      return shuffled.slice(0, limit).map((text, i) => ({
        id: -(1000 + i), // distinguish from feedback IDs (-1..-999) and corpus IDs (positive)
        raw_text: text,
        classified_intent: null,
        grade_failures: [{ type: 'intent_library_seed', detail: 'Sourced from intents.json' }],
        eval_scores: null,
        eval_overall: null, // null = treat as "needs replay" regardless of quickFailCheck
        is_covered: true,
      }));
    } catch (err) {
      this.deps.logger.warn(
        { err: (err as Error).message },
        'research.auto_fix.intent_library_load_failed',
      );
      return [];
    }
  }

  /**
   * Sample from the 60-entry FAQ seed table (services/api/src/cache/faq-seeds.ts).
   *
   * These are clinically-verified GLP-1 questions from the 2026-05-30 clinical
   * report's "Verified Target Responses" table — REAL medical data covering
   * nausea, hair loss, constipation, plateau, muscle loss, food noise, drug
   * interactions, injection site rotation, dose timing, alcohol, sleep,
   * heartburn, diarrhea, exercise, and 14 other categories.
   *
   * Each entry pairs a real user phrasing with a clinically-correct answer,
   * giving the auto-fix a high-signal accuracy check: if Grace fails one,
   * it's a true medical-accuracy regression worth a content rule.
   *
   * Lazy-loaded + cached. Errors degrade gracefully.
   */
  private sampleFromFaqSeeds(limit: number): FailingPost[] {
    if (limit <= 0 || FAQ_SEEDS.length === 0) return [];
    const shuffled = [...FAQ_SEEDS].sort(() => Math.random() - 0.5);
    return shuffled.slice(0, limit).map((seed, i) => ({
      id: -(5000 + i), // distinguish from feedback (-1..-999), intent (-1000..-4999), synthetic (-10000+)
      raw_text: seed.query,
      classified_intent: seed.category,
      grade_failures: [{ type: 'faq_clinical_seed', detail: `Clinically verified — category: ${seed.category}` }],
      eval_scores: null,
      eval_overall: null,
      is_covered: true,
    }));
  }

  /**
   * Generate synthetic GLP-1 user questions via Gemini when corpus + feedback
   * + intent library together still fall short of MIN_SAMPLE_FLOOR. This is
   * the bottom-of-stack safety net — guarantees the auto-fix always has
   * SOMETHING to chew on regardless of external dependencies.
   *
   * Prompted to produce realistic, diverse phrasings across the 10 GLP-1
   * topic domains. Uses gemini-2.0-flash with low temperature for stability.
   */
  private async generateSyntheticQuestions(limit: number): Promise<FailingPost[]> {
    if (limit <= 0) return [];
    try {
      // Ground Gemini in 12 REAL clinically-verified GLP-1 questions from FAQ_SEEDS.
      // This anchors the synthetic output in actual user language, not fabricated
      // medical scenarios. Sampled fresh each run for variety.
      const anchorExamples = [...FAQ_SEEDS]
        .sort(() => Math.random() - 0.5)
        .slice(0, 12)
        .map((s) => `- "${s.query}" (category: ${s.category})`)
        .join('\n');

      const prompt = `Generate ${limit} realistic, diverse questions that a GLP-1 medication user (Ozempic / Wegovy / Mounjaro / Zepbound / Rybelsus) might text to a WhatsApp health companion app.

REAL CLINICALLY-VERIFIED EXAMPLES from actual GLP-1 patient conversations (anchor your output in this style and clinical accuracy — do not invent symptoms that don't actually occur on GLP-1s):
${anchorExamples}

Cover these domains evenly:
- Medication (dose timing, missed dose, titration, switching meds)
- Side effects (nausea, constipation, hair loss, fatigue, heartburn, diarrhea, sulfur burps)
- Food and nutrition (what to eat, protein target, food noise, alcohol)
- Weight and progress (plateaus, scale frustration, Ozempic face, body image)
- Emotional support (feeling defeated, identity loss, fear of regaining)
- Exercise (timing, intensity on GLP-1, muscle preservation)
- Social situations (eating out, travel, holidays, family pressure)
- Safety (interactions, severe abdominal pain, persistent vomiting, contacting doctor)

Each question must:
- Be 15-200 characters long
- Read like a real GLP-1 user texting their companion (lowercase ok, typos ok, contractions ok)
- Reference REAL GLP-1 phenomena — actual side effects, real medications, real dose strengths (0.25/0.5/1.0/1.7/2.0 mg semaglutide, 2.5/5/7.5/10/12.5/15 mg tirzepatide)
- Sometimes pack 2-3 thoughts in one message (multi-part)
- Vary in tone: anxious, casual, frustrated, curious, hopeful

Return ONLY a JSON array of strings. No markdown fences, no commentary.`;

      const resp = await this.deps.llm.generate({
        model: 'gemini-2.5-flash',
        messages: [
          { role: 'system', content: 'You generate realistic patient questions in JSON format only. No markdown.' },
          { role: 'user', content: prompt },
        ],
        maxOutputTokens: 1500,
        temperature: 0.6,
      });
      const text = (resp.text ?? '').trim();
      const json = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
      const parsed = JSON.parse(json) as unknown[];
      if (!Array.isArray(parsed)) return [];
      const valid = parsed
        .filter((s): s is string => typeof s === 'string' && s.length >= 15 && s.length <= 400)
        .slice(0, limit);
      this.deps.logger.info(
        { generated: valid.length, requested: limit },
        'research.auto_fix.synthetic_generated',
      );
      return valid.map((text, i) => ({
        id: -(10_000 + i), // synthetic IDs in their own range
        raw_text: text,
        classified_intent: null,
        grade_failures: [{ type: 'synthetic_seed', detail: 'Gemini-generated GLP-1 question' }],
        eval_scores: null,
        eval_overall: null,
        is_covered: null,
      }));
    } catch (err) {
      this.deps.logger.warn(
        { err: (err as Error).message },
        'research.auto_fix.synthetic_generation_failed',
      );
      return [];
    }
  }

  private async fetchFailingPosts(limit: number): Promise<FailingPost[]> {
    const half = Math.floor(limit / 2);
    const { rows } = await this.deps.pool.query<{
      id: number;
      raw_text: string;
      classified_intent: string | null;
      grade_failures: Array<{ type: string; detail: string }>;
      eval_scores: Record<string, number> | null;
      eval_overall: number | null;
      is_covered: boolean | null;
    }>(
      `(
         SELECT id, raw_text, classified_intent, grade_failures,
                eval_scores, eval_overall, is_covered
           FROM real_data_corpus
          WHERE grade_passed = FALSE
            AND grace_response IS NOT NULL
          ORDER BY scraped_at DESC
          LIMIT $1
       )
       UNION ALL
       (
         SELECT id, raw_text, classified_intent, grade_failures,
                eval_scores, eval_overall, is_covered
           FROM real_data_corpus
          WHERE (eval_overall < 3.5 OR is_covered = FALSE)
            AND grace_response IS NOT NULL
            AND (grade_passed = TRUE OR grade_passed IS NULL)
          ORDER BY COALESCE(eval_overall, 5) ASC, scraped_at DESC
          LIMIT $2
       )`,
      [half, limit - half],
    );
    // Deduplicate by id (UNION ALL may include overlapping rows)
    const seen = new Set<number>();
    return rows.filter((r) => {
      if (seen.has(r.id)) return false;
      seen.add(r.id);
      return true;
    });
  }

  private quickFailCheck(response: string): string[] {
    if (!response || response.trim().length === 0) return ['empty_response'];
    const found: string[] = [];
    for (const { re, type } of FAST_FAIL_PATTERNS) {
      if (re.test(response)) found.push(type);
    }
    // Excessive length for short messages
    if (response.length > 700) found.push('too_long');
    // Multiple questions
    const questionCount = (response.match(/\?/g) ?? []).length;
    if (questionCount > 1) found.push('multiple_questions');
    return found;
  }

  private async generateContentRules(
    patternTypes: string[],
    examples: Array<{ user: string; grace: string; failTypes: string[] }>,
  ): Promise<GeneratedRule[]> {
    const exampleText = examples
      .slice(0, 10)
      .map(
        (e, i) =>
          `[${i + 1}] User: "${e.user}"\n    Grace: "${e.grace}"\n    Failures: ${e.failTypes.join(', ')}`,
      )
      .join('\n\n');

    const patternList = patternTypes
      .map((p, i) => `${i + 1}. ${p} (detected ${examples.filter((e) => e.failTypes.includes(p)).length}+ times)`)
      .join('\n');

    const prompt = `You are analyzing quality failures in Grace, a WhatsApp AI companion for GLP-1 medication users (Ozempic, Wegovy, Mounjaro, Zepbound, Rybelsus, compounded semaglutide / tirzepatide).

GLP-1 CLINICAL CONTEXT (use this to judge what's a real quality failure vs valid clinical content):
- Real GLP-1 side effects: nausea, constipation, hair loss (telogen effluvium), fatigue, heartburn / GERD, diarrhea, sulfur burps, Ozempic face (volume loss), injection site reactions
- Real GLP-1 mechanisms: GLP-1 receptor agonism, slowed gastric emptying, appetite suppression, food noise reduction (real phenomenon called Hedonic Hyperphagia)
- Real medical accuracy targets: protein 1.2-1.6 g/kg current body weight, muscle loss ~25-35% of weight lost if no strength training, plateau is normal (body recalibration), 988 = US crisis line, 911 = emergency
- Grace should NEVER: alarmist tone, prescribe dose changes, deny clinical phenomena, fabricate excuses, sycophantic openers, generic filler, multiple questions per turn, prescribe non-GLP-1 medications

FAILING EXAMPLES (user message → Grace response → detected failure types):
${exampleText}

PATTERNS TO ADDRESS:
${patternList}

Generate content rules (JSON array) to catch the most impactful patterns in Grace's responses.
Each rule triggers a response regeneration when matched.

Rules:
- Only generate rules for SPECIFIC, UNAMBIGUOUS phrases or patterns
- severity MUST be "regen" (never "block" — that requires human review)
- applies_to: "ai" for response issues, "all" if also relevant for proactive messages
- Do NOT generate rules that conflict with medical safety requirements
- Do NOT generate rules that would catch legitimate educational content
- Focus on: generic filler phrases, sycophantic openers, vague/unhelpful language
- Maximum 5 rules

Return ONLY a JSON array. No markdown fences. No explanation.

Example format:
[{"pattern":"let me know if you have any questions","is_regex":false,"reason":"Generic filler that adds no value","severity":"regen","applies_to":"ai"}]`;

    try {
      const resp = await this.deps.llm.generate({
        model: 'gemini-2.5-flash',
        messages: [
          { role: 'system', content: 'You generate content moderation rules in JSON format only. No markdown.' },
          { role: 'user', content: prompt },
        ],
        maxOutputTokens: 600,
        temperature: 0.1,
      });
      const text = (resp.text ?? '').trim();
      // Strip markdown fences if Gemini adds them anyway
      const json = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
      this.deps.logger.info(
        { raw_length: text.length, parsed_preview: json.slice(0, 400) },
        'research.auto_fix.gemini_rule_response',
      );
      const parsed = JSON.parse(json) as Array<Partial<GeneratedRule>>;
      if (!Array.isArray(parsed)) {
        this.deps.logger.warn(
          { json_preview: json.slice(0, 200) },
          'research.auto_fix.rule_generation_not_array',
        );
        return [];
      }
      // Validate + apply sensible defaults so a partial-but-valid rule isn't dropped.
      const normalized: GeneratedRule[] = [];
      const rejected: Array<{ rule: Partial<GeneratedRule>; why: string }> = [];
      for (const r of parsed) {
        if (!r || typeof r !== 'object') {
          rejected.push({ rule: r, why: 'not_object' });
          continue;
        }
        if (!r.pattern || typeof r.pattern !== 'string' || r.pattern.trim().length < 5) {
          rejected.push({ rule: r, why: 'pattern_missing_or_too_short' });
          continue;
        }
        const severity: 'regen' | 'log' = r.severity === 'log' ? 'log' : 'regen';
        const applies_to: 'ai' | 'scheduler' | 'all' =
          r.applies_to === 'scheduler' || r.applies_to === 'all' ? r.applies_to : 'ai';
        normalized.push({
          pattern: r.pattern.trim(),
          is_regex: r.is_regex === true,
          ...(r.flags ? { flags: r.flags } : {}),
          reason: typeof r.reason === 'string' && r.reason.trim().length > 0 ? r.reason.trim() : `Auto-detected pattern`,
          severity,
          applies_to,
        });
      }
      if (rejected.length > 0) {
        this.deps.logger.info(
          { rejected_count: rejected.length, sample_reasons: rejected.slice(0, 3).map((r) => r.why) },
          'research.auto_fix.rule_validation_rejections',
        );
      }
      return normalized.slice(0, 5);
    } catch (err) {
      this.deps.logger.warn(
        { err: (err as Error).message },
        'research.auto_fix.rule_generation_failed',
      );
      return [];
    }
  }

  private async insertContentRuleIfNew(rule: GeneratedRule): Promise<boolean> {
    try {
      // Check if a very similar rule already exists (avoid duplicates)
      const { rows } = await this.deps.pool.query<{ id: number }>(
        `SELECT id FROM content_rules WHERE LOWER(pattern) = LOWER($1) AND is_active = TRUE LIMIT 1`,
        [rule.pattern],
      );
      if (rows.length > 0) return false;

      // Validate regex before inserting
      if (rule.is_regex) {
        try {
          new RegExp(rule.pattern, rule.flags ?? 'i');
        } catch {
          this.deps.logger.warn({ pattern: rule.pattern }, 'research.auto_fix.invalid_regex_skipped');
          return false;
        }
      }

      await this.deps.pool.query(
        `INSERT INTO content_rules
           (rule_type, pattern, is_regex, flags, reason, severity, applies_to, is_active)
         VALUES
           ('auto_fix', $1, $2, $3, $4, $5, $6, TRUE)
         ON CONFLICT DO NOTHING`,
        [
          rule.pattern,
          rule.is_regex ?? false,
          rule.flags ?? 'i',
          `[auto-fix] ${rule.reason}`,
          rule.severity,
          rule.applies_to,
        ],
      );
      this.deps.logger.info(
        { pattern: rule.pattern, reason: rule.reason },
        'research.auto_fix.content_rule_inserted',
      );
      return true;
    } catch (err) {
      this.deps.logger.warn(
        { err: (err as Error).message, pattern: rule.pattern },
        'research.auto_fix.rule_insert_failed',
      );
      return false;
    }
  }

  private buildSyntheticFeedback(
    stillFailing: Array<{ post: FailingPost; freshResponse: string; failTypes: string[] }>,
  ): SyntheticFeedback[] {
    return stillFailing
      .filter((f) => f.freshResponse.trim().length > 0)
      .map(({ post, freshResponse, failTypes }) => {
        // Lower rating = more negative signal for the optimizer
        const rating = failTypes.includes('empty_response') ? 1
          : failTypes.length >= 3 ? 1
          : (post.eval_overall ?? 5) < 2.5 ? 1
          : 2;
        const comment = `Research corpus failure: ${failTypes.slice(0, 3).join(', ')}${
          post.eval_overall ? `. Eval score: ${post.eval_overall}/5` : ''
        }. Intent: ${post.classified_intent ?? 'unknown'}. User asked: "${post.raw_text.slice(0, 120)}"`;
        return {
          user_message: post.raw_text.slice(0, 500),
          assistant_message: freshResponse.slice(0, 500),
          comment,
          rating,
        };
      });
  }

  private computeWeakestDims(posts: FailingPost[]): Array<{ dim: string; avgScore: number }> {
    const dimTotals = new Map<string, { sum: number; count: number }>();
    for (const post of posts) {
      if (!post.eval_scores) continue;
      for (const [dim, score] of Object.entries(post.eval_scores)) {
        const cur = dimTotals.get(dim) ?? { sum: 0, count: 0 };
        cur.sum += score;
        cur.count++;
        dimTotals.set(dim, cur);
      }
    }
    return [...dimTotals.entries()]
      .map(([dim, { sum, count }]) => ({
        dim,
        avgScore: Math.round((sum / count) * 10) / 10,
      }))
      .sort((a, b) => a.avgScore - b.avgScore)
      .slice(0, 5);
  }

  private async loadActiveSystemPrompt(): Promise<string> {
    try {
      const { rows } = await this.deps.pool.query<{ content: string }>(
        `SELECT content FROM prompts WHERE active = TRUE ORDER BY created_at DESC LIMIT 1`,
      );
      return rows[0]?.content ?? 'You are Grace, a WhatsApp companion for GLP-1 users.';
    } catch {
      return 'You are Grace, a WhatsApp companion for GLP-1 users.';
    }
  }

  /**
   * Load the same content rules the production AI pipeline uses, so the
   * replay's content checker fires the same regens. Errors degrade
   * gracefully — an empty rule list just means the replay won't catch DB rules,
   * which is the prior behavior.
   */
  private async loadActiveContentRules(): Promise<DbContentRule[]> {
    try {
      const { rows } = await this.deps.pool.query<DbContentRule>(
        `SELECT id, rule_type, pattern, is_regex, flags, reason, severity, applies_to
           FROM content_rules
          WHERE is_active = TRUE
            AND applies_to IN ('ai', 'all')`,
      );
      this.deps.logger.info(
        { count: rows.length },
        'research.auto_fix.content_rules_loaded',
      );
      return rows;
    } catch (err) {
      this.deps.logger.warn(
        { err: (err as Error).message },
        'research.auto_fix.content_rules_load_failed',
      );
      return [];
    }
  }

  private async recordRun(): Promise<void> {
    await this.deps.redis
      .set(LAST_RUN_KEY, Date.now().toString(), 'EX', 7 * 24 * 3600)
      .catch(() => undefined);
  }

  private emptyReport(runAt = new Date().toISOString()): AutoFixReport {
    return {
      postsAnalyzed: 0,
      stillFailing: 0,
      alreadyFixed: 0,
      contentRulesGenerated: 0,
      syntheticFeedbackInjected: 0,
      topPatterns: [],
      weakestDimensions: [],
      promptOptimizerKicked: false,
      runAt,
    };
  }
}
