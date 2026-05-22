/**
 * Grace LLM Gateway — Feature 2
 *
 * Sits between the Grace API and the Gemini API. Adds:
 *   1. Gemini Context Caching — pins static system prompts server-side (1hr TTL)
 *   2. Intent-Based Model Routing — Flash for chat, Pro for medical escalations
 *   3. Circuit Breaker — opens on 5 failures/60s, recovers after 30s
 *   4. Per-user sliding-window rate limiting
 *
 * Wire in: set LLM_GATEWAY_URL=http://llm-gateway:3010 in the API service env.
 * No API source code changes required — the gateway speaks the same LLMRequest /
 * LLMResponse JSON contract as packages/shared/src/ai.ts.
 */
import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { GoogleGenerativeAI, type Content } from '@google/generative-ai';
import { GoogleAIFileManager } from '@google/generative-ai/server';
import Redis from 'ioredis';
import pino from 'pino';
import { z } from 'zod';
import { CircuitBreaker } from './circuit-breaker.js';
import { routeModel } from './intent-router.js';
import { ContextCacheManager } from './context-cache.js';

// ── Config ─────────────────────────────────────────────────────────────────

const cfg = {
  port: Number(process.env.PORT ?? 3010),
  geminiApiKey: process.env.GEMINI_API_KEY ?? '',
  flashModel: process.env.GEMINI_FLASH_MODEL ?? 'gemini-2.5-flash',
  proModel: process.env.GEMINI_PRO_MODEL ?? 'gemini-2.5-pro',
  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
  rateLimitPerMinute: Number(process.env.RATE_LIMIT_RPM ?? 60),
  logLevel: process.env.LOG_LEVEL ?? 'info',
  contextCacheEnabled: process.env.CONTEXT_CACHE_ENABLED !== 'false',
};

const logger = pino({ level: cfg.logLevel });

// ── Zod schemas ────────────────────────────────────────────────────────────

const MessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant']),
  content: z.string(),
});

const LLMRequestSchema = z.object({
  messages: z.array(MessageSchema).min(1),
  temperature: z.number().min(0).max(2).optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  responseFormat: z.enum(['text', 'json']).optional(),
  useGoogleSearch: z.boolean().optional(),
  userId: z.string().optional(), // for per-user rate limiting + routing context
});

// ── Infrastructure ─────────────────────────────────────────────────────────

const redis = new Redis(cfg.redisUrl, { lazyConnect: true, enableReadyCheck: false });
redis.connect().catch((err) => logger.warn({ err }, 'redis.connect_failed — running without Redis'));

const genAI = new GoogleGenerativeAI(cfg.geminiApiKey);
const cacheManager = cfg.contextCacheEnabled
  ? new ContextCacheManager(cfg.geminiApiKey, redis, logger)
  : null;

// One circuit breaker per model
const breakers = new Map<string, CircuitBreaker>();
function getBreaker(model: string): CircuitBreaker {
  if (!breakers.has(model)) breakers.set(model, new CircuitBreaker());
  return breakers.get(model)!;
}

// ── Fastify ────────────────────────────────────────────────────────────────

const app = Fastify({ logger: false });

await app.register(rateLimit, {
  max: cfg.rateLimitPerMinute,
  timeWindow: '1 minute',
  keyGenerator: (req) => {
    const body = req.body as { userId?: string } | undefined;
    return body?.userId ?? req.ip;
  },
});

// ── Health ─────────────────────────────────────────────────────────────────

app.get('/health', async () => ({
  ok: true,
  models: { flash: cfg.flashModel, pro: cfg.proModel },
  breakers: Object.fromEntries(
    [...breakers.entries()].map(([k, v]) => [k, v.currentState]),
  ),
}));

// ── Main generate endpoint ─────────────────────────────────────────────────

app.post('/generate', async (request, reply) => {
  const parsed = LLMRequestSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.status(400).send({ error: 'invalid_request', details: parsed.error.issues });
  }

  const req = parsed.data;

  // 1. Extract system instruction and conversation turns
  const systemMessages = req.messages.filter((m) => m.role === 'system');
  const conversation = req.messages.filter((m) => m.role !== 'system');
  const systemInstruction = systemMessages.map((m) => m.content).join('\n\n') || undefined;

  // 2. Route to Flash or Pro based on the last user message
  const lastUserText = [...req.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
  const { model: targetModel, reason: routeReason } = routeModel(
    lastUserText,
    cfg.flashModel,
    cfg.proModel,
  );

  logger.debug({ model: targetModel, reason: routeReason }, 'gateway.route');

  // 3. Circuit breaker check
  const breaker = getBreaker(targetModel);
  if (!breaker.isAllowed()) {
    // Fall back to Flash if Pro is open, or 503 if Flash is also open
    if (targetModel === cfg.proModel && getBreaker(cfg.flashModel).isAllowed()) {
      logger.warn({ model: targetModel }, 'gateway.circuit_open — downgrade to flash');
    } else {
      logger.error({ model: targetModel }, 'gateway.circuit_open — all models unavailable');
      return reply.status(503).send({ error: 'service_unavailable', message: 'Circuit open' });
    }
  }

  // 4. Build Gemini contents array
  const contents: Content[] = conversation.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));

  // 5. Attempt context-cached generation; fall back to standard on any error
  try {
    let text: string;
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    let cachedTokens: number | undefined;

    if (cacheManager && systemInstruction && systemInstruction.length > 500) {
      const cacheName = await cacheManager.getOrCreate(systemInstruction, targetModel);
      if (cacheName) {
        ({ text, inputTokens, outputTokens, cachedTokens } = await generateWithCache(
          cacheName,
          contents,
          req,
        ));
      } else {
        ({ text, inputTokens, outputTokens } = await generateDirect(
          targetModel,
          systemInstruction,
          contents,
          req,
        ));
      }
    } else {
      ({ text, inputTokens, outputTokens } = await generateDirect(
        targetModel,
        systemInstruction,
        contents,
        req,
      ));
    }

    breaker.recordSuccess();
    logger.info(
      { model: targetModel, route: routeReason, inputTokens, outputTokens, cachedTokens },
      'gateway.generate.ok',
    );

    return {
      text,
      finishReason: 'stop' as const,
      usage: inputTokens !== undefined
        ? { inputTokens, outputTokens: outputTokens ?? 0, cachedTokens }
        : undefined,
    };
  } catch (err) {
    breaker.recordFailure();
    logger.error({ err, model: targetModel }, 'gateway.generate.error');
    return reply.status(502).send({ error: 'upstream_error', message: String(err) });
  }
});

// ── Generation helpers ─────────────────────────────────────────────────────

async function generateWithCache(
  cacheName: string,
  contents: Content[],
  req: { temperature?: number; maxOutputTokens?: number; responseFormat?: string },
): Promise<{ text: string; inputTokens?: number; outputTokens?: number; cachedTokens?: number }> {
  const model = genAI.getGenerativeModelFromCachedContent({ name: cacheName } as never);
  const result = await model.generateContent({
    contents,
    generationConfig: buildGenConfig(req),
  });
  const resp = result.response;
  return {
    text: resp.text(),
    inputTokens: resp.usageMetadata?.promptTokenCount,
    outputTokens: resp.usageMetadata?.candidatesTokenCount,
    cachedTokens: resp.usageMetadata?.cachedContentTokenCount,
  };
}

async function generateDirect(
  modelName: string,
  systemInstruction: string | undefined,
  contents: Content[],
  req: { temperature?: number; maxOutputTokens?: number; responseFormat?: string; useGoogleSearch?: boolean },
): Promise<{ text: string; inputTokens?: number; outputTokens?: number }> {
  const tools =
    req.useGoogleSearch && req.responseFormat !== 'json'
      ? ([{ googleSearch: {} }] as never)
      : undefined;

  const model = genAI.getGenerativeModel({
    model: modelName,
    ...(systemInstruction ? { systemInstruction } : {}),
    ...(tools ? { tools } : {}),
    generationConfig: buildGenConfig(req),
  });

  const result = await model.generateContent({ contents });
  const resp = result.response;
  return {
    text: resp.text(),
    inputTokens: resp.usageMetadata?.promptTokenCount,
    outputTokens: resp.usageMetadata?.candidatesTokenCount,
  };
}

function buildGenConfig(req: {
  temperature?: number;
  maxOutputTokens?: number;
  responseFormat?: string;
}) {
  return {
    temperature: req.temperature ?? 0.6,
    maxOutputTokens: req.maxOutputTokens ?? 400,
    ...(req.responseFormat === 'json' ? { responseMimeType: 'application/json' } : {}),
  };
}

// ── Boot ───────────────────────────────────────────────────────────────────

app.listen({ port: cfg.port, host: '0.0.0.0' }, (err) => {
  if (err) { logger.error(err); process.exit(1); }
  logger.info({ port: cfg.port }, 'llm-gateway.started');
});
