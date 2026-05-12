import { createReadStream } from 'fs';
import { createInterface } from 'readline';
import { Pool } from 'pg';
import { resolve } from 'path';
import { existsSync } from 'fs';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error('DATABASE_URL is required');

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function run() {
  const filePath = resolve(process.argv[2] || 'grace_knowledge-export-2026-05-12_14-14-45.csv');
  if (!existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    process.exit(1);
  }

  const rl = createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });
  const rows: string[][] = [];
  let header = true;

  for await (const line of rl) {
    if (!line.trim()) continue;
    if (header) { header = false; continue; }
    // Split on semicolon but preserve content inside brackets (embeddings)
    const parts = line.split(';');
    if (parts.length >= 5) rows.push(parts);
  }

  console.log(`Parsed ${rows.length} knowledge rows. Inserting...`);

  const client = await pool.connect();
  let inserted = 0;
  try {
    for (const parts of rows) {
      const id = parts[0]?.trim();
      const user_message = parts[1]?.trim();
      const grace_response = parts[2]?.trim();
      const topic = parts[3]?.trim();
      const style_tag = parts[4]?.trim();
      // embedding is everything from index 5 onward rejoined (may contain semicolons)
      const embeddingRaw = parts.slice(5).join(';').trim();

      if (!user_message || !grace_response) continue;

      // Store as knowledge in embeddings table (no vector — will be re-embedded on first search)
      await client.query(
        `INSERT INTO grace_knowledge_staging (id, user_message, grace_response, topic, style_tag, embedding)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT DO NOTHING`,
        [id, user_message, grace_response, topic, style_tag, embeddingRaw]
      );
      inserted++;
      if (inserted % 50 === 0) console.log(`  ${inserted}/${rows.length}...`);
    }
    console.log(`Done. Inserted ${inserted} rows into grace_knowledge_staging.`);
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch((e) => { console.error(e); process.exit(1); });
