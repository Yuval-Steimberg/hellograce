import type { ChatTurn } from './messages.js';

export type Confidence = 'low' | 'medium' | 'high';

export interface RetrievedDoc {
  id: string;
  source: 'history' | 'knowledge' | 'web';
  content: string;
  score: number;
  metadata?: Record<string, unknown>;
}

export interface PlannerDecision {
  intent: string;
  needsTools: boolean;
  toolCalls: ToolCall[];
  rationale: string;
}

export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
}

export interface ToolResult {
  name: string;
  ok: boolean;
  output?: unknown;
  error?: string;
  latencyMs: number;
}

export interface OrchestratorInput {
  userId: string;
  text: string;
  history: ChatTurn[];
  retrieved: RetrievedDoc[];
  toolsEnabled: boolean;
  /** Override the default system prompt (loaded from DB prompts table). */
  systemPrompt?: string;
}

export interface OrchestratorOutput {
  text: string;
  confidence: Confidence;
  intent: string;
  toolResults: ToolResult[];
  usedRetrieval: boolean;
  latencyMs: number;
  /** Present when the LLM-critic was invoked (risky intent or validator flagged). */
  critic?: CriticReport;
  /** True if the response was regenerated after a critic/validator failure. */
  regenerated?: boolean;
  /** True if both attempts failed the gate and a safe fallback was returned. */
  usedSafeFallback?: boolean;
}

export type CriticCriterion = 'grounding' | 'safety' | 'on_task' | 'tone';

export interface CriticReport {
  /** 1-5 per criterion. Higher is better. */
  scores: Record<CriticCriterion, number>;
  /** Sum of scores (4-20). */
  overall: number;
  /** True if all criteria >= 3 and overall >= 14. */
  pass: boolean;
  /** Specific issues the critic flagged (verbatim, for regen prompt + admin review). */
  issues: string[];
  /** True if the critic itself failed (malformed JSON, LLM error). In that case
   *  we treat the response as if pass=false for safety. */
  malformed?: boolean;
}

/** Provider-agnostic LLM interface. Concrete adapters live in services/api. */
export interface LLMProvider {
  readonly id: string;
  generate(req: LLMRequest): Promise<LLMResponse>;
}

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LLMRequest {
  messages: LLMMessage[];
  temperature?: number;
  maxOutputTokens?: number;
  responseFormat?: 'text' | 'json';
}

export interface LLMResponse {
  text: string;
  finishReason: 'stop' | 'length' | 'safety' | 'other';
  usage?: { inputTokens: number; outputTokens: number };
}
