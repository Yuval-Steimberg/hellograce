/**
 * Cross-turn symptom-stacking accumulator (2026-06-06).
 *
 * Problem: Grace classifies each turn independently. A user can describe a
 * single escalating emergency over three messages — "severe abdominal pain"
 * → "vomiting for 2 days" → "now my heart's racing" — and only the message
 * that happens to match an EMERGENCY keyword on its OWN triggers a
 * SAFETY_RESPONSE. The other two get a standard knowledge-intent response.
 * Per the 2026-06-06 coverage audit, that's a critical gap.
 *
 * Solution: a per-user Redis LIST of recent (≤ 2h) symptom categories. When
 * a message matches a sub-emergency-threshold symptom signal, append its
 * category. When the LIST contains ≥ 2 DISTINCT categories within the
 * window, force SAFETY_RESPONSE on the current turn regardless of the
 * current message's standalone classification.
 *
 * Design choices:
 *
 *   - Distinct categories, not raw count. Multiple "nausea" mentions over
 *     3 hours don't escalate; nausea + chest pain do.
 *   - 2h window. Long enough that a multi-message description over coffee
 *     stays grouped; short enough that yesterday's mild GI doesn't combine
 *     with today's racing heart.
 *   - 6 categories: cardio / gi_severe / neuro / allergic / dehydration /
 *     weakness. Each EMERGENCY keyword group in guard.ts maps to one.
 *   - Threshold = 2. Conservative — symptoms genuinely co-occur and the
 *     SAFETY_RESPONSE is high-cost if wrong. Tune in production via logs.
 *   - Pure Redis. No DB write. State is intentionally ephemeral — a fresh
 *     conversation tomorrow starts clean.
 *   - Idempotent: same category appended multiple times within the window
 *     counts once (set semantics on read).
 */

import type { Redis } from 'ioredis';
import type { SymptomCategory } from './guard.js';

const KEY_PREFIX = 'safety:stack:';
/** TTL for the per-symptom entry (refreshed on every append). 2 hours. */
export const SYMPTOM_TTL_SECONDS = 7200;
/** Number of DISTINCT categories within the window that triggers escalation. */
export const STACKING_THRESHOLD = 2;
/** Hard cap on list length to bound memory. Latest entries are kept. */
const LIST_CAP = 32;

interface StackEntry {
  category: SymptomCategory;
  ts: number;
}

interface MinimalLogger {
  info: (obj: object, msg?: string) => void;
  warn: (obj: object, msg?: string) => void;
  error: (obj: object, msg?: string) => void;
}

export interface SymptomStackDeps {
  redis: Redis;
  logger: MinimalLogger;
}

function key(phone: string): string {
  return KEY_PREFIX + phone;
}

/**
 * Append a symptom category to the user's stack and refresh the TTL.
 * Returns the current stack state AFTER the append.
 */
export async function recordSymptom(
  phone: string,
  category: SymptomCategory,
  deps: SymptomStackDeps,
): Promise<{ count: number; categories: SymptomCategory[] }> {
  const entry: StackEntry = { category, ts: Date.now() };
  try {
    await deps.redis.rpush(key(phone), JSON.stringify(entry));
    await deps.redis.ltrim(key(phone), -LIST_CAP, -1);
    await deps.redis.expire(key(phone), SYMPTOM_TTL_SECONDS);
  } catch (err) {
    deps.logger.warn(
      { err: err instanceof Error ? err.message : String(err), phone, category },
      'symptom_stack.record_failed',
    );
  }
  return readStack(phone, deps);
}

/**
 * Read the active stack (entries within the TTL window). Stale entries
 * are filtered in-memory; we don't rewrite the list (TTL handles cleanup).
 */
export async function readStack(
  phone: string,
  deps: SymptomStackDeps,
): Promise<{ count: number; categories: SymptomCategory[] }> {
  let raws: string[] = [];
  try {
    raws = await deps.redis.lrange(key(phone), 0, -1);
  } catch (err) {
    deps.logger.warn(
      { err: err instanceof Error ? err.message : String(err), phone },
      'symptom_stack.read_failed',
    );
    return { count: 0, categories: [] };
  }
  const cutoff = Date.now() - SYMPTOM_TTL_SECONDS * 1000;
  const distinct = new Set<SymptomCategory>();
  let total = 0;
  for (const raw of raws) {
    let entry: StackEntry | null = null;
    try {
      entry = JSON.parse(raw) as StackEntry;
    } catch {
      continue;
    }
    if (!entry || entry.ts < cutoff) continue;
    distinct.add(entry.category);
    total += 1;
  }
  return { count: total, categories: Array.from(distinct) };
}

/**
 * True when the stack has accumulated >= STACKING_THRESHOLD distinct
 * categories within the window — caller should force-escalate.
 */
export function shouldEscalate(stack: { categories: SymptomCategory[] }): boolean {
  return stack.categories.length >= STACKING_THRESHOLD;
}

/**
 * Clear the user's stack. Call after a real escalation has been sent so
 * subsequent messages don't immediately re-escalate on a single symptom.
 */
export async function clearStack(phone: string, deps: SymptomStackDeps): Promise<void> {
  try {
    await deps.redis.del(key(phone));
  } catch (err) {
    deps.logger.warn(
      { err: err instanceof Error ? err.message : String(err), phone },
      'symptom_stack.clear_failed',
    );
  }
}

// Test-only exports.
export const __testing = {
  KEY_PREFIX,
  LIST_CAP,
};
