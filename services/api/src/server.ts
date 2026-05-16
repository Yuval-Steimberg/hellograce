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
import { getTurnQueue, getFactExtractQueue, closeQueues } from './workers/queues.js';
import { startWorkers, stopWorkers } from './workers/index.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerWebhookRoutes } from './routes/webhook.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerChatRoutes } from './routes/chat.js';
import { registerUserRoutes } from './routes/users.js';
import { UserService } from './user/user.service.js';
import { ContentRulesService } from './services/content-rules.service.js';
import { MessageGenerator } from './scheduler/message-generator.js';
import { Scheduler } from './scheduler/scheduler.js';
import { PromptOptimizer, type OptimizerRunReport } from './scheduler/prompt-optimizer.js';
import { AppError } from './errors.js';

async function buildServer(): Promise<{ app: FastifyInstance; shutdown: () => Promise<void> }> {
  const env = loadEnv();
  const logger = createLogger({ level: env.LOG_LEVEL, pretty: env.NODE_ENV !== 'production' });

  const pool = createPool(env);
  const redis = getRedisClient(env.REDIS_URL);
  const cache = new Cache(redis);

  const llm = new GeminiProvider({ apiKey: env.GEMINI_API_KEY, model: env.GEMINI_MODEL }, logger, cache);
  const memory = new MemoryService(pool);
  const embedder = new GeminiEmbedder(env.GEMINI_API_KEY, 'gemini-embedding-001', cache);
  const rag = new RagService(pool, embedder, logger);
  const turnQueue = getTurnQueue(redis);
  const factExtractQueue = getFactExtractQueue(redis);

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

  const contentRulesService = new ContentRulesService(pool, logger);
  contentRulesService.start();

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
    twilioSid: env.TWILIO_ACCOUNT_SID,
    twilioToken: env.TWILIO_AUTH_TOKEN,
    turnQueue,
    factExtractQueue,
    systemPrompt: await loadActivePrompt(),
    contentRulesService,
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
  // Seed the proactive generator with the same active prompt the AI service uses.
  generator.updateSystemPrompt(await loadActivePrompt());
  generator.updateRulesService(contentRulesService);

  // Hot-reload BOTH the reactive AIService and the proactive MessageGenerator
  // whenever the optimizer auto-activates a new prompt. No SIGHUP, no restart.
  const promptOptimizer = new PromptOptimizer(pool, llm, logger, {
    onPromptActivated: async (content: string) => {
      ai.updateSystemPrompt(content);
      generator.updateSystemPrompt(content);
      logger.info({ bytes: content.length }, 'prompt.hot_reloaded_from_optimizer');
    },
    onRunComplete: async (report: OptimizerRunReport) => {
      const adminPhone = env.ADMIN_PHONE;
      if (!adminPhone) return;
      const msg = buildOptimizerReport(report);
      await sender.send({ to: adminPhone, body: msg, channel: 'whatsapp' });
      logger.info({ adminPhone, version: report.version }, 'prompt_optimizer.report_sent');
    },
  });
  const scheduler = new Scheduler({ users, sender, generator, logger, promptOptimizer });

  // Shared hot-reload routine — used by SIGHUP and the admin sync endpoint.
  const reloadActivePrompt = async (): Promise<void> => {
    const p = await loadActivePrompt();
    ai.updateSystemPrompt(p);
    generator.updateSystemPrompt(p);
    logger.info({ bytes: p?.length ?? 0 }, 'prompt.hot_reloaded');
  };

  // Manual SIGHUP still works for ops-driven reloads (e.g. ad-hoc prompt edits
  // via the admin dashboard).
  process.on('SIGHUP', () => {
    void reloadActivePrompt().catch((err) => logger.error({ err }, 'prompt.reload.failed'));
  });

  startWorkers({ redis, pool, memory, llm, logger });

  scheduler.start();

  const app: FastifyInstance = Fastify({
    loggerInstance: logger as never,
    trustProxy: true,
  }) as unknown as FastifyInstance;
  await app.register(cors, { origin: true, credentials: true });
  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(formbody);
  await app.register(rateLimit, {
    max: 120,
    timeWindow: '1 minute',
    // Twilio webhook is already protected by signature verification — no rate cap needed.
    // Admin + chat routes keep the 120 req/min limit.
    skipOnError: false,
    keyGenerator: (req) => {
      if (req.routeOptions?.url === '/webhook/twilio') return 'twilio-exempt';
      return req.ip;
    },
    // Give the exempt key an effectively unlimited ceiling.
    allowList: ['twilio-exempt'],
  });

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
  registerAdminRoutes(app, { pool, cache, llm, promptOptimizer, reloadActivePrompt, ...(env.ADMIN_TOKEN ? { adminToken: env.ADMIN_TOKEN } : {}) });

  const shutdown = async () => {
    app.log.info('shutdown.start');
    contentRulesService.stop();
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

function buildOptimizerReport(r: OptimizerRunReport): string {
  const { status, stats, version, analysis, draftReason } = r;
  const pct = stats.satisfactionPct !== null ? `${stats.satisfactionPct}% positive` : 'no ratings';
  const statsLine = `${stats.totalMessages} msgs · ${stats.positiveCount}👍 ${stats.negativeCount}👎 · ${pct} · ${stats.fallbackCount} fallbacks`;

  switch (status) {
    case 'activated':
      return [
        `🤖 Grace RLHF Report — v${version} activated`,
        ``,
        `📊 Last 14 days: ${statsLine}`,
        ``,
        `What changed: ${analysis}`,
        ``,
        `Review at graceglp.com/admin/prompts`,
      ].join('\n');

    case 'draft':
      return [
        `🤖 Grace RLHF Report — v${version} saved as DRAFT`,
        ``,
        `📊 Last 14 days: ${statsLine}`,
        ``,
        `⚠️ Not auto-activated — ${draftReason ?? 'safety gate failed'}`,
        ``,
        `What the optimizer found: ${analysis}`,
        ``,
        `Action needed: review and manually activate at graceglp.com/admin/prompts`,
      ].join('\n');

    case 'skipped_insufficient_data':
      return [
        `🤖 Grace RLHF Report — skipped`,
        ``,
        `📊 Last 14 days: ${statsLine}`,
        ``,
        `Not enough signal to learn from yet. ${analysis}`,
      ].join('\n');

    case 'skipped_no_active_prompt':
      return `🤖 Grace RLHF Report — skipped\n\n⚠️ ${analysis}`;

    case 'skipped_lock_held':
      return `🤖 Grace RLHF Report — skipped (lock held by other machine)`;

    case 'skipped_generation_failed':
      return [
        `🤖 Grace RLHF Report — failed`,
        ``,
        `📊 Last 14 days: ${statsLine}`,
        ``,
        `⚠️ ${analysis}`,
      ].join('\n');

    case 'error':
      return [
        `🤖 Grace RLHF Report — crashed`,
        ``,
        `⚠️ ${analysis}`,
        ``,
        `Check fly logs --app grace-api for the stack trace.`,
      ].join('\n');
  }
}

export { buildServer };
