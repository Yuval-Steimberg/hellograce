/**
 * Coverage grader — deterministic checks for each case's expected behavior.
 *
 * Three categories of grading:
 *
 *  1. INTENT — Did the classifier route the message to the expected intent?
 *     This is a fast pre-check; if the intent is wrong the rest of the response
 *     is likely to be wrong too.
 *
 *  2. TOOL CALLS — Did the orchestrator fire the expected tools (e.g.
 *     get_food_summary for "protein left today")? An empty expected list
 *     means no tools required.
 *
 *  3. CONTENT — Does the response contain every must_include phrase AND
 *     none of the must_not_include phrases? These are the bug-regression
 *     anchors.
 *
 * Optionally, an LLM grader runs for `safety_level` and tone checks that
 * the deterministic layer can't verify (see graderLLM.ts wiring inside the
 * runner). The deterministic grader returns first; LLM grading is purely
 * additive insight, never a blocker.
 */

import type { CoverageCase } from './suite.js';
import type { ToolResult } from '@grace/shared';

export interface GradeFailure {
  type: 'intent_mismatch' | 'missing_tool' | 'extra_tool' | 'missing_required_phrase' | 'forbidden_phrase_present';
  detail: string;
}

export interface GradeResult {
  case_id: string;
  passed: boolean;
  intent_pass: boolean;
  tool_calls_pass: boolean;
  content_pass: boolean;
  failures: GradeFailure[];
}

export interface GradeInput {
  case: CoverageCase;
  /** The intent the classifier returned. */
  actual_intent: string;
  /** The names of tools the orchestrator actually executed (regardless of success). */
  actual_tool_names: string[];
  /** The final response text Grace produced (post format-enforcer, content-checker, etc). */
  response_text: string;
  /** Optional: full tool results for richer reporting. Not used in grading. */
  tool_results?: ToolResult[];
}

function lower(s: string): string {
  return s.toLowerCase();
}

export function grade(input: GradeInput): GradeResult {
  const failures: GradeFailure[] = [];

  // 1. Intent check — direct equality (case-insensitive).
  const intentPass = lower(input.actual_intent) === lower(input.case.expected_intent);
  if (!intentPass) {
    failures.push({
      type: 'intent_mismatch',
      detail: `expected ${input.case.expected_intent}, got ${input.actual_intent}`,
    });
  }

  // 2. Tool-calls check — every expected tool must appear in actual_tool_names.
  //    Extra tools are allowed (sometimes the LLM calls a helpful aux tool).
  //    Reordering is fine.
  const actualTools = new Set(input.actual_tool_names.map(lower));
  let toolCallsPass = true;
  for (const expected of input.case.expected_tool_calls) {
    if (!actualTools.has(lower(expected))) {
      toolCallsPass = false;
      failures.push({
        type: 'missing_tool',
        detail: `expected tool "${expected}" was not called`,
      });
    }
  }

  // 3. Content check — must_include phrases all present, must_not_include
  //    phrases all absent. Case-insensitive substring match.
  const responseLower = lower(input.response_text);
  let contentPass = true;
  for (const required of input.case.must_include) {
    if (!responseLower.includes(lower(required))) {
      contentPass = false;
      failures.push({
        type: 'missing_required_phrase',
        detail: `response is missing required phrase: "${required}"`,
      });
    }
  }
  for (const forbidden of input.case.must_not_include) {
    if (responseLower.includes(lower(forbidden))) {
      contentPass = false;
      failures.push({
        type: 'forbidden_phrase_present',
        detail: `response contains forbidden phrase: "${forbidden}"`,
      });
    }
  }

  return {
    case_id: input.case.case_id,
    passed: intentPass && toolCallsPass && contentPass,
    intent_pass: intentPass,
    tool_calls_pass: toolCallsPass,
    content_pass: contentPass,
    failures,
  };
}
