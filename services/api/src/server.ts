import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import formbody from '@fastify/formbody';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { loadEnv } from './config/env.js';
import { createLogger } from './logger.js';
import { createPool } from './db/pool.js';
import { getRedisClient, closeRedis } from './cache/redis.js';
import { Cache } from './cache/cache.js';
import { GeminiProvider } from './llm/gemini.js';
import { GeminiEmbedder } from './rag/gemini-embedder.js';
import { RagService } from './rag/rag.service.js';
import { MemoryService } from './memory/memory.service.js';
import { AIService } from './services/ai.service.js';
import { TwilioSender } from './twilio/sender.js';
import { getTurnQueue, closeQueues } from './workers/queues.js';
import { startWorkers, stopWorkers } from './workers/index.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerWebhookRoutes } from './routes/webhook.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerChatRoutes } from './routes/chat.js';
import { registerUserRoutes } from './routes/users.js';
import { UserService } from './user/user.service.js';
import { MessageGenerator } from './scheduler/message-generator.js';
import { Scheduler } from './scheduler/scheduler.js';
import { AppError } from './errors.js';

async function buildServer(): Promise<{ app: FastifyInstance; shutdown: () => Promise<void> }> {
  const env = loadEnv();
  const logger = createLogger({ level: env.LOG_LEVEL, pretty: env.NODE_ENV !== 'production' });

  const pool = createPool(env);
  const redis = getRedisClient(env.REDIS_URL);
  const cache = new Cache(redis);

  const llm = new GeminiProvider({ apiKey: env.GEMINI_API_KEY, model: env.GEMINI_MODEL }, logger, cache);
  const memory = new MemoryService(pool);
  const embedder = new GeminiEmbedder(env.GEMINI_API_KEY, 'text-embedding-004', cache);
  const rag = new RagService(pool, embedder, logger);
  const turnQueue = getTurnQueue(redis);

  const loadActivePrompt = async (): Promise<string | undefined> => {
    try {
      const { rows } = await pool.query<{ content: string }>(
        `SELECT content FROM prompts WHERE active = TRUE LIMIT 1`,
      );
      return rows[0]?.content;
    } catch {
      return undefined;
    }
  };

  const users = new UserService(pool);

  const ai = new AIService({
    pool,
    llm,
    memory,
    rag,
    users,
    logger,
    flags: { ragEnabled: env.RAG_ENABLED ?? true, toolsEnabled: env.TOOLS_ENABLED ?? true },
    geminiApiKey: env.GEMINI_API_KEY,
    geminiModel: env.GEMINI_MODEL,
    turnQueue,
    systemPrompt: await loadActivePrompt(),
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

  const generator = new MessageGenerator(llm);
  const scheduler = new Scheduler({ users, sender, generator, logger });

  startWorkers({ redis, pool, memory, logger });

  // Reload the active system prompt from DB without restarting the process.
  process.on('SIGHUP', () => {
    void loadActivePrompt().then((p) => ai.updateSystemPrompt(p));
  });

  scheduler.start();

  const app: FastifyInstance = Fastify({
    loggerInstance: logger as never,
    trustProxy: true,
  }) as unknown as FastifyInstance;
  await app.register(cors, { origin: true, credentials: true });
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
  registerWebhookRoutes(app, { env, ai, sender, users });
  registerUserRoutes(app, { pool, users, sender, generator });
  registerChatRoutes(app, ai, pool);
  registerAdminRoutes(app, { pool, cache, ...(env.ADMIN_TOKEN ? { adminToken: env.ADMIN_TOKEN } : {}) });

  const shutdown = async () => {
    app.log.info('shutdown.start');
    scheduler.stop();
    await app.close();
    await stopWorkers();
    await closeQueues();
    await closeRedis();
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
