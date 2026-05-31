/**
 * Coverage reporter — formats a coverage run report for human consumption
 * (terminal + admin UI) and writes it to disk for diff-against-previous-run
 * comparisons.
 *
 * Storage shape mirrors auto-eval/store.ts so future tooling can treat them
 * uniformly: one JSON file per run under `services/api/coverage/results/`.
 */

import { mkdirSync, writeFileSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CoverageRunReport } from './runner.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = join(__dirname, 'results');

export function ensureResultsDir(): void {
  if (!existsSync(RESULTS_DIR)) mkdirSync(RESULTS_DIR, { recursive: true });
}

export function saveReport(report: CoverageRunReport): string {
  ensureResultsDir();
  const filename = `${report.run_id}.json`;
  const fullPath = join(RESULTS_DIR, filename);
  writeFileSync(fullPath, JSON.stringify(report, null, 2));
  return fullPath;
}

/** List all past run reports newest-first. */
export function listReports(): Array<{ run_id: string; started_at: string; pass_rate: number; total: number }> {
  ensureResultsDir();
  const files = readdirSync(RESULTS_DIR).filter((f) => f.endsWith('.json'));
  const summaries = files
    .map((f) => {
      try {
        const raw = JSON.parse(readFileSync(join(RESULTS_DIR, f), 'utf-8')) as CoverageRunReport;
        return {
          run_id: raw.run_id,
          started_at: raw.started_at,
          pass_rate: raw.stats.pass_rate,
          total: raw.stats.total,
        };
      } catch {
        return null;
      }
    })
    .filter((r): r is { run_id: string; started_at: string; pass_rate: number; total: number } => r !== null)
    .sort((a, b) => b.started_at.localeCompare(a.started_at));
  return summaries;
}

export function loadReport(runId: string): CoverageRunReport | null {
  const path = join(RESULTS_DIR, `${runId}.json`);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as CoverageRunReport;
  } catch {
    return null;
  }
}

/**
 * Format a run as a human-readable terminal report. Used by the optional
 * stand-alone CLI runner (services/api/scripts/run-coverage.ts) and by the
 * weekly cron summary in Phase 4.
 */
export function formatTerminal(report: CoverageRunReport): string {
  const lines: string[] = [];
  lines.push(`━━━ Coverage Run ${report.run_id} ━━━`);
  lines.push(`Started:   ${report.started_at}`);
  lines.push(`Completed: ${report.completed_at}`);
  if (report.system_prompt_version != null) {
    lines.push(`Prompt version: v${report.system_prompt_version}`);
  }
  lines.push('');

  const s = report.stats;
  lines.push(`OVERALL: ${s.passed}/${s.total} passed (${s.pass_rate}%)`);
  lines.push(`  intent:       ${s.intent_pass_rate}%`);
  lines.push(`  tool_calls:   ${s.tool_calls_pass_rate}%`);
  lines.push(`  content:      ${s.content_pass_rate}%`);
  if (s.errored > 0) lines.push(`  errored:      ${s.errored}`);
  lines.push(`  median p50:   ${s.median_latency_ms}ms`);
  lines.push('');

  lines.push('BY DOMAIN:');
  const domainEntries = Object.entries(s.by_domain).sort(([, a], [, b]) => a.pass_rate - b.pass_rate);
  for (const [domain, breakdown] of domainEntries) {
    const bar = '█'.repeat(Math.round(breakdown.pass_rate / 5));
    lines.push(`  ${domain.padEnd(16)} ${String(breakdown.passed).padStart(3)}/${String(breakdown.total).padEnd(3)} ${breakdown.pass_rate.toString().padStart(5)}% ${bar}`);
  }
  lines.push('');

  lines.push('BY SAFETY LEVEL:');
  for (const [level, breakdown] of Object.entries(s.by_safety_level)) {
    lines.push(`  ${level.padEnd(20)} ${breakdown.passed}/${breakdown.total} (${breakdown.pass_rate}%)`);
  }
  lines.push('');

  const failures = report.cases.filter((c) => !c.grade.passed);
  if (failures.length > 0) {
    lines.push(`FAILURES (${failures.length}):`);
    for (const f of failures.slice(0, 20)) {
      lines.push(`  ✗ ${f.case_id}  [${f.domain}/${f.subtopic}]`);
      lines.push(`     user: "${f.user_message.slice(0, 80)}"`);
      lines.push(`     intent: expected=${f.expected_intent} actual=${f.actual_intent}`);
      for (const fail of f.grade.failures.slice(0, 3)) {
        lines.push(`     - ${fail.type}: ${fail.detail}`);
      }
    }
    if (failures.length > 20) {
      lines.push(`  ...and ${failures.length - 20} more (see JSON report)`);
    }
  }

  return lines.join('\n');
}

/**
 * Compute a delta between two runs: which intents flipped from passing to
 * failing (regressions) and which flipped from failing to passing (recoveries).
 * Used by the Phase 4 weekly cron to spot prompt-change regressions quickly.
 */
export function reportDelta(prev: CoverageRunReport, curr: CoverageRunReport): {
  regressions: Array<{ case_id: string; reason: string }>;
  recoveries: string[];
  pass_rate_delta: number;
} {
  const prevMap = new Map(prev.cases.map((c) => [c.case_id, c.grade.passed] as const));
  const currMap = new Map(curr.cases.map((c) => [c.case_id, c.grade.passed] as const));

  const regressions: Array<{ case_id: string; reason: string }> = [];
  const recoveries: string[] = [];

  for (const [id, currPassed] of currMap) {
    const prevPassed = prevMap.get(id);
    if (prevPassed === true && currPassed === false) {
      const c = curr.cases.find((cc) => cc.case_id === id);
      const reason = c?.grade.failures.map((f) => f.type).join(', ') ?? 'unknown';
      regressions.push({ case_id: id, reason });
    } else if (prevPassed === false && currPassed === true) {
      recoveries.push(id);
    }
  }

  return {
    regressions,
    recoveries,
    pass_rate_delta: curr.stats.pass_rate - prev.stats.pass_rate,
  };
}
