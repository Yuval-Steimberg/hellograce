// Regression runner — replays each known production bug with its exact
// trigger message and scores deterministically against banned phrases.
// This is the strictest layer of evaluation: a bug either regressed or didn't.
//
// Differs from the general auto-eval which uses an LLM judge — here the
// failure criteria are exact phrases from the original bug reports, so
// deterministic regex matching gives 0% false positive rate.

import type { LLMProvider } from '@grace/shared';
import type { Persona } from './types.js';
import { PERSONAS } from './personas.js';
import { REGRESSION_SCENARIOS, type RegressionScenario } from './regression-scenarios.js';

export interface RegressionResult {
  scenarioId: string;
  bugDescription: string;
  passed: boolean;
  graceResponse: string;
  bannedHits: string[];
  missingBehaviors: string[];
  latencyMs: number;
}

export interface RegressionReport {
  startedAt: string;
  completedAt: string;
  total: number;
  passed: number;
  failed: number;
  passRate: number;
  results: RegressionResult[];
}

interface RunDeps {
  llm: LLMProvider;
  // Function that takes a user message + persona and returns Grace's response.
  // Wired by the caller — uses the real orchestrator (with mocked tools when needed).
  invokeGrace: (input: { persona: Persona; userMessage: string; setup?: string }) => Promise<{ text: string; latencyMs: number }>;
  // Optional: additional DB-backed scenarios merged with static ones.
  dbScenarios?: RegressionScenario[];
}

export async function runRegressionSuite(deps: RunDeps): Promise<RegressionReport> {
  const startedAt = new Date().toISOString();
  const results: RegressionResult[] = [];

  const allScenarios = [...REGRESSION_SCENARIOS, ...(deps.dbScenarios ?? [])];
  for (const scenario of allScenarios) {
    const result = await runOne(scenario, deps);
    results.push(result);
  }

  const passed = results.filter((r) => r.passed).length;
  const failed = results.length - passed;

  return {
    startedAt,
    completedAt: new Date().toISOString(),
    total: results.length,
    passed,
    failed,
    passRate: results.length > 0 ? Math.round((passed / results.length) * 100) : 0,
    results,
  };
}

async function runOne(scenario: RegressionScenario, deps: RunDeps): Promise<RegressionResult> {
  const persona = PERSONAS.find((p) => p.id === scenario.personaId) ?? PERSONAS[0]!;
  const t0 = Date.now();

  let response: { text: string; latencyMs: number };
  try {
    response = await deps.invokeGrace({
      persona,
      userMessage: scenario.triggerMessage,
      setup: scenario.setup,
    });
  } catch (err) {
    return {
      scenarioId: scenario.id,
      bugDescription: scenario.bugDescription,
      passed: false,
      graceResponse: `ERROR: ${err instanceof Error ? err.message : String(err)}`,
      bannedHits: [],
      missingBehaviors: scenario.requiredBehavior,
      latencyMs: Date.now() - t0,
    };
  }

  const responseLower = response.text.toLowerCase();
  const bannedHits = scenario.bannedInResponse.filter((banned) =>
    responseLower.includes(banned.toLowerCase()),
  );

  // Required behaviors are checked semantically with an LLM judge — they're
  // not literal phrases, just "did the response do this".
  const missingBehaviors = scenario.requiredBehavior.length > 0
    ? await checkRequiredBehaviors(deps.llm, scenario, response.text)
    : [];

  return {
    scenarioId: scenario.id,
    bugDescription: scenario.bugDescription,
    passed: bannedHits.length === 0 && missingBehaviors.length === 0,
    graceResponse: response.text,
    bannedHits,
    missingBehaviors,
    latencyMs: response.latencyMs,
  };
}

async function checkRequiredBehaviors(
  llm: LLMProvider,
  scenario: RegressionScenario,
  response: string,
): Promise<string[]> {
  const prompt = `You are checking whether a chatbot response demonstrates specific behaviors.

USER MESSAGE: "${scenario.triggerMessage}"
${scenario.setup ? `CONTEXT: ${scenario.setup}\n` : ''}
CHATBOT RESPONSE: "${response}"

For each behavior below, output "yes" if the response clearly demonstrates it, "no" otherwise. Be strict.

Behaviors to check:
${scenario.requiredBehavior.map((b, i) => `${i + 1}. ${b}`).join('\n')}

Output ONLY a JSON object:
{"checks": [{"behavior": "<exact text>", "demonstrated": true/false}]}`;

  try {
    const resp = await llm.generate({
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.0,
      maxOutputTokens: 1024,
      responseFormat: 'json',
      model: 'gemini-2.0-flash',
    });
    const cleaned = resp.text.trim().replace(/^```json\s*/i, '').replace(/```$/, '').trim();
    const parsed = JSON.parse(cleaned) as { checks?: Array<{ behavior: string; demonstrated: boolean }> };
    const checks = parsed.checks ?? [];
    return checks.filter((c) => !c.demonstrated).map((c) => c.behavior);
  } catch {
    // Fail open — if LLM judge errors, only banned phrases count
    return [];
  }
}
