import { GoogleGenerativeAI, type Content } from '@google/generative-ai';
import type { Logger } from 'pino';
import type { LLMProvider, LLMRequest, LLMResponse } from '@grace/shared';
import { UpstreamError } from '../errors.js';

export class GeminiProvider implements LLMProvider {
  readonly id = 'gemini';
  private client: GoogleGenerativeAI;

  constructor(
    private cfg: { apiKey: string; model: string },
    private logger: Logger,
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
