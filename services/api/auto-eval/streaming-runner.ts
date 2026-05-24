import pino from 'pino';
import type { LLMProvider } from '@grace/shared';
import { GeminiProvider } from '../src/llm/gemini.js';
import { generateScenarios } from './scenarios.js';
import { ConversationSimulator } from './simulator.js';
import { ConversationEvaluator } from './evaluator.js';
import { analyzeResults } from './analyzer.js';
import { generatePreferencePairs } from './preference-pairs.js';
import { buildReport } from './reporter.js';
import { AutoEvalStore } from './store.js';
import type {
  AutoEvalReport,
  AutoEvalRunOptions,
  ConversationEvaluation,
  SimulatedConversation,
} from './types.js';

export type AutoEvalPhase = 'simulating' | 'evaluating' | 'analyzing' | 'preference_pairs' | 'reporting' | 'done' | 'error';

export interface AutoEvalProgressEvent {
  phase: AutoEvalPhase;
  progress: number; // 0-100
  total: number;
  completed: number;
  message: string;
  score?: number;
  error?: string;
}

export type ProgressCallback = (event: AutoEvalProgressEvent) => void;

export interface StreamingRunState {
  running: boolean;
  phase: AutoEvalPhase;
  progress: number;
  total: number;
  completed: number;
  startedAt: string;
  report?: AutoEvalReport;
  error?: string;
}

let currentRun: StreamingRunState | null = null;
const listeners = new Set<ProgressCallback>();

export function getRunState(): StreamingRunState | null {
  return currentRun;
}

export function addProgressListener(cb: ProgressCallback): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function emit(event: AutoEvalProgressEvent): void {
  if (currentRun) {
    currentRun.phase = event.phase;
    currentRun.progress = event.progress;
    currentRun.completed = event.completed;
    currentRun.total = event.total;
  }
  for (const cb of listeners) {
    try { cb(event); } catch { /* ignore listener errors */ }
  }
}

export async function runAutoEvalStreaming(opts: AutoEvalRunOptions): Promise<AutoEvalReport> {
  if (currentRun?.running) {
    throw new Error('An auto-eval run is already in progress');
  }

  currentRun = {
    running: true,
    phase: 'simulating',
    progress: 0,
    total: 0,
    completed: 0,
    startedAt: new Date().toISOString(),
  };

  try {
    const logger = pino({ level: 'silent' });

    const simLlm = new GeminiProvider(
      { apiKey: opts.apiKey, model: opts.model },
      logger,
    );

    const evalModel = opts.evaluatorModel ?? opts.model;
    const evalLlm: LLMProvider = evalModel !== opts.model
      ? new GeminiProvider({ apiKey: opts.apiKey, model: evalModel }, logger)
      : simLlm;

    const store = new AutoEvalStore(opts.outDir);
    const simulator = new ConversationSimulator({ llm: simLlm });
    const evaluator = new ConversationEvaluator(evalLlm);

    const scenarios = generateScenarios({
      categories: opts.categories,
      personaIds: opts.personaIds,
      count: opts.scenarioCount,
    });

    if (scenarios.length === 0) {
      throw new Error('No scenarios generated. Check category/persona filters.');
    }

    currentRun.total = scenarios.length;
    const concurrency = Math.max(1, opts.concurrency ?? 2);
    const conversations: SimulatedConversation[] = [];
    const evaluations: ConversationEvaluation[] = [];

    // Phase 1: Simulate conversations
    emit({
      phase: 'simulating',
      progress: 0,
      total: scenarios.length,
      completed: 0,
      message: `Starting simulation of ${scenarios.length} scenarios...`,
    });

    for (let i = 0; i < scenarios.length; i += concurrency) {
      const batch = scenarios.slice(i, i + concurrency);
      const results = await Promise.all(
        batch.map(async (scenario) => {
          const conv = await simulator.simulate(scenario);
          store.saveConversation(conv);
          return conv;
        }),
      );
      conversations.push(...results);

      const completed = Math.min(i + concurrency, scenarios.length);
      const errCount = results.filter((c) => c.error).length;
      emit({
        phase: 'simulating',
        progress: Math.round((completed / scenarios.length) * 50),
        total: scenarios.length,
        completed,
        message: `Simulated ${completed}/${scenarios.length}${errCount > 0 ? ` (${errCount} errors)` : ''}`,
      });
    }

    // Phase 2: Evaluate conversations
    emit({
      phase: 'evaluating',
      progress: 50,
      total: conversations.length,
      completed: 0,
      message: 'Starting evaluation...',
    });

    for (let i = 0; i < conversations.length; i += concurrency) {
      const batch = conversations.slice(i, i + concurrency);
      const results = await Promise.all(
        batch.map(async (conv) => {
          const evaluation = await evaluator.evaluate(conv);
          store.saveEvaluation(evaluation);
          return evaluation;
        }),
      );
      evaluations.push(...results);

      const completed = Math.min(i + concurrency, conversations.length);
      const avgScore = results.reduce((sum, e) => sum + e.overallScore, 0) / results.length;
      emit({
        phase: 'evaluating',
        progress: 50 + Math.round((completed / conversations.length) * 35),
        total: conversations.length,
        completed,
        message: `Evaluated ${completed}/${conversations.length} (batch avg: ${avgScore.toFixed(2)})`,
        score: avgScore,
      });
    }

    // Phase 3: Analyze patterns
    emit({
      phase: 'analyzing',
      progress: 85,
      total: 1,
      completed: 0,
      message: 'Analyzing patterns and detecting regressions...',
    });

    const previousReport = store.loadPreviousReport();
    const { patterns, regressions, suggestions } = analyzeResults(evaluations, previousReport);

    emit({
      phase: 'analyzing',
      progress: 90,
      total: 1,
      completed: 1,
      message: `Found ${patterns.length} patterns, ${regressions.length} regressions`,
    });

    // Phase 4: Generate preference pairs
    let preferencePairCount = 0;
    if (opts.generatePreferencePairs !== false) {
      emit({
        phase: 'preference_pairs',
        progress: 90,
        total: 1,
        completed: 0,
        message: 'Generating preference pairs...',
      });

      const pairs = await generatePreferencePairs(evalLlm, conversations, evaluations);
      preferencePairCount = pairs.length;
      store.savePreferencePairs(pairs);

      emit({
        phase: 'preference_pairs',
        progress: 95,
        total: 1,
        completed: 1,
        message: `Generated ${pairs.length} preference pairs`,
      });
    }

    // Phase 5: Build and save report
    emit({
      phase: 'reporting',
      progress: 95,
      total: 1,
      completed: 0,
      message: 'Building final report...',
    });

    const report = buildReport(
      evaluations,
      patterns,
      regressions,
      suggestions,
      preferencePairCount,
      opts.model,
    );
    store.saveReport(report);

    currentRun.report = report;
    currentRun.running = false;
    currentRun.phase = 'done';

    emit({
      phase: 'done',
      progress: 100,
      total: scenarios.length,
      completed: scenarios.length,
      message: `Complete! Overall score: ${report.overallScore.toFixed(2)}, pass rate: ${(report.passRate * 100).toFixed(0)}%`,
      score: report.overallScore,
    });

    return report;
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    if (currentRun) {
      currentRun.running = false;
      currentRun.phase = 'error';
      currentRun.error = errorMsg;
    }
    emit({
      phase: 'error',
      progress: currentRun?.progress ?? 0,
      total: currentRun?.total ?? 0,
      completed: currentRun?.completed ?? 0,
      message: `Error: ${errorMsg}`,
      error: errorMsg,
    });
    throw err;
  }
}
