import type { Pool, PoolClient } from 'pg';
import { USER_DAY_CTE, isCurrentUserDay } from '../nutrition/logging-window.js';

export interface FoodLedgerEntry {
  id: string;
  food: string;
  protein_g: number;
  calories: number;
}

export interface FoodLedgerTotals {
  protein_g: number;
  calories: number;
}

export interface FoodLedgerCache {
  invalidateTodaysFoodCache(userId: string): Promise<void> | void;
}

async function totals(client: PoolClient, userId: string): Promise<FoodLedgerTotals> {
  const result = await client.query<{ protein_g: number; calories: number }>(
    `${USER_DAY_CTE}
     SELECT COALESCE(SUM(fl.protein_g), 0) AS protein_g,
            COALESCE(SUM(fl.calories), 0) AS calories
     FROM food_logs fl, user_tz
     WHERE fl.user_id = $1 AND ${isCurrentUserDay('fl.created_at')}`,
    [userId],
  );
  return {
    protein_g: Math.round(result.rows[0]?.protein_g ?? 0),
    calories: Math.round(result.rows[0]?.calories ?? 0),
  };
}

async function findLatest(client: PoolClient, userId: string, ref: string): Promise<FoodLedgerEntry | null> {
  const result = await client.query<FoodLedgerEntry>(
    `${USER_DAY_CTE}
     SELECT fl.id, fl.food, COALESCE(fl.protein_g, 0) AS protein_g,
            COALESCE(fl.calories, 0) AS calories
     FROM food_logs fl, user_tz
     WHERE fl.user_id = $1
       AND ${isCurrentUserDay('fl.created_at')}
       AND (lower(fl.food) LIKE '%' || lower($2) || '%'
            OR lower(COALESCE(fl.raw_text, '')) LIKE '%' || lower($2) || '%')
     ORDER BY fl.created_at DESC
     LIMIT 1
     FOR UPDATE`,
    [userId, ref],
  );
  return result.rows[0] ?? null;
}

/** All user-visible food mutations pass through this service so transaction and
 * cache rules cannot diverge between chat paths. */
export class FoodLedgerService {
  constructor(
    private readonly pool: Pool,
    private readonly cache?: FoodLedgerCache,
  ) {}

  async removeLatest(userId: string, ref: string): Promise<{
    removed: FoodLedgerEntry | null;
    totals: FoodLedgerTotals;
  }> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const entry = await findLatest(client, userId, ref);
      if (entry) await client.query('DELETE FROM food_logs WHERE id = $1', [entry.id]);
      const nextTotals = await totals(client, userId);
      await client.query('COMMIT');
      if (entry) await this.cache?.invalidateTodaysFoodCache(userId);
      return { removed: entry, totals: nextTotals };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async replaceLatest(userId: string, ref: string, replacement: {
    food: string;
    protein_g: number;
    calories: number;
    confidence?: string | null;
    raw_text?: string | null;
    serving_size?: string | null;
  }): Promise<{
    replaced: FoodLedgerEntry | null;
    updated: FoodLedgerEntry | null;
    totals: FoodLedgerTotals;
  }> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const previous = await findLatest(client, userId, ref);
      let updated: FoodLedgerEntry | null = null;
      if (previous) {
        const result = await client.query<FoodLedgerEntry>(
          `UPDATE food_logs
           SET food = $2, protein_g = $3, calories = $4, confidence = $5,
               raw_text = COALESCE($6, raw_text),
               serving_size = COALESCE($7, serving_size),
               dedupe_key = NULL
           WHERE id = $1
           RETURNING id, food, protein_g, calories`,
          [
            previous.id,
            replacement.food,
            replacement.protein_g,
            replacement.calories,
            replacement.confidence ?? 'high',
            replacement.raw_text ?? null,
            replacement.serving_size ?? null,
          ],
        );
        updated = result.rows[0] ?? null;
      }
      const nextTotals = await totals(client, userId);
      await client.query('COMMIT');
      if (updated) await this.cache?.invalidateTodaysFoodCache(userId);
      return { replaced: previous, updated, totals: nextTotals };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
}
