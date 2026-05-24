import pino from 'pino';
import type { LLMProvider } from '@grace/shared';
import { GeminiProvider } from '../src/llm/gemini.js';
import { generateScenarios } from './scenarios.js';
import { ConversationSimulator } from './simulator.js';
import { ConversationEvaluator } from './evaluator.js';
import { analyzeResults } from './analyzer.js';
import { generatePreferencePairs } from './preference-pairs.js';
import { buildReport, formatReport } from './reporter.js';
import { AutoEvalStore } from './store.js';
import type {
  AutoEvalReport,
  AutoEvalRunOptions,
  ConversationEvaluation,
  SimulatedConversation,
} from './types.js';

export { formatReport } from './reporter.js';

export async function runAutoEval(opts: AutoEvalRunOptions): Promise<AutoEvalReport> {
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

  if (opts.verbose) {
    process.stderr.write(`\nAuto-eval: ${scenarios.length} scenarios, concurrency=${opts.concurrency ?? 2}\n`);
    process.stderr.write(`Models: sim=${opts.model}, eval=${evalModel}\n\n`);
  }

  const concurrency = Math.max(1, opts.concurrency ?? 2);
  const conversations: SimulatedConversation[] = [];
  const evaluations: ConversationEvaluation[] = [];
  let completed = 0;

  // Phase 1: Simulate conversations
  if (opts.verbose) {
    process.stderr.write('Phase 1: Simulating conversations...\n');
  }

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

    if (opts.verbose) {
      completed += results.length;
      const errCount = results.filter((c) => c.error).length;
      process.stderr.write(
        `  [${completed}/${scenarios.length}] simulated${errCount > 0 ? ` (${errCount} errors)` : ''}\n`,
      );
    }
  }

  // Phase 2: Evaluate conversations
  if (opts.verbose) {
    process.stderr.write('\nPhase 2: Evaluating responses...\n');
  }
  completed = 0;

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

    if (opts.verbose) {
      completed += results.length;
      const avgScore =
        results.reduce((sum, e) => sum + e.overallScore, 0) / results.length;
      process.stderr.write(
        `  [${completed}/${conversations.length}] evaluated (batch avg: ${avgScore.toFixed(2)})\n`,
      );
    }
  }

  // Phase 3: Analyze patterns
  if (opts.verbose) {
    process.stderr.write('\nPhase 3: Analyzing patterns...\n');
  }

  const previousReport = store.loadPreviousReport();
  const { patterns, regressions, suggestions } = analyzeResults(evaluations, previousReport);

  // Phase 4: Generate preference pairs (optional)
  let preferencePairCount = 0;
  if (opts.generatePreferencePairs !== false) {
    if (opts.verbose) {
      process.stderr.write('\nPhase 4: Generating preference pairs...\n');
    }

    const pairs = await generatePreferencePairs(evalLlm, conversations, evaluations);
    preferencePairCount = pairs.length;
    store.savePreferencePairs(pairs);

    if (opts.verbose) {
      process.stderr.write(`  Generated ${pairs.length} preference pairs\n`);
    }
  }

  // Phase 5: Build and save report
  const report = buildReport(
    evaluations,
    patterns,
    regressions,
    suggestions,
    preferencePairCount,
    opts.model,
  );
  store.saveReport(report);

  if (opts.verbose) {
    process.stderr.write('\nReport saved.\n');
  }

  return report;
}
