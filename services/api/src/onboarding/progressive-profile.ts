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
  'dietary', 'dislikes', 'goals', 'injection_day', 'goal_weight', 'current_weight',
  'sex', 'height', 'age', 'activity', 'wake_sleep',
] as const;
export type ProgressiveSlot = (typeof PROGRESSIVE_SLOTS)[number];

// medication / medication_frequency are OPTIONAL on the shape (only used to
// decide whether an injection_day ask is even relevant) so existing callers /
// test fixtures that don't provide them still type-check.
type ProfileShape = Pick<
  GraceUser,
  'sex' | 'current_weight' | 'height_cm' | 'age' | 'activity_level' | 'dietary_restriction' | 'dietary_pattern'
  | 'goal_weight' | 'food_dislikes' | 'goals' | 'wake_time' | 'injection_day'
> & Partial<Pick<GraceUser, 'medication' | 'medication_frequency'>>;

/** Injection day only makes sense for a WEEKLY injectable. A daily pill/injection
 *  (Rybelsus, Saxenda, Victoza) or an unknown cadence must NEVER be asked which
 *  day they inject — so we treat the slot as "filled" (skip) for those. */
function isWeeklyInjectable(user: ProfileShape): boolean {
  const freq = (user.medication_frequency ?? '').toLowerCase();
  if (freq === 'daily') return false;
  if (freq === 'weekly' || freq === 'biweekly') return true;
  const med = (user.medication ?? '').toLowerCase();
  if (/rybelsus|saxenda|victoza|liraglutide/.test(med)) return false;
  if (/ozempic|wegovy|mounjaro|zepbound|semaglutide|tirzepatide/.test(med)) return true;
  return false; // truly unknown cadence → don't ask (never nag a pill user)
}

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
    // "Filled" (skip) for non-weekly-injectable users so we never ask a pill
    // user for a shot day; otherwise filled once we know the day.
    case 'injection_day': return !isWeeklyInjectable(user) || !!user.injection_day;
  }
}

/** The next missing field in priority order, or null when the profile is complete. */
export function nextMissingProfileSlot(user: ProfileShape): ProgressiveSlot | null {
  for (const slot of PROGRESSIVE_SLOTS) {
    if (!isProfileSlotFilled(user, slot)) return slot;
  }
  return null;
}

// The Mifflin-St Jeor inputs — a CALORIE/macro target question is only as
// accurate as these. Asked in this order when one is missing.
const TARGET_INPUTS: ProgressiveSlot[] = ['sex', 'current_weight', 'height', 'age', 'activity'];

// A PROTEIN target only needs body weight (g/kg based) — so a protein-specific
// question should never interrogate sex/height/age/activity. Gathering the full
// Mifflin chain for "what's my protein goal" was the over-asking + repetition
// bug (asked "sitting/lightly active/on the move", couldn't answer, re-asked).
const PROTEIN_TARGET_INPUTS: ProgressiveSlot[] = ['current_weight'];

// Only a question about the USER'S OWN target/goal — "how much protein SHOULD I
// eat", "what's my protein target", "am I getting enough" — depends on the
// Mifflin inputs. A factual estimate of a food's content ("how much protein IS
// that / is in this salmon") does NOT — Grace just estimates it, never gathers.
const TARGET_QUESTION_RE =
  /\b(?:how (?:much|many) (?:protein|calories?|carbs?|macros?) (?:should|do|can|must) i (?:eat|need|have|get|aim|hit)|what'?s?(?: is)? my (?:daily )?(?:protein|calorie|macro)?\s?(?:target|goal|intake|need)|my (?:protein|calorie|daily) (?:target|goal)|am i (?:eating|getting) enough|do i (?:eat|get) enough (?:protein|calories))\b/i;
// A factual "how much protein/calories is in this food" — must NEVER gather.
const FOOD_CONTENT_RE =
  /\bhow (?:much|many) (?:protein|calories?|carbs?|fat|macros?)\b[^?]*\b(?:is|was|in|does|has|that|this|it|there|the meal)\b/i;
const FOOD_IDEA_RE =
  /\b(what (should|can|could) i (eat|have|make)|(?:meal|dinner|lunch|breakfast|snack|food)\s+ideas?|recipe|suggest|recommend|any ideas?|what's for)\b/i;
// A reminder/check-in timing question is only accurate once Grace knows the
// user's wake + sleep times — so gather those first when they're missing.
const REMINDER_TIMING_RE =
  /\b(reminder|remind me|check[\s-]?in|when.*(you|grace).*(text|message|remind|check)|what time.*(text|remind|check))\b/i;

/**
 * If the user's message is one a missing field would make more accurate, return
 * that field so Grace can ask for it in context. Returns null when nothing
 * relevant is missing (caller may then fall back to throttled gathering).
 */
export function relevantProfileSlot(user: ProfileShape, text: string): ProgressiveSlot | null {
  const t = text ?? '';
  // A factual food-content estimate ("how much protein is that?") is answered
  // directly — it never depends on the user's profile, so never gather for it.
  if (FOOD_CONTENT_RE.test(t)) return null;
  if (TARGET_QUESTION_RE.test(t)) {
    // Protein-only question → weight is the single input; calorie/macro → full set.
    const proteinOnly = /\bprotein\b/i.test(t) && !/\b(calorie|kcal|macro|carb|fat)s?\b/i.test(t);
    const inputs = proteinOnly ? PROTEIN_TARGET_INPUTS : TARGET_INPUTS;
    for (const slot of inputs) {
      if (!isProfileSlotFilled(user, slot)) return slot;
    }
  }
  if (FOOD_IDEA_RE.test(t)) {
    if (!isProfileSlotFilled(user, 'dietary')) return 'dietary';
    if (!isProfileSlotFilled(user, 'dislikes')) return 'dislikes';
  }
  if (REMINDER_TIMING_RE.test(t) && !isProfileSlotFilled(user, 'wake_sleep')) return 'wake_sleep';
  return null;
}

// ── Contextual follow-up gathering (proactive, answer-first) ──────────────────
// Broad everyday-topic matchers. Unlike relevantProfileSlot (which gates an
// ASK-FIRST short-circuit, only when Grace genuinely needs the value to answer
// accurately), these map ordinary conversation topics to the single most useful
// missing field — so the PROACTIVE follow-up ("...and do you usually take your
// shot on the same day each week?", asked AFTER Grace answers) feels like a
// friend's natural curiosity, never a survey.
const FOOD_TALK_RE =
  /\b(eat|eating|ate|meal|meals|food|dinner|lunch|breakfast|snack|snacks|recipe|cook(?:ing|ed)?|hungry|hunger|craving|cravings|diet)\b/i;
const MED_TALK_RE =
  /\b(shot|inject(?:ion|ing)?|dose|dosing|pen|ozempic|wegovy|mounjaro|zepbound|semaglutide|tirzepatide|my med|my medication)\b/i;
const EXERCISE_TALK_RE =
  /\b(workout|worked out|working out|work out|exercise|exercising|gym|run|running|jog(?:ging)?|walk(?:ing|ed)?|steps|yoga|pilates|lifting|weights|cardio|hike|hiking)\b/i;
const PROGRESS_TALK_RE =
  /\b(progress|goal weight|target weight|how (?:am i|i'?m) doing|on track|plateau|the scale|my weight|losing weight|lost weight)\b/i;
const SLEEP_TALK_RE =
  /\b(sleep|slept|sleeping|rest|rested|bed ?time|nap|wake up|woke up|insomnia)\b/i;
// Never tack a data question onto a symptom / emotionally-heavy turn — that is
// exactly the "out of nowhere" moment to avoid; those turns are handled by the
// symptom / emotional paths and are the wrong time to ask for profile data.
const HEAVY_OR_LOG_RE =
  /\b(nause\w*|vomit\w*|sick|throw(?:ing)? up|dizzy|pain|hurts?|sore|bruise|swell\w*|cramp\w*|headache|migraine|diarr\w*|constipat\w*|heartburn|sad|depress\w*|anxious|anxiety|cry\w*|crying|hopeless|overwhelm\w*|stressed|struggl\w*)\b/i;

/**
 * The single most useful MISSING field to gently follow up on, given what the
 * user is talking about right now — or null when nothing relevant is missing (or
 * the moment is heavy). Priority follows how personalizing each field is.
 */
export function contextualGatherSlot(user: ProfileShape, text: string): ProgressiveSlot | null {
  const t = (text ?? '').trim();
  if (!t) return null;
  if (HEAVY_OR_LOG_RE.test(t)) return null;
  // Medication talk → the weekly injection day (weekly injectables only).
  if (MED_TALK_RE.test(t) && !isProfileSlotFilled(user, 'injection_day')) return 'injection_day';
  // Exercise talk → how active they are day to day (drives calorie needs).
  if (EXERCISE_TALK_RE.test(t) && !isProfileSlotFilled(user, 'activity')) return 'activity';
  // Progress / weight talk → a goal weight to frame progress around, else current.
  if (PROGRESS_TALK_RE.test(t)) {
    if (!isProfileSlotFilled(user, 'goal_weight')) return 'goal_weight';
    if (!isProfileSlotFilled(user, 'current_weight')) return 'current_weight';
  }
  // Food talk → dislikes then diet, so recommendations never miss.
  if (FOOD_TALK_RE.test(t)) {
    if (!isProfileSlotFilled(user, 'dislikes')) return 'dislikes';
    if (!isProfileSlotFilled(user, 'dietary')) return 'dietary';
  }
  // Sleep / rest talk → wake + sleep times, so check-ins land at the right hour.
  if (SLEEP_TALK_RE.test(t) && !isProfileSlotFilled(user, 'wake_sleep')) return 'wake_sleep';
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
  injection_day: { ask: 'which day of the week they usually take their shot', why: 'so I can time your injection-day check-ins and side-effect heads-ups' },
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

// Keys are versioned (`pgather:*`) so any stale state written by earlier
// progressive-profiling code (the old `profile:ask` / `profile:lastask` keys) is
// ignored — a clean slate on deploy, which fixes "the gate never fires because a
// leftover pending/throttle key is poisoning it".
const PENDING_KEY = (phone: string): string => `pgather:pending:${phone}`;
const LASTASK_KEY = (phone: string): string => `pgather:lastask:${phone}`;
const PENDING_TTL_SEC = 3 * 24 * 3600; // 3 days to answer before we move on
const LASTASK_TTL_SEC = 14 * 24 * 3600;

// Per-slot "already asked" marker so a directly-relevant ask (food→diet) fires
// reliably without a global throttle, yet we never nag the SAME slot twice in
// the window (covers the case where the user skipped it).
const ASKED_SLOT_KEY = (phone: string, slot: string): string => `pgather:asked:${phone}:${slot}`;
const ASKED_SLOT_TTL_SEC = 20 * 3600;

export async function markSlotAsked(redis: RedisLike | undefined, phone: string, slot: ProgressiveSlot): Promise<void> {
  if (!redis) return;
  try { await redis.set(ASKED_SLOT_KEY(phone, slot), '1', 'EX', ASKED_SLOT_TTL_SEC); } catch { /* best-effort */ }
}
export async function wasSlotAskedRecently(redis: RedisLike | undefined, phone: string, slot: ProgressiveSlot): Promise<boolean> {
  if (!redis) return false;
  try { return (await redis.get(ASKED_SLOT_KEY(phone, slot))) != null; } catch { return false; }
}

// A "no thanks / skip" reply to a gather question — we then answer the original
// question generally and don't re-ask that slot (the marker handles the window).
// Anchored to the WHOLE short message so a real answer that merely starts with
// "no" — e.g. "no nuts or shellfish" (a dislikes answer) — is NOT a decline.
const GATHER_DECLINE_RE =
  /^\s*(no|nope|nah|none|skip( it)?|pass|no preference|no pref|prefer not( to)?|rather not|i['’]?d rather not|idk|i don['’]?t (know|care)|don['’]?t (know|care)|not sure|n\/a|whatever|doesn['’]?t matter|any|anything)\s*[.!]?\s*$/i;
export function isGatherDecline(text: string): boolean {
  return GATHER_DECLINE_RE.test((text ?? '').trim());
}

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

// When Grace asks for a missing detail BEFORE answering a question, we stash the
// original question here so the next turn (once they've answered) replays it and
// gives the now-personalized answer — "ask, then answer" with no lost intent.
const REPLAY_KEY = (phone: string): string => `pgather:replay:${phone}`;
const REPLAY_TTL_SEC = 3600;

export async function setReplayQuery(redis: RedisLike | undefined, phone: string, text: string): Promise<void> {
  if (!redis) return;
  try { await redis.set(REPLAY_KEY(phone), text.slice(0, 500), 'EX', REPLAY_TTL_SEC); } catch { /* best-effort */ }
}
export async function getReplayQuery(redis: RedisLike | undefined, phone: string): Promise<string | null> {
  if (!redis) return null;
  try { return await redis.get(REPLAY_KEY(phone)); } catch { return null; }
}
export async function clearReplayQuery(redis: RedisLike | undefined, phone: string): Promise<void> {
  if (!redis) return;
  try { await redis.del(REPLAY_KEY(phone)); } catch { /* best-effort */ }
}

/**
 * The warm "let me get one detail so I can tailor this" question Grace asks
 * BEFORE answering, when a missing field would make the answer specific. SMS
 * short, friendly, never a survey. The user's answer is parsed next turn and the
 * original question is replayed (personalized).
 */
const CLARIFY: Record<ProgressiveSlot, string> = {
  dietary: "Happy to help — quick q first so I can actually tailor this to you: do you follow any particular diet, and any foods you avoid or can't stand?",
  dislikes: "Want to get this right for you — any foods you really don't like or want me to skip?",
  goals: "Quick q so I focus on what matters to you — what are you most hoping for right now (weight, energy, fewer side effects, staying on track)?",
  goal_weight: "Do you have a goal weight in mind? Helps me tailor things — totally fine to skip.",
  current_weight: "To make this specific to you — roughly what's your current weight? (fine to skip)",
  sex: "Quick one so I can get this right for you — what's your biological sex (male, female, or other)?",
  height: "One detail so I can tailor your numbers — how tall are you?",
  age: "Quick q so your targets are accurate — how old are you?",
  activity: "So I can make this fit you — are you mostly sitting day to day, lightly active, or on the move?",
  wake_sleep: "Quick one so I check in at the right times — when do you usually wake up and head to bed?",
  injection_day: "One quick thing so I can time your injection-day check-ins — what day do you usually take your shot?",
};
export function buildGatherClarify(slot: ProgressiveSlot): string {
  return CLARIFY[slot];
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
