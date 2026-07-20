/**
 * Conversational profile-learning — Nudge-style structured extraction for
 * DURABLE profile facts the user volunteers mid-conversation.
 *
 * Problem this solves (priority: keep the profile accurate over time):
 *   Onboarding captures the profile once. After that, when a user says
 *   "I switched from Ozempic to Mounjaro", "my dose is 5mg now", "I inject on
 *   Fridays now", or "my goal is 160", Grace historically kept using the STALE
 *   onboarding value — the classic registration-vs-recent-message conflict.
 *
 * How it works (mirrors food-extract.ts):
 *   1. A cheap deterministic pre-filter (mightStateProfileChange) gates the LLM
 *      call so the common turn (food, questions, emotion) never pays for it.
 *   2. One LLM pass returns STRICT JSON of changed fields.
 *   3. parseProfileUpdates validates/normalizes EVERY field deterministically
 *      (clamps, canonical formats) and drops no-op / invalid values — so a
 *      hallucinated or malformed field can never reach the users table.
 *   4. The caller persists via UserService.update (the structured profile is the
 *      highest-precedence context layer, so this resolves the conflict) and
 *      merges into the in-memory user so the SAME turn's reply is fresh.
 *
 * Deliberately EXCLUDED to avoid duplicating existing logic:
 *   - current_weight  → handled by the log-weight tool / weight-log fast path
 *   - dietary pattern  → handled by detectDietaryRestriction + setDietaryPattern
 *   - side effects     → handled by detectAndSetSideEffectFlow
 *
 * Safety: this only RECORDS what the user said about themselves. It never makes
 * a prescribing decision and never infers from questions/hypotheticals.
 *
 * Pure parsing/validation lives here so it can be unit-tested without an LLM.
 */
import type { LLMProvider } from '@grace/shared';
import type { Logger } from 'pino';

/** Kill-switch. Enabled by default; set PROFILE_LEARNING_ENABLED=false to disable. */
export const PROFILE_LEARNING_ENABLED = process.env.PROFILE_LEARNING_ENABLED !== 'false';

/** Model for this structured extraction pass. flash-lite is faster for JSON
 *  classification; revertible via GEMINI_EXTRACT_MODEL. A bad/unavailable id
 *  falls back to GEMINI_FALLBACK_MODEL in the provider, so learning never breaks. */
const EXTRACT_MODEL = process.env.GEMINI_EXTRACT_MODEL || 'gemini-2.5-flash-lite';

/** The subset of user fields we will learn from conversation. All keys are real
 *  `users` columns; values are already normalized to the stored format. */
export interface ProfileUpdates {
  medication?: string;
  medication_frequency?: 'weekly' | 'biweekly' | 'daily';
  injection_day?: string; // full capitalized weekday, e.g. "Friday"
  medication_time?: string; // "HH:MM"
  dose_mg?: number;
  goal_weight?: number; // lbs
  timezone?: string; // IANA
  wake_time?: string; // "HH:MM"
  sleep_time?: string; // "HH:MM"
  food_dislikes?: string[]; // FULL merged list (existing + new)
}

/** Current values, used to (a) seed the prompt so the model only reports
 *  CHANGES, and (b) diff so we never write a no-op. */
export interface ProfileSnapshot {
  medication: string | null;
  medication_frequency: string | null;
  injection_day: string | null;
  medication_time: string | null;
  dose_mg: number | null;
  goal_weight: number | null;
  timezone: string | null;
  wake_time: string | null;
  sleep_time: string | null;
  food_dislikes: string[];
}

export const EMPTY_UPDATES: ProfileUpdates = {};

/**
 * Parse the most common explicit profile corrections without an LLM. These
 * phrases are unambiguous, latency-sensitive, and too important to lose when a
 * provider returns malformed JSON. The model extractor still handles natural
 * language outside these narrow patterns.
 */
export function parseExplicitProfileUpdates(
  text: string,
  current: ProfileSnapshot,
): ProfileUpdates {
  const out: ProfileUpdates = {};
  const dose = text.match(/\b(?:i(?:'m| am)?\s+(?:currently\s+)?(?:take|taking)|my\s+dose\s+(?:is|=|:)|(?:now|currently)\s+(?:on|taking))\s+(\d+(?:\.\d+)?)\s*mg\b/i);
  if (dose?.[1]) {
    const value = normalizeDose(Number(dose[1]));
    if (value != null && value !== current.dose_mg) out.dose_mg = value;
  }
  const day = text.match(/\b(?:every|on)\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)s?\b/i);
  if (day?.[1]) {
    const normalized = normalizeDay(day[1]);
    if (normalized && normalized !== current.injection_day) out.injection_day = normalized;
  }
  return out;
}

// ── Deterministic pre-filter ────────────────────────────────────────────────
// Only run the LLM extractor when the message PLAUSIBLY states a durable
// self-change. Past-tense ("I used to be on…"), questions, and third-party
// mentions are intentionally NOT enough on their own — the LLM applies the
// strict rules; this is just a cheap "is it worth a call" gate.
const CHANGE_VERB =
  /\b(switch(?:ed|ing)?|chang(?:ed|ing|e)|start(?:ed|ing)?|stop(?:ped|ping)?|mov(?:ed|ing|e)|bump(?:ed|ing)?|up(?:ped|ping)?|lower(?:ed|ing)?|increas(?:ed|ing|e)|decreas(?:ed|ing|e)|adjust(?:ed|ing)?|set|update[d]?|now on|now taking|now inject|now use|put me on|got (?:put |moved )?on)\b/i;
const PROFILE_NOUN =
  /\b(ozempic|wegovy|mounjaro|zepbound|saxenda|rybelsus|trulicity|victoza|semaglutide|tirzepatide|liraglutide|compounded|dose|mg|injection|inject|shot|goal weight|target weight|timezone|time zone|wake|sleep|bed ?time|don'?t (?:like|eat)|hate|allerg|can'?t stand)\b/i;
const FIRST_PERSON = /\b(i|i'?m|im|my|me|we|our)\b/i;

/**
 * Cheap gate: does the message look like the user is stating a durable profile
 * change about themselves? False positives are fine (the LLM filters them);
 * false negatives just mean we miss a learn opportunity (no harm).
 */
export function mightStateProfileChange(text: string): boolean {
  const t = text.toLowerCase();
  if (t.length === 0 || t.length > 1000) return false;
  if (!FIRST_PERSON.test(t)) return false;
  // A clear change verb + a profile noun, OR explicit "my goal/dose/timezone is".
  if (CHANGE_VERB.test(t) && PROFILE_NOUN.test(t)) return true;
  if (/\bmy (?:dose|goal weight|target weight|goal|timezone|time zone|wake[- ]?up time|bed ?time|injection day) (?:is|=|:)\b/i.test(t)) return true;
  if (/\bi (?:now |currently )?(?:inject|take my shot|do my shot) on\b/i.test(t)) return true;
  // Natural correction order: "I'm taking 10 mg every Monday now." The prior
  // gate only recognized "now taking", so this common phrasing never reached
  // the validated extractor and fell through to the legacy Settings redirect.
  if (/\bi(?:'m| am)?\s+(?:currently\s+)?taking\b[\s\S]{0,50}\b\d+(?:\.\d+)?\s*mg\b/i.test(t)) return true;
  if (/\bi\s+(?:currently\s+)?take\b[\s\S]{0,50}\b\d+(?:\.\d+)?\s*mg\b/i.test(t)) return true;
  // Present/habitual injection-day statements the patterns above miss (still
  // NEVER past/abandoned — the extractor's own prompt guards that). e.g.
  // "my shot day is Saturday", "my injection is on Fridays", "I get my shot on Sundays".
  if (/\bmy (?:shot|injection|jab)(?: day)? (?:is|are) (?:on )?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)s?\b/i.test(t)) return true;
  if (/\bi (?:now |currently )?(?:get|have|do) my (?:shot|injection|jab) on\b/i.test(t)) return true;
  if (/\bi (?:really )?(?:don'?t (?:like|eat)|do\s+not\s+(?:like|eat)|hate|can'?t stand)\b/i.test(t)) return true;
  return false;
}

// ── Normalizers (deterministic, format-faithful) ────────────────────────────

const KNOWN_MEDS: Record<string, string> = {
  ozempic: 'Ozempic', wegovy: 'Wegovy', mounjaro: 'Mounjaro', zepbound: 'Zepbound',
  saxenda: 'Saxenda', rybelsus: 'Rybelsus', trulicity: 'Trulicity', victoza: 'Victoza',
  semaglutide: 'Semaglutide', tirzepatide: 'Tirzepatide', liraglutide: 'Liraglutide',
};

function titleCase(s: string): string {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Canonicalize a medication name. Returns null if it doesn't look like a real
 *  med name (e.g. contains a dose number, symbols, or is too long). */
export function normalizeMedication(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const lower = raw.trim().toLowerCase();
  if (!lower || lower.length > 120) return null;
  for (const [key, canon] of Object.entries(KNOWN_MEDS)) {
    if (new RegExp(`\\b${key}\\b`).test(lower)) {
      return lower.includes('compound') ? `Compounded ${canon}` : canon;
    }
  }
  if (lower.includes('compound')) return titleCase(lower);
  // Unknown med: accept only a short, clean alpha phrase (no digits/symbols that
  // would indicate the model grabbed a dose or junk).
  if (/^[a-z][a-z .'-]{1,40}$/.test(lower)) return titleCase(lower);
  return null;
}

/** GLP-1 dosing cadence is deterministic from the drug: Rybelsus (oral) and
 *  Saxenda/Victoza (liraglutide) are DAILY; Ozempic/Wegovy/Mounjaro/Zepbound and
 *  compounded semaglutide/tirzepatide are WEEKLY. Returns null when the drug is
 *  unknown so the caller keeps the user's own answer / the default. */
export function inferFrequencyFromMedication(medication: string | null | undefined): 'daily' | 'weekly' | null {
  if (!medication) return null;
  const m = medication.toLowerCase();
  if (/rybelsus|saxenda|victoza|liraglutide/.test(m)) return 'daily';
  if (/ozempic|wegovy|mounjaro|zepbound|semaglutide|tirzepatide/.test(m)) return 'weekly';
  return null;
}

export function normalizeFrequency(raw: unknown): ProfileUpdates['medication_frequency'] | null {
  if (typeof raw !== 'string') return null;
  const t = raw.toLowerCase();
  if (/\bdaily\b|every ?day|once a day|each day/.test(t)) return 'daily';
  if (/biweekly|bi-weekly|every other week|every two weeks|fortnight/.test(t)) return 'biweekly';
  if (/weekly|once a week|every week|each week/.test(t)) return 'weekly';
  return null;
}

const DAY_MAP: Record<string, string> = {
  sun: 'Sunday', sunday: 'Sunday', mon: 'Monday', monday: 'Monday',
  tue: 'Tuesday', tues: 'Tuesday', tuesday: 'Tuesday', wed: 'Wednesday', weds: 'Wednesday', wednesday: 'Wednesday',
  thu: 'Thursday', thur: 'Thursday', thurs: 'Thursday', thursday: 'Thursday',
  fri: 'Friday', friday: 'Friday', sat: 'Saturday', saturday: 'Saturday',
};

/** Normalize to a full capitalized weekday — the EXACT format the scheduler and
 *  injection-flow cron compare against (DAYS = ['Sunday'..'Saturday']). */
export function normalizeDay(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const key = raw.trim().toLowerCase().replace(/[^a-z]/g, '');
  // Accept plural phrasing ("Fridays", "Mondays") by dropping a trailing 's'
  // when the exact key isn't known.
  return DAY_MAP[key] ?? (key.endsWith('s') ? DAY_MAP[key.slice(0, -1)] ?? null : null);
}

/** Parse a time into "HH:MM" 24h. Accepts "6am", "6:30 pm", "18:30", "6", "06:00". */
export function normalizeTime(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const t = raw.trim().toLowerCase();
  const m = t.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (!m) return null;
  let h = parseInt(m[1]!, 10);
  const min = m[2] ? parseInt(m[2], 10) : 0;
  const mer = m[3];
  if (min > 59) return null;
  if (mer) {
    if (h < 1 || h > 12) return null;
    if (mer === 'am') h = h === 12 ? 0 : h;
    else h = h === 12 ? 12 : h + 12;
  }
  if (h > 23) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

export function normalizeDose(raw: unknown): number | null {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? parseFloat(raw) : NaN;
  if (!Number.isFinite(n) || n <= 0 || n > 100) return null;
  return Math.round(n * 100) / 100; // keep up to 2 decimals (e.g. 0.25, 2.4)
}

export function normalizeGoalWeight(raw: unknown): number | null {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? parseFloat(raw) : NaN;
  if (!Number.isFinite(n) || n < 80 || n > 600) return null;
  return Math.round(n);
}

export function isValidTimezone(raw: unknown): raw is string {
  if (typeof raw !== 'string' || !raw.includes('/')) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: raw });
    return true;
  } catch {
    return false;
  }
}

function normalizeDislike(s: unknown): string | null {
  if (typeof s !== 'string') return null;
  const v = s.trim().toLowerCase().replace(/[^a-z0-9 '-]/g, '').trim();
  if (v.length < 2 || v.length > 40) return null;
  return v;
}

// ── Prompt ──────────────────────────────────────────────────────────────────

function snapshotLine(s: ProfileSnapshot): string {
  const parts = [
    `medication=${s.medication ?? 'unknown'}`,
    `medication_frequency=${s.medication_frequency ?? 'unknown'}`,
    `injection_day=${s.injection_day ?? 'unknown'}`,
    `medication_time=${s.medication_time ?? 'unknown'}`,
    `dose_mg=${s.dose_mg ?? 'unknown'}`,
    `goal_weight=${s.goal_weight ?? 'unknown'}`,
    `timezone=${s.timezone ?? 'unknown'}`,
    `wake_time=${s.wake_time ?? 'unknown'}`,
    `sleep_time=${s.sleep_time ?? 'unknown'}`,
    `food_dislikes=${s.food_dislikes.length ? s.food_dislikes.join(', ') : 'none'}`,
  ];
  return parts.join('; ');
}

export function buildProfileExtractPrompt(current: ProfileSnapshot): string {
  return `You extract DURABLE profile changes the user states about THEMSELVES in their latest message.
Return STRICT JSON only:
{
  "medication": string|null,
  "medication_frequency": "weekly"|"biweekly"|"daily"|null,
  "injection_day": string|null,
  "medication_time": string|null,
  "dose_mg": number|null,
  "goal_weight": number|null,
  "timezone": string|null,
  "wake_time": string|null,
  "sleep_time": string|null,
  "food_dislikes": string[]|null
}

The user's CURRENT profile (only report a field if the message clearly states a DIFFERENT, NEW value):
${snapshotLine(current)}

HARD RULES — when unsure, return null. A wrong write corrupts the profile; a missed one is harmless.
- ONLY the user's own, CURRENT, durable facts stated as fact. First person, present/just-now tense.
- NEVER from a QUESTION ("should I switch to Mounjaro?", "what dose is normal?") → all null.
- NEVER from HYPOTHETICALS / future maybes ("I might switch", "thinking about 5mg") → all null.
- NEVER from PAST/abandoned facts ("I used to be on Ozempic", "I was injecting on Mondays") → all null.
- NEVER about another person ("my sister takes Wegovy", "my doctor is on…") → all null.
- NEVER infer a value that wasn't explicitly stated. Do not guess.
- dose_mg: only the user's OWN current dose in mg (e.g. "my dose is 5mg now" → 5). Not a dose they're asking about.
- goal_weight: the user's TARGET weight in lbs ("my goal is 160"). NOT their current weight.
- injection_day: the weekday of their weekly shot, from a PRESENT/habitual statement ("I inject on Fridays now" → "Friday"; "my shot day is Saturday" → "Saturday"; "I get my shot on Sundays" → "Sunday"). NEVER from an abandoned past ("I used to inject Mondays" → null).
- wake_time/sleep_time/medication_time: a clock time ("I wake at 6 now" → "06:00").
- timezone: an IANA zone only if clearly stated/derivable ("I moved to California" is NOT enough → null).
- food_dislikes: foods they say they dislike/won't eat ("I really don't like mushrooms" → ["mushrooms"]). Only NEW ones. NOT allergies phrased as medical ("I'm allergic to…") — leave those to medical handling → null.
- Report ONLY changed fields; set everything unchanged or uncertain to null.

Output ONLY the JSON object.`;
}

// ── Parse + validate + diff ─────────────────────────────────────────────────

const FREQ_VALUES = new Set(['weekly', 'biweekly', 'daily']);

/**
 * Validate/normalize the model JSON against `current`, returning ONLY fields
 * that are valid AND differ from the current value. Pure + deterministic.
 */
export function parseProfileUpdates(raw: string, current: ProfileSnapshot): ProfileUpdates {
  let parsed: unknown;
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(match ? match[0] : raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object') return {};
  const obj = parsed as Record<string, unknown>;
  const out: ProfileUpdates = {};

  const med = normalizeMedication(obj.medication);
  if (med && med.toLowerCase() !== (current.medication ?? '').toLowerCase()) out.medication = med;

  const freq = typeof obj.medication_frequency === 'string' && FREQ_VALUES.has(obj.medication_frequency.toLowerCase())
    ? (obj.medication_frequency.toLowerCase() as ProfileUpdates['medication_frequency'])
    : normalizeFrequency(obj.medication_frequency);
  if (freq && freq !== (current.medication_frequency ?? '').toLowerCase()) out.medication_frequency = freq;

  const day = normalizeDay(obj.injection_day);
  if (day && day !== current.injection_day) out.injection_day = day;

  const medTime = normalizeTime(obj.medication_time);
  if (medTime && medTime !== normalizeTime(current.medication_time)) out.medication_time = medTime;

  const dose = normalizeDose(obj.dose_mg);
  if (dose != null && dose !== current.dose_mg) out.dose_mg = dose;

  const goal = normalizeGoalWeight(obj.goal_weight);
  if (goal != null && goal !== current.goal_weight) out.goal_weight = goal;

  if (isValidTimezone(obj.timezone) && obj.timezone !== current.timezone) out.timezone = obj.timezone;

  const wake = normalizeTime(obj.wake_time);
  if (wake && wake !== normalizeTime(current.wake_time)) out.wake_time = wake;

  const sleep = normalizeTime(obj.sleep_time);
  if (sleep && sleep !== normalizeTime(current.sleep_time)) out.sleep_time = sleep;

  if (Array.isArray(obj.food_dislikes)) {
    const existing = current.food_dislikes.map((d) => d.toLowerCase());
    const seen = new Set(existing);
    const additions: string[] = [];
    for (const d of obj.food_dislikes) {
      const n = normalizeDislike(d);
      if (n && !seen.has(n)) { seen.add(n); additions.push(n); }
    }
    if (additions.length > 0) {
      // Persist the FULL merged list (the column is the whole array), capped.
      out.food_dislikes = [...current.food_dislikes, ...additions].slice(0, 40);
    }
  }

  return out;
}

/** Run the extraction LLM pass. Fails closed (no updates) on any error so a
 *  profile-shaped turn never crashes or corrupts anything. */
export async function extractProfileUpdates(
  llm: LLMProvider,
  logger: Logger,
  userMessage: string,
  current: ProfileSnapshot,
): Promise<ProfileUpdates> {
  try {
    const system = buildProfileExtractPrompt(current);
    const resp = await llm.generate({
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: userMessage },
      ],
      model: EXTRACT_MODEL,
      temperature: 0,
      maxOutputTokens: 250,
      responseFormat: 'json',
      disableThinking: true,
    });
    const out = parseProfileUpdates(resp.text ?? '', current);
    const fields = Object.keys(out);
    if (fields.length > 0) logger.info({ fields }, 'profile_extract.done');
    return out;
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'profile_extract.error');
    return {};
  }
}
