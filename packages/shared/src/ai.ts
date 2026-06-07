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
  /** The arguments passed to the tool — stored in tool_logs for debugging. */
  args?: Record<string, unknown>;
  ok: boolean;
  output?: unknown;
  error?: string;
  latencyMs: number;
}

export interface DietaryRestriction {
  label: 'VEGAN' | 'VEGETARIAN' | 'PESCATARIAN';
  /** Lower-case food words that must NEVER appear in a recommendation. */
  forbidden: string[];
  /** Suggested allowed protein alternatives. */
  allowed: string[];
}

/** A single row from the content_rules table. */
export interface DbContentRule {
  id: number;
  rule_type: string;
  pattern: string;
  is_regex: boolean;
  flags: string;
  reason: string;
  severity: 'log' | 'regen' | 'block';
  applies_to: 'ai' | 'scheduler' | 'all';
}

export interface OrchestratorInput {
  userId: string;
  text: string;
  history: ChatTurn[];
  retrieved: RetrievedDoc[];
  toolsEnabled: boolean;
  /** Override the default system prompt (loaded from DB prompts table). */
  systemPrompt?: string;
  /** Detected dietary restriction (vegan/vegetarian/pescatarian). When
   *  present, the orchestrator post-checks the response for forbidden words
   *  and force-regens if any are found. */
  dietaryRestriction?: DietaryRestriction;
  /** User's first name. When present AND isFirstMessage is false, the
   *  format enforcer strips every occurrence from the draft (NAME USAGE
   *  ZERO TOLERANCE rule). */
  userFirstName?: string;
  /** True if this is the user's very first message. Suppresses the
   *  name-strip in the format enforcer (welcome messages are allowed to
   *  use the user's name once). */
  isFirstMessage?: boolean;
  /** Cleaned (prefix-stripped) list of foods the user dislikes. Content
   *  checker treats these like a mini dietary restriction — Grace must
   *  never suggest them. */
  foodDislikes?: string[];
  /** Inferred GLP-1 medication category. Drives the medication-contradiction
   *  guard so Grace doesn't talk about "injection day" to a Rybelsus user. */
  medicationType?: 'weekly_injection' | 'daily_pill' | 'daily_injection' | 'unknown';
  /** Modality flag set by ai.service.ts before invoking the orchestrator.
   *  'image_body' enables the medical-leak guard (Grace must not mention
   *  pain/injury/symptoms in response to a progress selfie). */
  responseMode?: 'text' | 'image_food' | 'image_body' | 'voice';
  /** Active content rules loaded from the DB. block → immediate safe fallback;
   *  regen → force regeneration; log → observe only. */
  dbRules?: DbContentRule[];
  /** Pre-computed planner decision. When the caller ran the planner in
   *  parallel with RAG retrieval (latency optimization), pass the result
   *  here and the orchestrator will skip its own planner call. */
  prePlannedDecision?: PlannerDecision;
  /** Top-k long-term semantic memories about this user, retrieved from
   *  the user_memories table. Injected verbatim into the system prompt. */
  userMemories?: string[];
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
  /** Codes of the violations that triggered the regen (banned_phrase,
   *  behavioral_violation, relevance_check_failed, etc). Used by the
   *  production-issue capture loop to label what kind of failure happened. */
  regenTriggerCodes?: string[];
  /** Detailed violation entries from the FINAL attempt (initial gen or
   *  regen — whichever was last). Includes the literal matched text so we
   *  can see WHICH banned phrase / forbidden food / db rule actually fired.
   *  Surfaced to production_issues.context for offline analysis. */
  regenViolationDetails?: Array<{
    code: string;
    match?: string;
    message?: string;
  }>;
  /** The text Gemini originally produced on the FIRST attempt before any
   *  regen. When usedSafeFallback is true, this is the text that was
   *  rejected. Without this we can't tell from production_issues what
   *  Gemini actually wanted to say. */
  originalAttemptText?: string;
  /** Internal stage timing (set by AIOrchestrator.run). Surfaced so the API
   *  layer can record per-stage breakdowns to messages.stage_timings JSONB. */
  internalTimings?: {
    /** Tool execution time (search_food_ideas, log_food, etc.) (ms). */
    tools?: number;
    /** Initial LLM generate call (ms). */
    generate?: number;
    /** Format enforcer + content checker + grounding precheck + drift detection (ms). */
    postgen?: number;
    /** Parallel post-gen guards: relevance + behavioral + critic (ms). */
    guards?: number;
    /** LLM relevance check duration (ms, 0 when skipped). */
    guardRelevance?: number;
    /** LLM behavioral guard duration (ms, 0 when skipped). */
    guardBehavioral?: number;
    /** Early-critic duration inside the guards batch (ms, 0 when skipped). */
    guardCritic?: number;
    /** Critic LLM call inside needsReview when not already run earlier (ms). */
    review?: number;
    /** Retry LLM call when content / guards failed (ms). 0 when no retry. */
    regen?: number;
    /** Whether thinking was disabled on the initial call. */
    thinkingDisabled?: boolean;
  };
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
  /** Quantitative or interaction-safety claims in the response with no
   *  support in retrieved knowledge. Populated by the deterministic
   *  grounding precheck (services/api/eval cannot mock these — they're
   *  computed from response text + retrieved chunks). */
  unsupportedClaims?: string[];
  /** True if the critic itself failed (malformed JSON, LLM error). In that case
   *  we treat the response as if pass=false for safety. */
  malformed?: boolean;
  /** True if the report was synthesized from the deterministic precheck
   *  rather than an LLM call. Saves a Gemini call when we can fail-closed
   *  on grounding alone. */
  source?: 'llm' | 'precheck';
  /** Phase B diagnostic (2026-06-07): bytes of input sent to the critic
   *  LLM. Tracks payload-size drivers of slow runs. */
  inputSizeChars?: number;
  /** Phase B diagnostic (2026-06-07): wall-clock latency of just the
   *  Gemini call inside the critic. Excludes JSON parsing. */
  llmMs?: number;
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
  /** Enable Gemini's built-in Google Search grounding — used as a last
   *  resort when the KB has no answer (e.g. recent clinical research
   *  Grace doesn't have indexed). Mutually exclusive with responseFormat
   *  = 'json'. */
  useGoogleSearch?: boolean;
  /** Override the default model for this request (e.g. 'gemini-2.0-flash' for cheaper calls). */
  model?: string;
  /** Disable thinking/reasoning tokens to reduce cost on simple messages. */
  disableThinking?: boolean;
  /** Structured-output schema. When set, the provider forces JSON output
   *  matching this schema (Gemini's responseSchema). Eliminates malformed
   *  output and lets the caller trust the parsed shape. Supersedes
   *  responseFormat — when schema is present, the response IS JSON. */
  responseSchema?: ResponseSchema;
}

/** Minimal JSON Schema subset that maps cleanly to Gemini's responseSchema
 *  (which itself is a subset of OpenAPI 3.0 schema). Provider-agnostic so
 *  we can swap models without rewriting tool code. */
export interface ResponseSchema {
  type: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean';
  /** For type='object': map of property name → schema. */
  properties?: Record<string, ResponseSchema>;
  /** For type='object': required property names. */
  required?: string[];
  /** For type='array': the item schema. */
  items?: ResponseSchema;
  /** For type='string' or 'number': enum of allowed values. */
  enum?: Array<string | number>;
  /** Human-readable description — guides the model's reasoning. */
  description?: string;
  /** For type='array': minimum item count (Gemini supports this). */
  minItems?: number;
}

export interface LLMResponse {
  text: string;
  finishReason: 'stop' | 'length' | 'safety' | 'other';
  usage?: { inputTokens: number; outputTokens: number };
}
