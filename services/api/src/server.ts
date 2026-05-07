import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import formbody from '@fastify/formbody';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { loadEnv } from './config/env.js';
import { createLogger } from './logger.js';
import { createPool } from './db/pool.js';
import { GeminiProvider } from './llm/gemini.js';
import { GeminiEmbedder } from './rag/gemini-embedder.js';
import { RagService } from './rag/rag.service.js';
import { MemoryService } from './memory/memory.service.js';
import { AIService } from './services/ai.service.js';
import { TwilioSender } from './twilio/sender.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerWebhookRoutes } from './routes/webhook.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerChatRoutes } from './routes/chat.js';
import { AppError } from './errors.js';

async function buildServer(): Promise<{ app: FastifyInstance; shutdown: () => Promise<void> }> {
  const env = loadEnv();
  const logger = createLogger({ level: env.LOG_LEVEL, pretty: env.NODE_ENV !== 'production' });

  const pool = createPool(env);
  const llm = new GeminiProvider({ apiKey: env.GEMINI_API_KEY, model: env.GEMINI_MODEL }, logger);
  const memory = new MemoryService(pool);
  const embedder = new GeminiEmbedder(env.GEMINI_API_KEY);
  const rag = new RagService(pool, embedder, logger);
  const ai = new AIService({
    pool,
    llm,
    memory,
    rag,
    logger,
    flags: { ragEnabled: env.RAG_ENABLED ?? true, toolsEnabled: env.TOOLS_ENABLED ?? true },
    geminiApiKey: env.GEMINI_API_KEY,
    geminiModel: env.GEMINI_MODEL,
  });
  const sender = new TwilioSender(
    {
      accountSid: env.TWILIO_ACCOUNT_SID,
      authToken: env.TWILIO_AUTH_TOKEN,
      ...(env.TWILIO_FROM_NUMBER ? { fromSms: env.TWILIO_FROM_NUMBER } : {}),
      ...(env.TWILIO_WHATSAPP_FROM ? { fromWhatsapp: env.TWILIO_WHATSAPP_FROM } : {}),
    },
    logger,
  );

  const app: FastifyInstance = Fastify({
    loggerInstance: logger as never,
    trustProxy: true,
  }) as unknown as FastifyInstance;
  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(formbody);
  await app.register(rateLimit, { max: 120, timeWindow: '1 minute' });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) {
      reply.status(err.statusCode).send({ error: err.code, message: err.message });
      return;
    }
    app.log.error({ err }, 'unhandled');
    reply.status(500).send({ error: 'INTERNAL_ERROR', message: 'Internal server error' });
  });

  registerHealthRoutes(app, pool);
  registerWebhookRoutes(app, { env, ai, sender });
  registerChatRoutes(app, ai);
  registerAdminRoutes(app, { pool, ...(env.ADMIN_TOKEN ? { adminToken: env.ADMIN_TOKEN } : {}) });

  const shutdown = async () => {
    app.log.info('shutdown.start');
    await app.close();
    await pool.end();
    app.log.info('shutdown.done');
  };

  return { app, shutdown };
}

async function main(): Promise<void> {
  const { app, shutdown } = await buildServer();
  const port = Number(process.env.PORT ?? 3001);
  await app.listen({ port, host: '0.0.0.0' });

  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.once(sig, () => {
      void shutdown().then(() => process.exit(0));
    });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('fatal startup error', err);
    process.exit(1);
  });
}

export { buildServer };
