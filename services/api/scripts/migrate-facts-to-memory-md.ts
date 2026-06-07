/**
 * Phase D — one-off migration: user_profile_facts → memory.md
 *
 * For each user that has facts in `user_profile_facts`, this script:
 *   1. Loads their existing facts grouped by category
 *   2. Asks Gemini to compose them into the memory.md schema
 *   3. Inserts the result into `user_memory_md` (idempotent — only adds
 *      rows for users not yet enrolled)
 *   4. Logs success / failure per user
 *
 * Safe to run multiple times. Existing memory.md content is preserved
 * (ON CONFLICT DO NOTHING in the underlying enrollment helper). To
 * re-migrate a specific user, DELETE their row first.
 *
 * Usage:
 *   pnpm --filter @grace/api exec tsx scripts/migrate-facts-to-memory-md.ts [--dry-run] [--phone +15551234567]
 *
 *   --dry-run        Show what would be written, don't enroll.
 *   --phone NUMBER   Migrate just this one user (for the pilot).
 *
 * Env vars required: DATABASE_URL, GEMINI_API_KEY
 */

import { Pool } from 'pg';
import { GeminiProvider } from '../src/llm/gemini.js';
import { MemoryMdService } from '../src/memory/memory-md.service.js';

const COMPOSE_SYSTEM = `You compose a per-user memory.md file for a GLP-1 wellness companion (Grace) from a list of durable facts about that user.

OUTPUT: ONLY the markdown file content. No preface, no \`\`\`fences, no explanation.

SCHEMA:
# <FirstName>'s Memory  (updated YYYY-MM-DD)

## Profile
- <one-line per durable fact>

## Recent context (last 7 days)
- (leave empty for initial migration — the worker will populate it)

## Open threads
- (leave empty)

RULES:
1. Group similar facts (e.g. dietary preferences together, schedule together).
2. Phrase facts as concise observations ("vegetarian", "works night shifts", "protein shakes cause nausea").
3. Drop low-confidence facts unless they're medically meaningful.
4. Don't invent facts not in the input list.
5. Keep "Profile" under 30 bullets total — pick the most useful.
6. If the input is empty or only contains low-quality facts, return a minimal file with empty sections.`;

interface UserRow {
  id: string;
  phone: string;
  first_name: string | null;
}

interface FactRow {
  fact: string;
  category: string;
  confidence: string;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const phoneFilterIdx = args.indexOf('--phone');
  const phoneFilter = phoneFilterIdx >= 0 ? args[phoneFilterIdx + 1] : null;

  const dbUrl = process.env['DATABASE_URL'];
  const apiKey = process.env['GEMINI_API_KEY'];
  if (!dbUrl || !apiKey) {
    console.error('Missing DATABASE_URL or GEMINI_API_KEY');
    process.exit(1);
  }

  const pool = new Pool({ connectionString: dbUrl });
  const llm = new GeminiProvider({ apiKey, model: 'gemini-2.5-flash-lite' }, console as never, undefined as never);
  const memoryMd = new MemoryMdService(pool, console as never);

  // Find candidate users — those with facts but not yet enrolled.
  const filterClause = phoneFilter ? `AND u.phone = $1` : '';
  const params = phoneFilter ? [phoneFilter] : [];
  const { rows: users } = await pool.query<UserRow>(
    `SELECT u.id, u.phone, u.first_name
     FROM users u
     WHERE EXISTS (
       SELECT 1 FROM user_profile_facts f WHERE f.user_id = u.id
     )
     AND NOT EXISTS (
       SELECT 1 FROM user_memory_md m WHERE m.user_id = u.id
     )
     ${filterClause}
     ORDER BY u.created_at ASC`,
    params,
  );

  console.log(`Found ${users.length} user(s) to migrate${dryRun ? ' (DRY RUN)' : ''}`);
  if (users.length === 0) {
    await pool.end();
    return;
  }

  let success = 0;
  let failure = 0;
  for (const user of users) {
    console.log(`\n→ ${user.phone} (${user.first_name ?? 'unnamed'})`);
    try {
      const { rows: facts } = await pool.query<FactRow>(
        `SELECT fact, category, confidence
         FROM user_profile_facts
         WHERE user_id = $1
         ORDER BY confidence DESC, created_at DESC
         LIMIT 50`,
        [user.id],
      );

      if (facts.length === 0) {
        console.log('  no facts, skipping');
        continue;
      }

      const factsText = facts
        .map((f) => `- [${f.category}, ${f.confidence}] ${f.fact}`)
        .join('\n');

      const userPrompt = `User first name: ${user.first_name ?? 'unknown'}
Today's date: ${new Date().toISOString().slice(0, 10)}

Facts from the database:
${factsText}

Return the initial memory.md.`;

      const resp = await llm.generate({
        messages: [
          { role: 'system', content: COMPOSE_SYSTEM },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.2,
        maxOutputTokens: 1200,
        model: 'gemini-2.5-flash-lite',
        disableThinking: true,
      });

      const content = resp.text
        .trim()
        .replace(/^```(?:markdown|md)?\s*\n?/i, '')
        .replace(/\n?```\s*$/, '')
        .trim();

      if (!content.startsWith('#')) {
        console.warn(`  malformed output (does not start with #), skipping`);
        failure += 1;
        continue;
      }

      if (dryRun) {
        console.log(`  (dry-run) would enroll with ${content.length} chars:\n${content.split('\n').map(l => '    ' + l).join('\n')}`);
        success += 1;
        continue;
      }

      await memoryMd.enroll(user.id, content);
      console.log(`  ✓ enrolled with ${content.length} chars`);
      success += 1;
    } catch (err) {
      console.error(`  failed:`, err);
      failure += 1;
    }
  }

  console.log(`\nDone — ${success} succeeded, ${failure} failed`);
  await pool.end();
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
