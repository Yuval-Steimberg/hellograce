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
import { ProductionIssuesService } from './services/production-issues.service.js';
import { AIService } from './services/ai.service.js';
import { TwilioSender } from './twilio/sender.js';
import { ImessageSender } from './imessage/sender.js';
import { SendblueSender } from './imessage/sendblue-sender.js';
import { ChannelRouter } from './channel-router.js';
import { getTurnQueue, getFactExtractQueue, getMemoryMdQueue, closeQueues } from './workers/queues.js';
import { MemoryMdService } from './memory/memory-md.service.js';
import { startWorkers, stopWorkers } from './workers/index.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerWebhookRoutes } from './routes/webhook.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerStripeWebhookRoutes } from './routes/stripe-webhook.js';
import { registerChatRoutes } from './routes/chat.js';
import { registerUserRoutes } from './routes/users.js';
import { registerSettingsRoutes } from './routes/settings.js';
import { UserService } from './user/user.service.js';
import { ContentRulesService } from './services/content-rules.service.js';
import { TodayFoodCacheService } from './cache/today-food-cache.js';
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
  // Startup Gemini health check — surfaces a dead/rate-limited key or a bad
  // model id immediately (instead of silently degrading to fallbacks on every
  // user message). Fire-and-forget so it never blocks boot.
  void (async () => {
    const started = Date.now();
    try {
      const r = await llm.generate({ messages: [{ role: 'user', content: 'Reply with exactly: ok' }], maxOutputTokens: 5, temperature: 0 });
      const text = (r.text ?? '').trim();
      if (text) {
        logger.info({ model: env.GEMINI_MODEL, ms: Date.now() - started, sample: text.slice(0, 20) }, 'startup.gemini_healthcheck.ok');
      } else {
        logger.error({ model: env.GEMINI_MODEL, ms: Date.now() - started }, 'startup.gemini_healthcheck.empty — model returned NO text. Set GEMINI_MODEL to gemini-2.5-flash (the lite model can return empty on big prompts).');
      }
    } catch (err) {
      logger.error(
        { model: env.GEMINI_MODEL, ms: Date.now() - started, err: err instanceof Error ? err.message : String(err) },
        'startup.gemini_healthcheck.failed — Gemini key/model is NOT working. Check quota (free-tier 429) or the API key.',
      );
    }
  })();
  const memory = new MemoryService(pool);
  const embedder = new GeminiEmbedder(env.GEMINI_API_KEY, 'gemini-embedding-001', cache);
  const rag = new RagService(pool, embedder, logger);
  const turnQueue = getTurnQueue(redis);
  const factExtractQueue = getFactExtractQueue(redis);
  // Phase D — memory.md per-user narrative layer. Pilot opt-in via row in
  // user_memory_md table (see migration 20260607000001_user_memory_md.sql).
  const memoryMd = new MemoryMdService(pool, logger);
  const memoryMdQueue = getMemoryMdQueue(redis);

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
  // Phase A2 (2026-06-07) — wire the Redis L2 cache for today's food
  // summary. Saves the ~100-150ms CTE+TZ subquery on every turn after
  // a cache warmup. Falls back to L1 in-memory + DB on Redis errors.
  users.setTodayFoodCache(new TodayFoodCacheService(redis, logger));

  const contentRulesService = new ContentRulesService(pool, logger);
  contentRulesService.start();

  const messageTemplatesService = new MessageTemplatesService(pool, logger);

  const userMemory = new UserMemoryService(pool, embedder, llm, logger);
  const productionIssues = new ProductionIssuesService(pool, logger);

  // Phase 5 USDA grounding for log_food. Was documented + env-gated but never
  // constructed anywhere, so USDA_API_KEY had no effect (2026-06-11
  // verification finding). Only built when the key is set — without it,
  // behavior is byte-identical to before (LLM-only macro estimates).
  const usda = env.USDA_API_KEY
    ? new (await import('./services/usda-food.service.js')).UsdaFoodService(pool, logger, env.USDA_API_KEY)
    : undefined;
  if (usda) logger.info('usda_food_service.enabled');

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
    historyTurns: env.CONVERSATION_HISTORY_TURNS,
    geminiApiKey: env.GEMINI_API_KEY,
    geminiModel: env.GEMINI_MODEL,
    geminiFallbackModel: env.GEMINI_FALLBACK_MODEL,
    twilioSid: env.TWILIO_ACCOUNT_SID,
    twilioToken: env.TWILIO_AUTH_TOKEN,
    turnQueue,
    factExtractQueue,
    memoryMd,
    memoryMdQueue,
    systemPrompt: await loadActivePrompt(),
    contentRulesService,
    userMemory,
    faqCache,
    redis,
    productionIssues,
    ...(usda ? { usda } : {}),
    // 2026-06-04 TRUST GEMINI flags — bypass LLM-as-judge guards.
    guards: {
      trustGemini: env.TRUST_GEMINI,
      behavioralEnabled: env.BEHAVIORAL_GUARD_ENABLED,
      relevanceEnabled: env.RELEVANCE_CHECK_ENABLED,
      qualityStrict: env.QUALITY_GUARD_STRICT,
      geminiFirst: env.GEMINI_FIRST,
      directReplyMode: env.DIRECT_REPLY_MODE,
    },
  });
  logger.info(
    { geminiFirst: env.GEMINI_FIRST, directReplyMode: env.DIRECT_REPLY_MODE },
    env.DIRECT_REPLY_MODE
      ? 'startup.direct_reply_mode — single Gemini call per reply (no orchestrator/guard cascade)'
      : env.GEMINI_FIRST
        ? 'startup.gemini_first_mode — all normal responses generated by Gemini (latency shortcuts demoted)'
        : 'startup.gemini_first_off — deterministic latency shortcuts active',
  );
  if (env.TRUST_GEMINI) {
    logger.info(
      { trustGemini: true, behavioral: false, relevance: false, qualityStrict: false },
      'startup.trust_gemini_mode',
    );
  } else if (!env.BEHAVIORAL_GUARD_ENABLED || !env.RELEVANCE_CHECK_ENABLED || !env.QUALITY_GUARD_STRICT) {
    logger.info(
      {
        behavioral: env.BEHAVIORAL_GUARD_ENABLED,
        relevance: env.RELEVANCE_CHECK_ENABLED,
        qualityStrict: env.QUALITY_GUARD_STRICT,
      },
      'startup.guards_partially_disabled',
    );
  }

  const twilioSender = new TwilioSender(
    {
      accountSid: env.TWILIO_ACCOUNT_SID,
      authToken: env.TWILIO_AUTH_TOKEN,
      ...(env.TWILIO_FROM_NUMBER ? { fromSms: env.TWILIO_FROM_NUMBER } : {}),
      ...(env.TWILIO_WHATSAPP_FROM ? { fromWhatsapp: env.TWILIO_WHATSAPP_FROM } : {}),
      canonicalWebUrl: env.PUBLIC_WEB_URL,
    },
    logger,
  );

  // iMessage is OFF until the relay credentials are present. LoopMessage needs
  // auth key + secret + sender name; Sendblue needs only key-id + secret (it
  // sends from a provisioned line, no sender name). When set, build the matching
  // sender and route by channel; WhatsApp/SMS are unaffected.
  const imessageConfigured =
    env.IMESSAGE_PROVIDER === 'sendblue'
      ? !!(env.IMESSAGE_AUTH_KEY && env.IMESSAGE_SECRET_KEY)
      : !!(env.IMESSAGE_AUTH_KEY && env.IMESSAGE_SECRET_KEY && env.IMESSAGE_SENDER_NAME);
  let imessageSender: ImessageSender | SendblueSender | undefined;
  if (imessageConfigured) {
    imessageSender =
      env.IMESSAGE_PROVIDER === 'sendblue'
        ? new SendblueSender(
            {
              ...(env.IMESSAGE_API_URL ? { apiUrl: env.IMESSAGE_API_URL } : {}),
              apiKeyId: env.IMESSAGE_AUTH_KEY!,
              apiSecret: env.IMESSAGE_SECRET_KEY!,
              canonicalWebUrl: env.PUBLIC_WEB_URL,
            },
            logger,
          )
        : new ImessageSender(
            {
              ...(env.IMESSAGE_API_URL ? { apiUrl: env.IMESSAGE_API_URL } : {}),
              authKey: env.IMESSAGE_AUTH_KEY!,
              secretKey: env.IMESSAGE_SECRET_KEY!,
              senderName: env.IMESSAGE_SENDER_NAME!,
              canonicalWebUrl: env.PUBLIC_WEB_URL,
            },
            logger,
          );
    logger.info({ provider: env.IMESSAGE_PROVIDER }, 'imessage.channel.enabled');
  }

  // Every outbound goes through the router; it dispatches by msg.channel.
  const sender = new ChannelRouter({ twilio: twilioSender, imessage: imessageSender }, logger);

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

      const msg = buildOptimizerReport(report, env.PUBLIC_WEB_URL) + coverageSnippet;
      await sender.send({ to: adminPhone, body: msg, channel: 'whatsapp', raw: true });
      logger.info({ adminPhone, version: report.version, hasCoverage: coverageSnippet.length > 0 }, 'prompt_optimizer.report_sent');
    },
  });

  // Seed optimizer with any available auto-eval preference pairs
  const synthetic = await loadSyntheticFeedback();
  if (synthetic.length > 0) {
    promptOptimizer.injectSyntheticFeedback(synthetic);
  }
  // Phase 17 weekly research scrape. Pulls top-of-week from default
  // subreddits → ingest → classify → replay + grade → LLM-eval failures.
  // Best-effort; each stage wrapped in try/catch. Sends admin WhatsApp
  // summary when ADMIN_PHONE is set.
  const researchScrape = async (): Promise<void> => {
    try {
      const { scrapeMultiple, DEFAULT_SUBREDDITS } = await import('./research/reddit-scraper.js');
      const { CorpusService, scrapedPostToIngestInput } = await import('./research/corpus.service.js');

      logger.info('research.weekly.start');
      const scraped = await scrapeMultiple([...DEFAULT_SUBREDDITS], { limit: 50, sort: 'top', time: 'week' });
      const posts = scraped.flatMap((s) => s.posts);
      const corpus = new CorpusService({ pool, llm, logger });
      const ingest = await corpus.ingestPosts(posts.map(scrapedPostToIngestInput));
      const rowIds = ingest.insertedIds.length > 0 ? ingest.insertedIds : undefined;
      const classified = await corpus.classifyAndCheckCoverage(rowIds);
      const replayed = await corpus.replayAndGrade(rowIds, { concurrency: 3 });
      const evaluated = await corpus.evaluateFailures(rowIds);
      const gaps = await corpus.coverageGaps();
      const uncoveredCount = Object.values(gaps.by_intent).reduce(
        (s, b) => s + b.uncovered, 0,
      );
      const weakest = gaps.weakest_dims[0];
      logger.info(
        { inserted: ingest.insertedIds.length, deduped: ingest.deduped, classified: classified.classified, replayed: replayed.replayed, evaluated: evaluated.evaluated },
        'research.weekly.done',
      );

      // Send admin WhatsApp summary
      if (env.ADMIN_PHONE) {
        const summary = [
          '🔬 Research scrape — weekly',
          ``,
          `📥 Scraped: ${posts.length} posts from ${DEFAULT_SUBREDDITS.length} subs`,
          `✨ New rows: ${ingest.insertedIds.length} (${ingest.deduped} dedup hits)`,
          `🔎 Classified: ${classified.classified} | Uncovered intents: ${uncoveredCount}`,
          `🤖 Sandbox replays: ${replayed.replayed} | LLM-evaluated failures: ${evaluated.evaluated}`,
          weakest ? `📉 Weakest dim: ${weakest.dim} (avg ${weakest.avg}/5 over ${weakest.count} evals)` : '',
          ``,
          `Review at ${env.PUBLIC_WEB_URL.replace(/\/$/, '')}/admin/research`,
        ].filter(Boolean).join('\n');
        await sender.send({ to: env.ADMIN_PHONE, body: summary, channel: 'whatsapp', raw: true });
      }
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : String(err) }, 'research.weekly.failed');
    }
  };

  // Phase 18: research auto-fix — re-replay corpus failures, generate content
  // rules, inject synthetic feedback into the prompt optimizer. Runs every 3
  // days and on startup if overdue. Best-effort; any failure is logged only.
  const { ResearchAutoFix } = await import('./research/auto-fix.js');
  const autoFix = new ResearchAutoFix({ pool, llm, logger, redis, promptOptimizer });

  const researchAutoFix = async (): Promise<void> => {
    // Distributed lock — Fly runs ≥ 2 machines and node-cron fires on every
    // one. Without this, both machines run the pipeline simultaneously and
    // each kicks the prompt optimizer in the background → the second optimizer
    // run hits the 15-min rate limit → admin sees a spurious "rate-limited"
    // WhatsApp report alongside the real run.  SET NX EX guarantees only one
    // machine actually runs per tick.  TTL is set well beyond a typical run
    // (auto-fix completes in 1–3 min) so a crash can't deadlock the next day.
    const lockKey = 'research:autofix:cron_lock';
    const lockTtlSec = 20 * 60;
    const acquired = await redis
      .set(lockKey, Date.now().toString(), 'EX', lockTtlSec, 'NX')
      .catch(() => null);
    if (acquired !== 'OK') {
      logger.info('research.auto_fix.cron.skipped_lock_held_by_other_machine');
      return;
    }
    try {
      logger.info('research.auto_fix.cron.start');
      const report = await autoFix.run({ sampleSize: 60 });
      logger.info(report, 'research.auto_fix.cron.done');
      if (env.ADMIN_PHONE) {
        // Surface the per-pattern action so admins can tell at a glance
        // whether each detected pattern produced a new content rule, hit a
        // duplicate, or routed to the prompt-fix path. Without this, the
        // report always read "Content rules added: 0" without explaining why.
        const formatPattern = (p: { pattern: string; count: number; action: string }) => {
          const tag = p.action === 'content_rule' ? ''
            : p.action === 'logged' ? ''
            : `, ${p.action}`;
          return `${p.pattern} (${p.count}×${tag})`;
        };
        const lines = [
          '🔧 Grace auto-fix run',
          ``,
          `📋 Posts analyzed: ${report.postsAnalyzed}`,
          `✅ Already fixed: ${report.alreadyFixed} | ⚠️ Still failing: ${report.stillFailing}`,
          `📏 Content rules added: ${report.contentRulesGenerated}`,
          `🧠 Synthetic feedback injected: ${report.syntheticFeedbackInjected}`,
          report.topPatterns.length > 0
            ? `🔍 Top patterns: ${report.topPatterns.slice(0, 3).map(formatPattern).join(', ')}`
            : '',
          report.weakestDimensions.length > 0
            ? `📉 Weakest dim: ${report.weakestDimensions[0]?.dim} (avg ${report.weakestDimensions[0]?.avgScore}/5)`
            : '',
          ``,
          `Review at ${env.PUBLIC_WEB_URL.replace(/\/$/, '')}/admin/research`,
        ].filter(Boolean).join('\n');
        await sender.send({ to: env.ADMIN_PHONE, body: lines, channel: 'whatsapp', raw: true });
      }
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : String(err) }, 'research.auto_fix.cron.failed');
    } finally {
      // Release the lock so the next day's cron isn't blocked if the TTL
      // outlives the run.
      await redis.del(lockKey).catch(() => undefined);
    }
  };

  // Run auto-fix on startup if it hasn't run recently (starts tonight if overdue).
  // 45s delay — short enough that Fly's idle auto-stop (5 min) almost certainly
  // doesn't interrupt, long enough that the prompt optimizer's own 30s catch-up
  // finishes first so we share the warm Gemini connection.
  logger.info({ wiredAt: new Date().toISOString() }, 'research.auto_fix.wired');
  setTimeout(() => {
    logger.info('research.auto_fix.startup_timer_fired');
    void autoFix.runIfMissedRecently().catch((err) =>
      logger.error({ err: err instanceof Error ? err.message : String(err) }, 'research.auto_fix.startup_check_failed'),
    );
  }, 45_000);

  const scheduler = new Scheduler({
    users,
    sender,
    generator,
    logger,
    redis,
    memory,
    promptOptimizer,
    researchScrape,
    researchAutoFix,
    engagementCooldownHours: env.ENGAGEMENT_COOLDOWN_HOURS,
    optimizersEnabled: env.OPTIMIZERS_ENABLED,
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

  startWorkers({ redis, pool, memory, llm, logger, memoryMd });

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
  registerSettingsRoutes(app, { redis, sender, users, whatsappEnabled: !!env.TWILIO_WHATSAPP_FROM });
  registerChatRoutes(app, ai, pool);
  registerAdminRoutes(app, {
    pool, cache, llm, promptOptimizer, reloadActivePrompt, redis,
    templates: messageTemplatesService, faqCache, users, memoryMd,
    sender, memory,
    stripeBasePriceId: env.STRIPE_BASE_PRICE_ID,
    stripeProPriceId: env.STRIPE_PRO_PRICE_ID,
    ...(env.ADMIN_TOKEN ? { adminToken: env.ADMIN_TOKEN } : {}),
  });

  // v2 Stripe webhook — only when a signing secret is configured. Keeps the
  // v1 Supabase edge function as the handler until the user cuts Stripe over
  // to this endpoint (both are idempotent on stripe_event_id / is_paid).
  if (env.STRIPE_WEBHOOK_SECRET) {
    registerStripeWebhookRoutes(app, {
      pool,
      logger,
      webhookSecret: env.STRIPE_WEBHOOK_SECRET,
      proPriceId: env.STRIPE_PRO_PRICE_ID,
    });
  }

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

function buildOptimizerReport(r: OptimizerRunReport, webUrl: string): string {
  const { status, stats, version, analysis, draftReason } = r;
  const pct = stats.satisfactionPct !== null ? `${stats.satisfactionPct}% positive` : 'no ratings';
  const statsLine = `${stats.totalMessages} msgs · ${stats.positiveCount}👍 ${stats.negativeCount}👎 · ${pct} · ${stats.fallbackCount} fallbacks`;
  const promptsUrl = `${webUrl.replace(/\/$/, '')}/admin/prompts`;

  switch (status) {
    case 'activated':
      return [
        `🤖 Grace RLHF Report — v${version} activated`,
        ``,
        `📊 Last 14 days: ${statsLine}`,
        ``,
        `What changed: ${analysis}`,
        ``,
        `Review at ${promptsUrl}`,
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
        `Action needed: review and manually activate at ${promptsUrl}`,
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

    case 'skipped_rate_limit':
      return [
        `🤖 Grace RLHF Report — rate-limited`,
        ``,
        `Another optimizer run produced v${version} less than 15 min ago. ${analysis}`,
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
