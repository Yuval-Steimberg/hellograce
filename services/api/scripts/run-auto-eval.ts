import { join } from 'path';
import { runAutoEval, formatReport } from '../auto-eval/runner.js';
import type { ScenarioCategory } from '../auto-eval/types.js';

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error('GEMINI_API_KEY is required. Set it in services/api/.env or your shell.');
  process.exit(1);
}

const model = process.env.GEMINI_EVAL_MODEL ?? process.env.GEMINI_MODEL ?? 'gemini-2.5-flash';
const evaluatorModel = process.env.GEMINI_EVALUATOR_MODEL ?? model;
const concurrency = process.env.AUTO_EVAL_CONCURRENCY
  ? Number(process.env.AUTO_EVAL_CONCURRENCY)
  : 2;
const scenarioCount = process.env.AUTO_EVAL_SCENARIOS
  ? Number(process.env.AUTO_EVAL_SCENARIOS)
  : undefined;
const categories = process.env.AUTO_EVAL_CATEGORIES
  ? (process.env.AUTO_EVAL_CATEGORIES.split(',') as ScenarioCategory[])
  : undefined;
const personaIds = process.env.AUTO_EVAL_PERSONAS
  ? process.env.AUTO_EVAL_PERSONAS.split(',')
  : undefined;
const generatePairs = process.env.AUTO_EVAL_SKIP_PAIRS !== '1';
const outDir = join(import.meta.dirname ?? __dirname, '..', 'auto-eval', 'results');

console.log(`
Grace Auto-Evaluation System
─────────────────────────────
Model (sim):    ${model}
Model (eval):   ${evaluatorModel}
Concurrency:    ${concurrency}
Scenarios:      ${scenarioCount ?? 'all'}
Categories:     ${categories?.join(', ') ?? 'all'}
Personas:       ${personaIds?.join(', ') ?? 'all'}
Pref. pairs:    ${generatePairs ? 'yes' : 'skip'}
Output:         ${outDir}
`);

(async () => {
  const report = await runAutoEval({
    apiKey,
    model,
    evaluatorModel,
    concurrency,
    scenarioCount,
    categories,
    personaIds,
    outDir,
    verbose: true,
    generatePreferencePairs: generatePairs,
  });

  console.log(formatReport(report));

  if (report.overallScore < 3) {
    console.error(`\nWARNING: Overall score ${report.overallScore.toFixed(2)} is below threshold (3.0)\n`);
    process.exit(1);
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
