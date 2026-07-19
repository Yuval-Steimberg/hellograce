/**
 * Pending food-item state (Redis) — the missing piece that lets a portion
 * answer RESOLVE a vague food instead of looping. When the extractor returns a
 * pending_portion item ("had pizza"), we stash it here; on the next turn it's
 * fed back to the extractor so "2 slices" resolves it as an edit. Redis-optional
 * (no-ops + never throws when absent), mirroring meal-recommendation-store.
 */
import type { Redis } from 'ioredis';
import type { Pool } from 'pg';

export interface PendingFood {
  item: string;
  clarify_question: string | null;
  ts: number;
}

const TTL_SECONDS = 6 * 60 * 60; // 6h — a meal's clarification window
const MAX_PENDING = 5;
const keyFor = (phone: string): string => `food:pending:${phone}`;

export async function getPendingFood(redis: Redis | undefined, phone: string, pool?: Pool): Promise<PendingFood[]> {
  if (redis) {
    try {
      const raw = await redis.get(keyFor(phone));
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return (parsed as PendingFood[]).filter((p) => p && typeof p.item === 'string');
      }
    } catch { /* durable fallback below */ }
  }
  if (pool) {
    try {
      const result = await pool.query<{ items: PendingFood[] }>(
        `SELECT items FROM food_pending_items WHERE user_id = $1 AND expires_at > now()`,
        [phone],
      );
      const items = result.rows[0]?.items;
      if (Array.isArray(items)) {
        if (redis) void redis.set(keyFor(phone), JSON.stringify(items), 'EX', TTL_SECONDS).catch(() => undefined);
        return items.filter((p) => p && typeof p.item === 'string');
      }
    } catch { /* migration may not be deployed yet */ }
  }
  return [];
}

export async function setPendingFood(redis: Redis | undefined, phone: string, items: PendingFood[], pool?: Pool): Promise<void> {
  const trimmed = items.slice(-MAX_PENDING);
  if (redis) {
    try {
      if (trimmed.length === 0) await redis.del(keyFor(phone));
      else await redis.set(keyFor(phone), JSON.stringify(trimmed), 'EX', TTL_SECONDS);
    } catch { /* database mirror still runs */ }
  }
  if (!pool) return;
  try {
    if (trimmed.length === 0) {
      await pool.query(`DELETE FROM food_pending_items WHERE user_id = $1`, [phone]);
    } else {
      await pool.query(
        `INSERT INTO food_pending_items (user_id, items, expires_at, updated_at)
         VALUES ($1, $2::jsonb, now() + interval '6 hours', now())
         ON CONFLICT (user_id) DO UPDATE
         SET items = EXCLUDED.items, expires_at = EXCLUDED.expires_at, updated_at = now()`,
        [phone, JSON.stringify(trimmed)],
      );
    }
  } catch { /* deploy-order safe */ }
}

export async function clearPendingFood(redis: Redis | undefined, phone: string, pool?: Pool): Promise<void> {
  await setPendingFood(redis, phone, [], pool);
}

/** Add new pending items, deduping by case-insensitive item text. */
export async function addPendingFood(
  redis: Redis | undefined,
  phone: string,
  newItems: Array<{ item: string; clarify_question: string | null }>,
  pool?: Pool,
): Promise<void> {
  if (newItems.length === 0) return;
  const existing = await getPendingFood(redis, phone, pool);
  const seen = new Set(existing.map((p) => p.item.toLowerCase()));
  const merged = [...existing];
  for (const it of newItems) {
    const key = it.item.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push({ item: it.item.trim().slice(0, 200), clarify_question: it.clarify_question, ts: Date.now() });
  }
  await setPendingFood(redis, phone, merged, pool);
}

/** Remove the pending item that an edit_ref / resolved phrase refers to.
 *  Fuzzy: matches when either string contains the other's core word. */
export async function resolvePendingFood(
  redis: Redis | undefined,
  phone: string,
  ref: string,
  pool?: Pool,
): Promise<void> {
  if (!ref) return;
  const existing = await getPendingFood(redis, phone, pool);
  if (existing.length === 0) return;
  const r = ref.toLowerCase();
  const remaining = existing.filter((p) => {
    const item = p.item.toLowerCase();
    const overlap = item.includes(r) || r.includes(item) ||
      item.split(/\s+/).some((w) => w.length >= 3 && r.includes(w));
    return !overlap;
  });
  await setPendingFood(redis, phone, remaining, pool);
}
