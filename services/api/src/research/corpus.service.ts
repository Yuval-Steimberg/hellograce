/**
 * Research corpus service — the pipeline orchestrator for the real_data_corpus
 * table.
 *
 * Stages (each runs idempotently on a row-id list):
 *   1. ingestPosts          → INSERT new rows, dedup on content_hash
 *   2. classifyAndCheckCoverage → run classifyMessage() + find nearest intent
 *   3. replayAndGrade        → sandbox-replay through orchestrator, deterministic grade
 *   4. evaluateFailures      → LLM 15-dim eval on rows where grade failed OR uncovered
 *
 * All stages skip rows that already have the target column populated, so
 * re-running a stage is safe and only processes new work.
 */

import type { Pool } from 'pg';
import type { Logger } from 'pino';
import type { LLMProvider } from '@grace/shared';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyMessage } from '@grace/ai-core';
import { runSandboxReplay, type ReplayPersona } from '../replay/sandbox.js';
import type { ScrapedPost } from './reddit-scraper.js';

export interface IngestPostInput {
  raw_text: string;
  content_hash: string;
  source_type: 'reddit' | 'csv_upload' | 'manual';
  source_url?: string;
  source_subreddit?: string;
  source_score?: number;
  source_comment_count?: number;
  author_hashed?: string;
}

export interface CorpusServiceDeps {
  pool: Pool;
  llm: LLMProvider;
  logger: Logger;
  /** System prompt for sandbox replay. If absent, the service reads the
   *  active prompt from the `prompts` table on each replay batch. */
  systemPrompt?: string;
}

interface IntentEntry {
  id: string;
  domain: string;
  subtopic: string;
  variations: string[];
  expected_intent: string;
  safety_level: string;
}

interface IntentsFile {
  intents: IntentEntry[];
}

/**
 * Default persona for sandbox replay. Mid-journey user with realistic
 * targets — same defaults as the coverage suite uses.
 */
const REPLAY_PERSONA: ReplayPersona = {
  firstName: 'Research',
  medication: 'Ozempic 1mg',
  proteinGoalGrams: 80,
  calorieGoalKcal: 1600,
  glp1WeekNumber: 16,
};

export class CorpusService {
  private intentsCache: IntentEntry[] | null = null;
  private intentsLoadedAt = 0;

  constructor(private deps: CorpusServiceDeps) {}

  /**
   * Insert posts, deduplicated by content_hash. Already-present hashes are
   * counted as `deduped` and skipped. Returns ids of newly-inserted rows.
   */
  async ingestPosts(posts: IngestPostInput[]): Promise<{ insertedIds: number[]; deduped: number }> {
    if (posts.length === 0) return { insertedIds: [], deduped: 0 };
    const insertedIds: number[] = [];
    let deduped = 0;
    for (const p of posts) {
      try {
        const { rows } = await this.deps.pool.query<{ id: number }>(
          `INSERT INTO real_data_corpus
             (content_hash, source_type, source_url, source_subreddit,
              source_score, source_comment_count, author_hashed, raw_text)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (content_hash) DO NOTHING
           RETURNING id`,
          [
            p.content_hash,
            p.source_type,
            p.source_url ?? null,
            p.source_subreddit ?? null,
            p.source_score ?? null,
            p.source_comment_count ?? null,
            p.author_hashed ?? null,
            p.raw_text,
          ],
        );
        if (rows.length === 0) {
          deduped++;
        } else {
          insertedIds.push(rows[0]!.id);
        }
      } catch (err) {
        this.deps.logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          'corpus.ingest.row_failed',
        );
      }
    }
    this.deps.logger.info({ inserted: insertedIds.length, deduped }, 'corpus.ingest.done');
    return { insertedIds, deduped };
  }

  /**
   * Run the deterministic classifier on each row's raw_text + find the
   * nearest intent.id match in intents.json. Writes classified_intent,
   * intent_id_match, is_covered. Skips rows where classified_intent is
   * already populated.
   */
  async classifyAndCheckCoverage(rowIds?: number[]): Promise<{ classified: number }> {
    const rows = await this.fetchRows(rowIds, 'classified_intent IS NULL');
    if (rows.length === 0) return { classified: 0 };
    const intents = this.loadIntents();
    let count = 0;
    for (const row of rows) {
      const intent = classifyMessage(row.raw_text).type;
      const match = this.findNearestIntent(row.raw_text, intent, intents);
      await this.deps.pool.query(
        `UPDATE real_data_corpus
            SET classified_intent = $1,
                intent_id_match = $2,
                is_covered = $3
          WHERE id = $4`,
        [intent, match?.id ?? null, match !== null, row.id],
      );
      count++;
    }
    this.deps.logger.info({ classified: count }, 'corpus.classify.done');
    return { classified: count };
  }

  /**
   * Replay each row through the orchestrator (sandbox) + apply the
   * deterministic grader: did we route to the expected intent? Did we
   * avoid the must_not_include phrases? Skips rows where grace_response
   * is already populated.
   */
  async replayAndGrade(rowIds?: number[], opts: { concurrency?: number } = {}): Promise<{ replayed: number }> {
    const rows = await this.fetchRows(rowIds, 'grace_response IS NULL AND classified_intent IS NOT NULL');
    if (rows.length === 0) return { replayed: 0 };
    const concurrency = Math.max(1, Math.min(8, opts.concurrency ?? 3));
    const systemPrompt = this.deps.systemPrompt ?? (await this.loadActiveSystemPrompt());

    const queue = [...rows];
    let count = 0;
    const worker = async () => {
      while (queue.length > 0) {
        const r = queue.shift();
        if (!r) return;
        try {
          const t0 = Date.now();
          const result = await runSandboxReplay({
            messages: [r.raw_text.slice(0, 1_000)],
            persona: REPLAY_PERSONA,
            systemPrompt,
            llm: this.deps.llm,
          });
          const lastGrace = [...result.turns].reverse().find((t) => t.role === 'grace');
          const responseText = lastGrace?.text ?? '';
          const responseIntent = lastGrace?.meta?.intent ?? '';
          const failures = this.gradeRow(r, responseText, responseIntent);
          await this.deps.pool.query(
            `UPDATE real_data_corpus
                SET grace_response = $1,
                    grace_response_intent = $2,
                    grade_passed = $3,
                    grade_failures = $4,
                    replay_latency_ms = $5,
                    replay_at = now()
              WHERE id = $6`,
            [
              responseText,
              responseIntent,
              failures.length === 0,
              JSON.stringify(failures),
              Date.now() - t0,
              r.id,
            ],
          );
          count++;
        } catch (err) {
          this.deps.logger.warn(
            { rowId: r.id, err: err instanceof Error ? err.message : String(err) },
            'corpus.replay.row_failed',
          );
        }
      }
    };
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    this.deps.logger.info({ replayed: count }, 'corpus.replay.done');
    return { replayed: count };
  }

  /**
   * Run the auto-eval 15-dimension LLM evaluator ONLY on rows where the
   * deterministic grader failed OR coverage check flagged uncovered intent.
   * Skips rows where eval_at is already populated.
   */
  async evaluateFailures(rowIds?: number[]): Promise<{ evaluated: number }> {
    const rows = await this.fetchRows(
      rowIds,
      'eval_at IS NULL AND grace_response IS NOT NULL AND (grade_passed = FALSE OR is_covered = FALSE)',
    );
    if (rows.length === 0) return { evaluated: 0 };

    // Dynamic import of the Evaluator (auto-eval is outside src/ rootDir).
    const evaluatorUrl = new URL('../../auto-eval/evaluator.js', import.meta.url).href;
    const mod = await import(evaluatorUrl).catch((err: unknown) => {
      this.deps.logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'corpus.eval.import_failed',
      );
      return null;
    }) as { Evaluator?: new (llm: LLMProvider) => { evaluateTurn: (input: unknown) => Promise<{ scores: Record<string, number>; overallScore: number; weaknesses: string[] }> } } | null;
    if (!mod?.Evaluator) {
      return { evaluated: 0 };
    }
    const evaluator = new mod.Evaluator(this.deps.llm);

    let count = 0;
    for (const r of rows) {
      try {
        const verdict = await evaluator.evaluateTurn({
          userMessage: r.raw_text.slice(0, 1_000),
          graceResponse: r.grace_response ?? '',
          turnIndex: 0,
          persona: { id: 'research', name: 'Research', medication: 'Ozempic' },
        });
        await this.deps.pool.query(
          `UPDATE real_data_corpus
              SET eval_scores = $1,
                  eval_overall = $2,
                  eval_weaknesses = $3,
                  eval_at = now()
            WHERE id = $4`,
          [
            JSON.stringify(verdict.scores ?? {}),
            verdict.overallScore ?? null,
            verdict.weaknesses ?? [],
            r.id,
          ],
        );
        count++;
      } catch (err) {
        this.deps.logger.warn(
          { rowId: r.id, err: err instanceof Error ? err.message : String(err) },
          'corpus.eval.row_failed',
        );
      }
    }
    this.deps.logger.info({ evaluated: count }, 'corpus.eval.done');
    return { evaluated: count };
  }

  // ── internals ──────────────────────────────────────────────────────────

  private async fetchRows(
    rowIds: number[] | undefined,
    extraWhere: string,
  ): Promise<Array<{
    id: number;
    raw_text: string;
    classified_intent: string | null;
    intent_id_match: string | null;
    is_covered: boolean | null;
    grace_response: string | null;
  }>> {
    if (rowIds && rowIds.length === 0) return [];
    const params: unknown[] = [];
    let where = extraWhere;
    if (rowIds && rowIds.length > 0) {
      params.push(rowIds);
      where = `${where} AND id = ANY($1)`;
    }
    const { rows } = await this.deps.pool.query(
      `SELECT id, raw_text, classified_intent, intent_id_match, is_covered, grace_response
         FROM real_data_corpus
        WHERE ${where}
        ORDER BY id ASC
        LIMIT 500`,
      params,
    );
    return rows as Array<{
      id: number;
      raw_text: string;
      classified_intent: string | null;
      intent_id_match: string | null;
      is_covered: boolean | null;
      grace_response: string | null;
    }>;
  }

  private loadIntents(): IntentEntry[] {
    const FIVE_MIN = 5 * 60 * 1_000;
    if (this.intentsCache && Date.now() - this.intentsLoadedAt < FIVE_MIN) {
      return this.intentsCache;
    }
    try {
      // Resolve coverage/intents.json. The file is checked into the repo
      // and shipped at runtime via the Dockerfile's explicit COPY.
      const __dirname = dirname(fileURLToPath(import.meta.url));
      const candidates = [
        join(__dirname, '..', '..', 'coverage', 'intents.json'),
        join(__dirname, '..', '..', '..', 'coverage', 'intents.json'),
      ];
      for (const path of candidates) {
        try {
          const raw = readFileSync(path, 'utf-8');
          const file = JSON.parse(raw) as IntentsFile;
          this.intentsCache = file.intents ?? [];
          this.intentsLoadedAt = Date.now();
          return this.intentsCache;
        } catch {
          /* try next */
        }
      }
      this.deps.logger.warn('corpus.intents.not_found');
      this.intentsCache = [];
      this.intentsLoadedAt = Date.now();
      return this.intentsCache;
    } catch (err) {
      this.deps.logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'corpus.intents.load_failed',
      );
      return [];
    }
  }

  /**
   * Nearest-intent matcher: find the intent.id whose expected_intent matches
   * the classifier output AND shares the most non-stopword tokens with the
   * raw_text. Returns null when no candidate has ≥2 shared tokens.
   */
  private findNearestIntent(
    rawText: string,
    classifiedIntent: string,
    intents: IntentEntry[],
  ): IntentEntry | null {
    const candidates = intents.filter((i) => i.expected_intent === classifiedIntent);
    if (candidates.length === 0) return null;

    const STOPWORDS = new Set([
      'the', 'a', 'an', 'i', 'my', 'me', 'is', 'it', 'and', 'or', 'but', 'so',
      'to', 'of', 'for', 'in', 'on', 'at', 'as', 'be', 'have', 'has', 'had',
      'this', 'that', 'with', 'what', 'when', 'where', 'how', 'why', 'do',
      'does', 'did', 'are', 'was', 'were', 'will', 'would', 'should', 'can',
      'about', 'from', 'by', 'just', 'any', 'all', 'some', 'not', 'no', 'yes',
      'feel', 'feels', 'feeling', 'felt', 'really', 'very', 'today', 'now',
    ]);
    const tokens = (s: string): Set<string> =>
      new Set(
        s
          .toLowerCase()
          .replace(/[^a-z0-9\s]/g, ' ')
          .split(/\s+/)
          .filter((t) => t.length >= 3 && !STOPWORDS.has(t)),
      );
    const rawTokens = tokens(rawText);

    let best: { intent: IntentEntry; score: number } | null = null;
    for (const c of candidates) {
      let totalShared = 0;
      for (const variation of c.variations) {
        const vTokens = tokens(variation);
        let shared = 0;
        for (const t of vTokens) if (rawTokens.has(t)) shared++;
        totalShared = Math.max(totalShared, shared);
      }
      // Also boost on subtopic keyword match
      const subtopicTokens = tokens(c.subtopic.replace(/_/g, ' '));
      for (const t of subtopicTokens) if (rawTokens.has(t)) totalShared++;
      if (totalShared < 2) continue;
      if (!best || totalShared > best.score) {
        best = { intent: c, score: totalShared };
      }
    }
    return best?.intent ?? null;
  }

  /**
   * Deterministic grader for replayed responses. Mirrors coverage/grader.ts
   * but operates on real-data rows where we have classified_intent (not
   * expected_intent from a hand-curated source). The minimum bar:
   *  - response is non-empty
   *  - response intent matches the classifier-inferred intent
   *  - response doesn't contain critical banned phrases that the layered
   *    guards should already strip (defense in depth)
   */
  private gradeRow(
    row: { classified_intent: string | null },
    response: string,
    responseIntent: string,
  ): Array<{ type: string; detail: string }> {
    const failures: Array<{ type: string; detail: string }> = [];
    if (!response || response.trim().length === 0) {
      failures.push({ type: 'empty_response', detail: 'Grace returned no text' });
      return failures;
    }
    if (row.classified_intent && responseIntent && responseIntent !== row.classified_intent &&
        // Allow downgrades to 'general' / 'chat' (orchestrator final intent)
        !['chat', 'general'].includes(responseIntent)) {
      failures.push({
        type: 'intent_mismatch',
        detail: `classifier said ${row.classified_intent}, orchestrator routed to ${responseIntent}`,
      });
    }
    // Critical banned-phrase guards (subset — others handled in the orchestrator)
    const banned = [
      { re: /\bi apologize for (the )?(confusion|mix.?up)\b/i, type: 'unprompted_apology' },
      { re: /\babsolutely critical questions\b/i, type: 'warning_label_tone' },
      { re: /\byou must discuss\b/i, type: 'warning_label_tone' },
      { re: /\bi only know about you\b/i, type: 'privacy_misfire' },
    ];
    for (const b of banned) {
      if (b.re.test(response)) {
        failures.push({ type: b.type, detail: `response contains "${b.re.source}"` });
      }
    }
    return failures;
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

  // ── reports for the admin UI ──────────────────────────────────────────

  async listCorpus(filters: {
    subreddit?: string;
    intent?: string;
    covered?: boolean;
    status?: string;
    limit?: number;
    offset?: number;
  } = {}): Promise<{ rows: Record<string, unknown>[]; total: number }> {
    const limit = Math.max(1, Math.min(200, filters.limit ?? 50));
    const offset = Math.max(0, filters.offset ?? 0);
    const where: string[] = [];
    const params: unknown[] = [];
    if (filters.subreddit) {
      params.push(filters.subreddit);
      where.push(`source_subreddit = $${params.length}`);
    }
    if (filters.intent) {
      params.push(filters.intent);
      where.push(`classified_intent = $${params.length}`);
    }
    if (typeof filters.covered === 'boolean') {
      params.push(filters.covered);
      where.push(`is_covered = $${params.length}`);
    }
    if (filters.status) {
      params.push(filters.status);
      where.push(`admin_status = $${params.length}`);
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

    const countParams = [...params];
    const { rows: countRows } = await this.deps.pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM real_data_corpus ${whereSql}`,
      countParams,
    );
    const total = parseInt(countRows[0]?.count ?? '0', 10);

    params.push(limit, offset);
    const { rows } = await this.deps.pool.query(
      `SELECT id, content_hash, source_type, source_url, source_subreddit,
              source_score, scraped_at, raw_text, classified_intent,
              intent_id_match, is_covered, grade_passed, eval_overall,
              admin_status
         FROM real_data_corpus
         ${whereSql}
         ORDER BY scraped_at DESC
         LIMIT $${params.length - 1}
         OFFSET $${params.length}`,
      params,
    );
    return { rows: rows as Record<string, unknown>[], total };
  }

  async getCorpusRow(id: number): Promise<Record<string, unknown> | null> {
    const { rows } = await this.deps.pool.query(
      `SELECT * FROM real_data_corpus WHERE id = $1`,
      [id],
    );
    return (rows[0] as Record<string, unknown>) ?? null;
  }

  async setAdminStatus(id: number, status: 'reviewed' | 'promoted_to_intent' | 'rejected', notes?: string): Promise<void> {
    await this.deps.pool.query(
      `UPDATE real_data_corpus
          SET admin_status = $1,
              reviewed_at = now(),
              notes = COALESCE($2, notes)
        WHERE id = $3`,
      [status, notes ?? null, id],
    );
  }

  /**
   * Aggregated coverage-gap view for the admin UI. Returns the prioritized
   * roadmap: which intents have the most uncovered posts, which subreddits
   * are weakest, which eval dimensions score lowest.
   */
  async coverageGaps(): Promise<{
    by_intent: Record<string, { covered: number; uncovered: number; total: number }>;
    by_subreddit: Record<string, { covered: number; uncovered: number; total: number }>;
    top_uncovered: Array<{ id: number; raw_text: string; classified_intent: string | null; source_url: string | null; source_score: number | null }>;
    weakest_dims: Array<{ dim: string; avg: number; count: number }>;
  }> {
    const byIntent: Record<string, { covered: number; uncovered: number; total: number }> = {};
    const bySub: Record<string, { covered: number; uncovered: number; total: number }> = {};

    const { rows: intentRows } = await this.deps.pool.query<{ classified_intent: string | null; is_covered: boolean | null; count: string }>(
      `SELECT classified_intent, is_covered, COUNT(*)::text AS count
         FROM real_data_corpus
        WHERE classified_intent IS NOT NULL
        GROUP BY classified_intent, is_covered`,
    );
    for (const r of intentRows) {
      const key = r.classified_intent ?? 'unknown';
      byIntent[key] ??= { covered: 0, uncovered: 0, total: 0 };
      const n = parseInt(r.count, 10);
      if (r.is_covered) byIntent[key]!.covered += n;
      else byIntent[key]!.uncovered += n;
      byIntent[key]!.total += n;
    }

    const { rows: subRows } = await this.deps.pool.query<{ source_subreddit: string | null; is_covered: boolean | null; count: string }>(
      `SELECT source_subreddit, is_covered, COUNT(*)::text AS count
         FROM real_data_corpus
        WHERE source_subreddit IS NOT NULL
        GROUP BY source_subreddit, is_covered`,
    );
    for (const r of subRows) {
      const key = r.source_subreddit ?? 'unknown';
      bySub[key] ??= { covered: 0, uncovered: 0, total: 0 };
      const n = parseInt(r.count, 10);
      if (r.is_covered) bySub[key]!.covered += n;
      else bySub[key]!.uncovered += n;
      bySub[key]!.total += n;
    }

    const { rows: topRows } = await this.deps.pool.query<{
      id: number;
      raw_text: string;
      classified_intent: string | null;
      source_url: string | null;
      source_score: number | null;
    }>(
      `SELECT id, raw_text, classified_intent, source_url, source_score
         FROM real_data_corpus
        WHERE is_covered = FALSE
          AND admin_status = 'pending'
        ORDER BY COALESCE(source_score, 0) DESC, scraped_at DESC
        LIMIT 20`,
    );

    // Weakest LLM-eval dimensions (avg score across all evaluated rows).
    const { rows: dimRows } = await this.deps.pool.query<{ key: string; avg: string; count: string }>(
      `WITH dims AS (
         SELECT key, (value::text)::numeric AS score
           FROM real_data_corpus, jsonb_each(eval_scores)
          WHERE eval_scores IS NOT NULL
       )
       SELECT key, AVG(score)::text AS avg, COUNT(*)::text AS count
         FROM dims
        GROUP BY key
        ORDER BY AVG(score) ASC
        LIMIT 5`,
    );
    const weakestDims = dimRows.map((r) => ({
      dim: r.key,
      avg: Math.round(parseFloat(r.avg) * 10) / 10,
      count: parseInt(r.count, 10),
    }));

    return {
      by_intent: byIntent,
      by_subreddit: bySub,
      top_uncovered: topRows,
      weakest_dims: weakestDims,
    };
  }
}

/**
 * Convert a ScrapedPost into the corpus ingest input shape. Tiny helper so
 * the cron / endpoint code stays clean.
 */
export function scrapedPostToIngestInput(p: ScrapedPost): IngestPostInput {
  return {
    raw_text: p.raw_text,
    content_hash: p.content_hash,
    source_type: 'reddit',
    source_url: p.permalink,
    source_subreddit: p.subreddit,
    source_score: p.score,
    source_comment_count: p.num_comments,
    author_hashed: p.author_hashed,
  };
}
