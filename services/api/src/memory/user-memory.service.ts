import type { Pool } from 'pg';
import type { Logger } from 'pino';
import type { LLMProvider } from '@grace/shared';
import type { Embedder } from '../rag/rag.service.js';

/**
 * Long-term semantic memory. Stores extracted facts about each user
 * (preferences, struggles, wins, medical context) as embeddings; top-k
 * by similarity to the current message are injected into every system
 * prompt so Grace remembers across days/weeks.
 */

export type MemoryKind = 'preference' | 'history' | 'struggle' | 'win' | 'medical' | 'context';

export interface ExtractedMemory {
  content: string;
  kind: MemoryKind;
  confidence: number;
}

const EXTRACTION_PROMPT = `You extract durable facts about a GLP-1 user from a single conversation turn. These facts get stored as long-term memory and injected into future system prompts so Grace can be personal across days/weeks.

ONLY extract facts that are:
1. About the USER (not generic GLP-1 knowledge)
2. Likely to stay true for weeks or months (not "I ate eggs today")
3. Useful for personalizing future replies (preferences, struggles, wins, medical context)

DO NOT extract:
- Single-meal logs ("ate salad today")
- Generic acknowledgments ("got it", "thanks")
- Already-known profile fields (medication name, weight goal)
- Crisis content (handled separately)

RETURN JSON ARRAY ONLY. 0 to 3 memories. Each item:
{ "content": "<one short sentence in third person, < 100 chars>", "kind": "preference|history|struggle|win|medical|context", "confidence": 0.0-1.0 }

If nothing notable: return [].

EXAMPLES:

INPUT: "I keep getting nauseous after my Mounjaro shot, it's been 3 weeks of this"
OUTPUT: [{"content":"Persistent post-injection nausea on Mounjaro, 3+ weeks","kind":"struggle","confidence":0.95},{"content":"On Mounjaro (tirzepatide)","kind":"medical","confidence":0.9}]

INPUT: "I hate eggs, can't even smell them without feeling sick"
OUTPUT: [{"content":"Strong aversion to eggs","kind":"preference","confidence":0.95}]

INPUT: "I finally fit into my old jeans!"
OUTPUT: [{"content":"Achieved non-scale victory: fitting old jeans","kind":"win","confidence":0.9}]

INPUT: "ate chicken and rice for lunch"
OUTPUT: []

INPUT: "thanks!"
OUTPUT: []`;

export class UserMemoryService {
  constructor(
    private pool: Pool,
    private embedder: Embedder,
    private llm: LLMProvider,
    private logger: Logger,
  ) {}

  /**
   * Retrieve top-k memories most similar to the current user message.
   * Returns plain strings ready to drop into the system prompt.
   */
  async retrieve(userId: string, queryText: string, topK = 3): Promise<string[]> {
    try {
      const queryEmbedding = await this.embedder.embed(queryText);
      const vectorStr = `[${queryEmbedding.join(',')}]`;
      const result = await this.pool.query<{ id: number; content: string; kind: string }>(
        `SELECT id, content, kind
         FROM user_memories
         WHERE user_id = $1 AND confidence >= 0.5
         ORDER BY embedding <=> $2::vector
         LIMIT $3`,
        [userId, vectorStr, topK],
      );

      if (result.rows.length === 0) return [];

      // Fire-and-forget: mark these memories as used so unused ones decay first.
      const ids = result.rows.map((r) => r.id);
      void this.pool
        .query(
          `UPDATE user_memories SET last_used_at = now(), use_count = use_count + 1 WHERE id = ANY($1)`,
          [ids],
        )
        .catch(() => {});

      return result.rows.map((r) => r.content);
    } catch (err) {
      this.logger.warn({ err, userId }, 'user_memory.retrieve.failed');
      return [];
    }
  }

  /**
   * Extract durable memories from a single user/assistant turn and store
   * them. Runs async after the response is sent — never blocks the user.
   */
  async extractAndStore(userId: string, userMessage: string, assistantMessage: string): Promise<void> {
    try {
      const resp = await this.llm.generate({
        messages: [
          { role: 'system', content: EXTRACTION_PROMPT },
          { role: 'user', content: `USER: ${userMessage}\nASSISTANT: ${assistantMessage}` },
        ],
        temperature: 0.1,
        maxOutputTokens: 400,
        responseFormat: 'json',
      });

      const parsed = parseExtractedMemories(resp.text);
      if (parsed.length === 0) return;

      for (const mem of parsed) {
        if (await this.exactDuplicateExists(userId, mem.content)) continue;
        const embedding = await this.embedder.embed(mem.content);
        const vectorStr = `[${embedding.join(',')}]`;
        await this.pool.query(
          `INSERT INTO user_memories (user_id, content, embedding, kind, confidence)
           VALUES ($1, $2, $3::vector, $4, $5)`,
          [userId, mem.content, vectorStr, mem.kind, mem.confidence],
        );
      }
      this.logger.info({ userId, count: parsed.length }, 'user_memory.extracted');
    } catch (err) {
      this.logger.warn({ err, userId }, 'user_memory.extract.failed');
    }
  }

  private async exactDuplicateExists(userId: string, content: string): Promise<boolean> {
    const result = await this.pool.query<{ exists: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM user_memories WHERE user_id = $1 AND content = $2) AS exists`,
      [userId, content],
    );
    return result.rows[0]?.exists ?? false;
  }
}

function parseExtractedMemories(raw: string): ExtractedMemory[] {
  try {
    const cleaned = raw.replace(/```json\n?|\n?```/g, '').trim();
    const parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (m): m is ExtractedMemory =>
          typeof m === 'object' &&
          m !== null &&
          typeof m.content === 'string' &&
          m.content.length > 0 &&
          m.content.length < 200 &&
          typeof m.kind === 'string' &&
          ['preference', 'history', 'struggle', 'win', 'medical', 'context'].includes(m.kind) &&
          typeof m.confidence === 'number' &&
          m.confidence >= 0 &&
          m.confidence <= 1,
      )
      .slice(0, 3);
  } catch {
    return [];
  }
}
