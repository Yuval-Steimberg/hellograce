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
