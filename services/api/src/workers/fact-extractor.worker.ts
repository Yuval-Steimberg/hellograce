import { Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Pool } from 'pg';
import type { Logger } from 'pino';
import type { LLMProvider } from '@grace/shared';
import type { FactExtractJob } from './queues.js';

const MIN_MESSAGE_LENGTH = 15;
const MAX_FACTS_PER_MESSAGE = 5;
const VALID_CATEGORIES = new Set([
  'diet', 'schedule', 'aversion', 'preference', 'exercise', 'symptom', 'social', 'other',
]);

const EXTRACTOR_SYSTEM = `You extract DURABLE personal facts about a user from a single message they sent to a GLP-1 wellness companion. Durable means it will still be true in a week — not "I'm tired today" but "I work night shifts."

Output ONLY a JSON object: {"facts": [{"fact": "<short factual phrase>", "category": "<one of: diet|schedule|aversion|preference|exercise|symptom|social|other>", "confidence": "<low|medium|high>"}]}

Examples of EXTRACTABLE facts (durable):
- "I'm vegetarian" → {"fact": "vegetarian", "category": "diet", "confidence": "high"}
- "I work night shifts" → {"fact": "works night shifts", "category": "schedule", "confidence": "high"}
- "I usually skip breakfast" → {"fact": "usually skips breakfast", "category": "schedule", "confidence": "high"}
- "Protein shakes make me nauseous" → {"fact": "protein shakes cause nausea", "category": "symptom", "confidence": "high"}
- "I train 4x a week" → {"fact": "trains 4x per week", "category": "exercise", "confidence": "high"}
- "I love Greek yogurt" → {"fact": "loves Greek yogurt", "category": "preference", "confidence": "medium"}
- "Dairy upsets my stomach" → {"fact": "dairy causes GI upset", "category": "symptom", "confidence": "high"}
- "Mostly eat at home" → {"fact": "eats at home mostly", "category": "social", "confidence": "medium"}

DO NOT extract:
- Temporary states: "I'm tired today", "feeling great", "had a rough night"
- Single food logs: "I had a burrito" (a meal, not a durable preference)
- Questions: "what should I eat?"
- Acknowledgments: "ok", "thanks", "got it"
- Specific numbers that change: "I weigh 175"
- Things already obvious from onboarding (medication name, weight, etc.)

If the message has no extractable durable facts, return {"facts": []}.

Be conservative — empty output is better than fabricating preferences.`;

export function createFactExtractorWorker(deps: {
  redis: Redis;
  pool: Pool;
  llm: LLMProvider;
  logger: Logger;
}): Worker<FactExtractJob> {
  const worker = new Worker<FactExtractJob>(
    'fact-extract',
    async (job) => {
      const { userId, userText, sourceMessageId } = job.data;
      const trimmed = userText.trim();

      // Skip trivial messages — saves cost, avoids hallucinated facts.
      if (trimmed.length < MIN_MESSAGE_LENGTH) return;
      if (/^[0-9\s\p{P}\p{Extended_Pictographic}]+$/u.test(trimmed)) return;

      let raw: string;
      try {
        const resp = await deps.llm.generate({
          messages: [
            { role: 'system', content: EXTRACTOR_SYSTEM },
            { role: 'user', content: trimmed },
          ],
          temperature: 0.1,
          maxOutputTokens: 1024,
          responseFormat: 'json',
        });
        raw = resp.text;
      } catch (err) {
        deps.logger.warn({ err, userId }, 'fact_extract.llm.failed');
        return;
      }

      const facts = parseFacts(raw);
      if (facts.length === 0) return;

      let inserted = 0;
      for (const f of facts.slice(0, MAX_FACTS_PER_MESSAGE)) {
        try {
          const result = await deps.pool.query(
            `INSERT INTO user_profile_facts (user_id, fact, category, confidence, source_message_id)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (user_id, lower(fact)) DO NOTHING`,
            [userId, f.fact, f.category, f.confidence, sourceMessageId ?? null],
          );
          if (result.rowCount && result.rowCount > 0) inserted += 1;
        } catch (err) {
          deps.logger.warn({ err, userId, fact: f.fact }, 'fact_extract.insert.failed');
        }
      }

      if (inserted > 0) {
        deps.logger.info({ userId, inserted, total: facts.length }, 'fact_extract.ok');
      }
    },
    {
      connection: deps.redis,
      concurrency: 3,
    },
  );

  worker.on('failed', (job, err) => {
    deps.logger.error({ jobId: job?.id, err }, 'fact-extract.worker.failed');
  });

  return worker;
}

interface ExtractedFact {
  fact: string;
  category: string;
  confidence: string;
}

export function parseFacts(raw: string): ExtractedFact[] {
  if (!raw || raw.trim().length === 0) return [];

  // Strip markdown fences Gemini sometimes wraps even with JSON mode
  let cleaned = raw.trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  if (!cleaned.startsWith('{')) {
    const first = cleaned.indexOf('{');
    const last = cleaned.lastIndexOf('}');
    if (first !== -1 && last > first) cleaned = cleaned.slice(first, last + 1);
  }

  let obj: { facts?: unknown };
  try {
    obj = JSON.parse(cleaned);
  } catch {
    return [];
  }

  if (!Array.isArray(obj.facts)) return [];

  const result: ExtractedFact[] = [];
  for (const item of obj.facts) {
    if (!item || typeof item !== 'object') continue;
    const f = item as Record<string, unknown>;
    const factText = typeof f['fact'] === 'string' ? f['fact'].trim() : '';
    const category = typeof f['category'] === 'string' ? f['category'].trim().toLowerCase() : 'other';
    const confidence = typeof f['confidence'] === 'string' ? f['confidence'].trim().toLowerCase() : 'medium';
    if (!factText || factText.length > 200) continue;
    if (!['low', 'medium', 'high'].includes(confidence)) continue;
    result.push({
      fact: factText,
      category: VALID_CATEGORIES.has(category) ? category : 'other',
      confidence,
    });
  }
  return result;
}
