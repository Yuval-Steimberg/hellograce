import { join } from 'path';
import { formatReport, runEval } from '../eval/runner.js';

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error('GEMINI_API_KEY is required. Set it in services/api/.env or your shell.');
  process.exit(1);
}

const model = process.env.GEMINI_EVAL_MODEL ?? process.env.GEMINI_MODEL ?? 'gemini-2.5-flash';
const filter = process.env.EVAL_FILTER;
const concurrency = process.env.EVAL_CONCURRENCY
  ? Number(process.env.EVAL_CONCURRENCY)
  : 3;
const outDir = join(import.meta.dirname ?? __dirname, '..', 'eval', 'results');

(async () => {
  const report = await runEval({
    apiKey,
    model,
    ...(filter ? { filter } : {}),
    concurrency,
    verbose: true,
    outDir,
  });
  console.log(formatReport(report));
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
