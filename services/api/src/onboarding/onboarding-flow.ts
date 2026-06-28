/**
 * Conversational onboarding — collect a user's profile over chat instead of a
 * web form, so it feels like talking to Grace, not filling out a survey.
 *
 * Two modes:
 *   - 'signup'  : a brand-new number. Walks a SHORT ordered sequence of the
 *                 minimum required fields (name → medication → schedule → goals →
 *                 consent), then starts the trial. Stripe still handles the paid
 *                 upgrade later via the existing paywall.
 *   - 'gapfill' : an already-registered user missing a few high-value optional
 *                 fields (goal/current weight). Asks one at a time, no consent /
 *                 trial step. Most optional fields are also captured passively by
 *                 the profile-learning extractor, so gap-fill stays light.
 *
 * Design choices that keep it natural and robust:
 *   - QUESTIONS are LLM-generated (warm, varied, personalized — never the same
 *     wording twice) with deterministic fallbacks so a slow/failed LLM never
 *     stalls the flow.
 *   - ANSWERS are parsed deterministically (reusing profile-extract normalizers)
 *     so a value can never be stored malformed.
 *   - STATE lives in the DB (onboarding_state + onboarding_last_slot), not in
 *     memory, so it survives restarts / cold isolates / load-balanced instances.
 *   - "minimum required first, then optional gradually": signup asks only the
 *     core; everything else is learned over time.
 *
 * Pure helpers (slot sequencing + answer parsing) are exported for unit tests.
 */
import type { LLMProvider } from '@grace/shared';
import type { Logger as PinoLogger } from 'pino';

/** Minimal logger surface — accepts pino's Logger and Fastify's request/base
 *  logger (both expose info/warn) without coupling to the full root-logger type. */
type Logger = Pick<PinoLogger, 'info' | 'warn'>;
import type { GraceUser } from '../user/user.service.js';
import {
  normalizeMedication,
  normalizeFrequency,
  normalizeDay,
  normalizeTime,
} from '../services/profile-extract.js';
import { parseTimezone, timezoneFromPhone } from '../services/timezone-parse.js';

export type SlotId =
  | 'first_name'
  | 'medication'
  | 'medication_frequency'
  | 'injection_day'
  | 'medication_time'
  | 'timezone'
  | 'goals'
  | 'wake_sleep'
  | 'consent'
  | 'goal_weight'
  | 'current_weight'
  | 'dietary'
  | 'dislikes'
  // Progressive (gathered along the way after the short signup core) — power
  // accurate protein/calorie targets + food recommendations.
  | 'sex'
  | 'height'
  | 'age'
  | 'activity';

/** Minimal user shape the flow reads/writes — keeps it decoupled + testable. */
type FlowUser = Pick<
  GraceUser,
  | 'phone'
  | 'first_name'
  | 'medication'
  | 'medication_frequency'
  | 'injection_day'
  | 'medication_time'
  | 'timezone'
  | 'goals'
  | 'sms_consent'
  | 'goal_weight'
  | 'current_weight'
  | 'food_dislikes'
  | 'wake_time'
  | 'sleep_time'
  | 'sex'
  | 'height_cm'
  | 'age'
  | 'activity_level'
  | 'dietary_restriction'
  | 'dietary_pattern'
  | 'trial_start'
  | 'onboarding_state'
  | 'onboarding_last_slot'
>;

type UserWriter = { update(phone: string, fields: Partial<GraceUser>): Promise<void> };

// ── Slot sequencing ──────────────────────────────────────────────────────────

/** The schedule slot depends on how often they dose: weekly/biweekly users have
 *  an injection DAY; daily users have a dose TIME. */
function scheduleSlot(user: Pick<FlowUser, 'medication_frequency'>): SlotId {
  return user.medication_frequency === 'daily' ? 'medication_time' : 'injection_day';
}

/** The ordered signup sequence given what we currently know (the schedule slot
 *  resolves once frequency is answered). Short on purpose — the minimum to start
 *  a useful trial; the rest is learned over time. */
export function signupSequence(user: Pick<FlowUser, 'medication_frequency'>): SlotId[] {
  // 'timezone' comes right after the schedule slot so reminders + daily resets
  // run on the user's REAL local time from the first scheduled message.
  // FAST CORE ONLY — the minimum to start a useful trial so the user can begin
  // texting in under a minute: who they are, what they're on, how/when they dose,
  // and the opt-in. 'timezone' auto-fills from the phone (rarely asked).
  // EVERYTHING else — goals, goal weight, diet, dislikes, wake/sleep, body
  // metrics — is gathered conversationally AFTER onboarding by the progressive
  // profiler (progressive-profile.ts), so the first experience stays quick.
  return ['first_name', 'medication', 'medication_frequency', scheduleSlot(user), 'timezone', 'consent'];
}

/** Next signup slot after `lastSlot` (null → the first slot). Returns null when
 *  the sequence is complete. */
export function nextSignupSlot(user: Pick<FlowUser, 'medication_frequency'>, lastSlot: string | null): SlotId | null {
  const seq = signupSequence(user);
  if (!lastSlot) return seq[0]!;
  const idx = seq.indexOf(lastSlot as SlotId);
  if (idx === -1) return seq[0]!; // unknown/stale slot → restart safely
  return seq[idx + 1] ?? null;
}

/** Gap-fill targets: genuinely-nullable, high-value fields only (no defaulted
 *  columns, so we never nag a user about a value we can't tell is real). */
const GAPFILL_SLOTS: SlotId[] = ['goal_weight', 'current_weight'];

export function nextGapfillSlot(user: Pick<FlowUser, 'goal_weight' | 'current_weight'>): SlotId | null {
  for (const slot of GAPFILL_SLOTS) {
    if (slot === 'goal_weight' && user.goal_weight == null) return slot;
    if (slot === 'current_weight' && user.current_weight == null) return slot;
  }
  return null;
}

/** Whether a slot's value is already on the user — so onboarding can SKIP it
 *  (e.g. a multi-field answer filled it out of order). `consent` is never
 *  "answered" passively: the yes/no opt-in is always asked explicitly. */
export function isSlotAnswered(u: FlowUser, slot: SlotId): boolean {
  switch (slot) {
    case 'first_name': return !!u.first_name;
    case 'medication': return !!u.medication;
    case 'medication_frequency': return !!u.medication_frequency;
    case 'injection_day': return !!u.injection_day;
    case 'medication_time': return !!u.medication_time;
    case 'timezone': return !!u.timezone;
    case 'goals': return Array.isArray(u.goals) && u.goals.length > 0;
    case 'goal_weight': return u.goal_weight != null;
    case 'current_weight': return u.current_weight != null;
    case 'dietary': return !!u.dietary_restriction || !!u.dietary_pattern;
    case 'dislikes': return Array.isArray(u.food_dislikes) && u.food_dislikes.length > 0;
    case 'wake_sleep': return !!u.wake_time;
    case 'sex': return !!u.sex;
    case 'height': return u.height_cm != null;
    case 'age': return u.age != null;
    case 'activity': return !!u.activity_level;
    case 'consent': return false;
  }
}

// ── Answer parsing ───────────────────────────────────────────────────────────

const SKIP_RE = /\b(skip|later|not now|prefer not|rather not|pass|dunno|don'?t know|no idea|maybe later)\b/i;
/** Optional slots the user may skip; required signup slots must be answered.
 *  timezone is skippable so a hard-to-parse answer never traps onboarding — it
 *  falls back to the temporary default and can be set later in Settings. */
const SKIPPABLE: ReadonlySet<SlotId> = new Set([
  'first_name', 'timezone', 'goals', 'wake_sleep', 'goal_weight', 'current_weight',
  'dietary', 'dislikes',
  // Progressive fields are always optional — a user can skip any of them and
  // Grace falls back to safe defaults (e.g. an 80g protein target).
  'sex', 'height', 'age', 'activity',
]);

const YES_RE = /\b(yes|yeah|yep|yup|sure|ok|okay|fine|sounds good|go ahead|please do|absolutely|of course|y)\b/i;
const NO_RE = /\b(no|nope|nah|don'?t|do not|stop|rather not|n)\b/i;

// Onboarding asks specifically for a GLP-1, so the medication slot is parsed
// STRICTLY: require a recognized brand or active ingredient. This rejects junk
// ("idk lol", "skip") that the looser profile-learning normalizer would accept —
// there the LLM gates what counts as a medication, but here it's raw user text.
const KNOWN_MED_RE =
  /\b(ozempic|wegovy|mounjaro|zepbound|saxenda|rybelsus|trulicity|victoza|semaglutide|tirzepatide|liraglutide|dulaglutide|compounded)\b/i;
function parseMedicationStrict(text: string): string | null {
  return KNOWN_MED_RE.test(text) ? normalizeMedication(text) : null;
}

function parseName(text: string): string | null {
  const cleaned = text
    .replace(/\b(hi|hey|hello|it'?s|i'?m|im|my name is|name'?s|this is|call me|its)\b/gi, ' ')
    .replace(/[^a-zA-Z'’\- ]/g, ' ')
    .trim();
  const first = cleaned.split(/\s+/)[0] ?? '';
  if (first.length < 2 || first.length > 40) return null;
  return first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
}

function parseGoals(text: string): string[] | null {
  const parts = text
    .split(/,|\band\b|\n|\+|&|\//gi)
    .map((p) => p.trim().toLowerCase().replace(/^(to|i want to|i'?d like to|help me)\s+/i, '').trim())
    .filter((p) => p.length >= 2 && p.length <= 60);
  return parts.length > 0 ? Array.from(new Set(parts)).slice(0, 10) : null;
}

function parseWeight(text: string): number | null {
  const m = text.match(/(\d{2,4}(?:\.\d)?)/);
  if (!m) return null;
  const n = parseFloat(m[1]!);
  if (!Number.isFinite(n) || n < 50 || n > 1000) return null;
  return Math.round(n);
}

function parseConsent(text: string): boolean | null {
  if (NO_RE.test(text) && !YES_RE.test(text)) return false;
  if (YES_RE.test(text)) return true;
  return null;
}

// ── Progressive-field parsers (strict — these run on free chat replies) ───────

/** A single clock time → "HH:MM" (24h). Accepts "7am", "7 am", "7", "07:00",
 *  "10pm", "22:00", "noon", "midnight". Returns null when unparseable. */
export function parseClockTime(text: string): string | null {
  const t = text.toLowerCase().trim();
  if (/\bnoon\b/.test(t)) return '12:00';
  if (/\bmidnight\b/.test(t)) return '00:00';
  const m = t.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/);
  if (!m) return null;
  let h = parseInt(m[1]!, 10);
  const min = m[2] ? parseInt(m[2], 10) : 0;
  const ap = m[3];
  if (h > 23 || min > 59) return null;
  if (ap === 'pm' && h < 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

/** "7am ... 10pm" → { wake_time, sleep_time }. First time = wake, second = sleep. */
function parseWakeSleep(text: string): Partial<GraceUser> | null {
  const matches = text.toLowerCase().match(/\b(?:noon|midnight|\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\b/g) ?? [];
  const times = matches.map((m) => parseClockTime(m)).filter((t): t is string => !!t);
  if (times.length === 0) return null;
  const fields: Partial<GraceUser> = { wake_time: times[0]! };
  if (times[1]) fields.sleep_time = times[1];
  return fields;
}

function parseSex(text: string): 'male' | 'female' | 'other' | null {
  const t = text.toLowerCase();
  if (/\b(female|woman|girl|f)\b/.test(t)) return 'female';
  if (/\b(male|man|boy|m)\b/.test(t)) return 'male';
  if (/\b(other|non-?binary|nb|prefer not|intersex)\b/.test(t)) return 'other';
  return null;
}

/** Height → cm. Accepts "190cm", "190", "6'2", "6 ft 2", "5'11\"", "5 foot 11". */
export function parseHeight(text: string): number | null {
  const t = text.toLowerCase().trim();
  // feet'inches: 6'2, 6' 2", 6 ft 2, 5 foot 11
  const ft = t.match(/(\d)\s*(?:'|’|ft|foot|feet)\s*(\d{1,2})?/);
  if (ft) {
    const feet = parseInt(ft[1]!, 10);
    const inches = ft[2] ? parseInt(ft[2], 10) : 0;
    const cm = Math.round(feet * 30.48 + inches * 2.54);
    return cm >= 80 && cm <= 250 ? cm : null;
  }
  const m = t.match(/(\d{2,3})\s*(?:cm)?/);
  if (!m) return null;
  const cm = parseInt(m[1]!, 10);
  return cm >= 80 && cm <= 250 ? cm : null;
}

/** Age from a plain number (13–120) or a date of birth (DD/MM/YYYY, YYYY-MM-DD,
 *  or a bare 4-digit birth year). Returns whole years. */
export function parseAge(text: string, now = new Date()): number | null {
  const t = text.trim();
  const year = t.match(/\b(19\d{2}|20[0-2]\d)\b/);
  if (year) {
    const age = now.getFullYear() - parseInt(year[1]!, 10);
    return age >= 13 && age <= 120 ? age : null;
  }
  const m = t.match(/\b(\d{1,3})\b/);
  if (!m) return null;
  const n = parseInt(m[1]!, 10);
  return n >= 13 && n <= 120 ? n : null;
}

function parseActivity(text: string): string | null {
  const t = text.toLowerCase();
  if (/\b(very active|athlete|intense|gym (daily|every)|heavy)\b/.test(t)) return 'very_active';
  if (/\b(active|on (my|the) (feet|move)|moderate|workout|exercise|run|lift)\b/.test(t)) return 'moderate';
  if (/\b(lightly active|light|some walking|walk)\b/.test(t)) return 'light';
  if (/\b(sedentary|desk|sitting|low|not (very|much)|barely|inactive)\b/.test(t)) return 'sedentary';
  return null;
}

/** Disliked / avoided foods → a clean string[]. Strips lead-ins ("I hate", "I
 *  don't like", "avoid", "no") and splits on commas / "and" / "or" / slashes.
 *  "none/nothing" → empty list (nothing to avoid). */
export function parseDislikes(text: string): string[] | null {
  const t = text.trim().toLowerCase();
  if (/^(no|none|nope|nah|not really|n\/a|nothing|i (eat|like) everything|no (foods?|preferences?))\b/.test(t)) {
    return [];
  }
  const cleaned = text
    .replace(/\b(i\s+(really\s+)?(hate|don'?t\s+(like|eat)|do\s+not\s+(like|eat)|can'?t\s+stand|dislike|avoid|am\s+allergic\s+to|allergic\s+to)|no\s+|avoid\s+|not\s+a\s+fan\s+of)\b/gi, ' ')
    .replace(/\b(and|or|plus)\b/gi, ',');
  const items = cleaned
    .split(/[,\/&\n]+/)
    .map((p) => p.trim().replace(/[.!?]+$/, '').toLowerCase())
    .filter((p) => p.length >= 2 && p.length <= 40 && /[a-z]/i.test(p));
  return items.length > 0 ? Array.from(new Set(items)).slice(0, 20) : null;
}

/** Diet/allergies → dietary_restriction (free text) + dietary_pattern enum when
 *  it's one of the supported plant-based patterns. "no/none" → cleared/skipped. */
function parseDiet(text: string): Partial<GraceUser> | null {
  const t = text.toLowerCase().trim();
  if (/^(no|none|nope|nah|not really|n\/a|nothing)\b/.test(t)) return { dietary_restriction: null };
  const fields: Partial<GraceUser> = {};
  if (/\bvegan\b/.test(t)) fields.dietary_pattern = 'vegan';
  else if (/\bvegetarian\b/.test(t)) fields.dietary_pattern = 'vegetarian';
  else if (/\bpescatarian\b/.test(t)) fields.dietary_pattern = 'pescatarian';
  fields.dietary_restriction = text.trim().slice(0, 120);
  return fields;
}

export interface ParsedAnswer {
  ok: boolean;
  skipped?: boolean;
  /** Validated fields to persist (real `users` columns). */
  fields?: Partial<GraceUser>;
}

/**
 * Multi-field extraction: pull EVERY profile fact the message mentions, not just
 * the slot we asked — so a chatty answer ("I'm on ozempic once a week and want
 * to get to 120kg") fills several slots at once and onboarding skips ahead.
 * Only the UNAMBIGUOUS, keyword-anchored fields are scanned here (a bare number
 * is never a goal weight unless framed as one), and every value goes through the
 * same strict validators as parseSlotAnswer — so nothing malformed is stored.
 */
export function extractAllFields(text: string): Partial<GraceUser> {
  const fields: Partial<GraceUser> = {};
  const med = parseMedicationStrict(text);
  if (med) fields.medication = med;
  const freq = normalizeFrequency(text);
  if (freq) fields.medication_frequency = freq;
  // Goal weight only when framed as a goal/target (never a bare number).
  if (/\b(goal|target|aim(ing)?|reach|get (down |up |back )?to|want to (be|hit|get to|reach|weigh)|lose (down )?to|down to)\b/i.test(text)) {
    const w = parseWeight(text);
    if (w) fields.goal_weight = w;
  }
  // Diet only with an explicit diet keyword.
  if (/\b(vegan|vegetarian|pescatarian|keto|paleo|kosher|halal|gluten[\s-]?free|dairy[\s-]?free|lactose|low[\s-]?carb|plant[\s-]?based)\b/i.test(text)) {
    const d = parseDiet(text);
    if (d) Object.assign(fields, d);
  }
  return fields;
}

/**
 * Parse the user's reply for a given slot into validated `users` fields. Returns
 * ok=false when the reply can't be understood (caller re-asks), or skipped=true
 * for a skippable optional slot the user declined.
 */
export function parseSlotAnswer(slot: SlotId, text: string): ParsedAnswer {
  const t = text.trim();
  if (!t) return { ok: false };
  if (SKIPPABLE.has(slot) && SKIP_RE.test(t)) return { ok: true, skipped: true };

  switch (slot) {
    case 'first_name': {
      const name = parseName(t);
      return name ? { ok: true, fields: { first_name: name } } : { ok: false };
    }
    case 'medication': {
      const med = parseMedicationStrict(t);
      return med ? { ok: true, fields: { medication: med } } : { ok: false };
    }
    case 'medication_frequency': {
      const freq = normalizeFrequency(t);
      return freq ? { ok: true, fields: { medication_frequency: freq } } : { ok: false };
    }
    case 'injection_day': {
      const day = normalizeDay(t);
      return day ? { ok: true, fields: { injection_day: day } } : { ok: false };
    }
    case 'medication_time': {
      const time = normalizeTime(t);
      return time ? { ok: true, fields: { medication_time: time } } : { ok: false };
    }
    case 'timezone': {
      const tz = parseTimezone(t);
      return tz ? { ok: true, fields: { timezone: tz } } : { ok: false };
    }
    case 'goals': {
      const goals = parseGoals(t);
      return goals ? { ok: true, fields: { goals } } : { ok: false };
    }
    case 'consent': {
      const c = parseConsent(t);
      return c == null ? { ok: false } : { ok: true, fields: { sms_consent: c } };
    }
    case 'goal_weight': {
      const w = parseWeight(t);
      return w ? { ok: true, fields: { goal_weight: w } } : { ok: false };
    }
    case 'current_weight': {
      const w = parseWeight(t);
      return w ? { ok: true, fields: { current_weight: w } } : { ok: false };
    }
    case 'wake_sleep': {
      const fields = parseWakeSleep(t);
      return fields ? { ok: true, fields } : { ok: false };
    }
    case 'sex': {
      const s = parseSex(t);
      return s ? { ok: true, fields: { sex: s } } : { ok: false };
    }
    case 'height': {
      const h = parseHeight(t);
      return h ? { ok: true, fields: { height_cm: h } } : { ok: false };
    }
    case 'age': {
      const a = parseAge(t);
      return a ? { ok: true, fields: { age: a } } : { ok: false };
    }
    case 'activity': {
      const a = parseActivity(t);
      return a ? { ok: true, fields: { activity_level: a } } : { ok: false };
    }
    case 'dietary': {
      const fields = parseDiet(t);
      return fields ? { ok: true, fields } : { ok: false };
    }
    case 'dislikes': {
      const dislikes = parseDislikes(t);
      return dislikes ? { ok: true, fields: { food_dislikes: dislikes } } : { ok: false };
    }
    default:
      return { ok: false };
  }
}

// ── Question generation (LLM-phrased, varied; deterministic fallback) ─────────

const SLOT_BRIEF: Record<SlotId, string> = {
  first_name: 'their first name (so Grace can address them personally)',
  medication: 'which GLP-1 medication they take (e.g. Ozempic, Wegovy, Mounjaro, Zepbound)',
  medication_frequency: 'how often they take it — weekly or daily',
  injection_day: 'which day of the week they take their weekly shot',
  medication_time: 'what time of day they take their daily dose',
  timezone: 'their timezone — ask for their city or region, so check-ins and daily totals use their local time',
  goals: 'what they most want help with on GLP-1 (protein, hydration, side effects, weight, habits)',
  consent: 'a yes/no OK to text them daily check-ins',
  wake_sleep: 'what time they usually wake up and head to bed, so check-ins land at the right local hours',
  goal_weight: 'their goal weight, if they have one in mind (it is optional)',
  current_weight: 'their current weight, if they are comfortable sharing (it is optional)',
  sex: 'their biological sex (male/female/other) — only to get hydration and protein needs right',
  height: 'their height (cm or feet/inches) — to make calorie and protein targets accurate',
  age: 'their age — to make daily targets accurate',
  activity: 'how active they are day to day (mostly sitting, lightly active, or on the move)',
  dietary: 'whether they follow any diet or have foods they avoid or are allergic to',
  dislikes: 'foods they really dislike or want to avoid, so Grace never suggests them',
};

function fallbackQuestion(slot: SlotId, _name: string | null, reask: boolean): string {
  // No name/greeting prefix on follow-up questions: the opener already greeted
  // them, so leading every question with "Hey <name>," reads robotic + repetitive.
  const variants: Record<SlotId, string[]> = {
    first_name: ["Hey, I'm Grace 🧡 What should I call you?", "Hi, I'm Grace! What's your name?"],
    medication: [`Which GLP-1 are you on — Ozempic, Wegovy, Mounjaro, Zepbound, something else?`, `What medication are you taking?`, `Nice to meet you! So, which GLP-1 are you on?`],
    medication_frequency: [`Got it. Do you take it weekly or daily?`, `Is that a weekly shot or a daily dose?`, `Perfect — weekly or daily?`],
    injection_day: [`Which day do you usually do your shot?`, `What day's your injection?`, `And what day do you take it?`],
    medication_time: [`What time of day do you usually take it?`, `When do you take your daily dose — morning or evening?`, `Morning or evening for your dose?`],
    timezone: [`What timezone are you in? Just your city or region — it keeps your check-ins and daily totals on your local time.`, `Where are you based? (city or region) That way I send check-ins at the right time for you.`],
    goals: [`What would you most like my help with — protein, hydration, side effects, staying on track?`, `What matters most to you right now on this journey?`],
    consent: [`Is it ok if I check in with you by text now and then? (yes/no)`, `Want me to text you little check-ins? Just reply yes or no.`],
    wake_sleep: [`What time do you usually wake up, and when do you head to bed?`, `When's your usual wake-up and bedtime? Helps me check in at the right times.`],
    goal_weight: [`Do you have a goal weight in mind? (totally optional)`, `Any goal weight you're working toward? You can skip this.`],
    current_weight: [`If you're comfortable, what's your current weight? (optional)`, `Mind sharing your current weight? Feel free to skip.`],
    sex: [`Quick one so I get your protein and hydration needs right — what's your biological sex?`, `To dial in your targets, can I ask your biological sex? (male/female/other)`],
    height: [`How tall are you? It helps me set accurate targets.`, `What's your height? (cm or ft/in) — just to keep your numbers accurate.`],
    age: [`How old are you? It helps me get your daily targets right.`, `Mind sharing your age? It makes your targets more accurate.`],
    activity: [`How active are you day to day — mostly sitting, lightly active, or on the move?`, `Would you say you're mostly at a desk, or pretty active during the day?`],
    dietary: [`Do you follow any particular diet, or have foods you avoid or are allergic to?`, `Any diet you stick to, or foods I should keep out of suggestions?`],
    dislikes: [`Any foods you really don't like or want me to keep out of suggestions?`, `Last one — anything you can't stand or want me to avoid suggesting?`],
  };
  const opts = variants[slot];
  const base = opts[reask ? Math.min(1, opts.length - 1) : Math.floor(Math.random() * opts.length)]!;
  return reask ? `No worries — ${base}` : base;
}

/**
 * Build a warm, varied, personalized question for a slot. Uses the LLM when
 * available (so it's never the same wording twice and adapts to the user), and
 * falls back to a short rotating template otherwise. Always returns quickly.
 */
export async function generateQuestion(
  slot: SlotId,
  user: Pick<FlowUser, 'first_name'>,
  llm: LLMProvider | undefined,
  opts: { reask?: boolean; logger?: Logger } = {},
): Promise<string> {
  const reask = !!opts.reask;
  if (!llm) return fallbackQuestion(slot, user.first_name ?? null, reask);
  try {
    const system = `You are Grace, a warm, casual GLP-1 text companion onboarding a new user one quick question at a time — like a friend texting, never a form.
Write ONE short question (max ~140 chars) to learn ${SLOT_BRIEF[slot]}.
Rules: warm and natural, vary the wording, contractions ok, ${user.first_name ? `use their name "${user.first_name}" naturally` : 'no name yet'}, at most one tiny emoji, no lists, no preamble, plain text only — output just the question.${reask ? ' The user\'s last answer was unclear, so gently re-ask and make it a touch more concrete.' : ''}`;
    const resp = await Promise.race([
      llm.generate({ messages: [{ role: 'system', content: system }, { role: 'user', content: '(generate the question)' }], temperature: 0.85, maxOutputTokens: 80, disableThinking: true }),
      new Promise<{ text: string }>((r) => setTimeout(() => r({ text: '' }), 4000)),
    ]);
    const text = (resp.text ?? '').trim().replace(/^["']|["']$/g, '');
    if (text && /[A-Za-z]{3,}/.test(text)) return text.slice(0, 280);
  } catch (err) {
    opts.logger?.warn({ err: err instanceof Error ? err.message : String(err), slot }, 'onboarding.question.llm_failed');
  }
  return fallbackQuestion(slot, user.first_name ?? null, reask);
}

// A magnetic first message: introduce Grace compellingly AND ask the first
// question (their name) in one breath, so a new user wants to keep going instead
// of stalling after "hi". Confident + warm + value-forward, like a friend who's
// genuinely in your corner. NO fabricated stats / user counts (we don't claim
// numbers we can't back up).
const OPENER_FALLBACKS = [
  "Hi!! I'm Grace 🧡 and honestly I'm so glad you're here — this is the start of something really good. I'm going to be right here with you through all of it: the protein, the hard days, the little wins worth celebrating. First things first — what should I call you?",
  "Hey you 🧡 I'm Grace, and I have a really good feeling about us. Think of me as the friend in your pocket for this whole GLP-1 journey — I've got your back on the food stuff, the rough days, all of it. So tell me — what's your name?",
  "Oh hi 🧡 I'm Grace and I'm genuinely excited you found me. You don't have to do this alone anymore — I'm here for the questions, the wins, the messy middle, all of it. Let's make this fun. What should I call you?",
];

/**
 * The opening message for SMS signup — a warm, confident intro that ends by
 * asking the user's name. LLM-generated for variety with a strong rotating
 * fallback. This is the single most important message in the flow: it has to
 * make the user want to reply.
 */
export async function generateOpener(
  llm: LLMProvider | undefined,
  opts: { logger?: Logger } = {},
): Promise<string> {
  const fallback = OPENER_FALLBACKS[Math.floor(Math.random() * OPENER_FALLBACKS.length)]!;
  if (!llm) return fallback;
  try {
    const system = `You are Grace, a warm, bubbly, genuinely EXCITED GLP-1 text companion greeting a brand-new user for the very first time over iMessage. This is the first impression — it should make them light up and feel an instant connection, like a friend who's thrilled they showed up.
Write a SHORT opening message (2–3 sentences, max ~280 chars) that:
- introduces you as Grace and radiates warmth + genuine excitement that they're here ("so glad you're here", "I have a good feeling about us"),
- makes them feel they're not doing this alone — you're in their corner for the whole GLP-1 journey (protein, hydration, injection days, hard days, the wins) and you'll remember them,
- sparks a little anticipation that this will actually be enjoyable, not a chore,
- ENDS by warmly asking their first name.
Rules: sound like a real, excited friend texting — casual, warm, a little playful; confident not salesy; contractions; at most ONE emoji; no lists, no markdown, plain text only. NEVER invent statistics or user counts. Output just the message.`;
    const resp = await Promise.race([
      llm.generate({ messages: [{ role: 'system', content: system }, { role: 'user', content: '(write the opener)' }], temperature: 0.9, maxOutputTokens: 140, disableThinking: true }),
      new Promise<{ text: string }>((r) => setTimeout(() => r({ text: '' }), 4000)),
    ]);
    const text = (resp.text ?? '').trim().replace(/^["']|["']$/g, '');
    // Must actually ask something (end with a question) or we use the fallback.
    if (text && /[A-Za-z]{3,}/.test(text) && text.includes('?')) return text.slice(0, 320);
  } catch (err) {
    opts.logger?.warn({ err: err instanceof Error ? err.message : String(err) }, 'onboarding.opener.llm_failed');
  }
  return fallback;
}

/**
 * Re-engagement nudge for a user who STARTED signup but went quiet before
 * finishing. Warmly re-asks the slot we're waiting on so they can pick up where
 * they left off — no pressure, never a guilt trip. Returns null if there's no
 * pending slot to re-ask.
 */
export async function buildOnboardingNudge(
  user: Pick<FlowUser, 'first_name' | 'onboarding_last_slot'>,
  llm: LLMProvider | undefined,
  opts: { logger?: Logger } = {},
): Promise<string | null> {
  const slot = (user.onboarding_last_slot as SlotId | null) ?? null;
  if (!slot) return null;
  const q = await generateQuestion(slot, user, llm, { logger: opts.logger });
  const name = user.first_name ? `${user.first_name}, ` : '';
  return `Hey ${name}🧡 we were right in the middle of getting you set up — no rush at all. Whenever you've got a sec: ${q}`;
}

/**
 * The signup-complete message. Tomo-style: rather than just "you're all set," it
 * names the free trial that's now running and drops the checkout link so the
 * user can lock in their subscription — woven into the flow, never a hard wall.
 * Falls back to the plain confirmation when no checkout link is provided.
 */
export function buildSignupCompleteReply(firstName: string | null, upgradeUrl?: string): string {
  const greet = firstName ? `, ${firstName}` : '';
  if (upgradeUrl) {
    return `You're all set${greet} 🧡 Your 3-day free trial is on — daily check-ins, food & protein help, side-effect support, and someone who actually remembers your journey. To keep going after, lock it in here (I'll remind you before the trial ends): ${upgradeUrl}. For now just text me — log a meal, ask anything, or check in.`;
  }
  return `You're all set${greet} 🧡 I'm here whenever you need me — log a meal, ask a question, or just check in. Talk soon.`;
}

/**
 * LLM understanding fallback — fires ONLY when the deterministic parser can't
 * read the answer (a typo, abbreviation, slang, or roundabout phrasing the regex
 * missed). The LLM NORMALIZES the messy reply to a single clean value for the
 * slot; that value then goes back through parseSlotAnswer, so the deterministic
 * validators still gate what's stored (a hallucinated/garbage value is rejected).
 * Returns null when the LLM is absent, times out, or the answer truly isn't one.
 *
 * Examples it recovers: "1x a wk" → weekly · "evry day" → daily · "ozemic" →
 * Ozempic · "munjaro" → Mounjaro · "bout 120 kilos" → 120 · "im sara" → Sara.
 */
export async function understandSlotWithLlm(
  slot: SlotId,
  text: string,
  llm: LLMProvider | undefined,
  opts: { logger?: Logger } = {},
): Promise<ParsedAnswer | null> {
  if (!llm) return null;
  const system = `You normalize a new user's onboarding reply. They were asked for ${SLOT_BRIEF[slot]}.
Read their reply — it may have typos, abbreviations, slang, emojis, or extra words — and output ONLY the single normalized value as plain text, nothing else.
Rules: fix obvious typos and expand abbreviations. For how-often answers output exactly "weekly" or "daily". For a medication output the proper brand or ingredient name. For a weight or age output just the number. For a name output just the first name. If they don't know, decline, or it's unrelated/unclear, output exactly "NONE".`;
  try {
    const resp = await Promise.race([
      llm.generate({
        messages: [{ role: 'system', content: system }, { role: 'user', content: text }],
        temperature: 0,
        maxOutputTokens: 24,
        disableThinking: true,
      }),
      new Promise<{ text: string }>((r) => setTimeout(() => r({ text: '' }), 3500)),
    ]);
    const value = (resp.text ?? '').trim().replace(/^["']|["']$/g, '');
    if (!value || /^none\b/i.test(value)) return null;
    // Re-validate the LLM's normalized value through the deterministic parser —
    // never trust the LLM's output into storage without the same checks.
    const parsed = parseSlotAnswer(slot, value);
    return parsed.ok ? parsed : null;
  } catch (err) {
    opts.logger?.warn({ err: err instanceof Error ? err.message : String(err), slot }, 'onboarding.llm_understand.failed');
    return null;
  }
}

// ── Turn orchestration ───────────────────────────────────────────────────────

export interface OnboardingTurnResult {
  reply: string;
  completed: boolean;
}

/**
 * Run one onboarding turn. Reads onboarding state off `user`, parses the reply
 * into the slot we last asked, persists it, and asks the next slot — or finishes
 * (signup: starts the trial + records consent). Never throws; on internal error
 * it returns a gentle reply so the user is never left hanging.
 */
export async function runOnboardingTurn(params: {
  user: FlowUser;
  text: string;
  mode: 'signup' | 'gapfill';
  users: UserWriter;
  llm?: LLMProvider;
  logger: Logger;
  now?: Date;
  /** Checkout link surfaced in the signup-complete message (Tomo-style: the
   *  free-trial offer is woven into the flow). When omitted, the plain "you're
   *  all set" message is used (keeps existing tests/back-compat). */
  upgradeUrl?: string;
}): Promise<OnboardingTurnResult> {
  const { user, text, mode, users, llm, logger } = params;
  const now = params.now ?? new Date();
  // Local working copy so next-slot computation sees just-persisted values.
  let u: FlowUser = { ...user };

  // Next required slot AFTER the last one asked, skipping any already answered
  // (a multi-field reply can fill several at once). Walks the live sequence.
  const pickNext = (): SlotId | null => {
    const seq = mode === 'signup' ? signupSequence(u) : GAPFILL_SLOTS;
    const last = (u.onboarding_last_slot as SlotId | null);
    const startIdx = last ? seq.indexOf(last) + 1 : 0;
    for (let i = Math.max(0, startIdx); i < seq.length; i++) {
      const s = seq[i]!;
      if (s === 'consent') return s;       // always ask the opt-in explicitly
      if (!isSlotAnswered(u, s)) return s;  // skip slots already filled
    }
    return null;
  };

  try {
    const starting = u.onboarding_state !== 'in_progress';

    // First turn — greet (signup) and ask the first slot. We do NOT parse the
    // user's opening message as an answer (it's usually "hi"); volunteered facts
    // are still captured passively by the profile-learning extractor.
    if (starting) {
      const firstSlot = mode === 'signup' ? nextSignupSlot(u, null) : nextGapfillSlot(u);
      if (!firstSlot) {
        // Nothing to collect (gap-fill with no gaps) — mark done, stay silent.
        await users.update(u.phone, { onboarding_state: 'complete' } as Partial<GraceUser>);
        return { reply: '', completed: true };
      }
      await users.update(u.phone, {
        onboarding_state: 'in_progress',
        onboarding_last_slot: firstSlot,
        onboarding_started_at: now,
      } as Partial<GraceUser>);
      // Signup's first slot is the name — open with the magnetic intro+ask
      // (the ONE message worth an LLM call). Every other question is a fast,
      // deterministic, warm one-liner — no per-turn LLM call, so onboarding
      // feels instant and never repeats "Hey <name>," on each step.
      const q = mode === 'signup' && firstSlot === 'first_name'
        ? await generateOpener(llm, { logger })
        : fallbackQuestion(firstSlot, null, false);
      return { reply: q, completed: false };
    }

    // Continuing — parse the reply into the slot we last asked.
    const slot = (u.onboarding_last_slot as SlotId | null) ?? pickNext();
    if (!slot) {
      await users.update(u.phone, { onboarding_state: 'complete', onboarding_last_slot: null } as Partial<GraceUser>);
      return { reply: '', completed: true };
    }

    // Understand the reply: the current slot's answer (primary) PLUS any other
    // profile facts the message volunteered (multi-field, validated). A chatty
    // "I'm on ozempic once a week and want to get to 120kg" fills several slots
    // and skips ahead — never a robotic one-field-at-a-time march.
    const multi = extractAllFields(text);
    let parsed = parseSlotAnswer(slot, text);

    // Typo / slang / abbreviation tolerance: if neither the deterministic parser
    // NOR the multi-field scan understood the answer, let the LLM normalize it
    // (validated back through the parser) before giving up. Only on this miss
    // path — the clean common case never pays for an extra call, so onboarding
    // stays fast.
    if (!parsed.ok && Object.keys(multi).length === 0) {
      const recovered = await understandSlotWithLlm(slot, text, llm, { logger });
      if (recovered) parsed = recovered;
    }

    // Nothing understood for the slot we asked AND nothing else volunteered →
    // one friendly clarification (re-ask the same slot). A skip counts as
    // handled and advances.
    const understoodCurrent = parsed.ok || Object.keys(multi).length > 0;
    if (!understoodCurrent) {
      const q = fallbackQuestion(slot, null, true);
      return { reply: q, completed: false };
    }

    const updates: Partial<GraceUser> = { ...multi };
    if (parsed.ok && parsed.fields && !parsed.skipped) Object.assign(updates, parsed.fields);
    if (Object.keys(updates).length > 0) {
      await users.update(u.phone, updates);
      u = { ...u, ...updates } as FlowUser;
    }

    // Advance.
    u = { ...u, onboarding_last_slot: slot };
    let next = pickNext();

    // Auto-fill the timezone slot from the phone's country/area code so most
    // users are never asked (e.g. +972 → Asia/Jerusalem, +44 → Europe/London).
    // Only when we genuinely can't tell does the timezone question get asked.
    while (next === 'timezone') {
      const tz = timezoneFromPhone(u.phone);
      if (!tz) break;
      await users.update(u.phone, { timezone: tz } as Partial<GraceUser>);
      u = { ...u, timezone: tz, onboarding_last_slot: 'timezone' };
      logger.info({ phone: u.phone, tz }, 'onboarding.timezone.auto_from_phone');
      next = pickNext();
    }

    if (!next) {
      // Complete.
      if (mode === 'signup') {
        const finish: Partial<GraceUser> = { onboarding_state: 'complete', onboarding_last_slot: null };
        if (!u.trial_start) finish.trial_start = now; // start the trial via SMS signup
        await users.update(u.phone, finish);
        logger.info({ phone: u.phone, mode }, 'onboarding.completed');
        return {
          reply: buildSignupCompleteReply(u.first_name ?? null, params.upgradeUrl),
          completed: true,
        };
      }
      await users.update(u.phone, { onboarding_state: 'complete', onboarding_last_slot: null } as Partial<GraceUser>);
      logger.info({ phone: u.phone, mode }, 'onboarding.completed');
      return { reply: `Got it — thanks for sharing that 🧡`, completed: true };
    }

    await users.update(u.phone, { onboarding_last_slot: next } as Partial<GraceUser>);
    const q = fallbackQuestion(next, null, false);
    return { reply: q, completed: false };
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err), phone: user.phone }, 'onboarding.turn.error');
    return { reply: `Sorry, I got a bit tangled there — could you say that once more?`, completed: false };
  }
}
