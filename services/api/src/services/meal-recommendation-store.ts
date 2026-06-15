/**
 * Active meal-recommendation memory (2026-06-15).
 *
 * Holds the meal a user is currently CONSIDERING (status "suggested") so a
 * later bare confirmation — "I ended up making it" / "had it" — can be logged
 * without the user having to repeat the meal name.
 *
 * Lifecycle (per the meal-lifecycle spec):
 *   - set on selection/exploration ("the lentil dal sounds good")
 *   - overwritten when a new meal is selected
 *   - cleared after the meal is logged
 *   - auto-expires after a few hours so a stale suggestion can't be logged
 *     against the wrong day/meal
 *
 * Redis-optional: every function no-ops (and never throws) when Redis is
 * absent, so the rest of the pipeline degrades gracefully.
 */

import type { Redis } from 'ioredis';

export interface ActiveMealRecommendation {
  /** The meal the user is considering, e.g. "halloumi and roasted vegetable plate". */
  meal: string;
  status: 'suggested';
  /** Epoch ms when it was stored. */
  ts: number;
}

/** How long a suggested-but-not-eaten meal stays resolvable. */
export const ACTIVE_MEAL_TTL_SECONDS = 5 * 60 * 60; // 5 hours

const keyFor = (phone: string): string => `meal:rec:${phone}`;

type MinimalLogger = { warn: (obj: unknown, msg?: string) => void };

export async function setActiveMeal(
  redis: Redis | undefined,
  phone: string,
  meal: string,
  logger?: MinimalLogger,
): Promise<void> {
  if (!redis) return;
  const clean = meal.trim();
  if (clean.length < 3) return;
  const payload: ActiveMealRecommendation = { meal: clean, status: 'suggested', ts: Date.now() };
  try {
    await redis.set(keyFor(phone), JSON.stringify(payload), 'EX', ACTIVE_MEAL_TTL_SECONDS);
  } catch (err) {
    logger?.warn({ err: err instanceof Error ? err.message : String(err), phone }, 'meal_rec_store.set_failed');
  }
}

export async function getActiveMeal(
  redis: Redis | undefined,
  phone: string,
  logger?: MinimalLogger,
): Promise<ActiveMealRecommendation | null> {
  if (!redis) return null;
  try {
    const raw = await redis.get(keyFor(phone));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ActiveMealRecommendation;
    if (!parsed || typeof parsed.meal !== 'string' || parsed.meal.trim().length < 3) return null;
    return parsed;
  } catch (err) {
    logger?.warn({ err: err instanceof Error ? err.message : String(err), phone }, 'meal_rec_store.get_failed');
    return null;
  }
}

export async function clearActiveMeal(
  redis: Redis | undefined,
  phone: string,
  logger?: MinimalLogger,
): Promise<void> {
  if (!redis) return;
  try {
    await redis.del(keyFor(phone));
  } catch (err) {
    logger?.warn({ err: err instanceof Error ? err.message : String(err), phone }, 'meal_rec_store.clear_failed');
  }
}
