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

  constructor(
    private cfg: { apiKey: string; model: string },
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

  private async callGemini(
    systemInstruction: string | undefined,
    contents: Content[],
    req: LLMRequest,
  ): Promise<LLMResponse> {
    const model = this.client.getGenerativeModel({
      model: this.cfg.model,
      ...(systemInstruction ? { systemInstruction } : {}),
      generationConfig: {
        temperature: req.temperature ?? 0.6,
        maxOutputTokens: req.maxOutputTokens ?? 400,
        ...(req.responseFormat === 'json' ? { responseMimeType: 'application/json' } : {}),
      },
    });

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
      this.logger.error({ err }, 'gemini.generate.failed');
      throw new UpstreamError('Gemini generation failed', err);
    }
  }
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
