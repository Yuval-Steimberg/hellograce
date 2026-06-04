#!/usr/bin/env tsx
/**
 * Latency analyzer — pulls /admin/latency from production, cross-references
 * against the per-category target table in cases.ts, and produces a report
 * showing:
 *   1. Per-category P50/P95/P99 from real production traffic
 *   2. Whether each category MEETS its target
 *   3. Slow samples per category for deep diagnosis
 *   4. Per-stage breakdown (orch_generate, parallel_io, etc.) showing where
 *      time is going for each intent
 *
 * USAGE:
 *   tsx latency-bench/analyze.ts                       # default 24h
 *   tsx latency-bench/analyze.ts 1h                    # 1h window
 *   tsx latency-bench/analyze.ts 5m                    # 5m window
 *
 * REQUIRES:
 *   GRACE_API_URL=https://grace-api.fly.dev (default)
 *   ADMIN_TOKEN=<bearer> (or pass via env)
 *
 * Pairs with services/api/latency-bench/cases.ts which defines the target
 * floor + hard cap for every kind of message Grace can receive.
 */

import { LATENCY_CASES, type LatencyCase } from './cases.js';

const API_URL = process.env['GRACE_API_URL'] ?? 'https://grace-api.fly.dev';
const ADMIN_TOKEN = process.env['ADMIN_TOKEN'] ?? '';

if (!ADMIN_TOKEN) {
  console.error('Set ADMIN_TOKEN env var. Example:');
  console.error('  ADMIN_TOKEN=<token> tsx latency-bench/analyze.ts 24h');
  process.exit(1);
}

interface AdminLatencyResponse {
  window: string;
  overall: {
    n: string;
    p50: string | null;
    p95: string | null;
    p99: string | null;
    max: string | null;
    avg: string | null;
  } | null;
  by_intent: Array<{
    intent: string;
    n: string;
    p50: string;
    p95: string;
    p99: string;
    avg: string;
  }>;
  by_stage: Array<{
    stage: string;
    avg_ms: string;
    p95_ms: string;
    n: string;
  }>;
  slow_samples: Array<{
    intent: string;
    latency_ms: number;
    created_at: string;
    stage_timings: Record<string, number>;
    content: string;
  }>;
}

/**
 * Map cases.ts expectedPath → telemetry intent buckets.
 * The /admin/latency endpoint groups by the intent recorded by AIService.
 * Our case definitions use coarser "path" labels.
 */
const EXPECTED_PATH_TO_INTENTS: Record<LatencyCase['expectedPath'], string[]> = {
  fast_path: ['fast_path_greeting', 'fast_path_thanks', 'fast_path_brief_positive', 'fast_path_brief_negative', 'fast_path_brief_ack', 'fast_path_goodnight', 'fast_path_farewell', 'fast_path_laughter', 'fast_path_apology', 'fast_path_reaction', 'fast_path_appreciation', 'fast_path_love_it', 'fast_path_confirmation', 'fast_path_denial'],
  food_log_fast: ['food_log_fast'],
  weight_log_fast: ['weight_log_fast'],
  query_fast: ['query_fast_protein_goal', 'query_fast_calorie_goal', 'query_fast_weight_goal', 'query_fast_protein_today', 'query_fast_calorie_today', 'query_fast_progress_today'],
  faq_cache: ['faq_cache_'],
  orchestrator_simple: ['food_log', 'food_question', 'weight_log', 'mood_log', 'emotional', 'exercise_log', 'injection_log', 'social_situation', 'scheduling', 'general'],
  orchestrator_complex: ['knowledge', 'medication_question', 'appointment_prep'],
  safety: ['safety_emergency', 'safety_crisis'],
  scheduling: ['scheduling'],
  pause: ['pause_request'],
  image: ['image_food', 'image_body', 'image_other'],
  voice: ['voice_transcribed'],
  rlhf: ['rlhf_feedback'],
};

async function main() {
  const window_ = process.argv[2] ?? '24h';
  const url = `${API_URL}/admin/latency?window=${window_}`;
  console.log(`Fetching ${url}...`);

  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
  });
  if (!resp.ok) {
    console.error(`HTTP ${resp.status}: ${await resp.text()}`);
    process.exit(1);
  }
  const data = (await resp.json()) as AdminLatencyResponse;

  printOverall(data, window_);
  printByStage(data);
  printByExpectedPath(data);
  printSlowSamples(data);
  printGaps(data);
}

function printOverall(data: AdminLatencyResponse, win: string): void {
  console.log('\n=== OVERALL (' + win + ') ===');
  if (!data.overall || !data.overall.n || data.overall.n === '0') {
    console.log('No samples in window.');
    return;
  }
  console.log(`  n=${data.overall.n}  P50=${data.overall.p50}ms  P95=${data.overall.p95}ms  P99=${data.overall.p99}ms  max=${data.overall.max}ms  avg=${data.overall.avg}ms`);
}

function printByStage(data: AdminLatencyResponse): void {
  console.log('\n=== BY STAGE (where time is going) ===');
  for (const s of data.by_stage) {
    const flag = parseInt(s.avg_ms, 10) > 1000 ? ' ⚠️' : '';
    console.log(`  ${s.stage.padEnd(28)} avg=${s.avg_ms.padStart(6)}ms  p95=${s.p95_ms.padStart(6)}ms  n=${s.n}${flag}`);
  }
}

function printByExpectedPath(data: AdminLatencyResponse): void {
  console.log('\n=== PER PATH — target vs. actual ===');
  const intentMap = new Map(data.by_intent.map((i) => [i.intent, i]));

  // Group cases by expectedPath
  const pathToCases = new Map<LatencyCase['expectedPath'], LatencyCase[]>();
  for (const c of LATENCY_CASES) {
    if (!pathToCases.has(c.expectedPath)) pathToCases.set(c.expectedPath, []);
    pathToCases.get(c.expectedPath)!.push(c);
  }

  for (const [path, cases] of pathToCases.entries()) {
    const intentBuckets = EXPECTED_PATH_TO_INTENTS[path] ?? [path];
    const targetMs = Math.min(...cases.map((c) => c.latencyTargetMs));
    const hardCapMs = Math.max(...cases.map((c) => c.latencyHardCapMs));

    // Aggregate samples across all intent buckets that map to this path
    const matchingSamples: typeof data.by_intent[number][] = [];
    for (const bucket of intentBuckets) {
      for (const i of data.by_intent) {
        if (i.intent === bucket || i.intent.startsWith(bucket + '_')) {
          matchingSamples.push(i);
        }
      }
    }

    if (matchingSamples.length === 0) {
      console.log(`  ${path.padEnd(22)} target≤${targetMs}ms  hardcap≤${hardCapMs}ms  ${'NO DATA'.padStart(14)}`);
      continue;
    }

    const totalN = matchingSamples.reduce((s, m) => s + parseInt(m.n, 10), 0);
    const maxP95 = Math.max(...matchingSamples.map((m) => parseInt(m.p95, 10)));
    const maxP99 = Math.max(...matchingSamples.map((m) => parseInt(m.p99, 10)));
    const status =
      maxP95 <= targetMs ? '✅ MEETS TARGET' :
      maxP95 <= hardCapMs ? '🟡 ABOVE TARGET' :
      '❌ BREACHES CAP';
    console.log(
      `  ${path.padEnd(22)} target≤${String(targetMs).padStart(4)}ms  hardcap≤${String(hardCapMs).padStart(4)}ms  ` +
      `n=${String(totalN).padStart(4)}  p95=${String(maxP95).padStart(5)}ms  p99=${String(maxP99).padStart(5)}ms  ${status}`,
    );
    // Drill-down per intent
    for (const m of matchingSamples) {
      console.log(`     └── ${m.intent.padEnd(36)} n=${m.n.padStart(3)}  p50=${m.p50}ms  p95=${m.p95}ms`);
    }
  }
}

function printSlowSamples(data: AdminLatencyResponse): void {
  console.log('\n=== TOP 5 SLOW SAMPLES (diagnose where time went) ===');
  for (const s of data.slow_samples.slice(0, 5)) {
    const stages = Object.entries(s.stage_timings)
      .filter(([, v]) => v > 50)
      .sort(([, a], [, b]) => (b as number) - (a as number))
      .slice(0, 5)
      .map(([k, v]) => `${k}=${v}ms`)
      .join('  ');
    console.log(`  ${s.created_at}  ${s.intent.padEnd(24)}  ${s.latency_ms}ms`);
    console.log(`     stages: ${stages}`);
    console.log(`     content: ${s.content.slice(0, 100)}`);
  }
}

function printGaps(data: AdminLatencyResponse): void {
  console.log('\n=== CATEGORIES MISSING FROM PRODUCTION DATA ===');
  console.log('(These are message kinds defined in cases.ts but not yet tested live)');
  const seenIntents = new Set(data.by_intent.map((i) => i.intent));
  const expected = new Set<string>();
  for (const c of LATENCY_CASES) {
    for (const intent of EXPECTED_PATH_TO_INTENTS[c.expectedPath] ?? []) {
      expected.add(intent);
    }
  }
  const missing = [...expected].filter((i) => !seenIntents.has(i) && ![...seenIntents].some((s) => s.startsWith(i)));
  if (missing.length === 0) {
    console.log('  (none — every expected intent has at least one sample)');
    return;
  }
  for (const m of missing.slice(0, 30)) {
    console.log(`  • ${m}`);
  }
  if (missing.length > 30) console.log(`  ... and ${missing.length - 30} more`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
