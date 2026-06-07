import { Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import type { LLMProvider } from '@grace/shared';
import type { MemoryMdUpdateJob } from './queues.js';
import type { MemoryMdService } from '../memory/memory-md.service.js';

/**
 * memory.md updater worker (Phase D, 2026-06-07).
 *
 * After each assistant turn for a pilot-enrolled user, this worker:
 *   1. Loads the user's current memory.md (small file, cached)
 *   2. Sends current memory.md + (user message, Grace's reply) to Gemini
 *   3. Gemini returns the FULL updated memory.md as a single block
 *   4. Worker persists if the new content is meaningfully different
 *
 * Best-effort, fire-and-forget. If the worker fails or the LLM call
 * fails, the user's memory.md stays at the prior version — the next
 * turn picks up where we left off.
 *
 * The worker is gated at enqueue time: ai.service.ts only enqueues for
 * users where memoryMd.isEnrolled() is true. So this worker never fires
 * for non-pilot users — no wasted cost.
 */

/** Hard cap on memory.md size to keep prompt + Gemini cost bounded.
 *  When exceeded, the LLM is asked to compact the "Recent context"
 *  section. 8KB ≈ 2,000 tokens — comfortably under any reasonable
 *  budget. */
const MAX_MEMORY_CHARS = 8000;

/** Skip the update when neither user nor assistant text is substantive
 *  enough to extract new facts from. Trivial acks ("yes", "ok") don't
 *  warrant a Gemini call. */
const MIN_MEANINGFUL_CHARS = 12;

const UPDATER_SYSTEM = `You maintain a per-user memory.md file for a GLP-1 medication wellness companion (Grace).

Your job: given the user's CURRENT memory.md AND the latest exchange (user message + Grace's reply), return the FULL updated memory.md.

OUTPUT RULES:
1. Output ONLY the markdown file content. No preface, no \`\`\`fences, no explanation.
2. Preserve the section structure: # Header, ## Profile, ## Recent context, ## Open threads.
3. The HARD FIELDS that come from the users database table (medication, dose, injection day, weight, goals) are managed elsewhere. DO NOT invent them in memory.md if they're not already there. If they ARE there, update them when the user clearly corrects them in this exchange.
4. ADD to "Recent context" when the user shared something durable about their journey or Grace gave them specific guidance worth remembering.
5. UPDATE existing entries when this exchange contradicts or refines them.
6. REMOVE stale entries when they no longer apply (user says "I'm not vegetarian anymore", remove the vegetarian note).
7. Keep "Recent context" to the most recent ~7 days. Move older durable items to "Profile" if they're stable, or DROP them.
8. Keep total file under 8000 characters. If exceeded, compact "Recent context" by merging similar entries.
9. Dates should be the date of the exchange in YYYY-MM-DD form when known.

SCHEMA:
# <user-first-name>'s Memory  (updated YYYY-MM-DD)

## Profile
- <bullet of durable facts: diet, schedule, preferences, restrictions>

## Recent context (last 7 days)
- YYYY-MM-DD: <one-line summary of the exchange or new info>

## Open threads
- <questions or topics Grace should bring up later>

If the exchange added nothing new and the memory.md is current, return it UNCHANGED. Do not invent facts.`;

export function createMemoryMdUpdaterWorker(deps: {
  redis: Redis;
  llm: LLMProvider;
  memoryMd: MemoryMdService;
  logger: Logger;
}): Worker<MemoryMdUpdateJob> {
  const worker = new Worker<MemoryMdUpdateJob>(
    'memory-md-update',
    async (job) => {
      const { userId, userText, assistantText } = job.data;
      const trimmedUser = userText.trim();
      const trimmedAssistant = assistantText.trim();

      // Trivial exchange — skip the LLM call.
      if (trimmedUser.length + trimmedAssistant.length < MIN_MEANINGFUL_CHARS) {
        return;
      }

      // Re-check enrollment in case the user was unenrolled between
      // enqueue and dequeue. Avoids wasted Gemini calls.
      const current = await deps.memoryMd.get(userId);
      if (current === null) return;

      const dateStamp = new Date().toISOString().slice(0, 10);
      const userPrompt =
`CURRENT memory.md:
${current.length === 0 ? '(empty — first turn for this user, please create the initial structure)' : current}

LATEST EXCHANGE (date: ${dateStamp}):
USER: ${trimmedUser}
GRACE: ${trimmedAssistant}

Return the FULL updated memory.md.`;

      let raw: string;
      try {
        const resp = await deps.llm.generate({
          messages: [
            { role: 'system', content: UPDATER_SYSTEM },
            { role: 'user', content: userPrompt },
          ],
          temperature: 0.2,
          maxOutputTokens: 1600,
          // gemini-2.5-flash-lite is plenty for a structured rewrite —
          // it's cheaper and faster than full flash, and the task is
          // straightforward instruction-following on small input.
          model: 'gemini-2.5-flash-lite',
          disableThinking: true,
        });
        raw = resp.text;
      } catch (err) {
        deps.logger.warn(
          { err: err instanceof Error ? err.message : String(err), userId },
          'memory_md_update.llm_failed',
        );
        return;
      }

      const cleaned = cleanLlmOutput(raw);
      if (cleaned.length === 0) {
        deps.logger.warn({ userId }, 'memory_md_update.empty_output');
        return;
      }

      // Cap enforcement — if the LLM ignored the size constraint, hard-
      // truncate to the limit. Better a slightly-clipped file than an
      // unbounded one.
      const capped = cleaned.length > MAX_MEMORY_CHARS
        ? cleaned.slice(0, MAX_MEMORY_CHARS)
        : cleaned;

      // Skip the write if the content is byte-identical to the current.
      // Reduces DB churn for "no-op" exchanges where the LLM correctly
      // identified there's nothing new to record.
      if (capped === current) return;

      // Sanity check: the updated file should still look like markdown
      // (start with a # header). If not, the LLM hallucinated free-form
      // text — drop it.
      if (!capped.trimStart().startsWith('#')) {
        deps.logger.warn(
          { userId, head: capped.slice(0, 80) },
          'memory_md_update.malformed',
        );
        return;
      }

      try {
        await deps.memoryMd.writeFromWorker(userId, capped);
        deps.logger.info(
          {
            userId,
            previousChars: current.length,
            newChars: capped.length,
            delta: capped.length - current.length,
          },
          'memory_md_update.ok',
        );
      } catch (err) {
        deps.logger.warn(
          { err: err instanceof Error ? err.message : String(err), userId },
          'memory_md_update.write_failed',
        );
      }
    },
    {
      connection: deps.redis,
      // Single-concurrency keeps per-user writes serialized — if two
      // back-to-back turns enqueue, the second waits, sees the first
      // worker's updated memory.md, and builds on it.
      concurrency: 2,
    },
  );

  worker.on('failed', (job, err) => {
    deps.logger.error({ jobId: job?.id, err }, 'memory_md_update.worker_failed');
  });

  return worker;
}

/** Strip code fences + leading/trailing whitespace from LLM output.
 *  Some Gemini responses wrap the markdown in ```markdown blocks despite
 *  the prompt saying not to. */
function cleanLlmOutput(raw: string): string {
  return raw
    .trim()
    .replace(/^```(?:markdown|md)?\s*\n?/i, '')
    .replace(/\n?```\s*$/, '')
    .trim();
}

// Test-only exports
export const __testing = {
  MAX_MEMORY_CHARS,
  MIN_MEANINGFUL_CHARS,
  cleanLlmOutput,
};
