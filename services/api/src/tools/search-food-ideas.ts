import { createHash } from 'node:crypto';
import type { Logger } from 'pino';
import type { Redis } from 'ioredis';
import type { Tool } from '@grace/ai-core';
import type { LLMProvider, DietaryRestriction } from '@grace/shared';
import { getCuratedFoodIdeas } from './curated-meal-ideas.js';

export interface FoodIdea {
  name: string;
  protein_g: number | null;
  why: string;
}

export interface SearchFoodIdeasDeps {
  llm: LLMProvider;
  logger: Logger;
  userId: string;
  /** Optional Redis client used to cache results by dietary profile + meal
   *  type. Cache hits skip the ~2–4 s Google-Search grounding call entirely. */
  redis?: Redis;
  /** User's dietary restriction (vegan / vegetarian / etc.) — part of the
   *  cache key so a vegan and a meat-eater don't share suggestions. */
  dietaryRestriction?: DietaryRestriction | null;
  /** Sorted-joined food dislikes — part of the cache key. */
  foodDislikes?: string[];
}

/** Meal-type bucket pulled out of the query so "what should I eat for lunch?"
 *  and "any lunch ideas?" share a cache entry. */
function extractMealType(query: string): string {
  const lower = query.toLowerCase();
  if (/\b(breakfast|morning meal|first meal)\b/.test(lower)) return 'breakfast';
  if (/\b(lunch|midday meal)\b/.test(lower)) return 'lunch';
  if (/\b(dinner|supper|evening meal)\b/.test(lower)) return 'dinner';
  if (/\b(snack|snacks|nibble)\b/.test(lower)) return 'snack';
  if (/\b(dessert|sweet)\b/.test(lower)) return 'dessert';
  return 'general';
}

/** 6-hour bucket so suggestions feel time-relevant without churning the cache
 *  every minute. Buckets: 0=overnight, 1=morning, 2=midday, 3=evening. */
function hourBucket(now = new Date()): number {
  return Math.floor(now.getHours() / 6);
}

function buildCacheKey(
  query: string,
  dietaryRestriction: DietaryRestriction | null | undefined,
  foodDislikes: string[] | undefined,
): string {
  const dietLabel = dietaryRestriction?.label?.toLowerCase() ?? 'none';
  const dislikes = [...(foodDislikes ?? [])].map((d) => d.toLowerCase()).sort().join(',');
  const meal = extractMealType(query);
  const bucket = hourBucket();
  const raw = `${dietLabel}|${dislikes}|${meal}|${bucket}`;
  const hash = createHash('sha256').update(raw).digest('hex').slice(0, 32);
  return `tool:search_food_ideas:${hash}`;
}

// 30-minute TTL — enough to absorb several "what should I eat" turns from
// the same user within a session, short enough that suggestions stay fresh
// across the day.
const CACHE_TTL_SECONDS = 30 * 60;

export function makeSearchFoodIdeasTool(deps: SearchFoodIdeasDeps): Tool {
  return {
    name: 'search_food_ideas',
    description:
      'Search the web for specific, current meal or snack ideas. Use when the user asks what to eat, requests food recommendations, snack ideas, or dinner/lunch/breakfast options. Always pass their dietary restriction (vegetarian, vegan, etc.) and any food dislikes in the query so results are safe to suggest.',
    async execute(args) {
      const query = typeof args['query'] === 'string' ? args['query'].trim() : '';
      if (!query) return { ok: false, error: 'empty_query' };

      // Curated bank — fastest path. Returns 4 hand-picked GLP-1 ideas in
      // ~5–15 ms for the most common (diet × meal-type) combinations.
      // Skips Redis lookup, skips Gemini, skips Google Search. Falls
      // through to the cache+LLM path when the meal type or post-dislike
      // filter isn't covered.
      const mealType = extractMealType(query);
      const curated = getCuratedFoodIdeas({
        userId: deps.userId,
        query,
        mealType,
        dietaryRestriction: deps.dietaryRestriction ?? null,
        foodDislikes: deps.foodDislikes ?? [],
      });
      if (curated && curated.length >= 3) {
        deps.logger.info(
          { userId: deps.userId, query, count: curated.length, mealType },
          'tool.search_food_ideas.curated_hit',
        );
        return { ok: true, ideas: curated };
      }

      const cacheKey = deps.redis
        ? buildCacheKey(query, deps.dietaryRestriction ?? null, deps.foodDislikes)
        : null;

      // Cache hit → return immediately, skip the Google-Search grounding call.
      if (deps.redis && cacheKey) {
        try {
          const cached = await deps.redis.get(cacheKey);
          if (cached) {
            const parsed = JSON.parse(cached) as FoodIdea[];
            if (Array.isArray(parsed) && parsed.length > 0) {
              deps.logger.info(
                { userId: deps.userId, query, count: parsed.length },
                'tool.search_food_ideas.cache_hit',
              );
              return { ok: true, ideas: parsed };
            }
          }
        } catch (err) {
          // Cache read failure is non-fatal — fall through to the live call.
          deps.logger.warn(
            { err: err instanceof Error ? err.message : String(err), userId: deps.userId },
            'tool.search_food_ideas.cache_read_failed',
          );
        }
      }

      try {
        const resp = await deps.llm.generate({
          messages: [
            {
              role: 'system',
              content: `You are a nutrition assistant for someone on GLP-1 medication (semaglutide or tirzepatide). Use Google Search to find specific, practical, varied meal and snack ideas.

RULES:
- Return ONLY a JSON array — no prose, no markdown outside the array
- Each item: {"name": "...", "protein_g": <number or null>, "why": "<one short reason it works on GLP-1>"}
- 4–6 items maximum
- Suggestions must be SPECIFIC (e.g. "Greek yogurt with hemp seeds" not "high-protein snack")
- Favour small, protein-dense options — GLP-1 slows digestion so smaller portions sit better
- Strictly respect any dietary restriction in the query — never include forbidden ingredients
- Vary categories: not 5 shakes, not 5 salads — mix snacks, meals, quick prep options
- Include approximate protein only when reasonably certain; use null otherwise`,
            },
            {
              role: 'user',
              content: `Find 4–6 specific high-protein meal or snack ideas for: ${query}`,
            },
          ],
          temperature: 0.4,
          maxOutputTokens: 600,
          useGoogleSearch: true,
          responseFormat: 'json',
        });

        let cleaned = resp.text
          .trim()
          .replace(/^```(?:json)?\s*/i, '')
          .replace(/```\s*$/i, '')
          .trim();

        const arrStart = cleaned.indexOf('[');
        const arrEnd = cleaned.lastIndexOf(']');
        if (arrStart !== -1 && arrEnd > arrStart) {
          cleaned = cleaned.slice(arrStart, arrEnd + 1);
        }

        let ideas: FoodIdea[];
        try {
          ideas = JSON.parse(cleaned) as FoodIdea[];
          if (!Array.isArray(ideas) || ideas.length === 0) throw new Error('empty array');
        } catch {
          deps.logger.warn(
            { userId: deps.userId, query, raw: resp.text.slice(0, 300) },
            'tool.search_food_ideas.parse_failed',
          );
          return { ok: false, error: 'parse_failed' };
        }

        // Write-through cache. Best-effort — a Redis hiccup never blocks the
        // user-facing response.
        if (deps.redis && cacheKey) {
          deps.redis
            .set(cacheKey, JSON.stringify(ideas), 'EX', CACHE_TTL_SECONDS)
            .catch((err: Error) => {
              deps.logger.warn(
                { err: err.message, userId: deps.userId },
                'tool.search_food_ideas.cache_write_failed',
              );
            });
        }

        deps.logger.info({ userId: deps.userId, query, count: ideas.length }, 'tool.search_food_ideas.ok');
        return { ok: true, ideas };
      } catch (err) {
        deps.logger.warn({ err, userId: deps.userId, query }, 'tool.search_food_ideas.error');
        return { ok: false, error: 'search_failed' };
      }
    },
  };
}

// Test exports — internal helpers exposed for unit tests without widening
// the runtime surface.
export const __testing = { buildCacheKey, extractMealType, hourBucket };
