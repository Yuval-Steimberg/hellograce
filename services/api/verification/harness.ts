// Production-shaped wiring for execution-path verification. Mirrors
// services/api/src/server.ts (same services, same construction order, same
// webhook/chat routes) with exactly three substitutions, all behind the same
// interfaces production uses:
//   GeminiProvider  → StubLLM        (deterministic, latency-controllable)
//   GeminiEmbedder  → StubEmbedder   (deterministic 768-dim vectors)
//   TwilioSender    → CaptureSender  (records outbound instead of Twilio API)
// Postgres (with real migrations) and Redis are REAL local services, so the
// memory pipeline, coalescing, locks, queues, and workers all execute the
// exact production code.
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import formbody from '@fastify/formbody';
import pino from 'pino';
import { loadEnv, type Env } from '../src/config/env.js';
import { createPool } from '../src/db/pool.js';
import { getRedisClient } from '../src/cache/redis.js';
import { Cache } from '../src/cache/cache.js';
import { RagService } from '../src/rag/rag.service.js';
import { MemoryService } from '../src/memory/memory.service.js';
import { UserMemoryService } from '../src/memory/user-memory.service.js';
import { MemoryMdService } from '../src/memory/memory-md.service.js';
import { AIService } from '../src/services/ai.service.js';
import { UserService } from '../src/user/user.service.js';
import { ContentRulesService } from '../src/services/content-rules.service.js';
import { TodayFoodCacheService } from '../src/cache/today-food-cache.js';
import { MessageTemplatesService } from '../src/services/message-templates.service.js';
import { getTurnQueue, getFactExtractQueue, getMemoryMdQueue, closeQueues } from '../src/workers/queues.js';
import { startWorkers, stopWorkers } from '../src/workers/index.js';
import { registerWebhookRoutes } from '../src/routes/webhook.js';
import { registerChatRoutes } from '../src/routes/chat.js';
import type { TwilioSender } from '../src/twilio/sender.js';
import type { GeminiEmbedder } from '../src/rag/gemini-embedder.js';
import { StubLLM, type StubDelays } from './stub-llm.js';
import { StubEmbedder } from './stub-embedder.js';
import { CaptureSender } from './capture-sender.js';

const KNOWLEDGE: Array<{ topic: string; content: string }> = [
  { topic: 'protein', content: 'On GLP-1 medications, aim for 0.7-1.0g of protein per pound of goal body weight to preserve muscle while losing fat.' },
  { topic: 'hydration', content: 'GLP-1s reduce thirst cues. Aim for 64-80oz of water daily; add electrolytes if you feel lightheaded.' },
  { topic: 'nausea', content: 'Eat smaller, lower-fat meals on injection day. Ginger tea, plain crackers, and protein-first plates help reduce nausea.' },
  { topic: 'constipation', content: 'Increase soluble fiber slowly and pair with water. Magnesium citrate at night can help when needed.' },
  { topic: 'side_effects', content: 'Most side effects (nausea, fatigue, constipation) peak in the first 48h after a dose increase and fade within 2-3 days.' },
  { topic: 'injection', content: 'Rotate sites between abdomen and thigh. Refrigerated pens last longer; once in use, room temp is fine for 28-56 days depending on brand.' },
  { topic: 'plateau', content: 'Weight plateaus on GLP-1s are normal at the 8-12 week mark. Keep protein high and strength training consistent.' },
  { topic: 'alcohol', content: 'GLP-1s slow gastric emptying. Alcohol hits harder and longer. Hydrate aggressively and avoid drinking on injection day.' },
];

export interface Harness {
  app: FastifyInstance;
  env: Env;
  llm: StubLLM;
  sender: CaptureSender;
  users: UserService;
  pool: import('pg').Pool;
  redis: import('ioredis').Redis;
  /** POST a Twilio-shaped webhook for `phone` and wait for Grace's reply. */
  sendWhatsApp(phone: string, text: string, opts?: { timeoutMs?: number; noWait?: boolean }): Promise<{ body: string; latencyMs: number } | null>;
  /** Synchronous demo-channel turn (same AI pipeline, no webhook layer). */
  chatSend(phone: string, text: string): Promise<{ reply: string; intent: string; latencyMs: number; toolResults: Array<{ name: string; ok: boolean; output?: unknown }> }>;
  createUser(phone: string, fields?: Record<string, unknown>): Promise<void>;
  wipeUser(phone: string): Promise<void>;
  shutdown(): Promise<void>;
}

let msgSeq = 0;

export async function buildHarness(opts: { delays?: StubDelays } = {}): Promise<Harness> {
  const env = loadEnv({
    ...process.env, // let HARNESS runs toggle feature flags (SMS_ONBOARDING_ENABLED, etc.)
    NODE_ENV: 'development',
    LOG_LEVEL: process.env.HARNESS_LOG_LEVEL ?? 'warn',
    PUBLIC_BASE_URL: 'http://localhost:3001',
    DATABASE_URL: process.env.HARNESS_DATABASE_URL ?? 'postgresql://postgres@localhost:5433/grace',
    REDIS_URL: process.env.HARNESS_REDIS_URL ?? 'redis://localhost:6390',
    GEMINI_API_KEY: 'stub-key',
    TWILIO_ACCOUNT_SID: 'ACstub',
    TWILIO_AUTH_TOKEN: 'stub-token',
    TWILIO_WHATSAPP_FROM: 'whatsapp:+10000000000',
  } as NodeJS.ProcessEnv);

  const logger = pino({ level: env.LOG_LEVEL });
  const pool = createPool(env);
  const redis = getRedisClient(env.REDIS_URL);
  const cache = new Cache(redis);
  void cache;

  const llm = new StubLLM(opts.delays ?? {});
  const embedder = new StubEmbedder();
  const memory = new MemoryService(pool);
  const rag = new RagService(pool, embedder, logger);
  const turnQueue = getTurnQueue(redis);
  const factExtractQueue = getFactExtractQueue(redis);
  const memoryMd = new MemoryMdService(pool, logger);
  const memoryMdQueue = getMemoryMdQueue(redis);

  const users = new UserService(pool);
  users.setTodayFoodCache(new TodayFoodCacheService(redis, logger));

  const contentRulesService = new ContentRulesService(pool, logger);
  contentRulesService.start();
  const templates = new MessageTemplatesService(pool, logger);
  const userMemory = new UserMemoryService(pool, embedder as unknown as GeminiEmbedder, llm, logger);

  // Seed the knowledge base with stub-embedded vectors (idempotent).
  const { rows: kbRows } = await pool.query<{ n: string }>(`SELECT COUNT(*) AS n FROM embeddings WHERE source = 'knowledge'`);
  if (Number(kbRows[0]!.n) === 0) {
    for (const k of KNOWLEDGE) {
      const vec = await embedder.embed(k.content);
      await pool.query(
        `INSERT INTO embeddings (user_id, source, content, embedding, metadata) VALUES (NULL, 'knowledge', $1, $2::vector, $3)`,
        [k.content, `[${vec.join(',')}]`, { topic: k.topic }],
      );
    }
  }

  const ai = new AIService({
    pool,
    llm,
    memory,
    rag,
    users,
    logger,
    flags: { ragEnabled: true, toolsEnabled: true },
    geminiApiKey: env.GEMINI_API_KEY,
    geminiModel: env.GEMINI_MODEL,
    turnQueue,
    factExtractQueue,
    memoryMd,
    memoryMdQueue,
    contentRulesService,
    userMemory,
    redis,
    guards: {
      trustGemini: env.TRUST_GEMINI,
      behavioralEnabled: env.BEHAVIORAL_GUARD_ENABLED,
      relevanceEnabled: env.RELEVANCE_CHECK_ENABLED,
      qualityStrict: env.QUALITY_GUARD_STRICT,
      // Match production (server.ts) so the harness exercises the same paths.
      directReplyMode: env.DIRECT_REPLY_MODE,
      progressiveProfile: env.PROGRESSIVE_PROFILE_ENABLED,
    },
  });

  const sender = new CaptureSender(logger);

  startWorkers({ redis, pool, memory, llm, logger, memoryMd });

  const app = Fastify({ loggerInstance: logger as never }) as unknown as FastifyInstance;
  await app.register(formbody);
  registerWebhookRoutes(app, { env, ai, sender: sender as unknown as TwilioSender, users, redis, templates });
  registerChatRoutes(app, ai, pool);
  await app.ready();

  const sendWhatsApp: Harness['sendWhatsApp'] = async (phone, text, o = {}) => {
    const since = Date.now();
    const fromIndex = sender.sent.length;
    const res = await app.inject({
      method: 'POST',
      url: '/webhook/twilio',
      payload: new URLSearchParams({
        From: `whatsapp:${phone}`,
        To: 'whatsapp:+10000000000',
        Body: text,
        MessageSid: `SM-harness-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${++msgSeq}`,
        NumMedia: '0',
      }).toString(),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    if (res.statusCode !== 200) throw new Error(`webhook status ${res.statusCode}: ${res.body}`);
    if (o.noWait) return null;
    const reply = await sender.waitForReplyAfterIndex(phone, fromIndex, o.timeoutMs ?? 25_000);
    return reply ? { body: reply.body, latencyMs: reply.at - since } : null;
  };

  const chatSend: Harness['chatSend'] = async (phone, text) => {
    const res = await app.inject({
      method: 'POST',
      url: '/chat/send',
      payload: { userId: phone, text },
    });
    if (res.statusCode !== 200) throw new Error(`chat/send status ${res.statusCode}: ${res.body}`);
    return res.json();
  };

  const createUser: Harness['createUser'] = async (phone, fields = {}) => {
    await users.ensureUser(phone);
    const merged: Record<string, unknown> = {
      first_name: 'Test',
      medication: 'Ozempic',
      timezone: 'America/New_York',
      protein_goal_grams: 90,
      calorie_goal_kcal: 1600,
      current_weight: 210,
      goal_weight: 170,
      trial_start: new Date(),
      ...fields,
    };
    const cols = Object.keys(merged);
    const sets = cols.map((c, i) => `${c} = $${i + 2}`).join(', ');
    await pool.query(`UPDATE users SET ${sets} WHERE phone = $1`, [phone, ...cols.map((c) => merged[c])]);
  };

  const wipeUser: Harness['wipeUser'] = async (phone) => {
    for (const t of ['messages', 'food_logs', 'weight_logs', 'check_ins', 'feedback']) {
      await pool.query(`DELETE FROM ${t} WHERE user_id = $1`, [phone]).catch(() => null);
    }
    await pool.query(`DELETE FROM conversations WHERE user_id = $1`, [phone]).catch(() => null);
    await pool.query(`DELETE FROM embeddings WHERE user_id = $1`, [phone]).catch(() => null);
    await pool.query(`DELETE FROM user_memories WHERE user_id = $1`, [phone]).catch(() => null);
    await pool.query(`DELETE FROM user_profile_facts WHERE user_id = $1`, [phone]).catch(() => null);
    await pool.query(`DELETE FROM user_memory_md WHERE user_id = $1`, [phone]).catch(() => null);
    await pool.query(`DELETE FROM users WHERE phone = $1`, [phone]).catch(() => null);
    const keys = await redis.keys(`*${phone}*`);
    if (keys.length > 0) await redis.del(...keys);
  };

  const shutdown = async () => {
    contentRulesService.stop();
    await app.close();
    await stopWorkers();
    await closeQueues();
    redis.disconnect();
    await pool.end();
  };

  return { app, env, llm, sender, users, pool, redis, sendWhatsApp, chatSend, createUser, wipeUser, shutdown };
}
