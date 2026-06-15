/**
 * Today's food summary — Redis-backed cache (Phase A2, 2026-06-07).
 *
 * The production latency audit found `getTodaysFoodSummary` was the single
 * heaviest read in `parallel_io` (~100-150ms × every turn). It runs a CTE
 * with a timezone subquery + ordered scan of `food_logs`. The in-memory
 * 10-second cache catches repeats within a single user's burst, but a
 * "what's my protein today?" question after a 30-second pause still pays
 * the full CTE cost.
 *
 * This module adds a Redis L2 cache between the existing 10s in-memory
 * cache and the Postgres CTE:
 *
 *   L1 (in-memory, 10s TTL)
 *     ↓ miss
 *   L2 (Redis, ~24h TTL)
 *     ↓ miss
 *   L3 (Postgres CTE)
 *
 * Key strategy: `food:today:{phone}:{loggingDayDate}` where loggingDayDate is
 * the user's personal logging-day date (wake_time to next wake_time, in their
 * timezone — see nutrition/logging-window.ts). Each logging day gets a fresh
 * key at wake_time — no cleanup job needed because stale keys age out via TTL.
 * MUST match the SQL window or the L2 cache would serve a different day.
 *
 * Write-through pattern: log_food / food-log-fast invalidate L2 on every
 * INSERT, same as the existing L1 invalidation. The next read recomputes
 * from DB and refills both caches.
 *
 * Fallback: any Redis error → fall through to L3 (DB). No behavior change
 * on cache miss; this is a pure latency optimization.
 */

import type { Redis } from 'ioredis';
import { computeUserLoggingDay } from '../nutrition/logging-window.js';

const KEY_PREFIX = 'food:today:';
/** TTL covers the maximum possible "today" window across timezones.
 *  36 hours is generous and lets natural day transitions drop stale keys. */
const TTL_SECONDS = 36 * 60 * 60;

export interface TodayFoodValue {
  protein_g: number;
  calories: number;
  items: string[];
  items_detailed: Array<{
    food: string;
    protein_g: number;
    calories: number;
    logged_at: string;
  }>;
}

interface MinimalLogger {
  info: (obj: object, msg?: string) => void;
  warn: (obj: object, msg?: string) => void;
  error: (obj: object, msg?: string) => void;
}

function buildKey(phone: string, loggingDayDate: string): string {
  return `${KEY_PREFIX}${phone}:${loggingDayDate}`;
}

export class TodayFoodCacheService {
  constructor(
    private readonly redis: Redis | undefined,
    private readonly logger: MinimalLogger,
  ) {}

  /**
   * Returns the cached summary if present, null otherwise. Never throws —
   * Redis errors fall through to a null result so the caller falls back
   * to the source-of-truth DB query.
   */
  async get(phone: string, timezone: string, wakeTime?: string | null): Promise<TodayFoodValue | null> {
    if (!this.redis) return null;
    const key = buildKey(phone, computeUserLoggingDay(timezone, wakeTime));
    try {
      const raw = await this.redis.get(key);
      if (!raw) return null;
      return JSON.parse(raw) as TodayFoodValue;
    } catch (err) {
      this.logger.warn(
        { err: err instanceof Error ? err.message : String(err), phone },
        'today_food_cache.get_failed',
      );
      return null;
    }
  }

  /**
   * Write-through after a DB recompute. Best-effort — Redis hiccup never
   * blocks the caller because the in-memory L1 cache already covers the
   * immediate next read.
   */
  async set(phone: string, timezone: string, value: TodayFoodValue, wakeTime?: string | null): Promise<void> {
    if (!this.redis) return;
    const key = buildKey(phone, computeUserLoggingDay(timezone, wakeTime));
    try {
      await this.redis.set(key, JSON.stringify(value), 'EX', TTL_SECONDS);
    } catch (err) {
      this.logger.warn(
        { err: err instanceof Error ? err.message : String(err), phone },
        'today_food_cache.set_failed',
      );
    }
  }

  /**
   * Drop the cached value — call after every food log INSERT so the next
   * read recomputes. The L1 in-memory cache invalidation happens
   * separately via `UserService.invalidateTodaysFoodCache()`.
   *
   * Invalidates BOTH today's and yesterday's keys defensively (covers a log
   * landing right at the midnight boundary or minor clock skew between
   * machines).
   */
  async invalidate(phone: string, timezone: string, wakeTime?: string | null): Promise<void> {
    if (!this.redis) return;
    const now = new Date();
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const keys = [
      buildKey(phone, computeUserLoggingDay(timezone, wakeTime, now)),
      buildKey(phone, computeUserLoggingDay(timezone, wakeTime, yesterday)),
    ];
    try {
      await this.redis.del(...keys);
    } catch (err) {
      this.logger.warn(
        { err: err instanceof Error ? err.message : String(err), phone },
        'today_food_cache.invalidate_failed',
      );
    }
  }
}

// Test-only exports
export const __testing = {
  KEY_PREFIX,
  TTL_SECONDS,
  buildKey,
};
