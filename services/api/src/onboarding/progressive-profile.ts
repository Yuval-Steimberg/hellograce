/**
 * Progressive profiling — gather the rest of a user's profile "along the way"
 * instead of front-loading a 15-question survey at signup.
 *
 * The short conversational onboarding (onboarding-flow.ts) collects only the
 * CORE upfront: medication, schedule, goals, wake/sleep, consent. Everything
 * else needed for ACCURATE protein/calorie targets + food recommendations —
 * biological sex, current weight, height, age, activity level, diet — is
 * collected here, one gentle question at a time, woven into normal conversation:
 *
 *   1. RELEVANCE-FIRST: when the user asks something a missing field would make
 *      accurate ("how much protein should I eat?" needs sex/weight/height/age/
 *      activity), Grace asks for THAT field in context, so the answer is right.
 *   2. THROTTLED otherwise: on an ordinary chat turn, Grace may tack ONE warm
 *      question onto the end of its reply — but never more than one, and not
 *      again for a cooldown window, so it never feels like an interrogation.
 *
 * The question is PHRASED by the LLM (a directContextNote tells Gemini to add
 * one natural question), and the ANSWER is parsed deterministically next turn by
 * the onboarding-flow parsers. State (which field we just asked) lives in Redis.
 *
 * Pure helpers are exported for unit tests; the Redis store is injected.
 */
import type { GraceUser } from '../user/user.service.js';
import { parseSlotAnswer, type SlotId } from './onboarding-flow.js';

/** Minimal Redis surface so the store is easy to stub in tests. */
export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: 'EX', ttl: number): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

/** The fields we collect progressively, in priority order. Each maps 1:1 to an
 *  onboarding SlotId so parsing reuses parseSlotAnswer. Sex/weight/height/age/
 *  activity are the Mifflin-St Jeor inputs (accurate targets); diet powers food
 *  recs; goal_weight is last (nice-to-have for progress framing). */
export const PROGRESSIVE_SLOTS = [
  'dietary', 'dislikes', 'goals', 'goal_weight', 'current_weight',
  'sex', 'height', 'age', 'activity', 'wake_sleep',
] as const;
export type ProgressiveSlot = (typeof PROGRESSIVE_SLOTS)[number];

type ProfileShape = Pick<
  GraceUser,
  'sex' | 'current_weight' | 'height_cm' | 'age' | 'activity_level' | 'dietary_restriction' | 'dietary_pattern'
  | 'goal_weight' | 'food_dislikes' | 'goals' | 'wake_time'
>;

export function isProfileSlotFilled(user: ProfileShape, slot: ProgressiveSlot): boolean {
  switch (slot) {
    case 'sex': return !!user.sex;
    case 'current_weight': return user.current_weight != null;
    case 'height': return user.height_cm != null;
    case 'age': return user.age != null;
    case 'activity': return !!user.activity_level;
    case 'dietary': return !!user.dietary_restriction || !!user.dietary_pattern;
    case 'goal_weight': return user.goal_weight != null;
    case 'dislikes': return Array.isArray(user.food_dislikes) && user.food_dislikes.length > 0;
    case 'goals': return Array.isArray(user.goals) && user.goals.length > 0;
    case 'wake_sleep': return !!user.wake_time;
  }
}

/** The next missing field in priority order, or null when the profile is complete. */
export function nextMissingProfileSlot(user: ProfileShape): ProgressiveSlot | null {
  for (const slot of PROGRESSIVE_SLOTS) {
    if (!isProfileSlotFilled(user, slot)) return slot;
  }
  return null;
}

// The Mifflin-St Jeor inputs — a protein/calorie/target question is only as
// accurate as these. Asked in this order when one is missing.
const TARGET_INPUTS: ProgressiveSlot[] = ['sex', 'current_weight', 'height', 'age', 'activity'];

const TARGET_QUESTION_RE =
  /\b(protein|calorie|calories|macro|macros|how much (should|do|can) i (eat|need|have)|my (daily )?(target|goal)|am i (eating|getting) enough|how many calories)\b/i;
const FOOD_IDEA_RE =
  /\b(what (should|can|could) i (eat|have|make)|(?:meal|dinner|lunch|breakfast|snack|food)\s+ideas?|recipe|suggest|recommend|any ideas?|what's for)\b/i;

/**
 * If the user's message is one a missing field would make more accurate, return
 * that field so Grace can ask for it in context. Returns null when nothing
 * relevant is missing (caller may then fall back to throttled gathering).
 */
export function relevantProfileSlot(user: ProfileShape, text: string): ProgressiveSlot | null {
  const t = text ?? '';
  if (TARGET_QUESTION_RE.test(t)) {
    for (const slot of TARGET_INPUTS) {
      if (!isProfileSlotFilled(user, slot)) return slot;
    }
  }
  if (FOOD_IDEA_RE.test(t)) {
    if (!isProfileSlotFilled(user, 'dietary')) return 'dietary';
    if (!isProfileSlotFilled(user, 'dislikes')) return 'dislikes';
  }
  return null;
}

const GATHER_REASON: Record<ProgressiveSlot, { ask: string; why: string }> = {
  sex: { ask: 'their biological sex (male, female, or other)', why: 'so your protein and hydration needs are right' },
  current_weight: { ask: 'their current weight', why: 'so I can track your progress and set accurate targets' },
  height: { ask: 'their height (cm or feet/inches)', why: 'so your calorie and protein targets are accurate' },
  age: { ask: 'their age', why: 'so your daily targets are accurate' },
  activity: { ask: 'how active they are day to day (mostly sitting, lightly active, or on the move)', why: 'so your calorie needs are right' },
  dietary: { ask: 'whether they follow any diet or have foods they avoid or are allergic to', why: "so I never suggest something you can't or won't eat" },
  goal_weight: { ask: 'their goal weight, if they have one in mind', why: 'so I can help you track toward it' },
  dislikes: { ask: 'any foods they really dislike or want to avoid', why: "so I never suggest something you can't stand" },
  goals: { ask: "what they most want help with on this journey (protein, hydration, side effects, staying on track)", why: 'so I can focus on what matters most to you' },
  wake_sleep: { ask: 'what time they usually wake up and go to bed', why: 'so my check-ins land at the right times for you' },
};

/**
 * The directContextNote that tells the single Gemini reply to append ONE warm,
 * natural question for `slot` AFTER it has fully answered the user. Gemini
 * phrases it (varied, in-voice); we never ship a canned form question.
 */
export function buildProfileGatherNote(slot: ProgressiveSlot): string {
  const g = GATHER_REASON[slot];
  return `\n\n[PROFILE GATHERING — after you've fully answered the user's message, add ONE short, warm, casual question to learn ${g.ask} (${g.why}). Phrase it naturally like a friend, vary the wording, never a form or "survey" tone, and ask ONLY this one thing — never stack questions. If the moment is heavy (a symptom, a hard feeling), skip it entirely and don't ask.]`;
}

// ── Pending-answer state (Redis) ──────────────────────────────────────────────

const PENDING_KEY = (phone: string): string => `profile:ask:${phone}`;
const LASTASK_KEY = (phone: string): string => `profile:lastask:${phone}`;
const PENDING_TTL_SEC = 3 * 24 * 3600; // 3 days to answer before we move on
const LASTASK_TTL_SEC = 14 * 24 * 3600;

/** Record that we just asked for `slot` (sets the pending field + a throttle
 *  timestamp). Best-effort — never throws if Redis is down. */
export async function setPendingProfileAsk(redis: RedisLike | undefined, phone: string, slot: ProgressiveSlot, nowMs: number): Promise<void> {
  if (!redis) return;
  try {
    await redis.set(PENDING_KEY(phone), slot, 'EX', PENDING_TTL_SEC);
    await redis.set(LASTASK_KEY(phone), String(nowMs), 'EX', LASTASK_TTL_SEC);
  } catch { /* best-effort */ }
}

export async function getPendingProfileAsk(redis: RedisLike | undefined, phone: string): Promise<ProgressiveSlot | null> {
  if (!redis) return null;
  try {
    const v = await redis.get(PENDING_KEY(phone));
    return v && (PROGRESSIVE_SLOTS as readonly string[]).includes(v) ? (v as ProgressiveSlot) : null;
  } catch { return null; }
}

export async function clearPendingProfileAsk(redis: RedisLike | undefined, phone: string): Promise<void> {
  if (!redis) return;
  try { await redis.del(PENDING_KEY(phone)); } catch { /* best-effort */ }
}

/** True if we asked a profile question within `cooldownHours` — used to throttle
 *  the non-relevance (proactive) gathering so it never feels like a survey. */
export async function askedProfileRecently(redis: RedisLike | undefined, phone: string, cooldownHours: number, nowMs: number): Promise<boolean> {
  if (!redis) return false;
  try {
    const v = await redis.get(LASTASK_KEY(phone));
    if (!v) return false;
    return nowMs - Number(v) < cooldownHours * 3600 * 1000;
  } catch { return false; }
}

// ── Answer parsing (defensive) ────────────────────────────────────────────────

// A pending answer is only parsed from a SHORT reply — a direct response to our
// question ("male", "5'11", "33", "180kg"). This stops a normal sentence that
// happens to contain a number ("I had 100g of protein") from being mis-stored as
// a weight/age. Longer messages mean the user moved on; we just clear the ask.
const MAX_ANSWER_WORDS = 6;

export interface ProfileAnswer {
  /** Validated fields to persist, or null when the reply isn't a usable answer. */
  fields: Partial<GraceUser> | null;
}

/**
 * Try to read the user's reply as the answer to the pending profile question.
 * Returns the parsed fields to persist, or null (caller clears the pending ask
 * either way so the user is never trapped).
 */
export function parseProfileReply(slot: ProgressiveSlot, text: string): ProfileAnswer {
  const t = (text ?? '').trim();
  if (!t) return { fields: null };
  // Only treat a SHORT reply as a direct answer (see note above). List-style
  // answers (diet, dislikes, goals) can be a touch longer ("vegetarian, no
  // nuts" / "chicken, eggs and tuna"), so allow a higher cap there.
  const LONGER = new Set<ProgressiveSlot>(['dietary', 'dislikes', 'goals']);
  const wordCap = LONGER.has(slot) ? 12 : MAX_ANSWER_WORDS;
  if (t.split(/\s+/).length > wordCap) return { fields: null };
  const parsed = parseSlotAnswer(slot as SlotId, t);
  if (parsed.skipped) return { fields: null };
  return { fields: parsed.ok && parsed.fields ? parsed.fields : null };
}
