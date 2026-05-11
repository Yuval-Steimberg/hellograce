import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import pino from 'pino';
import { AIOrchestrator } from '@grace/ai-core';
import type { OrchestratorOutput } from '@grace/shared';
import { GeminiProvider } from '../src/llm/gemini.js';
import { EVAL_CASES } from './cases.js';
import { gradeCase } from './grade.js';
import { buildMockToolRegistry } from './mockTools.js';
import type {
  CaseResult,
  CategoryReport,
  EvalCase,
  EvalCategory,
  EvalReport,
} from './types.js';

export interface RunOptions {
  apiKey: string;
  model: string;
  /** If set, only run cases whose id matches this prefix (e.g. "food"). */
  filter?: string;
  /** Concurrency for case execution (default 3). Bump cautiously — Gemini has RPM limits. */
  concurrency?: number;
  /** Pretty-print progress to stderr. */
  verbose?: boolean;
  /** Directory to write results JSON into. */
  outDir: string;
}

export async function runEval(opts: RunOptions): Promise<EvalReport> {
  const logger = pino({ level: 'silent' });
  const llm = new GeminiProvider({ apiKey: opts.apiKey, model: opts.model }, logger);
  const tools = buildMockToolRegistry();
  const orchestrator = new AIOrchestrator({ llm, tools });

  const cases = opts.filter
    ? EVAL_CASES.filter((c) => c.id.startsWith(opts.filter!))
    : EVAL_CASES;

  if (cases.length === 0) {
    throw new Error(`No cases match filter "${opts.filter}"`);
  }

  const concurrency = Math.max(1, opts.concurrency ?? 3);
  const results: CaseResult[] = [];
  let completed = 0;

  async function runOne(c: EvalCase): Promise<CaseResult> {
    const started = Date.now();
    try {
      const out: OrchestratorOutput = await orchestrator.run({
        userId: `eval-${c.id}`,
        text: c.input,
        history: [],
        retrieved: [],
        toolsEnabled: true,
      });
      const result = gradeCase(c, out, Date.now() - started);
      if (opts.verbose) {
        process.stderr.write(
          `[${++completed}/${cases.length}] ${result.passed ? 'PASS' : 'FAIL'} ${c.id} ` +
            `(score ${result.score.toFixed(2)}, ${result.response.latencyMs}ms)\n`,
        );
      }
      return result;
    } catch (err) {
      completed++;
      const message = err instanceof Error ? err.message : String(err);
      if (opts.verbose) {
        process.stderr.write(`[${completed}/${cases.length}] ERROR ${c.id} — ${message}\n`);
      }
      return {
        case: c,
        response: {
          text: '',
          intent: 'unknown',
          confidence: 'low',
          toolNames: [],
          latencyMs: Date.now() - started,
        },
        checks: [],
        passed: false,
        score: 0,
        error: message,
      };
    }
  }

  for (let i = 0; i < cases.length; i += concurrency) {
    const batch = cases.slice(i, i + concurrency);
    const batchResults = await Promise.all(batch.map(runOne));
    results.push(...batchResults);
  }

  const report = buildReport(results, opts.model);
  persistReport(report, opts.outDir);
  return report;
}

function buildReport(results: CaseResult[], model: string): EvalReport {
  const categories = new Map<EvalCategory, CaseResult[]>();
  for (const r of results) {
    const list = categories.get(r.case.category) ?? [];
    list.push(r);
    categories.set(r.case.category, list);
  }

  const byCategory: CategoryReport[] = [];
  for (const [category, list] of categories) {
    byCategory.push({
      category,
      total: list.length,
      passed: list.filter((r) => r.passed).length,
      avgScore: avg(list.map((r) => r.score)),
    });
  }
  byCategory.sort((a, b) => a.category.localeCompare(b.category));

  const totalPassed = results.filter((r) => r.passed).length;
  const overallScore = avg(results.map((r) => r.score));
  const avgLatencyMs = avg(results.map((r) => r.response.latencyMs));

  const worstCases = [...results].sort((a, b) => a.score - b.score).slice(0, 8);

  return {
    timestamp: new Date().toISOString(),
    model,
    totalCases: results.length,
    totalPassed,
    overallScore,
    avgLatencyMs,
    byCategory,
    worstCases,
    cases: results,
  };
}

function persistReport(report: EvalReport, outDir: string): void {
  mkdirSync(outDir, { recursive: true });
  const safeStamp = report.timestamp.replace(/[:.]/g, '-');
  const path = join(outDir, `${safeStamp}.json`);
  writeFileSync(path, JSON.stringify(report, null, 2), 'utf8');
}

function avg(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

export function formatReport(report: EvalReport): string {
  const lines: string[] = [];
  lines.push('');
  lines.push(`Grace Eval — model: ${report.model} — ${report.timestamp}`);
  lines.push('─'.repeat(72));
  lines.push(
    `OVERALL: ${report.totalPassed}/${report.totalCases} cases passed ` +
      `(${pct(report.totalPassed / report.totalCases)}) · ` +
      `avg score ${report.overallScore.toFixed(2)} · ` +
      `avg latency ${Math.round(report.avgLatencyMs)}ms`,
  );
  lines.push('');
  lines.push('BY CATEGORY:');
  for (const c of report.byCategory) {
    lines.push(
      `  ${c.category.padEnd(18)} ${c.passed}/${c.total}  (${pct(c.passed / c.total)})  ` +
        `avg score ${c.avgScore.toFixed(2)}`,
    );
  }
  lines.push('');
  lines.push('WORST CASES:');
  for (const r of report.worstCases) {
    lines.push(`  [${r.case.id}] score ${r.score.toFixed(2)} — "${truncate(r.case.input, 60)}"`);
    if (r.error) {
      lines.push(`    ERROR: ${r.error}`);
      continue;
    }
    for (const check of r.checks.filter((c) => !c.passed)) {
      lines.push(`    ✗ ${check.check}: ${check.detail}`);
    }
    lines.push(`    response: "${truncate(r.response.text, 100)}"`);
  }
  lines.push('');
  return lines.join('\n');
}

function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}
