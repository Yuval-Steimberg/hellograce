import { createHash } from 'crypto';
import { GoogleGenerativeAI, type Content } from '@google/generative-ai';
import type { Logger } from 'pino';
import type { LLMProvider, LLMRequest, LLMResponse } from '@grace/shared';
import { UpstreamError } from '../errors.js';
import type { Cache } from '../cache/cache.js';

const LLM_TTL_SEC = 30 * 60; // 30 min

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
      maxOutputTokens: req.maxOutputTokens ?? 200,
      ...(req.responseFormat === 'json' ? { responseMimeType: 'application/json' } : {}),
    };
    // thinkingConfig only works on Gemini 2.5+ models. Sending it to 2.0
    // models causes a 400 error. Check the model name before setting it.
    if (req.disableThinking && /2\.5|gemini-exp/i.test(modelName)) {
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

/** True for transient errors worth retrying — 503 overload, 429 rate limit, network. */
function isTransientGeminiError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const status = (err as { status?: number }).status;
  if (status === 503 || status === 429 || status === 500 || status === 504) return true;
  const message = (err as { message?: string }).message ?? '';
  return /503|overload|high demand|unavailable|rate limit|429|timeout|ECONN|ETIMEDOUT/i.test(message);
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
