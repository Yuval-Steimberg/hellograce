/**
 * Coverage runner — executes the coverage suite against the live orchestrator.
 *
 * Reuses runSandboxReplay (services/api/src/replay/sandbox.ts) so every case
 * goes through the FULL production pipeline:
 *   classifier → planner skip → tools → orchestrator → format-enforcer →
 *   content-checker → quality-guard → relevance/behavioral/critic guards.
 *
 * This is intentional — the coverage report measures what Grace would
 * ACTUALLY do, not what each layer does in isolation.
 *
 * Concurrency is configurable. Default is 4 — Gemini Flash handles that
 * comfortably with our per-key RPM limits. 1000 cases at 4 concurrency
 * ≈ 12-15 minutes runtime (each case is ~3-5s end-to-end).
 */

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LLMProvider } from '@grace/shared';
import { runSandboxReplay, type ReplayPersona } from '../src/replay/sandbox.js';
import { classifyMessage } from '@grace/ai-core';
import { grade, type GradeResult } from './grader.js';
import type { CoverageCase } from './suite.js';

export interface CoverageRunCase {
  case_id: string;
  intent_id: string;
  domain: string;
  subtopic: string;
  user_message: string;
  expected_intent: string;
  expected_tool_calls: string[];
  safety_level: string;
  /** The intent the live classifier emitted (deterministic, no LLM). */
  actual_intent: string;
  /** Tool names the orchestrator executed. */
  actual_tool_names: string[];
  /** Final response text after format-enforcer, content-checker, regen, etc. */
  response_text: string;
  /** Grading verdict. */
  grade: GradeResult;
  /** Latency in milliseconds for the full case (sandbox replay). */
  latency_ms: number;
  /** Error message if the case crashed before grading. */
  error?: string;
}

export interface CoverageRunStats {
  total: number;
  passed: number;
  failed: number;
  errored: number;
  pass_rate: number; // 0-100
  intent_pass_rate: number;
  tool_calls_pass_rate: number;
  content_pass_rate: number;
  /** Pass rate broken down per domain. */
  by_domain: Record<string, { total: number; passed: number; pass_rate: number }>;
  /** Pass rate broken down per safety level. */
  by_safety_level: Record<string, { total: number; passed: number; pass_rate: number }>;
  /** Median latency in ms. */
  median_latency_ms: number;
}

export interface CoverageRunReport {
  run_id: string;
  started_at: string;
  completed_at: string;
  filters: {
    domains?: string[];
    journey_stages?: string[];
    safety_levels?: string[];
    limit?: number;
  };
  cases: CoverageRunCase[];
  stats: CoverageRunStats;
  system_prompt_version: number | null;
}

export interface RunOpts {
  cases: CoverageCase[];
  llm: LLMProvider;
  systemPrompt: string;
  concurrency?: number;
  /** Default persona to use for replays. Override per-case when adding
   *  persona-conditioning in Phase 4. */
  defaultPersona?: ReplayPersona;
  /** Filters carried through into the report metadata. */
  filters?: CoverageRunReport['filters'];
  /** Optional progress callback — fires after each case completes. */
  onProgress?: (completed: number, total: number, lastCase: CoverageRunCase) => void;
  /** Active system-prompt version, included in report metadata. */
  systemPromptVersion?: number | null;
}

/**
 * Default persona — generic mid-journey user with realistic protein target.
 * Each case can override (e.g. to test vegan-specific content paths).
 */
const DEFAULT_PERSONA: ReplayPersona = {
  firstName: 'Test',
  medication: 'Ozempic 1mg',
  proteinGoalGrams: 80,
  calorieGoalKcal: 1600,
  glp1WeekNumber: 16,
};

async function runOneCase(
  c: CoverageCase,
  opts: { llm: LLMProvider; systemPrompt: string; persona: ReplayPersona },
): Promise<CoverageRunCase> {
  const t0 = Date.now();
  const actualIntent = classifyMessage(c.user_message).type;
  try {
    const result = await runSandboxReplay({
      messages: [c.user_message],
      persona: opts.persona,
      systemPrompt: opts.systemPrompt,
      llm: opts.llm,
    });
    const lastGraceTurn = [...result.turns].reverse().find((t) => t.role === 'grace');
    const responseText = lastGraceTurn?.text ?? '';
    const actualToolNames = lastGraceTurn?.meta?.toolCalls?.map((tc) => tc.name) ?? [];
    const gradeResult = grade({
      case: c,
      actual_intent: actualIntent,
      actual_tool_names: actualToolNames,
      response_text: responseText,
    });
    return {
      case_id: c.case_id,
      intent_id: c.intent_id,
      domain: c.domain,
      subtopic: c.subtopic,
      user_message: c.user_message,
      expected_intent: c.expected_intent,
      expected_tool_calls: c.expected_tool_calls,
      safety_level: c.safety_level,
      actual_intent: actualIntent,
      actual_tool_names: actualToolNames,
      response_text: responseText,
      grade: gradeResult,
      latency_ms: Date.now() - t0,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      case_id: c.case_id,
      intent_id: c.intent_id,
      domain: c.domain,
      subtopic: c.subtopic,
      user_message: c.user_message,
      expected_intent: c.expected_intent,
      expected_tool_calls: c.expected_tool_calls,
      safety_level: c.safety_level,
      actual_intent: actualIntent,
      actual_tool_names: [],
      response_text: '',
      grade: {
        case_id: c.case_id,
        passed: false,
        intent_pass: false,
        tool_calls_pass: false,
        content_pass: false,
        failures: [{ type: 'intent_mismatch', detail: `runtime error: ${message}` }],
      },
      latency_ms: Date.now() - t0,
      error: message,
    };
  }
}

/**
 * Run a batch of cases with a fixed concurrency. Returns all results once the
 * last case completes (or errors out). Progress callback fires per case.
 */
export async function runCoverage(opts: RunOpts): Promise<CoverageRunReport> {
  const concurrency = Math.max(1, Math.min(16, opts.concurrency ?? 4));
  const persona = opts.defaultPersona ?? DEFAULT_PERSONA;
  const startedAt = new Date().toISOString();
  const runId = `coverage-${Date.now()}`;

  const results: CoverageRunCase[] = [];
  let completed = 0;

  // Simple worker-pool concurrency without external deps.
  const queue = [...opts.cases];
  async function worker(): Promise<void> {
    while (queue.length > 0) {
      const c = queue.shift();
      if (!c) return;
      const result = await runOneCase(c, {
        llm: opts.llm,
        systemPrompt: opts.systemPrompt,
        persona,
      });
      results.push(result);
      completed++;
      opts.onProgress?.(completed, opts.cases.length, result);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  // Stable ordering for deterministic comparison across runs.
  results.sort((a, b) => a.case_id.localeCompare(b.case_id));

  const stats = computeStats(results);
  return {
    run_id: runId,
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    filters: opts.filters ?? {},
    cases: results,
    stats,
    system_prompt_version: opts.systemPromptVersion ?? null,
  };
}

function computeStats(results: CoverageRunCase[]): CoverageRunStats {
  const total = results.length;
  const passed = results.filter((r) => r.grade.passed).length;
  const errored = results.filter((r) => r.error).length;
  const intentPassed = results.filter((r) => r.grade.intent_pass).length;
  const toolPassed = results.filter((r) => r.grade.tool_calls_pass).length;
  const contentPassed = results.filter((r) => r.grade.content_pass).length;

  const byDomain: Record<string, { total: number; passed: number; pass_rate: number }> = {};
  const bySafety: Record<string, { total: number; passed: number; pass_rate: number }> = {};
  for (const r of results) {
    byDomain[r.domain] ??= { total: 0, passed: 0, pass_rate: 0 };
    byDomain[r.domain]!.total++;
    if (r.grade.passed) byDomain[r.domain]!.passed++;

    bySafety[r.safety_level] ??= { total: 0, passed: 0, pass_rate: 0 };
    bySafety[r.safety_level]!.total++;
    if (r.grade.passed) bySafety[r.safety_level]!.passed++;
  }
  for (const key of Object.keys(byDomain)) {
    const b = byDomain[key]!;
    b.pass_rate = b.total > 0 ? Math.round((b.passed / b.total) * 1000) / 10 : 0;
  }
  for (const key of Object.keys(bySafety)) {
    const b = bySafety[key]!;
    b.pass_rate = b.total > 0 ? Math.round((b.passed / b.total) * 1000) / 10 : 0;
  }

  const latencies = results.map((r) => r.latency_ms).sort((a, b) => a - b);
  const median = latencies.length > 0 ? latencies[Math.floor(latencies.length / 2)] ?? 0 : 0;

  return {
    total,
    passed,
    failed: total - passed,
    errored,
    pass_rate: total > 0 ? Math.round((passed / total) * 1000) / 10 : 0,
    intent_pass_rate: total > 0 ? Math.round((intentPassed / total) * 1000) / 10 : 0,
    tool_calls_pass_rate: total > 0 ? Math.round((toolPassed / total) * 1000) / 10 : 0,
    content_pass_rate: total > 0 ? Math.round((contentPassed / total) * 1000) / 10 : 0,
    by_domain: byDomain,
    by_safety_level: bySafety,
    median_latency_ms: median,
  };
}

/** Resolve coverage/intents.json + read the active system prompt from the DB.
 *  Exposed as a separate helper so the admin endpoint can call it directly. */
export function loadCoverageDeps(): { intentsPath: string } {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  return { intentsPath: join(__dirname, 'intents.json') };
}
