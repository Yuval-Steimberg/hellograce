/**
 * Coverage suite — loads intents.json, expands every variation into a runnable
 * test case. Each case carries the user message + the grading criteria (expected
 * intent, tool calls, must_include / must_not_include phrases, safety level).
 *
 * The runner (runner.ts) feeds each case through runSandboxReplay (the real
 * production orchestrator with mocked tools) and the grader (grader.ts)
 * evaluates the response.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export type SafetyLevel = 'informational' | 'clinical_redirect' | 'emergency';

export interface CoverageIntent {
  id: string;
  domain: string;
  subtopic: string;
  variations: string[];
  expected_intent: string;
  expected_tool_calls: string[];
  must_include: string[];
  must_not_include: string[];
  safety_level: SafetyLevel;
  journey_stages: string[];
  source: string;
}

export interface IntentsFile {
  version: number;
  description: string;
  schema: Record<string, string>;
  intents: CoverageIntent[];
}

export interface CoverageCase {
  case_id: string;        // "<intent.id>#<variation_index>"
  intent_id: string;
  domain: string;
  subtopic: string;
  user_message: string;
  expected_intent: string;
  expected_tool_calls: string[];
  must_include: string[];
  must_not_include: string[];
  safety_level: SafetyLevel;
  journey_stages: string[];
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const INTENTS_PATH = join(__dirname, 'intents.json');

/** Load intents.json from disk. Throws if malformed (test would catch this). */
export function loadIntents(path: string = INTENTS_PATH): IntentsFile {
  const raw = readFileSync(path, 'utf-8');
  const parsed = JSON.parse(raw) as IntentsFile;
  if (!parsed.intents || !Array.isArray(parsed.intents)) {
    throw new Error('intents.json: missing or invalid `intents` array');
  }
  return parsed;
}

export interface BuildSuiteOpts {
  domains?: string[];         // filter by domain (default: all)
  journeyStages?: string[];   // filter by stage (default: all)
  safetyLevels?: SafetyLevel[];
  limit?: number;             // cap total cases (random sample if exceeded)
  intentsFile?: IntentsFile;  // dependency injection for tests
}

/**
 * Build the list of runnable cases from intents.json. Every variation
 * becomes its own case. Filters narrow the run scope so admins can target
 * specific domains / stages / safety tiers without running the full ~500+.
 */
export function buildSuite(opts: BuildSuiteOpts = {}): CoverageCase[] {
  const file = opts.intentsFile ?? loadIntents();
  let intents = file.intents;

  if (opts.domains && opts.domains.length > 0) {
    const set = new Set(opts.domains);
    intents = intents.filter((i) => set.has(i.domain));
  }
  if (opts.safetyLevels && opts.safetyLevels.length > 0) {
    const set = new Set(opts.safetyLevels);
    intents = intents.filter((i) => set.has(i.safety_level));
  }
  if (opts.journeyStages && opts.journeyStages.length > 0) {
    const set = new Set(opts.journeyStages);
    intents = intents.filter((i) =>
      // Empty journey_stages → applies to all stages
      i.journey_stages.length === 0 || i.journey_stages.some((s) => set.has(s)),
    );
  }

  const cases: CoverageCase[] = [];
  for (const intent of intents) {
    for (let i = 0; i < intent.variations.length; i++) {
      const variation = intent.variations[i];
      if (!variation || variation.trim().length === 0) continue;
      cases.push({
        case_id: `${intent.id}#${i}`,
        intent_id: intent.id,
        domain: intent.domain,
        subtopic: intent.subtopic,
        user_message: variation,
        expected_intent: intent.expected_intent,
        expected_tool_calls: intent.expected_tool_calls,
        must_include: intent.must_include,
        must_not_include: intent.must_not_include,
        safety_level: intent.safety_level,
        journey_stages: intent.journey_stages,
      });
    }
  }

  if (opts.limit && opts.limit > 0 && cases.length > opts.limit) {
    // Stable random sample so the same `limit` returns the same slice
    // across runs — easier to compare deltas between runs.
    const sorted = [...cases].sort((a, b) => a.case_id.localeCompare(b.case_id));
    return sorted.slice(0, opts.limit);
  }
  return cases;
}
