/**
 * Re-embed all `source='knowledge'` rows in the embeddings table with
 * gemini-embedding-001 (outputDimensionality=768). Replaces zero-vector
 * placeholders left by the bulk CSV import.
 *
 * Run:
 *   pnpm --filter @grace/api exec tsx scripts/reembed-knowledge.ts
 *
 * Flags:
 *   --all       re-embed every knowledge row, even ones that already look real
 *   --limit N   stop after N rows (useful for smoke tests)
 *
 * Resumable: by default skips rows whose stored embedding magnitude is > 0
 * (i.e. already real), so reruns only fill in what's missing or failed.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadEnv } from '../src/config/env.js';
import { createPool } from '../src/db/pool.js';
import { GeminiEmbedder } from '../src/rag/gemini-embedder.js';

// Auto-load services/api/.env so callers don't need --env-file=.env.
const envPath = resolve(process.cwd(), '.env');
if (existsSync(envPath)) {
  process.loadEnvFile(envPath);
}

const args = new Set(process.argv.slice(2));
const limitArgIdx = process.argv.indexOf('--limit');
const limit = limitArgIdx >= 0 ? Number(process.argv[limitArgIdx + 1]) : undefined;
const reembedAll = args.has('--all');

async function main(): Promise<void> {
  const env = loadEnv();
  const pool = createPool(env);
  const embedder = new GeminiEmbedder(env.GEMINI_API_KEY, 'gemini-embedding-001');

  // Detect placeholder rows by sampling the first vector element.
  // Real embeddings have a non-zero first element with overwhelming probability;
  // the zero-vector placeholders inserted by the CSV import have all zeros.
  const where = reembedAll
    ? `source = 'knowledge'`
    : `source = 'knowledge' AND (embedding::text LIKE '[0,0,0,0,0,0,0,0,0,0,%')`;
  const limitClause = limit ? `LIMIT ${limit}` : '';
  const { rows } = await pool.query<{ id: string; content: string }>(
    `SELECT id, content FROM embeddings WHERE ${where} ORDER BY created_at ASC ${limitClause}`,
  );

  // eslint-disable-next-line no-console
  console.log(`reembed: ${rows.length} rows to process${reembedAll ? ' (--all)' : ''}`);
  if (rows.length === 0) {
    await pool.end();
    return;
  }

  let done = 0;
  let failed = 0;
  const startMs = Date.now();

  for (const row of rows) {
    try {
      const vec = await embedder.embed(row.content);
      const lit = `[${vec.join(',')}]`;
      await pool.query(`UPDATE embeddings SET embedding = $1::vector WHERE id = $2`, [lit, row.id]);
      done++;
      if (done % 25 === 0 || done === rows.length) {
        const rate = done / ((Date.now() - startMs) / 1000);
        // eslint-disable-next-line no-console
        console.log(`  ${done}/${rows.length}  (${rate.toFixed(1)} rows/s, ${failed} failed)`);
      }
    } catch (err) {
      failed++;
      // eslint-disable-next-line no-console
      console.error(`  failed id=${row.id}:`, (err as Error).message);
    }
  }

  // eslint-disable-next-line no-console
  console.log(`done: ${done} embedded, ${failed} failed in ${((Date.now() - startMs) / 1000).toFixed(1)}s`);
  await pool.end();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
