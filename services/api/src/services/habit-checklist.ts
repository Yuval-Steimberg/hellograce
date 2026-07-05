/**
 * Quick-checkmark habit tracking (Feature gap 2) — the low-friction daily
 * checklist, detection + labels + reply builders. Persistence lives in
 * habit-store.ts; the chat intercept + dashboard route call into both.
 *
 * CONSERVATIVE chat detection (per product decision): a habit is only checked
 * from chat on explicit completion phrasing, and the whole detector bails the
 * moment the message names a specific food or reads as a consumption statement —
 * so it can NEVER hijack a meal log. Missing an odd phrasing is preferred over
 * swallowing food.
 */
import { namesSpecificFood, foodSpanFromConsumption } from './meal-lifecycle.js';

export type HabitKey =
  | 'protein'
  | 'fiber'
  | 'fluids'
  | 'movement'
  | 'strength'
  | 'supplements'
  | 'symptoms_managed'
  | 'ate_enough'
  | 'weighed_in'
  | 'injected';

export interface HabitDef {
  key: HabitKey;
  label: string;
  icon: string;
  /** 'injected' only makes sense for users on a weekly injectable. */
  weeklyInjectableOnly?: boolean;
}

export const HABITS: readonly HabitDef[] = [
  { key: 'protein', label: 'Hit protein goal', icon: '🥩' },
  { key: 'fiber', label: 'Got fiber in', icon: '🥦' },
  { key: 'fluids', label: 'Drank enough fluids', icon: '💧' },
  { key: 'movement', label: 'Moved / walked', icon: '🚶' },
  { key: 'strength', label: 'Strength training', icon: '💪' },
  { key: 'supplements', label: 'Vitamins / supplements', icon: '💊' },
  { key: 'symptoms_managed', label: 'Managed symptoms', icon: '🌿' },
  { key: 'ate_enough', label: 'Ate enough today', icon: '🍽️' },
  { key: 'weighed_in', label: 'Weighed in', icon: '⚖️' },
  { key: 'injected', label: 'Took my shot', icon: '💉', weeklyInjectableOnly: true },
] as const;

export const HABIT_KEYS: readonly HabitKey[] = HABITS.map((h) => h.key);

const LABEL_BY_KEY: Record<HabitKey, string> = Object.fromEntries(
  HABITS.map((h) => [h.key, h.label]),
) as Record<HabitKey, string>;

/** Short spoken word for a habit, used in chat confirmations. */
const SPOKEN: Record<HabitKey, string> = {
  protein: 'protein',
  fiber: 'fiber',
  fluids: 'fluids',
  movement: 'movement',
  strength: 'strength training',
  supplements: 'supplements',
  symptoms_managed: 'symptoms',
  ate_enough: 'eating enough',
  weighed_in: 'weigh-in',
  injected: 'your shot',
};

/** A generic "I completed a goal" frame, required for the macro habits (protein,
 *  fiber, fluids) that overlap with food logging. */
const COMPLETION_RE =
  /\b(hit|met|reached|nailed|crushed|smashed|checked?\s*off|done\s+with|got\s+(?:my|in|all\s+my)|finished|completed|did\s+my|knocked\s+out)\b/i;

/** Aspiration ("I want to hit my protein goal") — an intent, not a completion.
 *  Scoped to an aspiration verb immediately governing a completion verb, so it
 *  won't misfire on "I hit protein, going to bed". */
const ASPIRATION_RE =
  /\b(?:want|wanna|trying|need|hoping|gonna|going|plan|planning|would\s+like|about)\s+(?:to\s+)?(?:hit|meet|reach|nail|crush|smash|check\s*off|get|finish|complete|do|knock)\b/i;

/**
 * Detect which habits a message is checking off. Returns a de-duped list (may be
 * several — "I hit protein and water today" → protein + fluids). Empty when the
 * message isn't a habit check.
 */
export function detectHabitCheck(text: string): HabitKey[] {
  const t = (text || '').toLowerCase().trim();
  if (!t || t.includes('?')) return [];
  // Aspiration ("I want to hit my protein goal") is an intent, not a check.
  if (ASPIRATION_RE.test(t)) return [];
  // Never treat a food log / consumption statement as a habit check — food wins.
  if (namesSpecificFood(t) || foodSpanFromConsumption(t)) return [];

  const found = new Set<HabitKey>();
  const hasCompletion = COMPLETION_RE.test(t);

  // Tier A — macro habits overlap with food logging, so require a completion frame.
  if (hasCompletion) {
    if (/\bprotein\b/.test(t)) found.add('protein');
    if (/\bfib(?:er|re)\b/.test(t)) found.add('fiber');
    if (/\b(water|fluids?|hydration|hydrated)\b/.test(t)) found.add('fluids');
  }

  // Tier B — self-contained completion phrases with little/no food overlap.
  if (/\b(done\s+with\s+(?:my\s+)?(?:movement|exercise|workout)|worked\s+out|got\s+(?:my|a)\s+(?:workout|walk)\s*(?:in)?|went\s+for\s+a\s+(?:walk|run|jog)|walked|moved\s+my\s+body|got\s+my\s+steps|did\s+(?:my\s+)?cardio|hit\s+the\s+gym)\b/.test(t)) {
    found.add('movement');
  }
  if (/\b(strength\s+(?:training|work)|lifted|lifting|did\s+weights|resistance\s+training|hit\s+the\s+weights)\b/.test(t)) {
    found.add('strength');
    found.add('movement');
  }
  if (/\b(took\s+(?:my\s+)?(?:vitamins?|supplements?|vits|multivitamin)|had\s+my\s+(?:vitamins?|supplements?)|got\s+my\s+(?:vitamins?|supplements?)\s+in)\b/.test(t)) {
    found.add('supplements');
  }
  if (/\b(managed\s+(?:my\s+)?(?:nausea|symptoms|side\s+effects)|kept\s+(?:the|my)\s+nausea\s+(?:down|at\s+bay)|handled\s+my\s+symptoms)\b/.test(t)) {
    found.add('symptoms_managed');
  }
  if (/\b(ate\s+enough|eaten\s+enough|got\s+enough\s+(?:food|calories|to\s+eat)|had\s+enough\s+to\s+eat)\b/.test(t)) {
    found.add('ate_enough');
  }
  if (/\b(weighed\s+in|weighed\s+myself|stepped\s+on\s+the\s+scale)\b/.test(t)) {
    found.add('weighed_in');
  }

  // 'injected' is intentionally NOT chat-detected — the injection state machine
  // (webhook) owns "I injected"; the dashboard checkbox handles the habit.
  found.delete('injected');
  return [...found];
}

/** "I don't want to log food today" — offer the low-friction checklist instead. */
export function detectSkipFoodLogging(text: string): boolean {
  const t = (text || '').toLowerCase();
  if (t.includes('?')) return false;
  return (
    /\b(?:don'?t|do\s+not|really\s+don'?t|not\s+going\s+to|won'?t|can'?t\s+be\s+bothered\s+to|too\s+tired\s+to|don'?t\s+wanna|dont\s+want\s+to)\b[^.?!]*\b(log|track|count|record)\b[^.?!]*\b(food|meals?|everything|calories|what\s+i\s+(?:eat|ate)|today)\b/i.test(t) ||
    /\bnot\s+logging\s+(?:food|today|my\s+meals?|everything)\b/i.test(t) ||
    /\bdon'?t\s+want\s+to\s+log\s+(?:food|today|my\s+meals?|everything)\b/i.test(t)
  );
}

/** Warm confirmation for the habits just checked. */
export function buildHabitCheckReply(keys: HabitKey[]): string {
  const words = keys.map((k) => SPOKEN[k]);
  const list = joinWords(words);
  return `Nice — checked off ${list} for today. 💪 Tap "dashboard" anytime to see your full day.`;
}

/** The offer shown when a user says they don't want to log food. */
export function buildSkipFoodOffer(): string {
  return (
    `Totally fine — you don't have to log every bite. Want to just check off the basics instead? ` +
    `Tell me what you did — like "hit protein and fluids" or "got my movement in" — and I'll tick them off.`
  );
}

export function habitLabel(key: HabitKey): string {
  return LABEL_BY_KEY[key] ?? key;
}

function joinWords(words: string[]): string {
  if (words.length === 0) return '';
  if (words.length === 1) return words[0]!;
  if (words.length === 2) return `${words[0]} and ${words[1]}`;
  return `${words.slice(0, -1).join(', ')}, and ${words[words.length - 1]}`;
}
