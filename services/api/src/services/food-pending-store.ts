/**
 * Pending food-item state (Redis) — the missing piece that lets a portion
 * answer RESOLVE a vague food instead of looping. When the extractor returns a
 * pending_portion item ("had pizza"), we stash it here; on the next turn it's
 * fed back to the extractor so "2 slices" resolves it as an edit. Redis-optional
 * (no-ops + never throws when absent), mirroring meal-recommendation-store.
 */
import type { Redis } from 'ioredis';

export interface PendingFood {
  item: string;
  clarify_question: string | null;
  ts: number;
}

const TTL_SECONDS = 6 * 60 * 60; // 6h — a meal's clarification window
const MAX_PENDING = 5;
const keyFor = (phone: string): string => `food:pending:${phone}`;

export async function getPendingFood(redis: Redis | undefined, phone: string): Promise<PendingFood[]> {
  if (!redis) return [];
  try {
    const raw = await redis.get(keyFor(phone));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as PendingFood[]).filter((p) => p && typeof p.item === 'string') : [];
  } catch {
    return [];
  }
}

export async function setPendingFood(redis: Redis | undefined, phone: string, items: PendingFood[]): Promise<void> {
  if (!redis) return;
  try {
    const trimmed = items.slice(-MAX_PENDING);
    if (trimmed.length === 0) {
      await redis.del(keyFor(phone));
      return;
    }
    await redis.set(keyFor(phone), JSON.stringify(trimmed), 'EX', TTL_SECONDS);
  } catch {
    /* best-effort */
  }
}

export async function clearPendingFood(redis: Redis | undefined, phone: string): Promise<void> {
  if (!redis) return;
  try {
    await redis.del(keyFor(phone));
  } catch {
    /* best-effort */
  }
}

/** Add new pending items, deduping by case-insensitive item text. */
export async function addPendingFood(
  redis: Redis | undefined,
  phone: string,
  newItems: Array<{ item: string; clarify_question: string | null }>,
): Promise<void> {
  if (!redis || newItems.length === 0) return;
  const existing = await getPendingFood(redis, phone);
  const seen = new Set(existing.map((p) => p.item.toLowerCase()));
  const merged = [...existing];
  for (const it of newItems) {
    const key = it.item.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push({ item: it.item.trim().slice(0, 200), clarify_question: it.clarify_question, ts: Date.now() });
  }
  await setPendingFood(redis, phone, merged);
}

/** Remove the pending item that an edit_ref / resolved phrase refers to.
 *  Fuzzy: matches when either string contains the other's core word. */
export async function resolvePendingFood(
  redis: Redis | undefined,
  phone: string,
  ref: string,
): Promise<void> {
  if (!redis || !ref) return;
  const existing = await getPendingFood(redis, phone);
  if (existing.length === 0) return;
  const r = ref.toLowerCase();
  const remaining = existing.filter((p) => {
    const item = p.item.toLowerCase();
    const overlap = item.includes(r) || r.includes(item) ||
      item.split(/\s+/).some((w) => w.length >= 3 && r.includes(w));
    return !overlap;
  });
  await setPendingFood(redis, phone, remaining);
}
