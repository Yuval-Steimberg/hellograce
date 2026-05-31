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
import { FaqSemanticCache } from './cache/faq-semantic-cache.js';
import { RagService } from './rag/rag.service.js';
import { MemoryService } from './memory/memory.service.js';
import { UserMemoryService } from './memory/user-memory.service.js';
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
import { MessageTemplatesService } from './services/message-templates.service.js';
import { MessageGenerator } from './scheduler/message-generator.js';
import { Scheduler } from './scheduler/scheduler.js';
import { PromptOptimizer, type OptimizerRunReport, type SyntheticFeedback } from './scheduler/prompt-optimizer.js';
import { AppError } from './errors.js';
import { initFieldEncryption } from './crypto/field-encrypt.js';
import { initStripe } from './services/stripe.service.js';

async function buildServer(): Promise<{ app: FastifyInstance; shutdown: () => Promise<void> }> {
  const env = loadEnv();
  initFieldEncryption(env.FIELD_ENCRYPTION_KEY);
  initStripe(env.STRIPE_SECRET_KEY);
  const logger = createLogger({ level: env.LOG_LEVEL, pretty: env.NODE_ENV !== 'production' });

  const pool = createPool(env);
  const redis = getRedisClient(env.REDIS_URL);
  const cache = new Cache(redis);

  const llm = new GeminiProvider({ apiKey: env.GEMINI_API_KEY, model: env.GEMINI_MODEL, fallbackModel: env.GEMINI_FALLBACK_MODEL }, logger, cache);
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

  const messageTemplatesService = new MessageTemplatesService(pool, logger);

  const userMemory = new UserMemoryService(pool, embedder, llm, logger);

  // FAQ semantic cache — opt-in via FAQ_CACHE_ENABLED env var. Initializes
  // (embeds all seeds) in the background so server boot isn't blocked.
  let faqCache: FaqSemanticCache | undefined;
  if (env.FAQ_CACHE_ENABLED) {
    const threshold = env.FAQ_CACHE_THRESHOLD ?? 0.92;
    faqCache = new FaqSemanticCache(embedder, logger, threshold);
    void faqCache.initialize().catch((err) =>
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'faq_cache.init_failed'),
    );
  }

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
    userMemory,
    faqCache,
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
  generator.updateTemplatesService(messageTemplatesService);
  generator.updateWebUrl(env.PUBLIC_WEB_URL);

  // Hot-reload BOTH the reactive AIService and the proactive MessageGenerator
  // whenever the optimizer auto-activates a new prompt. No SIGHUP, no restart.
  // Load auto-eval preference pairs as synthetic RLHF signals.
  // Path is constructed at runtime so tsc doesn't try to resolve auto-eval/ (outside rootDir).
  const loadSyntheticFeedback = async (): Promise<SyntheticFeedback[]> => {
    try {
      const feedbackPath = new URL('../auto-eval/feedback-loop.js', import.meta.url).href;
      const mod = await import(feedbackPath).catch(() => null) as {
        loadPreferencePairs: (dir: string) => Array<{ userMessage: string; rejected: string; dimension: string; reasoning: string; chosen: string }>;
        pairsToSyntheticFeedback: (pairs: unknown[]) => SyntheticFeedback[];
      } | null;
      if (!mod) return [];
      const { existsSync } = await import('fs');
      const resultsDir = new URL('../auto-eval/results', import.meta.url).pathname;
      if (!existsSync(resultsDir)) return [];
      const pairs = mod.loadPreferencePairs(resultsDir);
      if (pairs.length > 0) {
        logger.info({ pairs: pairs.length }, 'synthetic_feedback.loaded_from_auto_eval');
        return mod.pairsToSyntheticFeedback(pairs);
      }
    } catch {
      // auto-eval results may not exist yet — that's fine
    }
    return [];
  };

  const promptOptimizer = new PromptOptimizer(pool, llm, logger, {
    onPromptActivated: async (content: string) => {
      ai.updateSystemPrompt(content);
      generator.updateSystemPrompt(content);
      logger.info({ bytes: content.length }, 'prompt.hot_reloaded_from_optimizer');
    },
    onRunComplete: async (report: OptimizerRunReport) => {
      const adminPhone = env.ADMIN_PHONE;
      if (!adminPhone) return;

      // Run a coverage smoke (~50 cases) after a successful prompt activation
      // so the admin WhatsApp report includes a delta vs the previous run.
      // Phase 4 of the deep-research coverage plan. The coverage run is
      // best-effort — any failure is logged and skipped, never blocks the
      // optimizer report.
      let coverageSnippet = '';
      if (report.status === 'activated') {
        try {
          // Load the freshly-activated prompt from DB for the coverage run.
          const { rows: promptRows } = await pool.query<{ content: string }>(
            `SELECT content FROM prompts WHERE active = TRUE ORDER BY created_at DESC LIMIT 1`,
          );
          const currentPrompt = promptRows[0]?.content ?? '';
          if (!currentPrompt) {
            logger.warn('coverage.smoke.no_active_prompt');
            throw new Error('no active prompt');
          }

          const suiteUrl = new URL('../coverage/suite.js', import.meta.url).href;
          const runnerUrl = new URL('../coverage/runner.js', import.meta.url).href;
          const reporterUrl = new URL('../coverage/reporter.js', import.meta.url).href;
          const suiteMod = await import(suiteUrl) as {
            buildSuite: (opts: { limit?: number }) => unknown[];
          };
          const runnerMod = await import(runnerUrl) as {
            runCoverage: (opts: unknown) => Promise<{ run_id: string; stats: { pass_rate: number; passed: number; total: number; by_domain: Record<string, { pass_rate: number; total: number }> } }>;
          };
          const reporterMod = await import(reporterUrl) as {
            saveReport: (r: unknown) => string;
            listReports: () => Array<{ run_id: string; pass_rate: number }>;
            loadReport: (id: string) => unknown | null;
            reportDelta: (prev: unknown, curr: unknown) => { regressions: unknown[]; pass_rate_delta: number };
          };
          const cases = suiteMod.buildSuite({ limit: 50 });
          const past = reporterMod.listReports();
          const coverageReport = await runnerMod.runCoverage({
            cases,
            llm,
            systemPrompt: currentPrompt,
            concurrency: 4,
            systemPromptVersion: report.version ?? null,
          } as never);
          reporterMod.saveReport(coverageReport);
          const previous = past.find(() => true);
          const delta = previous ? reporterMod.reportDelta(reporterMod.loadReport(previous.run_id)!, coverageReport) : null;
          const worstDomain = Object.entries(coverageReport.stats.by_domain)
            .sort(([, a], [, b]) => a.pass_rate - b.pass_rate)[0];
          coverageSnippet = `\n\n🎯 Coverage smoke (${coverageReport.stats.total} cases): ${coverageReport.stats.pass_rate}%`;
          if (delta) {
            coverageSnippet += ` (${delta.pass_rate_delta >= 0 ? '+' : ''}${delta.pass_rate_delta.toFixed(1)}% vs previous)`;
            if (delta.regressions.length > 0) {
              coverageSnippet += `\n⚠️ ${delta.regressions.length} regression${delta.regressions.length === 1 ? '' : 's'}`;
            }
          }
          if (worstDomain) {
            coverageSnippet += `\nWeakest domain: ${worstDomain[0]} (${worstDomain[1].pass_rate}%)`;
          }
        } catch (err) {
          logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'coverage.smoke.failed');
        }
      }

      const msg = buildOptimizerReport(report) + coverageSnippet;
      await sender.send({ to: adminPhone, body: msg, channel: 'whatsapp', raw: true });
      logger.info({ adminPhone, version: report.version, hasCoverage: coverageSnippet.length > 0 }, 'prompt_optimizer.report_sent');
    },
  });

  // Seed optimizer with any available auto-eval preference pairs
  const synthetic = await loadSyntheticFeedback();
  if (synthetic.length > 0) {
    promptOptimizer.injectSyntheticFeedback(synthetic);
  }
  const scheduler = new Scheduler({
    users,
    sender,
    generator,
    logger,
    redis,
    promptOptimizer,
    engagementCooldownHours: env.ENGAGEMENT_COOLDOWN_HOURS,
  });

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
  const allowedOrigins = env.NODE_ENV === 'production'
    ? [
        process.env.PUBLIC_WEB_URL ?? 'https://grace-admin-silk.vercel.app',
        'https://grace-admin-silk.vercel.app',
        'https://graceglp.com',
        'https://www.graceglp.com',
        // Allow local web dev (Vite on :8080) to call the live API for quick
        // UI iteration. Safe because only the browser origin is checked —
        // sensitive endpoints still require the admin Bearer token.
        'http://localhost:8080',
        'http://127.0.0.1:8080',
      ]
    : [
        'http://localhost:5173',
        'http://localhost:3000',
        'http://localhost:3001',
        // Match the Vite config (apps/web/vite.config.ts) so the local web
        // dev server on :8080 can call a locally-running API too.
        'http://localhost:8080',
        'http://127.0.0.1:8080',
      ];
  await app.register(cors, { origin: allowedOrigins, credentials: true });
  await app.register(helmet);
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
  registerWebhookRoutes(app, { env, ai, sender, users, redis, templates: messageTemplatesService });
  registerUserRoutes(app, { pool, users, sender, generator });
  registerChatRoutes(app, ai, pool);
  registerAdminRoutes(app, { pool, cache, llm, promptOptimizer, reloadActivePrompt, redis, templates: messageTemplatesService, faqCache, ...(env.ADMIN_TOKEN ? { adminToken: env.ADMIN_TOKEN } : {}) });

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

    case 'skipped_already_ran_today':
      return [
        `🤖 Grace RLHF Report — skipped`,
        ``,
        `Already ran today (v${version}). ${analysis}`,
      ].join('\n');

    case 'skipped_no_new_patterns':
      return [
        `🤖 Grace RLHF Report — no changes`,
        ``,
        `📊 Last 14 days: ${statsLine}`,
        ``,
        `${analysis}`,
      ].join('\n');

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
