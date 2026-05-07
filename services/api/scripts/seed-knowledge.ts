/**
 * Seed the `embeddings` table with a small GLP-1 knowledge base for the investor demo.
 *
 * Run:  pnpm --filter @grace/api exec tsx scripts/seed-knowledge.ts
 */
import { loadEnv } from '../src/config/env.js';
import { createPool } from '../src/db/pool.js';
import { GeminiEmbedder } from '../src/rag/gemini-embedder.js';

const KNOWLEDGE: { topic: string; content: string }[] = [
  { topic: 'protein', content: 'On GLP-1 medications, aim for 0.7–1.0g of protein per pound of goal body weight to preserve muscle while losing fat.' },
  { topic: 'hydration', content: 'GLP-1s reduce thirst cues. Aim for 64–80oz of water daily; add electrolytes if you feel lightheaded.' },
  { topic: 'nausea', content: 'Eat smaller, lower-fat meals on injection day. Ginger tea, plain crackers, and protein-first plates help reduce nausea.' },
  { topic: 'constipation', content: 'Increase soluble fiber slowly and pair with water. Magnesium citrate at night can help when needed.' },
  { topic: 'side_effects', content: 'Most side effects (nausea, fatigue, constipation) peak in the first 48h after a dose increase and fade within 2–3 days.' },
  { topic: 'injection', content: 'Rotate sites between abdomen and thigh. Refrigerated pens last longer; once in use, room temp is fine for 28–56 days depending on brand.' },
  { topic: 'plateau', content: 'Weight plateaus on GLP-1s are normal at the 8–12 week mark. Keep protein high and strength training consistent.' },
  { topic: 'alcohol', content: 'GLP-1s slow gastric emptying — alcohol hits harder and longer. Hydrate aggressively and avoid drinking on injection day.' },
];

async function main(): Promise<void> {
  const env = loadEnv();
  const pool = createPool(env);
  const embedder = new GeminiEmbedder(env.GEMINI_API_KEY);

  for (const k of KNOWLEDGE) {
    const vec = await embedder.embed(k.content);
    const lit = `[${vec.join(',')}]`;
    await pool.query(
      `INSERT INTO embeddings (user_id, source, content, embedding, metadata)
       VALUES (NULL, 'knowledge', $1, $2::vector, $3)`,
      [k.content, lit, { topic: k.topic }],
    );
    // eslint-disable-next-line no-console
    console.log(`seeded: ${k.topic}`);
  }

  await pool.end();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
