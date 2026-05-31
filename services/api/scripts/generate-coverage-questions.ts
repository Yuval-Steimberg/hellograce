/**
 * Coverage question generator — uses Gemini to expand the intent library
 * (services/api/coverage/intents.json) with additional realistic variations.
 *
 * Usage:
 *   GEMINI_API_KEY=... pnpm --filter @grace/api exec tsx scripts/generate-coverage-questions.ts \
 *     --domain side_effects --subtopic nausea --persona sarah_new --stage first_week --count 20
 *
 *   GEMINI_API_KEY=... pnpm --filter @grace/api exec tsx scripts/generate-coverage-questions.ts \
 *     --batch all --count-per-intent 5
 *
 * Output: writes to services/api/coverage/intents-expanded.json (gitignored).
 * Human review required — open the file, copy approved entries into intents.json,
 * tag them with source="human_curated" instead of "synthetic_v1".
 *
 * Why synthetic generation works for us (per the plan):
 *   - 20 existing personas encode realistic communication styles
 *   - 11 journey stages constrain context
 *   - 10 documented domains + safety framework keep outputs in-distribution
 *   - Each batch is human-reviewed before merging
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GeminiProvider } from '../src/llm/gemini.js';

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error('GEMINI_API_KEY is required. Set it in services/api/.env or your shell.');
  process.exit(1);
}

// ── Argv parsing ────────────────────────────────────────────────────────────
function arg(name: string, fallback?: string): string | undefined {
  const flag = `--${name}`;
  const idx = process.argv.indexOf(flag);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return fallback;
}

const domain = arg('domain');
const subtopic = arg('subtopic');
const personaId = arg('persona');
const stage = arg('stage');
const count = Number(arg('count', '10'));
const batchAll = arg('batch') === 'all';
const countPerIntent = Number(arg('count-per-intent', '5'));

// ── Load existing intents + journey map + personas ──────────────────────────
const __dirname = dirname(fileURLToPath(import.meta.url));
const coverageDir = join(__dirname, '..', 'coverage');
const intentsPath = join(coverageDir, 'intents.json');
const journeyPath = join(coverageDir, 'journey-map.json');
const expandedPath = join(coverageDir, 'intents-expanded.json');

interface ExistingIntent {
  id: string;
  domain: string;
  subtopic: string;
  variations: string[];
  expected_intent: string;
  expected_tool_calls: string[];
  must_include: string[];
  must_not_include: string[];
  safety_level: 'informational' | 'clinical_redirect' | 'emergency';
  journey_stages: string[];
  source: string;
}

interface IntentsFile {
  version: number;
  description: string;
  schema: Record<string, string>;
  intents: ExistingIntent[];
}

interface JourneyStage {
  id: string;
  label: string;
  context: string;
  typical_concerns: string[];
  tone_notes: string;
}

interface JourneyFile {
  stages: JourneyStage[];
}

const intentsFile = JSON.parse(readFileSync(intentsPath, 'utf-8')) as IntentsFile;
const journeyFile = JSON.parse(readFileSync(journeyPath, 'utf-8')) as JourneyFile;
const stages = new Map(journeyFile.stages.map((s) => [s.id, s] as const));

// ── Generation prompt template ──────────────────────────────────────────────

function buildGenPrompt(intent: ExistingIntent, n: number): string {
  const stageContext = intent.journey_stages
    .map((id) => stages.get(id))
    .filter((s): s is JourneyStage => Boolean(s))
    .map((s) => `${s.label}: ${s.context}`)
    .join('\n');

  return `You generate realistic variations of a GLP-1 user question for a coverage test suite.

EXISTING INTENT:
  id: ${intent.id}
  domain: ${intent.domain}
  subtopic: ${intent.subtopic}
  safety_level: ${intent.safety_level}
${stageContext ? `  journey context:\n${stageContext}` : ''}

CURRENT VARIATIONS (do NOT repeat these — generate NEW phrasings):
${intent.variations.map((v) => `  - "${v}"`).join('\n')}

YOUR TASK:
Produce ${n} NEW realistic ways a GLP-1 user might ask the same underlying question. Mix phrasing styles:
  - 1-3 word fragments ("nausea", "help")
  - Casual / slangy ("rn", "ngl", "tho")
  - Typo-laden (realistic, not random)
  - Emotional context layered with the factual question
  - Long form with life context (1-2 sentences before the actual ask)
  - Direct + curt
  - Follow-up style ("ok but what about…", "and also…")

RULES:
- Each variation must classify to the SAME underlying intent
- Do NOT change the question's safety level (e.g. don't escalate a drug-interaction question to emergency)
- Real human language — no formal medical jargon unless the user style calls for it
- Include occasional misspellings, missing punctuation, lowercase, abbreviations
- Vary length — at least 2 short (1-5 words) and 2 long (15+ words)

OUTPUT FORMAT — JSON array only, no prose, no markdown fences:
["variation 1", "variation 2", "variation 3", ...]`;
}

// ── Run generation ──────────────────────────────────────────────────────────

const llm = new GeminiProvider({
  apiKey,
  model: process.env.GEMINI_GEN_MODEL ?? 'gemini-2.5-flash',
});

interface Batch {
  intent_id: string;
  generated_variations: string[];
  generated_at: string;
  source: 'synthetic_v1';
}

async function generateForIntent(intent: ExistingIntent, n: number): Promise<string[]> {
  const prompt = buildGenPrompt(intent, n);
  try {
    const resp = await llm.generate({
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.9,
      maxOutputTokens: 2048,
      responseFormat: 'json',
    });
    const cleaned = resp.text.trim().replace(/^```json\s*/i, '').replace(/```$/, '').trim();
    const parsed = JSON.parse(cleaned) as unknown;
    if (!Array.isArray(parsed)) throw new Error('not an array');
    return parsed.filter((v) => typeof v === 'string' && v.trim().length > 0).map((v) => String(v).trim());
  } catch (err) {
    console.error(`  [skip] ${intent.id}: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

async function main(): Promise<void> {
  // Decide which intents to expand
  let targets: ExistingIntent[];
  if (batchAll) {
    targets = intentsFile.intents;
    console.log(`Batch mode: expanding all ${targets.length} intents with ${countPerIntent} variations each.`);
  } else {
    targets = intentsFile.intents.filter((i) => {
      if (domain && i.domain !== domain) return false;
      if (subtopic && i.subtopic !== subtopic) return false;
      if (stage && !i.journey_stages.includes(stage)) return false;
      return true;
    });
    if (targets.length === 0) {
      console.error('No intents match the filters. Try --batch all or relax the filters.');
      console.error(`Available domains: ${[...new Set(intentsFile.intents.map((i) => i.domain))].join(', ')}`);
      process.exit(1);
    }
    console.log(`Filter mode: matched ${targets.length} intent(s).`);
  }

  // Note: --persona is parsed but currently unused (persona-conditioned
  // generation will land in Phase 4 of the plan, when we tie auto-eval
  // scenarios to the intent library). Acknowledge if set.
  if (personaId) {
    console.log(`(--persona ${personaId} parsed; persona-conditioning lands in Phase 4. Generating without persona conditioning for now.)`);
  }

  const n = batchAll ? countPerIntent : count;
  const batches: Batch[] = [];

  for (const intent of targets) {
    process.stdout.write(`Generating ${n} variations for ${intent.id}... `);
    const generated = await generateForIntent(intent, n);
    process.stdout.write(`got ${generated.length}\n`);
    batches.push({
      intent_id: intent.id,
      generated_variations: generated,
      generated_at: new Date().toISOString(),
      source: 'synthetic_v1',
    });
  }

  const output = {
    description: 'Synthetic-generated coverage variations. HUMAN REVIEW REQUIRED before merging into intents.json. Drop bad variations, keep good ones, tag with source="human_curated" when merging.',
    generated_at: new Date().toISOString(),
    total_intents_expanded: batches.length,
    total_variations: batches.reduce((s, b) => s + b.generated_variations.length, 0),
    batches,
  };

  writeFileSync(expandedPath, JSON.stringify(output, null, 2));
  console.log(`\n✓ Wrote ${output.total_variations} variations across ${output.total_intents_expanded} intents to:\n  ${expandedPath}`);
  console.log('\nNext steps:');
  console.log('  1. Open intents-expanded.json');
  console.log('  2. Review each batch — drop unrealistic / unsafe variations');
  console.log('  3. Copy approved variations into intents.json under the matching intent.id');
  console.log('  4. (Optional) Bump source="human_curated" once reviewed');
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
