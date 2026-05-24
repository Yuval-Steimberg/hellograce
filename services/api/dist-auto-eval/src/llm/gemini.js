import { createHash } from 'crypto';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { UpstreamError } from '../errors.js';
const LLM_TTL_SEC = 30 * 60; // 30 min
export class GeminiProvider {
    cfg;
    logger;
    cache;
    id = 'gemini';
    client;
    constructor(cfg, logger, cache) {
        this.cfg = cfg;
        this.logger = logger;
        this.cache = cache;
        this.client = new GoogleGenerativeAI(cfg.apiKey);
    }
    async generate(req) {
        const systemMessages = req.messages.filter((m) => m.role === 'system');
        const conversation = req.messages.filter((m) => m.role !== 'system');
        const systemInstruction = systemMessages.map((m) => m.content).join('\n\n') || undefined;
        const contents = conversation.map((m) => ({
            role: m.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: m.content }],
        }));
        if (this.cache) {
            const cacheKey = hashRequest(req);
            const cached = await this.cache.get('llm', cacheKey).catch(() => null);
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
    async callGemini(systemInstruction, contents, req) {
        // Try primary model with retry-backoff first. If it keeps failing with
        // transient errors (503 overload), switch to the fallback model
        // (e.g. gemini-2.0-flash) which has independent capacity. Better to serve
        // a slightly older-model response than to silently drop the user's message.
        try {
            return await this.tryModel(this.cfg.model, systemInstruction, contents, req, 3);
        }
        catch (err) {
            if (!isTransientGeminiError(err) || !this.cfg.fallbackModel || this.cfg.fallbackModel === this.cfg.model) {
                this.logger.error({ err }, 'gemini.generate.failed');
                throw err instanceof UpstreamError ? err : new UpstreamError('Gemini generation failed', err);
            }
            this.logger.warn({ from: this.cfg.model, to: this.cfg.fallbackModel }, 'gemini.fallback_model.switch');
            try {
                return await this.tryModel(this.cfg.fallbackModel, systemInstruction, contents, req, 2);
            }
            catch (fallbackErr) {
                this.logger.error({ err: fallbackErr }, 'gemini.fallback_model.failed');
                throw fallbackErr instanceof UpstreamError ? fallbackErr : new UpstreamError('Gemini generation failed', fallbackErr);
            }
        }
    }
    async tryModel(modelName, systemInstruction, contents, req, maxAttempts) {
        // Google Search grounding: enabled for last-resort web lookups when the
        // KB has nothing. Cannot be combined with JSON mode.
        const tools = req.useGoogleSearch && req.responseFormat !== 'json'
            ? [{ googleSearch: {} }]
            : undefined;
        const model = this.client.getGenerativeModel({
            model: modelName,
            ...(systemInstruction ? { systemInstruction } : {}),
            ...(tools ? { tools } : {}),
            generationConfig: {
                temperature: req.temperature ?? 0.6,
                maxOutputTokens: req.maxOutputTokens ?? 400,
                ...(req.responseFormat === 'json' ? { responseMimeType: 'application/json' } : {}),
            },
        });
        // Retry transient overload errors (503/429/network blips) with exponential
        // backoff: 800ms, 1600ms, 3200ms.
        let lastErr;
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
            }
            catch (err) {
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
function isTransientGeminiError(err) {
    if (!err || typeof err !== 'object')
        return false;
    const status = err.status;
    if (status === 503 || status === 429 || status === 500 || status === 504)
        return true;
    const message = err.message ?? '';
    return /503|overload|high demand|unavailable|rate limit|429|timeout|ECONN|ETIMEDOUT/i.test(message);
}
function hashRequest(req) {
    const payload = JSON.stringify({
        messages: req.messages,
        temperature: req.temperature ?? 0.6,
        maxOutputTokens: req.maxOutputTokens ?? 400,
        responseFormat: req.responseFormat,
    });
    return createHash('sha256').update(payload).digest('hex');
}
function mapFinishReason(reason) {
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
