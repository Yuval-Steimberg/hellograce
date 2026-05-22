import { createHash } from 'crypto';
import { GoogleAICacheManager } from '@google/generative-ai/server';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';

// Gemini cached content lives for 60 min; we refresh 5 min early to avoid races.
const GEMINI_TTL_SEC = 3600;
const REDIS_TTL_SEC = 3300;
const REDIS_PREFIX = 'llmgw:cache:';

export class ContextCacheManager {
  private manager: GoogleAICacheManager;

  constructor(
    apiKey: string,
    private readonly redis: Redis,
    private readonly logger: Logger,
  ) {
    this.manager = new GoogleAICacheManager(apiKey);
  }

  /**
   * Returns the name of an active Gemini cachedContent for the given system
   * instruction + model, creating one if none exists. Returns null when the
   * model doesn't support context caching or on any API error.
   */
  async getOrCreate(
    systemInstruction: string,
    model: string,
  ): Promise<string | null> {
    const hash = createHash('sha256')
      .update(`${model}:${systemInstruction}`)
      .digest('hex')
      .slice(0, 16);
    const redisKey = `${REDIS_PREFIX}${hash}`;

    // Fast path: cached name already in Redis
    const existing = await this.redis.get(redisKey).catch(() => null);
    if (existing) {
      this.logger.debug({ hash }, 'context_cache.hit');
      return existing;
    }

    // Slow path: create a new Gemini cachedContent
    try {
      const cache = await this.manager.create({
        model: `models/${model}`,
        displayName: `grace-system-${hash}`,
        systemInstruction: {
          role: 'system',
          parts: [{ text: systemInstruction }],
        },
        ttlSeconds: GEMINI_TTL_SEC,
        // Gemini requires at least one content entry alongside the system instruction.
        // We add a minimal placeholder that's always present in the conversation.
        contents: [
          {
            role: 'user',
            parts: [{ text: '[session start]' }],
          },
        ],
      });

      await this.redis.set(redisKey, cache.name, 'EX', REDIS_TTL_SEC);
      this.logger.info({ model, hash, name: cache.name }, 'context_cache.created');
      return cache.name;
    } catch (err) {
      // Non-fatal: log and fall through to uncached generation.
      this.logger.warn({ err, model }, 'context_cache.create_failed — falling back to uncached');
      return null;
    }
  }

  async invalidate(systemInstruction: string, model: string): Promise<void> {
    const hash = createHash('sha256')
      .update(`${model}:${systemInstruction}`)
      .digest('hex')
      .slice(0, 16);
    await this.redis.del(`${REDIS_PREFIX}${hash}`).catch(() => null);
  }
}
