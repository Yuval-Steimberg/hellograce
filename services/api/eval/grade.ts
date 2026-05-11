import type { OrchestratorOutput } from '@grace/shared';
import type { CaseResult, CheckResult, EvalCase } from './types.js';

export function gradeCase(
  c: EvalCase,
  out: OrchestratorOutput,
  latencyMs: number,
): CaseResult {
  const checks: CheckResult[] = [];
  const toolNames = out.toolResults.map((r) => r.name);
  const lowerText = out.text.toLowerCase();
  const e = c.expected;

  if (e.intent !== undefined) {
    checks.push({
      check: 'intent',
      passed: out.intent === e.intent,
      detail: `expected ${e.intent}, got ${out.intent}`,
    });
  }

  if (e.toolCalls !== undefined) {
    const missing = e.toolCalls.filter((t) => !toolNames.includes(t));
    checks.push({
      check: 'toolCalls',
      passed: missing.length === 0,
      detail:
        missing.length === 0
          ? `all ${e.toolCalls.length} expected tools called`
          : `missing: ${missing.join(', ')}`,
    });
  }

  if (e.forbiddenToolCalls !== undefined) {
    const found = e.forbiddenToolCalls.filter((t) => toolNames.includes(t));
    checks.push({
      check: 'forbiddenToolCalls',
      passed: found.length === 0,
      detail:
        found.length === 0
          ? `no forbidden tools called`
          : `unexpectedly called: ${found.join(', ')}`,
    });
  }

  if (e.mustInclude !== undefined) {
    const missing = e.mustInclude.filter((s) => !lowerText.includes(s.toLowerCase()));
    checks.push({
      check: 'mustInclude',
      passed: missing.length === 0,
      detail:
        missing.length === 0
          ? `all required phrases present`
          : `missing phrases: ${missing.map((s) => `"${s}"`).join(', ')}`,
    });
  }

  if (e.mustNotInclude !== undefined) {
    const found = e.mustNotInclude.filter((s) => lowerText.includes(s.toLowerCase()));
    checks.push({
      check: 'mustNotInclude',
      passed: found.length === 0,
      detail:
        found.length === 0
          ? `no forbidden phrases present`
          : `found forbidden: ${found.map((s) => `"${s}"`).join(', ')}`,
    });
  }

  if (e.maxLengthChars !== undefined) {
    checks.push({
      check: 'maxLengthChars',
      passed: out.text.length <= e.maxLengthChars,
      detail: `length ${out.text.length} (max ${e.maxLengthChars})`,
    });
  }

  if (e.minLengthChars !== undefined) {
    checks.push({
      check: 'minLengthChars',
      passed: out.text.length >= e.minLengthChars,
      detail: `length ${out.text.length} (min ${e.minLengthChars})`,
    });
  }

  if (e.confidence !== undefined) {
    checks.push({
      check: 'confidence',
      passed: out.confidence === e.confidence,
      detail: `expected ${e.confidence}, got ${out.confidence}`,
    });
  }

  const passedCount = checks.filter((c) => c.passed).length;
  const score = checks.length === 0 ? 1 : passedCount / checks.length;

  return {
    case: c,
    response: {
      text: out.text,
      intent: out.intent,
      confidence: out.confidence,
      toolNames,
      latencyMs,
    },
    checks,
    passed: checks.every((c) => c.passed),
    score,
  };
}
