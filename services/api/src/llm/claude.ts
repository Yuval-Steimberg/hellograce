import Anthropic from '@anthropic-ai/sdk';
import type { Logger } from 'pino';
import type { LLMProvider, LLMRequest, LLMResponse } from '@grace/shared';
import { UpstreamError } from '../errors.js';
import { NUDGE_RULES } from '../services/nudge-prompt.js';

/**
 * Claude adapter for the REPLY path only (2026-07-18).
 *
 * This implements the same provider-agnostic `LLMProvider` seam as
 * `GeminiProvider`, but it is wired in ONLY as the optional `replyLlm` used by
 * `runUnifiedReply`'s grounded reply generation — the single warm, user-facing
 * text turn governed by the big Nudge behavioral prompt. Every other Gemini call
 * (food/profile extraction, structured `responseSchema` tools, vision, voice
 * transcription, the critic) stays on `GeminiProvider` untouched, so accuracy on
 * those paths cannot change.
 *
 * Safety contract (why this can't damage the live path):
 *   - It is constructed ONLY when LLM_REPLY_PROVIDER=claude AND ANTHROPIC_API_KEY
 *     is set. When absent, the reply path uses `deps.llm` (Gemini) exactly as
 *     before — the default is byte-identical.
 *   - The grounded caller wraps `generate()` in a timeout race + `.catch(() => null)`
 *     and falls back to a DETERMINISTIC reply on any empty/failed result. So if
 *     Claude errors, times out, or returns nothing, the turn degrades to the same
 *     deterministic answer it would have produced anyway — Claude can only improve
 *     a turn, never break one.
 *   - It refuses JSON / structured-schema requests (throws): those are the
 *     accuracy-critical extraction calls, and they must never be routed here. The
 *     throw is caught upstream and degrades to the deterministic path.
 */

/** Bounded a hair under the caller's 11s UNIFIED_GEN_TIMEOUT_MS race, so a stalled
 *  Anthropic connection aborts here (clean UpstreamError → deterministic fallback)
 *  rather than being left hanging while the caller's race resolves null. */
const CLAUDE_GEN_TIMEOUT_MS = 10_000;

export class ClaudeProvider implements LLMProvider {
  readonly id = 'claude';
  private client: Anthropic;

  constructor(
    private cfg: { apiKey: string; model: string },
    private logger: Logger,
  ) {
    // maxRetries 1: one quick retry on a transient 429/5xx, then fail fast so the
    // caller's deterministic fallback answers instead of stacking latency.
    this.client = new Anthropic({ apiKey: cfg.apiKey, maxRetries: 1 });
  }

  async generate(req: LLMRequest): Promise<LLMResponse> {
    // Guard: never handle the accuracy-critical structured/JSON extraction calls.
    // The reply path never sends these; if one is ever routed here by mistake, the
    // throw is caught upstream and degrades to the deterministic path — it must not
    // be silently answered with unstructured text.
    if (req.responseSchema || req.responseFormat === 'json') {
      throw new UpstreamError('ClaudeProvider handles the text reply path only; JSON/schema requests belong on Gemini');
    }

    const system = req.messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n')
      .trim();

    // Map the conversation turns. Claude requires the first message to be `user`
    // and rejects empty content, so drop empties and any leading assistant turns.
    const mapped = req.messages
      .filter((m) => m.role !== 'system' && m.content.trim().length > 0)
      .map((m) => ({ role: m.role === 'assistant' ? ('assistant' as const) : ('user' as const), content: m.content }));
    while (mapped.length > 0 && mapped[0]!.role === 'assistant') mapped.shift();

    if (mapped.length === 0) {
      // Nothing to answer (all turns were empty/assistant). Let the caller's
      // deterministic fallback handle it rather than sending an invalid request.
      throw new UpstreamError('ClaudeProvider: no user content to answer');
    }

    try {
      const resp = await this.client.messages.create(
        {
          model: req.model ?? this.cfg.model,
          max_tokens: req.maxOutputTokens ?? 250,
          temperature: req.temperature ?? 0.6,
          ...(system ? { system: buildSystemBlocks(system) } : {}),
          messages: mapped,
        },
        { timeout: CLAUDE_GEN_TIMEOUT_MS },
      );

      const text = resp.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('')
        .trim();

      return {
        text,
        finishReason: mapStopReason(resp.stop_reason),
        usage: {
          inputTokens: resp.usage.input_tokens,
          outputTokens: resp.usage.output_tokens,
        },
      };
    } catch (err) {
      this.logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'claude.generate.failed');
      throw err instanceof UpstreamError ? err : new UpstreamError('Claude generation failed', err);
    }
  }
}

/**
 * Split the system prompt so the static Nudge RULES block gets its own
 * prompt-cache breakpoint. The grounded reply prompt is RULES (byte-identical
 * every turn) + the per-user profile/snapshot/temporal blocks (volatile), so
 * caching the RULES prefix bills it at ~0.1× on cache reads. Purely a cost/
 * latency optimization: Claude concatenates the blocks, so the model receives
 * the identical system content — output is unchanged. Falls back to a single
 * plain string whenever the prompt isn't the grounded reply prompt (e.g. any
 * future caller), so it can never mis-split.
 */
function buildSystemBlocks(system: string): string | Anthropic.TextBlockParam[] {
  if (system.startsWith(NUDGE_RULES) && system.length > NUDGE_RULES.length) {
    return [
      { type: 'text', text: NUDGE_RULES, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: system.slice(NUDGE_RULES.length) },
    ];
  }
  return system;
}

function mapStopReason(reason: string | null): LLMResponse['finishReason'] {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'stop';
    case 'max_tokens':
      return 'length';
    case 'refusal':
      return 'safety';
    default:
      return 'other';
  }
}
