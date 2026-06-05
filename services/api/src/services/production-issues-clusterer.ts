/**
 * Production-issues clustering — Phase C of the architectural inversion.
 *
 * Pulls all pending production_issues from a rolling window and groups
 * them by user-message similarity (n-gram Jaccard). For each cluster:
 *   - sample messages (3 most-recent representatives)
 *   - sample failing Grace responses
 *   - common violation codes across the cluster
 *   - suggested fast-path regex (heuristic: longest common prefix +
 *     anchored keyword pattern)
 *   - count, first-seen, last-seen
 *
 * Powers the admin "what's failing in production" view so we can grow
 * the fast-path coverage without manual log diving.
 *
 * No LLM calls in this service — all clustering is deterministic.
 * Adding a Gemini suggestion step on top is straightforward but kept
 * separate (caller can opt in).
 *
 * Cost: O(N^2) Jaccard for N issues in the window. With a 14-day window
 * and ~50 issues/day, N ~700, so ~250k comparisons — under 100ms.
 */

import type { Pool } from 'pg';
import type { Logger } from 'pino';

export interface ProductionIssueRow {
  id: number;
  user_id: string;
  user_message: string;
  grace_response: string | null;
  trigger: string;
  violation_codes: string[] | null;
  context: Record<string, unknown> | null;
  created_at: Date;
}

export interface ProductionIssueCluster {
  /** Stable ID derived from the first issue in the cluster. */
  cluster_id: string;
  /** Number of issues in the cluster. */
  count: number;
  /** Up to 3 representative user messages (most recent). */
  sample_messages: string[];
  /** Up to 3 representative Grace responses. */
  sample_grace_responses: Array<string | null>;
  /** Distinct trigger types observed in this cluster, with counts. */
  triggers: Array<{ trigger: string; count: number }>;
  /** Distinct violation codes observed, with counts. */
  violation_codes: Array<{ code: string; count: number }>;
  /** Heuristic regex suggestion for a new fast-path matcher. */
  suggested_pattern: string | null;
  /** Common keyword tokens (≥50% of cluster). */
  common_keywords: string[];
  /** First and last observation. */
  first_seen: Date;
  last_seen: Date;
}

export interface ClusterOptions {
  /** Days back to include. Default 14. */
  windowDays?: number;
  /** Jaccard similarity threshold for grouping. Default 0.35. */
  similarityThreshold?: number;
  /** Maximum clusters to return. Default 20. */
  maxClusters?: number;
  /** Minimum cluster size to surface. Default 2. */
  minClusterSize?: number;
}

export class ProductionIssuesClusterer {
  constructor(
    private readonly pool: Pool,
    private readonly logger: Logger,
  ) {}

  /**
   * Pull recent pending issues and cluster them by message similarity.
   * Returns clusters sorted by count desc.
   */
  async cluster(opts: ClusterOptions = {}): Promise<ProductionIssueCluster[]> {
    const windowDays = opts.windowDays ?? 14;
    const threshold = opts.similarityThreshold ?? 0.35;
    const maxClusters = opts.maxClusters ?? 20;
    const minClusterSize = opts.minClusterSize ?? 2;

    const rows = await this.fetchIssues(windowDays);
    if (rows.length === 0) return [];

    // Pre-tokenize each message for Jaccard.
    const tokenSets = rows.map((r) => tokenize(r.user_message));

    // Single-pass greedy clustering. For each issue, find a cluster whose
    // representative passes the similarity threshold; otherwise create a new
    // cluster. The representative is the first issue assigned to the cluster.
    const clusters: number[][] = []; // index → [issue indices]
    const representativeTokens: Set<string>[] = [];

    for (let i = 0; i < rows.length; i++) {
      let placed = false;
      for (let c = 0; c < clusters.length; c++) {
        const j = jaccard(tokenSets[i]!, representativeTokens[c]!);
        if (j >= threshold) {
          clusters[c]!.push(i);
          placed = true;
          break;
        }
      }
      if (!placed) {
        clusters.push([i]);
        representativeTokens.push(tokenSets[i]!);
      }
    }

    // Build summaries, filter, sort, and cap.
    const summaries = clusters
      .map((idxs) => this.summarizeCluster(idxs, rows, tokenSets))
      .filter((s) => s.count >= minClusterSize)
      .sort((a, b) => b.count - a.count)
      .slice(0, maxClusters);

    this.logger.info(
      { totalIssues: rows.length, clusters: summaries.length, windowDays },
      'production_issues_clusterer.complete',
    );
    return summaries;
  }

  private async fetchIssues(windowDays: number): Promise<ProductionIssueRow[]> {
    const result = await this.pool.query<ProductionIssueRow>(
      `SELECT id, user_id, user_message, grace_response, trigger,
              violation_codes, context, created_at
       FROM production_issues
       WHERE status = 'pending'
         AND created_at > now() - INTERVAL '${windowDays.toFixed(0)} days'
         AND user_message IS NOT NULL
         AND length(user_message) > 0
       ORDER BY created_at DESC
       LIMIT 2000`,
    );
    return result.rows;
  }

  private summarizeCluster(
    indices: number[],
    rows: ProductionIssueRow[],
    tokenSets: Set<string>[],
  ): ProductionIssueCluster {
    const members = indices.map((i) => rows[i]!);
    const memberTokens = indices.map((i) => tokenSets[i]!);

    const triggerCounts = new Map<string, number>();
    const codeCounts = new Map<string, number>();
    for (const m of members) {
      triggerCounts.set(m.trigger, (triggerCounts.get(m.trigger) ?? 0) + 1);
      for (const code of m.violation_codes ?? []) {
        codeCounts.set(code, (codeCounts.get(code) ?? 0) + 1);
      }
    }

    // Common keywords: tokens appearing in ≥50% of cluster members.
    const tokenDocFreq = new Map<string, number>();
    for (const set of memberTokens) {
      for (const tok of set) {
        tokenDocFreq.set(tok, (tokenDocFreq.get(tok) ?? 0) + 1);
      }
    }
    const half = Math.ceil(members.length / 2);
    const commonKeywords = [...tokenDocFreq.entries()]
      .filter(([, count]) => count >= half)
      .sort((a, b) => b[1] - a[1])
      .map(([tok]) => tok)
      .slice(0, 8);

    // Suggested pattern: anchored regex requiring 2+ of the common keywords.
    // Simple heuristic — not perfect, but a starting point for a human review.
    const suggestedPattern = commonKeywords.length >= 2
      ? `/\\b(${commonKeywords.slice(0, 4).map(escapeRegex).join('|')})\\b/i`
      : null;

    const sortedByRecency = [...members].sort(
      (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
    );

    return {
      cluster_id: `cl_${members[0]!.id}`,
      count: members.length,
      sample_messages: sortedByRecency.slice(0, 3).map((m) => m.user_message),
      sample_grace_responses: sortedByRecency.slice(0, 3).map((m) => m.grace_response),
      triggers: [...triggerCounts.entries()]
        .map(([trigger, count]) => ({ trigger, count }))
        .sort((a, b) => b.count - a.count),
      violation_codes: [...codeCounts.entries()]
        .map(([code, count]) => ({ code, count }))
        .sort((a, b) => b.count - a.count),
      suggested_pattern: suggestedPattern,
      common_keywords: commonKeywords,
      first_seen: new Date(
        Math.min(...members.map((m) => new Date(m.created_at).getTime())),
      ),
      last_seen: new Date(
        Math.max(...members.map((m) => new Date(m.created_at).getTime())),
      ),
    };
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

const STOP_WORDS = new Set([
  'i', 'me', 'my', 'mine', 'we', 'us', 'our', 'you', 'your', 'yours',
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'do', 'does', 'did', 'doing', 'have', 'has', 'had', 'having',
  'to', 'of', 'in', 'on', 'at', 'by', 'for', 'with', 'about', 'as',
  'and', 'or', 'but', 'if', 'so', 'than', 'then', 'too', 'very',
  'this', 'that', 'these', 'those', 'it', 'its', 'they', 'them', 'their',
  'not', 'no', 'yes', 'just', 'also', 'only', 'some', 'any', 'all',
  'what', 'when', 'where', 'why', 'how', 'who', 'which',
  'will', 'would', 'should', 'could', 'can', 'may', 'might',
  'now', 'today', 'tomorrow', 'yesterday',
  'thanks', 'thank', 'please', 'ok', 'okay', 'grace',
]);

/** Tokenize a user message into a normalized set of content words. */
function tokenize(text: string): Set<string> {
  const tokens = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !STOP_WORDS.has(t));
  return new Set(tokens);
}

/** Jaccard similarity: |A ∩ B| / |A ∪ B|. */
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Internal exports for unit tests
export const __testing = { tokenize, jaccard, escapeRegex };
