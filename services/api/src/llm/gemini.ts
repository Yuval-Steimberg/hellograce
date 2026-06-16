import { createHash } from 'crypto';
import { GoogleGenerativeAI, type Content } from '@google/generative-ai';
import type { Logger } from 'pino';
import type { LLMProvider, LLMRequest, LLMResponse } from '@grace/shared';
import { UpstreamError } from '../errors.js';
import type { Cache } from '../cache/cache.js';

const LLM_TTL_SEC = 30 * 60; // 30 min

// ── Quota circuit breaker (2026-06-11) ────────────────────────────────────────
// Production failure: a free-tier key returned 429 with `limit: 0` on every
// call. The retry ladder (800→1600→3200ms × 2 models) burned 8-10s per LLM
// call on retries that COULD NOT succeed, stacking user turns minutes deep.
// When Google says "quota exhausted, retry in Ns", we open a breaker: all
// Gemini calls fail instantly until the window passes, so the deterministic
// fallback layer answers in milliseconds instead of after a retry storm.
// Module-level on purpose — one breaker per process covers all call sites
// (orchestrator, direct paths, workers).
let quotaBreakerUntil = 0;
let contextCacheDisabledUntil = 0;

function parseQuotaError(err: unknown): { isQuota: boolean; retryMs: number } {
  if (!err || typeof err !== 'object') return { isQuota: false, retryMs: 0 };
  const message = (err as { message?: string }).message ?? '';
  const status = (err as { status?: number }).status;
  if (status !== 429 && !/429|quota/i.test(message)) return { isQuota: false, retryMs: 0 };
  // Honor Google's RetryInfo when present ("Please retry in 39.2s"), capped.
  const m = message.match(/retry in (\d+(?:\.\d+)?)s/i);
  const retryMs = m ? Math.min(Math.ceil(parseFloat(m[1]!) * 1000), 60_000) : 30_000;
  return { isQuota: true, retryMs };
}

/** Exposed for tests/diagnostics. */
export function isQuotaBreakerOpen(): boolean {
  return Date.now() < quotaBreakerUntil;
}
export function resetQuotaBreaker(): void {
  quotaBreakerUntil = 0;
  contextCacheDisabledUntil = 0;
}

export class GeminiProvider implements LLMProvider {
  readonly id = 'gemini';
  private client: GoogleGenerativeAI;
  private cachedContentName: string | null = null;
  private cachedContentModel: string | null = null;
  private cachedContentHash: string | null = null;

  constructor(
    private cfg: { apiKey: string; model: string; fallbackModel?: string },
    private logger: Logger,
    private cache?: Cache,
  ) {
    this.client = new GoogleGenerativeAI(cfg.apiKey);
  }

  async generate(req: LLMRequest): Promise<LLMResponse> {
    // Quota breaker open → fail instantly so deterministic fallbacks answer
    // in milliseconds instead of after a doomed retry ladder.
    if (Date.now() < quotaBreakerUntil) {
      throw new UpstreamError(
        `Gemini quota breaker open for ${Math.ceil((quotaBreakerUntil - Date.now()) / 1000)}s`,
      );
    }
    const systemMessages = req.messages.filter((m) => m.role === 'system');
    const conversation = req.messages.filter((m) => m.role !== 'system');

    const systemInstruction = systemMessages.map((m) => m.content).join('\n\n') || undefined;

    const contents: Content[] = conversation.map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));

    if (this.cache) {
      const cacheKey = hashRequest(req);
      const cached = await this.cache.get<LLMResponse>('llm', cacheKey).catch(() => null);
      if (cached) {
        this.logger.debug({ cacheKey }, 'llm.cache.hit');
        return cached;
      }

      const response = await this.callGemini(systemInstruction, contents, req);
      await this.cache.set('llm', cacheKey, response, LLM_TTL_SEC).catch(() => null);
      return response;
    }

    return this.callGemini(systemInstruction, contents, req);
  }

  private async getOrCreateCachedContent(systemInstruction: string, modelName: string): Promise<string | null> {
    // After a 403/429 on the cachedContents endpoint, every subsequent call
    // was re-paying the failed HTTP roundtrip (~300ms each). Negative-cache
    // the failure for 10 minutes.
    if (Date.now() < contextCacheDisabledUntil) return null;
    const hash = createHash('sha256').update(systemInstruction).digest('hex').slice(0, 16);
    if (this.cachedContentName && this.cachedContentHash === hash && this.cachedContentModel === modelName) {
      return this.cachedContentName;
    }
    try {
      const fullModel = modelName.startsWith('models/') ? modelName : `models/${modelName}`;
      const resp = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/cachedContents?key=${this.cfg.apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: fullModel,
            systemInstruction: { parts: [{ text: systemInstruction }] },
            ttl: '3600s',
            displayName: `grace-system-${hash.slice(0, 8)}`,
          }),
        },
      );
      if (!resp.ok) {
        this.logger.warn({ status: resp.status }, 'gemini.context_cache.http_failed');
        if (resp.status === 403 || resp.status === 429) {
          contextCacheDisabledUntil = Date.now() + 10 * 60_000;
        }
        return null;
      }
      const data = await resp.json() as { name: string };
      this.cachedContentName = data.name;
      this.cachedContentHash = hash;
      this.cachedContentModel = modelName;
      this.logger.info({ model: modelName, hash: hash.slice(0, 8) }, 'gemini.context_cache.created');
      return data.name;
    } catch (err) {
      this.logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'gemini.context_cache.failed');
      return null;
    }
  }

  private async callGemini(
    systemInstruction: string | undefined,
    contents: Content[],
    req: LLMRequest,
  ): Promise<LLMResponse> {
    const modelName = req.model ?? this.cfg.model;
    try {
      return await this.tryModel(modelName, systemInstruction, contents, req, 3);
    } catch (err) {
      const fallback = this.cfg.fallbackModel;
      if (!isTransientGeminiError(err) || !fallback || fallback === modelName) {
        this.logger.error({ err }, 'gemini.generate.failed');
        throw err instanceof UpstreamError ? err : new UpstreamError('Gemini generation failed', err);
      }
      this.logger.warn({ from: modelName, to: fallback }, 'gemini.fallback_model.switch');
      try {
        return await this.tryModel(fallback, systemInstruction, contents, req, 2);
      } catch (fallbackErr) {
        this.logger.error({ err: fallbackErr }, 'gemini.fallback_model.failed');
        throw fallbackErr instanceof UpstreamError ? fallbackErr : new UpstreamError('Gemini generation failed', fallbackErr);
      }
    }
  }

  private async tryModel(
    modelName: string,
    systemInstruction: string | undefined,
    contents: Content[],
    req: LLMRequest,
    maxAttempts: number,
  ): Promise<LLMResponse> {
    const tools = req.useGoogleSearch && req.responseFormat !== 'json'
      ? ([{ googleSearch: {} }] as unknown as Parameters<typeof this.client.getGenerativeModel>[0]['tools'])
      : undefined;

    // Context caching: cache system prompts >2500 chars to save ~75% on input
    // tokens. Threshold lowered from 4000 to 2500 (2026-05-30 latency pass) so
    // the behavioral-guard and critic prompts (~3000 chars) also cache. The
    // Gemini API requires a minimum of 1024 tokens (~3000 chars) for context
    // caching to be billed at the cached rate; we set the floor at 2500 chars
    // to stay comfortably above the minimum on every cached call.
    let cachedContentName: string | null = null;
    if (systemInstruction && systemInstruction.length > 2500 && !req.useGoogleSearch) {
      cachedContentName = await this.getOrCreateCachedContent(systemInstruction, modelName);
    }

    const genConfig: Record<string, unknown> = {
      temperature: req.temperature ?? 0.6,
      maxOutputTokens: req.maxOutputTokens ?? 250,
      ...(req.responseFormat === 'json' || req.responseSchema
        ? { responseMimeType: 'application/json' }
        : {}),
    };
    // Structured-output (Gemini's responseSchema). When set, the model is
    // FORCED to produce JSON matching the schema — catches malformed outputs
    // at the API boundary instead of relying on downstream parsing. Used
    // by log_food and other tools where the response shape is critical.
    if (req.responseSchema) {
      genConfig.responseSchema = req.responseSchema;
    }
    // thinkingConfig only works on Gemini 2.5+ models. Sending it to 2.0
    // models causes a 400 error. Check the model name before setting it.
    // Gemini 3.x flash defaults to mandatory reasoning that burns the output
    // budget (truncated/empty replies) — so disabling thinking is essential
    // when we move the base model to 3.x. Covers 2.5, gemini-exp, and 3.x+.
    if (req.disableThinking && /2\.5|gemini-exp|gemini-[3-9]/i.test(modelName)) {
      genConfig.thinkingConfig = { thinkingBudget: 0 };
    }

    const modelOpts: Parameters<typeof this.client.getGenerativeModel>[0] = {
      model: modelName,
      ...(!cachedContentName && systemInstruction ? { systemInstruction } : {}),
      ...(tools ? { tools } : {}),
      generationConfig: genConfig as Parameters<typeof this.client.getGenerativeModel>[0]['generationConfig'],
    };
    if (cachedContentName) {
      (modelOpts as unknown as Record<string, unknown>).cachedContent = cachedContentName;
    }
    const model = this.client.getGenerativeModel(modelOpts);

    // Retry transient overload errors (503/429/network blips) with exponential
    // backoff: 800ms, 1600ms, 3200ms.
    let lastErr: unknown;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const result = await model.generateContent({ contents });
        const resp = result.response;
        const text = resp.text();
        const finishReason = mapFinishReason(resp.candidates?.[0]?.finishReason);
        const usage = resp.usageMetadata
          ? {
              inputTokens: resp.usageMetadata.promptTokenCount ?? 0,
              outputTokens: resp.usageMetadata.candidatesTokenCount ?? 0,
            }
          : undefined;

        return { text, finishReason, ...(usage ? { usage } : {}) };
      } catch (err) {
        lastErr = err;
        // Quota exhaustion is NOT transient within the retry window — Google
        // tells us how long to wait ("retry in 39s"). Open the breaker and
        // fail immediately; retrying within seconds is guaranteed to fail and
        // was stacking user turns 8-10s deep per LLM call.
        const quota = parseQuotaError(err);
        if (quota.isQuota) {
          quotaBreakerUntil = Math.max(quotaBreakerUntil, Date.now() + quota.retryMs);
          this.logger.warn(
            { model: modelName, breakerForMs: quota.retryMs },
            'gemini.quota_breaker.opened',
          );
          throw err;
        }
        // Model-not-found (404) will NEVER succeed on retry — retrying it 3x
        // with backoff just adds ~2.4s of dead latency to every call before the
        // GEMINI_FALLBACK_MODEL chain takes over. Fail fast so an unavailable
        // primary model (e.g. a Gemini 3 id not yet on this key) falls back to
        // the known-good fallback instantly. callGemini still routes 404 to the
        // fallback model (isTransientGeminiError keeps returning true for it).
        if (isModelNotFoundError(err)) {
          this.logger.warn({ model: modelName }, 'gemini.model_not_found.fast_fallback');
          throw err;
        }
        if (!isTransientGeminiError(err) || attempt === maxAttempts - 1) {
          throw err;
        }
        const delayMs = 800 * Math.pow(2, attempt);
        this.logger.warn({ attempt, delayMs, model: modelName }, 'gemini.generate.retry');
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
    throw lastErr;
  }
}

/** True for transient errors worth retrying — 503 overload, 429 rate limit,
 *  network, AND 404 model-not-found. The 404 case is technically not transient,
 *  but treating it as one lets the GEMINI_FALLBACK_MODEL chain catch model
 *  deprecations automatically. Production failure 2026-06-03: Google deprecated
 *  gemini-2.0-flash overnight and every call started returning 404, falling
 *  into the bare-bones emergency-fallback path that bypassed dietary/content
 *  guards. Now the fallback model kicks in BEFORE that path runs. */
/** True specifically for "model not found" (404 / deprecated / unavailable).
 *  Used to fail fast to the fallback model instead of retrying a primary that
 *  can never succeed — makes upgrading GEMINI_MODEL to a new (e.g. Gemini 3) id
 *  safe: if the id isn't on this key, every call falls back instantly. */
function isModelNotFoundError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  if ((err as { status?: number }).status === 404) return true;
  const message = (err as { message?: string }).message ?? '';
  return /404|not found|no longer available|is not supported|not exist/i.test(message);
}

function isTransientGeminiError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const status = (err as { status?: number }).status;
  if (status === 503 || status === 429 || status === 500 || status === 504 || status === 404) return true;
  const message = (err as { message?: string }).message ?? '';
  return /503|overload|high demand|unavailable|rate limit|429|timeout|ECONN|ETIMEDOUT|404|no longer available|not found/i.test(message);
}

function hashRequest(req: LLMRequest): string {
  const payload = JSON.stringify({
    messages: req.messages,
    temperature: req.temperature ?? 0.6,
    maxOutputTokens: req.maxOutputTokens ?? 400,
    responseFormat: req.responseFormat,
  });
  return createHash('sha256').update(payload).digest('hex');
}

function mapFinishReason(reason: string | undefined): LLMResponse['finishReason'] {
  switch (reason) {
    case 'STOP':
      return 'stop';
    case 'MAX_TOKENS':
      return 'length';
    case 'SAFETY':
    case 'BLOCKLIST':
      return 'safety';
    default:
      return 'other';
  }
}
