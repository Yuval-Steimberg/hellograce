/**
 * Per-conversation summary memory.
 *
 * Every N turns we ask Gemini to compress the conversation into a short
 * neutral summary and store it on `conversations.summary`. The summary is then
 * injected into the orchestrator's runtime context so Grace can recall earlier
 * details without re-reading 100 raw messages on every turn.
 *
 * Purely additive — the existing 12-turn history-rendering path is untouched.
 * If the summary isn't present yet (cold start, new user) we just skip it.
 */

import type { Pool } from 'pg';
import type { Logger } from 'pino';
import type { LLMProvider } from '@grace/shared';

const SUMMARIZE_EVERY_N_TURNS = 20;
const MAX_SUMMARY_TOKENS = 200;

export interface ConversationSummary {
  summary: string;
  updated_at: Date;
}

export class ConversationSummaryService {
  constructor(
    private pool: Pool,
    private llm: LLMProvider,
    private logger: Logger,
  ) {}

  /**
   * Fetch the stored summary for a conversation, or null if none yet.
   * Cheap single-row read — safe to call on every turn.
   */
  async get(conversationId: string): Promise<ConversationSummary | null> {
    try {
      const { rows } = await this.pool.query<{ summary: string | null; summary_updated_at: Date | null }>(
        `SELECT summary, summary_updated_at FROM conversations WHERE id = $1 LIMIT 1`,
        [conversationId],
      );
      const row = rows[0];
      if (!row || !row.summary || !row.summary_updated_at) return null;
      return { summary: row.summary, updated_at: row.summary_updated_at };
    } catch (err) {
      this.logger.warn({ err, conversationId }, 'conversation_summary.get.failed');
      return null;
    }
  }

  /**
   * Conditionally regenerate the summary. Bumps the turn counter and only
   * actually summarizes once every N turns. Fire-and-forget by the caller.
   */
  async maybeSummarize(conversationId: string): Promise<void> {
    try {
      const { rows } = await this.pool.query<{ summary_turn_count: number }>(
        `UPDATE conversations
            SET summary_turn_count = summary_turn_count + 1
          WHERE id = $1
        RETURNING summary_turn_count`,
        [conversationId],
      );
      const count = rows[0]?.summary_turn_count ?? 0;
      if (count === 0 || count % SUMMARIZE_EVERY_N_TURNS !== 0) return;

      const history = await this.fetchRecentMessages(conversationId, 40);
      if (history.length < 6) return;

      const transcript = history
        .map((m) => `${m.role === 'user' ? 'User' : 'Grace'}: ${m.content}`)
        .join('\n');

      const summary = await this.summarizeViaLLM(transcript);
      if (!summary) return;

      await this.pool.query(
        `UPDATE conversations
            SET summary = $1,
                summary_updated_at = now()
          WHERE id = $2`,
        [summary, conversationId],
      );
      this.logger.info({ conversationId, turnCount: count, summaryLen: summary.length }, 'conversation_summary.updated');
    } catch (err) {
      this.logger.warn({ err, conversationId }, 'conversation_summary.maybe.failed');
    }
  }

  private async fetchRecentMessages(conversationId: string, limit: number): Promise<{ role: string; content: string }[]> {
    const { rows } = await this.pool.query<{ role: string; content: string }>(
      `SELECT role, content
         FROM messages
        WHERE conversation_id = $1
        ORDER BY created_at DESC
        LIMIT $2`,
      [conversationId, limit],
    );
    return rows.reverse();
  }

  private async summarizeViaLLM(transcript: string): Promise<string | null> {
    const resp = await this.llm.generate({
      messages: [
        {
          role: 'system',
          content:
            'You compress a WhatsApp conversation between a user and Grace (a GLP-1 wellness companion) into a neutral 2-4 sentence summary. Focus on durable facts: medication details mentioned, dietary preferences/restrictions, recent struggles or wins, recurring topics. Do NOT include emojis, do NOT include conversational pleasantries, do NOT quote messages. Output ONLY the summary text.',
        },
        { role: 'user', content: transcript },
      ],
      temperature: 0.2,
      maxOutputTokens: MAX_SUMMARY_TOKENS,
    });
    const text = resp.text.trim();
    if (text.length < 20 || text.length > 1200) return null;
    return text;
  }
}
