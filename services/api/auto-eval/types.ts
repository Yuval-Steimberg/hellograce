import type { Confidence, CriticReport, ToolResult } from '@grace/shared';

// ── Personas ──────────────────────────────────────────────────────────────

export interface Persona {
  id: string;
  name: string;
  age: number;
  medication: string;
  medicationType: 'weekly_injection' | 'daily_pill' | 'daily_injection';
  weekOnGlp1: number;
  goals: string[];
  dietaryRestriction?: 'VEGAN' | 'VEGETARIAN' | 'PESCATARIAN';
  foodDislikes?: string[];
  personalityTraits: string[];
  communicationStyle: CommunicationStyle;
  typicalIssues: string[];
  backstory: string;
  weight?: { current: number; goal: number };
}

export type CommunicationStyle =
  | 'verbose'
  | 'terse'
  | 'emoji-heavy'
  | 'formal'
  | 'casual'
  | 'anxious';

// ── Scenarios ─────────────────────────────────────────────────────────────

export type ScenarioCategory =
  | 'onboarding'
  | 'food_logging'
  | 'emotional_support'
  | 'medical_question'
  | 'topic_switching'
  | 'correction'
  | 'frustration'
  | 'multi_question'
  | 'slang_typos'
  | 'long_term_memory'
  | 'injection_day'
  | 'side_effects'
  | 'weight_tracking'
  | 'proactive_response'
  | 'edge_case';

export interface ConversationScenario {
  id: string;
  personaId: string;
  category: ScenarioCategory;
  description: string;
  turnCount: number;
  challenges: string[];
  setup?: string;
}

// ── Simulation ────────────────────────────────────────────────────────────

export interface SimulatedTurn {
  role: 'user' | 'grace';
  text: string;
  timestamp: number;
  orchestratorMeta?: {
    intent: string;
    confidence: Confidence;
    toolResults: ToolResult[];
    latencyMs: number;
    regenerated?: boolean;
    usedSafeFallback?: boolean;
    critic?: CriticReport;
  };
}

export interface SimulatedConversation {
  id: string;
  scenarioId: string;
  personaId: string;
  persona: Persona;
  scenario: ConversationScenario;
  turns: SimulatedTurn[];
  startedAt: string;
  completedAt: string;
  error?: string;
}

// ── Evaluation ────────────────────────────────────────────────────────────

export type EvalDimensionName =
  | 'relevance'
  | 'context_memory'
  | 'tone_match'
  | 'conciseness'
  | 'naturalness'
  | 'no_repetition'
  | 'no_generic_fallback'
  | 'conversational_continuity'
  | 'no_unnecessary_questions'
  | 'no_hallucination'
  | 'guardrail_compliance'
  | 'topic_tracking'
  | 'empathy'
  | 'actionability'
  | 'persona_awareness';

export interface EvaluationDimension {
  name: EvalDimensionName;
  score: number; // 1-5
  reasoning: string;
}

export interface TurnEvaluation {
  turnIndex: number;
  userMessage: string;
  graceResponse: string;
  dimensions: EvaluationDimension[];
  overallScore: number;
  strengths: string[];
  weaknesses: string[];
  suggestions: string[];
  criticalIssues: string[];
  passed: boolean;
}

export interface ConversationEvaluation {
  conversationId: string;
  scenarioId: string;
  personaId: string;
  category: ScenarioCategory;
  turnEvaluations: TurnEvaluation[];
  overallScore: number;
  conversationLevelIssues: string[];
  memoryUsageScore: number;
  consistencyScore: number;
  naturalness: number;
  summary: string;
  timestamp: string;
}

// ── Preference Pairs ──────────────────────────────────────────────────────

export interface PreferencePair {
  id: string;
  conversationId: string;
  turnIndex: number;
  context: string;
  userMessage: string;
  chosen: string;
  rejected: string;
  chosenScore: number;
  rejectedScore: number;
  dimension: EvalDimensionName;
  reasoning: string;
}

// ── Analysis ──────────────────────────────────────────────────────────────

export interface PatternAnalysis {
  pattern: string;
  frequency: number;
  avgScoreImpact: number;
  exampleConversationIds: string[];
  suggestedFix: string;
  category: 'prompt' | 'guardrail' | 'tool' | 'memory' | 'tone' | 'content';
}

export interface RegressionFlag {
  dimension: EvalDimensionName;
  previousAvg: number;
  currentAvg: number;
  delta: number;
  significance: 'low' | 'medium' | 'high';
}

// ── Report ────────────────────────────────────────────────────────────────

export interface AutoEvalReport {
  runId: string;
  timestamp: string;
  model: string;
  totalConversations: number;
  totalTurns: number;
  overallScore: number;
  passRate: number;
  scoreByCategory: Record<string, {
    avg: number;
    count: number;
    passRate: number;
    worstScore: number;
  }>;
  scoreByDimension: Record<string, {
    avg: number;
    failRate: number;
  }>;
  topPatterns: PatternAnalysis[];
  worstConversations: ConversationEvaluation[];
  preferencePairsGenerated: number;
  regressions: RegressionFlag[];
  improvementSuggestions: string[];
}

// ── Run Options ───────────────────────────────────────────────────────────

export interface AutoEvalRunOptions {
  apiKey: string;
  model: string;
  evaluatorModel?: string;
  scenarioCount?: number;
  turnsPerConversation?: number;
  concurrency?: number;
  categories?: ScenarioCategory[];
  personaIds?: string[];
  outDir: string;
  verbose?: boolean;
  generatePreferencePairs?: boolean;
  previousReportPath?: string;
}
