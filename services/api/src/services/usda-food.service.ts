/**
 * USDA FoodData Central lookup with a Postgres-backed cache.
 *
 * Returns per-100g protein and calorie values for a food name. Used by the
 * `log_food` tool to replace LLM macro estimation with USDA values for common
 * foods. The LLM still handles decomposition (multi-item meals) and portion
 * weight estimation; USDA only supplies the per-100g constants.
 *
 * Cache strategy: lookups are normalized (lowercased, punctuation stripped)
 * and stored in `usda_food_cache` with a 30-day refresh window. Avoids
 * burning the 1000 requests/hour free-tier quota on repeated foods.
 *
 * Failure mode: every method returns null on error — the caller is expected
 * to fall back to the existing LLM-only path. Never throws.
 */

import type { Pool } from 'pg';
import type { Logger } from 'pino';

const API_BASE = 'https://api.nal.usda.gov/fdc/v1';
const REFRESH_DAYS = 30;
const HTTP_TIMEOUT_MS = 3000;
// Prefer cleanly-curated data types in priority order. Foundation > SR Legacy >
// Survey > Branded — Foundation is the closest to a clinical reference; Branded
// is full of vendor-submitted noise (one example: "Air" with 0g everything).
const PREFERRED_DATA_TYPES = ['Foundation', 'SR Legacy', 'Survey (FNDDS)', 'Branded'];

export interface UsdaLookup {
  /** Normalized lookup key actually used (lowercased, punctuation stripped). */
  normalized: string;
  display: string;
  proteinPer100g: number;
  caloriesPer100g: number;
  fdcId: number | null;
  dataType: string | null;
  /** True when the value was served from cache. */
  fromCache: boolean;
}

export class UsdaFoodService {
  private apiKey: string | null;
  constructor(
    private pool: Pool,
    private logger: Logger,
    apiKey?: string,
  ) {
    this.apiKey = apiKey && apiKey.length > 5 ? apiKey : null;
  }

  /** True if the API key is set. Callers should fall back to LLM-only when false. */
  enabled(): boolean {
    return this.apiKey !== null;
  }

  async lookup(foodName: string): Promise<UsdaLookup | null> {
    if (!this.apiKey) return null;
    const normalized = normalize(foodName);
    if (!normalized) return null;

    const cached = await this.fromCache(normalized);
    if (cached) return cached;

    const fresh = await this.fetchFromApi(foodName, normalized);
    if (!fresh) return null;

    await this.writeCache(fresh);
    return fresh;
  }

  private async fromCache(normalized: string): Promise<UsdaLookup | null> {
    try {
      const { rows } = await this.pool.query<{
        normalized_name: string;
        display_name: string;
        protein_per_100g: number;
        calories_per_100g: number;
        fdc_id: number | null;
        data_type: string | null;
        last_refreshed_at: Date;
      }>(
        `SELECT normalized_name, display_name, protein_per_100g, calories_per_100g, fdc_id, data_type, last_refreshed_at
           FROM usda_food_cache
          WHERE normalized_name = $1
            AND last_refreshed_at > now() - ($2 || ' days')::interval
          LIMIT 1`,
        [normalized, REFRESH_DAYS],
      );
      const row = rows[0];
      if (!row) return null;
      return {
        normalized: row.normalized_name,
        display: row.display_name,
        proteinPer100g: row.protein_per_100g,
        caloriesPer100g: row.calories_per_100g,
        fdcId: row.fdc_id,
        dataType: row.data_type,
        fromCache: true,
      };
    } catch (err) {
      this.logger.warn({ err, normalized }, 'usda.cache.read.failed');
      return null;
    }
  }

  private async fetchFromApi(originalName: string, normalized: string): Promise<UsdaLookup | null> {
    if (!this.apiKey) return null;
    const url = new URL(API_BASE + '/foods/search');
    url.searchParams.set('api_key', this.apiKey);
    url.searchParams.set('query', originalName);
    url.searchParams.set('pageSize', '10');
    url.searchParams.set('dataType', PREFERRED_DATA_TYPES.join(','));

    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS);
      const resp = await fetch(url.toString(), { signal: ctrl.signal });
      clearTimeout(timer);
      if (!resp.ok) {
        this.logger.warn({ status: resp.status, normalized }, 'usda.api.non_ok');
        return null;
      }
      const body = (await resp.json()) as UsdaSearchResponse;
      const best = pickBestMatch(body.foods ?? []);
      if (!best) return null;
      const protein = extractNutrient(best, ['Protein']);
      const calories = extractNutrient(best, ['Energy', 'Energy (Atwater General Factors)']);
      if (protein == null || calories == null) return null;
      return {
        normalized,
        display: best.description ?? originalName,
        proteinPer100g: roundTo(protein, 2),
        caloriesPer100g: roundTo(calories, 1),
        fdcId: best.fdcId ?? null,
        dataType: best.dataType ?? null,
        fromCache: false,
      };
    } catch (err) {
      this.logger.warn({ err, normalized }, 'usda.api.fetch.failed');
      return null;
    }
  }

  private async writeCache(lookup: UsdaLookup): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO usda_food_cache
                (normalized_name, display_name, fdc_id, protein_per_100g, calories_per_100g, data_type)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (normalized_name) DO UPDATE
            SET display_name        = EXCLUDED.display_name,
                fdc_id              = EXCLUDED.fdc_id,
                protein_per_100g    = EXCLUDED.protein_per_100g,
                calories_per_100g   = EXCLUDED.calories_per_100g,
                data_type           = EXCLUDED.data_type,
                last_refreshed_at   = now()`,
        [lookup.normalized, lookup.display, lookup.fdcId, lookup.proteinPer100g, lookup.caloriesPer100g, lookup.dataType],
      );
    } catch (err) {
      this.logger.warn({ err, normalized: lookup.normalized }, 'usda.cache.write.failed');
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

interface UsdaSearchResponse {
  foods?: UsdaFood[];
}

interface UsdaFood {
  fdcId?: number;
  description?: string;
  dataType?: string;
  foodNutrients?: Array<{ nutrientName?: string; value?: number; unitName?: string }>;
}

function normalize(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function pickBestMatch(foods: UsdaFood[]): UsdaFood | null {
  if (foods.length === 0) return null;
  for (const dt of PREFERRED_DATA_TYPES) {
    const found = foods.find((f) => f.dataType === dt);
    if (found) return found;
  }
  return foods[0] ?? null;
}

function extractNutrient(food: UsdaFood, names: string[]): number | null {
  const nutrients = food.foodNutrients ?? [];
  for (const target of names) {
    const match = nutrients.find((n) => n.nutrientName === target);
    if (match && typeof match.value === 'number') return match.value;
  }
  return null;
}

function roundTo(n: number, digits: number): number {
  const k = 10 ** digits;
  return Math.round(n * k) / k;
}
