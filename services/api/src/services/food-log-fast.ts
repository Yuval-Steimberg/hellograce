/**
 * Food-log fast-response: deterministic, instant reply for clear food logs
 * that the fast-lookup table can resolve without an LLM call.
 *
 * When the user says "I ate two eggs" / "Just had a protein shake", we already
 * know the macros from the COMMON_FOODS table in log-food.ts. Instead of paying
 * 2-4 seconds for the orchestrator (planner + LLM final response + guards),
 * we run the log_food tool directly and synthesize the response from a small
 * rotating template pool.
 *
 * Latency saving: ~2-4 seconds → ~150ms.
 * Accuracy preserved: macros come from the same USDA-anchored table the LLM
 * would use, AND the response format follows the prompt's prescribed pattern.
 *
 * Hard guards:
 *   - Only fires when classifier says 'food_log'
 *   - Only fires when lookupCommonFoodMacros returns a match (high-confidence)
 *   - Only fires when message is under 80 chars (longer = compound meal)
 *   - Never fires when media is present (image analysis goes through orchestrator)
 *   - Never fires when message contains question marks (user is asking, not logging)
 */

import { createHash } from 'crypto';
import type { Pool } from 'pg';
import type { Logger } from 'pino';
import { lookupCommonFoodMacros } from '../tools/log-food.js';

const TEMPLATES = [
  '{food} — about {protein}g protein. You\'re at {total}g/{goal}g today.',
  '{food}, roughly {protein}g protein. You\'re at {total}g of your {goal}g target.',
  'Logged — around {protein}g protein. Total today: {total}g/{goal}g.',
  'Got it. {food} is about {protein}g protein. You\'re at {total}g/{goal}g today.',
];

const TEMPLATES_NO_GOAL = [
  '{food} — about {protein}g protein. {total}g today so far.',
  'Logged {food} — roughly {protein}g protein. Running total: {total}g.',
  'Got it, around {protein}g protein. You\'re at {total}g.',
];

/** Maximum length of a candidate food-log message for the fast-path. */
const MAX_FOOD_LOG_LENGTH = 80;

export interface FoodLogFastResult {
  text: string;
  macros: { food: string; protein_g: number; calories: number };
  dailyProteinG: number;
  dailyCalories: number;
}

export interface FoodLogFastDeps {
  pool: Pool;
  logger: Logger;
  userId: string;
  intentType: string;
  proteinGoalGrams?: number | null;
  /** Optional — when present, invalidated after INSERT so the next
   *  getTodaysFoodSummary call reads fresh totals instead of a stale cache. */
  users?: { invalidateTodaysFoodCache: (userId: string) => void };
}

/**
 * Attempt to handle the message as a fast food log. Returns null when the
 * message doesn't qualify — caller falls through to the full orchestrator.
 */
export async function tryFoodLogFastResponse(
  text: string,
  deps: FoodLogFastDeps,
): Promise<FoodLogFastResult | null> {
  if (deps.intentType !== 'food_log') return null;
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_FOOD_LOG_LENGTH) return null;
  // Question marks indicate the user is asking, not logging
  if (trimmed.includes('?')) return null;
  // Negations exclude — "I didn't eat eggs" must NOT log
  if (/\b(didn'?t|did not|haven'?t|have not|won'?t|won not|never|skipped|skipping)\b/i.test(trimmed)) {
    return null;
  }

  const macros = lookupCommonFoodMacros(trimmed);
  if (!macros) return null;

  // Insert the food_log row directly using the same dedupe semantics as the
  // log_food tool. We DON'T pipe the message through an LLM, so the macros
  // come from the deterministic table.
  const minuteBucket = Math.floor(Date.now() / 60_000);
  const normalized = trimmed.toLowerCase().replace(/\s+/g, ' ');
  const dedupeKey = createHash('sha256')
    .update(`${deps.userId}|${normalized}|${minuteBucket}`)
    .digest('hex')
    .slice(0, 32);

  try {
    await deps.pool.query(
      `INSERT INTO food_logs (user_id, food, protein_g, calories, confidence, raw_text, source, dedupe_key)
       VALUES ($1, $2, $3, $4, $5, $6, 'text', $7)
       ON CONFLICT (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`,
      [deps.userId, macros.food, macros.protein_g, macros.calories, macros.confidence, trimmed, dedupeKey],
    );

    // Invalidate the cached daily food summary so the next handleMessage()
    // turn sees the just-inserted log instead of a stale 10s-old aggregate.
    deps.users?.invalidateTodaysFoodCache(deps.userId);

    // Read the live daily total post-insert so the response is accurate.
    const totalsResult = await deps.pool.query<{ total_protein_g: number; total_calories: number }>(
      `WITH user_tz AS (
         SELECT COALESCE(NULLIF(timezone, ''), 'UTC') AS tz
         FROM users WHERE phone = $1
       )
       SELECT COALESCE(SUM(fl.protein_g), 0) AS total_protein_g,
              COALESCE(SUM(fl.calories), 0) AS total_calories
         FROM food_logs fl, user_tz
        WHERE fl.user_id = $1
          AND (fl.created_at AT TIME ZONE user_tz.tz)::date
              = (now()        AT TIME ZONE user_tz.tz)::date`,
      [deps.userId],
    );
    const dailyProteinG = Math.round(totalsResult.rows[0]?.total_protein_g ?? 0);
    const dailyCalories = Math.round(totalsResult.rows[0]?.total_calories ?? 0);

    const goalG = deps.proteinGoalGrams && deps.proteinGoalGrams > 0 ? deps.proteinGoalGrams : null;
    const template = pickTemplate(deps.userId, goalG !== null);
    const text = renderTemplate(template, {
      food: macros.food,
      protein: macros.protein_g,
      total: dailyProteinG,
      goal: goalG ?? 0,
    });

    deps.logger.info(
      { userId: deps.userId, food: macros.food, protein: macros.protein_g, dailyProteinG },
      'ai.food_log_fast.hit',
    );

    return {
      text,
      macros: { food: macros.food, protein_g: macros.protein_g, calories: macros.calories },
      dailyProteinG,
      dailyCalories,
    };
  } catch (err) {
    deps.logger.warn(
      { err: err instanceof Error ? err.message : String(err), userId: deps.userId },
      'ai.food_log_fast.db_failed',
    );
    return null;
  }
}

function pickTemplate(seed: string, hasGoal: boolean): string {
  const pool = hasGoal ? TEMPLATES : TEMPLATES_NO_GOAL;
  // Daily-rotating seed so the same user gets variety across the day.
  const today = new Date().toISOString().slice(0, 10);
  const hashSeed = `${seed}|${today}|${new Date().getHours()}`;
  let hash = 0;
  for (let i = 0; i < hashSeed.length; i++) {
    hash = ((hash << 5) - hash) + hashSeed.charCodeAt(i);
    hash |= 0;
  }
  return pool[Math.abs(hash) % pool.length]!;
}

function renderTemplate(
  template: string,
  vars: { food: string; protein: number; total: number; goal: number },
): string {
  return template
    .replace('{food}', vars.food)
    .replace('{protein}', String(vars.protein))
    .replace('{total}', String(vars.total))
    .replace('{goal}', String(vars.goal));
}
