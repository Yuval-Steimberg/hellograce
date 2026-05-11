import type { Confidence } from '@grace/shared';

export type EvalCategory =
  | 'food'
  | 'weight'
  | 'mood'
  | 'injection'
  | 'side_effect'
  | 'medical_question'
  | 'off_topic'
  | 'chat';

export interface EvalExpectation {
  /** Planner-declared intent must equal this string. */
  intent?: string;
  /** Each tool name listed must appear in the planner's tool calls. */
  toolCalls?: string[];
  /** No tool whose name appears here may be called. */
  forbiddenToolCalls?: string[];
  /** Case-insensitive substrings, all of which must appear in the response. */
  mustInclude?: string[];
  /** Case-insensitive substrings, none of which may appear in the response. */
  mustNotInclude?: string[];
  /** Hard upper bound on response length (chars). */
  maxLengthChars?: number;
  /** Hard lower bound on response length (chars). */
  minLengthChars?: number;
  /** Expected validator confidence. */
  confidence?: Confidence;
}

export interface EvalCase {
  id: string;
  category: EvalCategory;
  input: string;
  expected: EvalExpectation;
  /** Optional plain-English note for humans reading the report. */
  note?: string;
}

export type CheckName =
  | 'intent'
  | 'toolCalls'
  | 'forbiddenToolCalls'
  | 'mustInclude'
  | 'mustNotInclude'
  | 'maxLengthChars'
  | 'minLengthChars'
  | 'confidence';

export interface CheckResult {
  check: CheckName;
  passed: boolean;
  detail: string;
}

export interface CaseResult {
  case: EvalCase;
  response: {
    text: string;
    intent: string;
    confidence: Confidence;
    toolNames: string[];
    latencyMs: number;
  };
  checks: CheckResult[];
  passed: boolean;
  score: number;
  error?: string;
}

export interface CategoryReport {
  category: EvalCategory;
  total: number;
  passed: number;
  avgScore: number;
}

export interface EvalReport {
  timestamp: string;
  model: string;
  totalCases: number;
  totalPassed: number;
  overallScore: number;
  avgLatencyMs: number;
  byCategory: CategoryReport[];
  worstCases: CaseResult[];
  cases: CaseResult[];
}
