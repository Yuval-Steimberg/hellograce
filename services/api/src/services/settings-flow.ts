/**
 * Settings & Profile Update Flow (2026-06-06).
 *
 * Centralized handler for VIEWING and UPDATING any user profile field via
 * WhatsApp/SMS chat. Runs as a short-circuit in webhook.ts AFTER the
 * existing detectNaturalOptOut / detectFrequencyChange / detectInjectionDay
 * handlers (so their established UX stays untouched) and BEFORE the AI
 * pipeline.
 *
 * Two-phase update flow with confirmation:
 *
 *   user: "change my goal weight to 170"
 *   Grace: "Change your goal weight to 170 lbs? Reply yes to confirm."
 *   user: "yes"
 *   Grace: "Done — your goal weight is now 170 lbs."
 *
 * Pending updates live in Redis (`settings:pending:{phone}`, TTL 10 min) so
 * a "yes" after distraction still applies the right change, and the same
 * "yes" can't accidentally re-trigger an old pending update from yesterday.
 *
 * Read requests answer directly + always append the settings URL:
 *
 *   user: "what is my timezone?"
 *   Grace: "Your timezone is Asia/Jerusalem (Jerusalem).
 *           You can change it at https://graceglp.com/settings"
 *
 * The FIELDS registry below is the single source of truth — adding a new
 * settable field is one entry: key + label + readPatterns + updatePatterns
 * + parse + format. Tests in settings-flow.test.ts cover every field.
 *
 * Scope decisions (the brief calls for "all current and future user
 * profile fields" — these are MVP exclusions for safety / overlap):
 *   - injection_day UPDATE: skipped, handled by existing
 *     detectInjectionDayChange in webhook.ts (immediate, no confirmation,
 *     matches typo "injuction"). READ included here.
 *   - checkin_count_per_day UPDATE: skipped, handled by existing
 *     detectFrequencyChange in webhook.ts. READ included here.
 *   - protein_goal_grams / calorie_goal_kcal: READ only, UPDATE goes to
 *     settings URL — these are computed targets, not raw user input.
 *   - food_dislikes UPDATE: ADD mode only ("I don't eat eggs anymore",
 *     "I'm allergic to fish"). REMOVE goes to settings URL.
 */

import type { Redis } from 'ioredis';
import type { UserService, GraceUser } from '../user/user.service.js';

/** Minimal logger surface accepted by this module. Compatible with both
 *  pino's `Logger` and Fastify's `FastifyBaseLogger`. */
interface MinimalLogger {
  info: (obj: object, msg?: string) => void;
  warn: (obj: object, msg?: string) => void;
  error: (obj: object, msg?: string) => void;
}

const SETTINGS_URL = 'https://graceglp.com/settings';
const PENDING_TTL_SECONDS = 600; // 10 minutes
const PENDING_KEY_PREFIX = 'settings:pending:';

interface PendingUpdate {
  field: keyof GraceUser | 'food_dislikes_add';
  /** Canonical typed value to write. For food_dislikes_add this is the
   *  string token to append. */
  value: unknown;
  /** Human-readable representation of the new value for confirmation. */
  display: string;
  /** Field label for confirmation reply. */
  label: string;
  raw: string;
  ts: number;
}

export interface SettingsHandlerDeps {
  users: UserService;
  redis: Redis;
  logger: MinimalLogger;
}

interface FieldDef {
  key: keyof GraceUser;
  label: string;
  readPatterns: RegExp[];
  /** Each pattern must have a single capture group with the new value. */
  updatePatterns: RegExp[];
  /** Coerce captured raw value to typed value + display string. Return
   *  null on invalid input (handler asks user to re-send). */
  parse: (raw: string) => { value: unknown; display: string } | null;
  /** Format the stored value for a read reply. Return null when unset. */
  format: (user: GraceUser) => string | null;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const CONFIRMATION_RE = /^(?:yes|yep|yeah|yup|sure|ok|okay|confirm|confirmed|correct|that'?s right|right|do it|go ahead|please do|please|alright|absolutely)\s*[.!]?\s*$/i;
const CANCELLATION_RE = /^(?:no|nope|nah|cancel|stop|wait|don'?t|do not|not now|never mind|nevermind|hold on|wrong|that'?s wrong|incorrect)\s*[.!]?\s*$/i;

function isConfirmation(text: string): boolean {
  return CONFIRMATION_RE.test(text.trim());
}
function isCancellation(text: string): boolean {
  return CANCELLATION_RE.test(text.trim());
}

const TIMEZONE_MAP: Record<string, { iana: string; label: string }> = {
  'jerusalem': { iana: 'Asia/Jerusalem', label: 'Jerusalem' },
  'tel aviv': { iana: 'Asia/Jerusalem', label: 'Jerusalem' },
  'israel': { iana: 'Asia/Jerusalem', label: 'Jerusalem' },
  'new york': { iana: 'America/New_York', label: 'New York' },
  'nyc': { iana: 'America/New_York', label: 'New York' },
  'eastern': { iana: 'America/New_York', label: 'Eastern' },
  'est': { iana: 'America/New_York', label: 'Eastern' },
  'edt': { iana: 'America/New_York', label: 'Eastern' },
  'los angeles': { iana: 'America/Los_Angeles', label: 'Los Angeles' },
  'la': { iana: 'America/Los_Angeles', label: 'Los Angeles' },
  'pacific': { iana: 'America/Los_Angeles', label: 'Pacific' },
  'pst': { iana: 'America/Los_Angeles', label: 'Pacific' },
  'pdt': { iana: 'America/Los_Angeles', label: 'Pacific' },
  'chicago': { iana: 'America/Chicago', label: 'Chicago' },
  'central': { iana: 'America/Chicago', label: 'Central' },
  'cst': { iana: 'America/Chicago', label: 'Central' },
  'denver': { iana: 'America/Denver', label: 'Denver' },
  'mountain': { iana: 'America/Denver', label: 'Mountain' },
  'mst': { iana: 'America/Denver', label: 'Mountain' },
  'london': { iana: 'Europe/London', label: 'London' },
  'uk': { iana: 'Europe/London', label: 'London' },
  'paris': { iana: 'Europe/Paris', label: 'Paris' },
  'berlin': { iana: 'Europe/Berlin', label: 'Berlin' },
  'madrid': { iana: 'Europe/Madrid', label: 'Madrid' },
  'rome': { iana: 'Europe/Rome', label: 'Rome' },
  'amsterdam': { iana: 'Europe/Amsterdam', label: 'Amsterdam' },
  'sydney': { iana: 'Australia/Sydney', label: 'Sydney' },
  'tokyo': { iana: 'Asia/Tokyo', label: 'Tokyo' },
  'singapore': { iana: 'Asia/Singapore', label: 'Singapore' },
  'dubai': { iana: 'Asia/Dubai', label: 'Dubai' },
  'toronto': { iana: 'America/Toronto', label: 'Toronto' },
  'mexico city': { iana: 'America/Mexico_City', label: 'Mexico City' },
  'utc': { iana: 'UTC', label: 'UTC' },
  'gmt': { iana: 'UTC', label: 'UTC' },
};

function parseTimezone(raw: string): { value: string; display: string } | null {
  const t = raw.trim().toLowerCase().replace(/[.,!?]+$/, '').trim();
  const direct = TIMEZONE_MAP[t];
  if (direct) return { value: direct.iana, display: `${direct.iana} (${direct.label})` };
  // Accept literal IANA strings (e.g. "Asia/Jerusalem") if they match the
  // format Region/City.
  if (/^[A-Za-z]+\/[A-Za-z_]+$/.test(raw.trim())) {
    return { value: raw.trim(), display: raw.trim() };
  }
  return null;
}

const MEDICATIONS = ['ozempic', 'wegovy', 'mounjaro', 'zepbound', 'rybelsus', 'saxenda', 'victoza', 'trulicity', 'compounded semaglutide', 'compounded tirzepatide'] as const;
function parseMedication(raw: string): { value: string; display: string } | null {
  const t = raw.trim().toLowerCase().replace(/[.,!?]+$/, '');
  for (const m of MEDICATIONS) {
    if (t.includes(m)) {
      const display = m.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
      return { value: display, display };
    }
  }
  return null;
}

function parsePositiveNumber(raw: string, min: number, max: number): number | null {
  const m = /(\d+(?:\.\d+)?)/.exec(raw);
  if (!m) return null;
  const n = parseFloat(m[1]!);
  if (!Number.isFinite(n) || n < min || n > max) return null;
  return n;
}

function parseSex(raw: string): { value: string; display: string } | null {
  const t = raw.trim().toLowerCase();
  if (/^(?:m|male|man|guy)$/.test(t)) return { value: 'male', display: 'male' };
  if (/^(?:f|female|woman|girl)$/.test(t)) return { value: 'female', display: 'female' };
  if (/^(?:nb|non-?binary|nonbinary|enby|other)$/.test(t)) return { value: 'nonbinary', display: 'non-binary' };
  return null;
}

function cmFromAnyHeight(raw: string): number | null {
  // "175 cm" / "175cm"
  let m = /(\d{2,3}(?:\.\d+)?)\s*cm\b/i.exec(raw);
  if (m) {
    const cm = parseFloat(m[1]!);
    return cm >= 80 && cm <= 250 ? cm : null;
  }
  // "5'10" / "5'10''" / "5'10\""
  m = /(\d)\s*['’]\s*(\d{1,2})\s*(?:''|"|”|in|inches)?/i.exec(raw);
  if (m) {
    const ft = parseInt(m[1]!, 10);
    const inch = parseInt(m[2]!, 10);
    if (ft >= 3 && ft <= 8 && inch >= 0 && inch < 12) {
      return Math.round((ft * 12 + inch) * 2.54);
    }
  }
  // Plain number → assume cm if 90-250, inches if <90
  m = /^(\d{2,3}(?:\.\d+)?)$/.exec(raw.trim());
  if (m) {
    const n = parseFloat(m[1]!);
    if (n >= 90 && n <= 250) return n;
    if (n >= 36 && n < 90) return Math.round(n * 2.54);
  }
  return null;
}

function formatHeight(cm: number): string {
  const totalIn = Math.round(cm / 2.54);
  const ft = Math.floor(totalIn / 12);
  const inch = totalIn % 12;
  return `${cm} cm (${ft}'${inch}")`;
}

// ─── Field registry ──────────────────────────────────────────────────────────

const FIELDS: FieldDef[] = [
  // Timezone
  {
    key: 'timezone',
    label: 'timezone',
    readPatterns: [
      /^what(?:'?s| is)\s+my\s+(?:time\s?zone|tz)\??$/i,
      /^(?:what'?s|whats|what is)\s+my\s+timezone\??$/i,
    ],
    updatePatterns: [
      /^(?:change|update|set|switch|move)\s+my\s+(?:time\s?zone|tz)\s+to\s+(.+?)\s*[.!?]?$/i,
      /^my\s+(?:time\s?zone|tz)\s+is\s+(?:now\s+)?(.+?)\s*[.!?]?$/i,
      /^i'?m\s+(?:in|on)\s+(.+?)\s+(?:time|timezone|tz)\s*[.!?]?$/i,
    ],
    parse: parseTimezone,
    format: (u) => {
      if (!u.timezone) return null;
      const friendly = Object.values(TIMEZONE_MAP).find((t) => t.iana === u.timezone);
      return friendly ? `${u.timezone} (${friendly.label})` : u.timezone;
    },
  },
  // Injection day — READ only (UPDATE handled by detectInjectionDayChange)
  {
    key: 'injection_day',
    label: 'injection day',
    readPatterns: [
      /^what(?:'?s| is)\s+my\s+(?:injection|shot|jab|dose)\s+day\??$/i,
      /^when\s+(?:do\s+i|is\s+my)\s+(?:injection|shot|jab|dose)\??$/i,
    ],
    updatePatterns: [],
    parse: () => null,
    format: (u) => (u.injection_day ? u.injection_day : null),
  },
  // Medication
  {
    key: 'medication',
    label: 'medication',
    readPatterns: [
      /^what(?:'?s| is)\s+my\s+(?:medication|med|drug|prescription)\??$/i,
      /^what\s+am\s+i\s+(?:taking|on)\??$/i,
    ],
    updatePatterns: [
      /^(?:change|update|set|switch)\s+my\s+(?:medication|med|drug)\s+to\s+(.+?)\s*[.!?]?$/i,
      /^my\s+(?:medication|med|drug)\s+is\s+(?:now\s+)?(.+?)\s*[.!?]?$/i,
      /^i\s+(?:switched|moved|changed)\s+to\s+(.+?)\s*[.!?]?$/i,
      /^i'?m\s+(?:now\s+)?(?:taking|on)\s+(.+?)\s*[.!?]?$/i,
    ],
    parse: parseMedication,
    format: (u) => u.medication,
  },
  // Dose
  {
    key: 'dose_mg',
    label: 'dose',
    readPatterns: [
      /^what(?:'?s| is)\s+my\s+(?:dose|dosage)\??$/i,
      /^how\s+much\s+(?:am\s+i\s+(?:on|taking)|do\s+i\s+take)\??$/i,
    ],
    updatePatterns: [
      /^(?:change|update|set|switch|move|bump)\s+my\s+dose\s+to\s+(.+?)\s*[.!?]?$/i,
      /^my\s+dose\s+is\s+(?:now\s+)?(.+?)\s*[.!?]?$/i,
      /^i'?m\s+(?:now\s+)?on\s+(\d+(?:\.\d+)?\s*mg)\s*[.!?]?$/i,
      /^i\s+(?:moved|bumped|escalated)\s+(?:up\s+)?to\s+(\d+(?:\.\d+)?\s*mg)\s*[.!?]?$/i,
    ],
    parse: (raw) => {
      const n = parsePositiveNumber(raw, 0.1, 20);
      if (n === null) return null;
      return { value: n, display: `${n} mg` };
    },
    format: (u) => (u.dose_mg ? `${u.dose_mg} mg` : null),
  },
  // Current weight
  {
    key: 'current_weight',
    label: 'current weight',
    readPatterns: [
      /^what(?:'?s| is)\s+my\s+(?:current\s+)?weight\??$/i,
      /^how\s+much\s+do\s+i\s+weigh\??$/i,
    ],
    updatePatterns: [
      /^(?:change|update|set)\s+my\s+(?:current\s+)?weight\s+to\s+(.+?)\s*[.!?]?$/i,
      /^my\s+(?:current\s+)?weight\s+is\s+(?:now\s+)?(.+?)\s*[.!?]?$/i,
      /^i\s+(?:weigh|weighed)\s+(\d+(?:\.\d+)?\s*(?:lbs?|pounds?|kg|kilos?)?)\s*(?:now)?\s*[.!?]?$/i,
    ],
    parse: (raw) => {
      const m = /(\d+(?:\.\d+)?)\s*(lbs?|pounds?|kg|kilos?)?/i.exec(raw);
      if (!m) return null;
      let n = parseFloat(m[1]!);
      const unit = (m[2] ?? '').toLowerCase();
      if (unit.startsWith('kg') || unit.startsWith('kilo')) n = Math.round(n * 2.205 * 10) / 10;
      if (!Number.isFinite(n) || n < 60 || n > 700) return null;
      return { value: n, display: `${n} lbs` };
    },
    format: (u) => (u.current_weight ? `${u.current_weight} lbs` : null),
  },
  // Goal weight
  {
    key: 'goal_weight',
    label: 'goal weight',
    readPatterns: [
      /^what(?:'?s| is)\s+my\s+(?:goal|target)\s+weight\??$/i,
      /^what(?:'?s| is)\s+my\s+weight\s+(?:goal|target)\??$/i,
    ],
    updatePatterns: [
      /^(?:change|update|set|move)\s+my\s+(?:goal|target)\s+weight\s+to\s+(.+?)\s*[.!?]?$/i,
      /^(?:change|update|set|move)\s+my\s+weight\s+(?:goal|target)\s+to\s+(.+?)\s*[.!?]?$/i,
      /^my\s+(?:goal|target)\s+weight\s+is\s+(?:now\s+)?(.+?)\s*[.!?]?$/i,
      /^my\s+(?:goal|target)\s+weight\s+changed\s+to\s+(.+?)\s*[.!?]?$/i,
    ],
    parse: (raw) => {
      const m = /(\d+(?:\.\d+)?)\s*(lbs?|pounds?|kg|kilos?)?/i.exec(raw);
      if (!m) return null;
      let n = parseFloat(m[1]!);
      const unit = (m[2] ?? '').toLowerCase();
      if (unit.startsWith('kg') || unit.startsWith('kilo')) n = Math.round(n * 2.205 * 10) / 10;
      if (!Number.isFinite(n) || n < 60 || n > 700) return null;
      return { value: n, display: `${n} lbs` };
    },
    format: (u) => (u.goal_weight ? `${u.goal_weight} lbs` : null),
  },
  // Height
  {
    key: 'height_cm',
    label: 'height',
    readPatterns: [
      /^what(?:'?s| is)\s+my\s+height\??$/i,
      /^how\s+tall\s+am\s+i\??$/i,
    ],
    updatePatterns: [
      /^(?:change|update|set)\s+my\s+height\s+to\s+(.+?)\s*[.!?]?$/i,
      /^my\s+height\s+is\s+(?:now\s+)?(.+?)\s*[.!?]?$/i,
      /^i'?m\s+(\d(?:'\d{1,2}'?'?|\s+(?:ft|feet)\s+\d{1,2}(?:\s+(?:in|inches))?|\s*\d{2,3}\s*cm))\s*(?:tall)?\s*[.!?]?$/i,
    ],
    parse: (raw) => {
      const cm = cmFromAnyHeight(raw);
      if (cm === null) return null;
      return { value: cm, display: formatHeight(cm) };
    },
    format: (u) => (u.height_cm ? formatHeight(u.height_cm) : null),
  },
  // Sex
  {
    key: 'sex',
    label: 'sex',
    readPatterns: [
      /^what(?:'?s| is)\s+my\s+sex\??$/i,
      /^what(?:'?s| is)\s+my\s+gender\??$/i,
    ],
    updatePatterns: [
      /^(?:change|update|set)\s+my\s+(?:sex|gender)\s+to\s+(.+?)\s*[.!?]?$/i,
      /^my\s+(?:sex|gender)\s+is\s+(?:now\s+)?(.+?)\s*[.!?]?$/i,
      /^i'?m\s+(male|female|man|woman|nonbinary|non-binary|nb)\s*[.!?]?$/i,
    ],
    parse: parseSex,
    format: (u) => u.sex,
  },
  // First name
  {
    key: 'first_name',
    label: 'name',
    readPatterns: [
      /^what(?:'?s| is)\s+my\s+name\??$/i,
      /^do\s+you\s+(?:know|remember)\s+my\s+name\??$/i,
    ],
    updatePatterns: [
      /^(?:change|update|set)\s+my\s+(?:first\s+)?name\s+to\s+(.+?)\s*[.!?]?$/i,
      /^my\s+(?:first\s+)?name\s+is\s+(?:now\s+)?(.+?)\s*[.!?]?$/i,
      /^call\s+me\s+(.+?)\s*[.!?]?$/i,
    ],
    parse: (raw) => {
      const t = raw.trim().replace(/[.,!?]+$/, '').trim();
      if (t.length < 1 || t.length > 40) return null;
      if (!/^[A-Za-z][A-Za-z'\- ]{0,39}$/.test(t)) return null;
      // Capitalize first letter
      const display = t.split(/\s+/).map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
      return { value: display, display };
    },
    format: (u) => u.first_name,
  },
  // Age
  {
    key: 'age',
    label: 'age',
    readPatterns: [
      /^what(?:'?s| is)\s+my\s+age\??$/i,
      /^how\s+old\s+am\s+i\??$/i,
    ],
    updatePatterns: [
      /^(?:change|update|set)\s+my\s+age\s+to\s+(\d{1,3})\s*[.!?]?$/i,
      /^my\s+age\s+is\s+(?:now\s+)?(\d{1,3})\s*[.!?]?$/i,
      /^i'?m\s+(\d{1,3})\s*(?:years?\s*old)?\s*[.!?]?$/i,
    ],
    parse: (raw) => {
      const n = parsePositiveNumber(raw, 13, 110);
      if (n === null) return null;
      return { value: Math.round(n), display: `${Math.round(n)}` };
    },
    format: (u) => (u.age ? `${u.age}` : null),
  },
  // Primary goal
  {
    key: 'primary_goal',
    label: 'primary goal',
    readPatterns: [
      /^what(?:'?s| is)\s+my\s+(?:primary\s+)?goal\??$/i,
    ],
    updatePatterns: [
      /^(?:change|update|set)\s+my\s+(?:primary\s+)?goal\s+to\s+(.+?)\s*[.!?]?$/i,
      /^my\s+(?:primary\s+)?goal\s+is\s+(?:now\s+)?(.+?)\s*[.!?]?$/i,
    ],
    parse: (raw) => {
      const t = raw.trim().toLowerCase().replace(/[.,!?]+$/, '').trim();
      const map: Record<string, string> = {
        'fat loss': 'fat_loss', 'fat_loss': 'fat_loss', 'weight loss': 'fat_loss', 'lose weight': 'fat_loss',
        'recomp': 'recomp', 'body recomposition': 'recomp', 'recomposition': 'recomp',
        'maintenance': 'maintenance', 'maintain': 'maintenance', 'maintaining': 'maintenance',
        'muscle gain': 'muscle_gain', 'muscle_gain': 'muscle_gain', 'gain muscle': 'muscle_gain', 'build muscle': 'muscle_gain',
      };
      const canonical = map[t];
      if (!canonical) return null;
      return { value: canonical, display: canonical.replace('_', ' ') };
    },
    format: (u) => (u.primary_goal ? u.primary_goal.replace('_', ' ') : null),
  },
  // Check-in frequency — READ only (UPDATE handled by detectFrequencyChange)
  {
    key: 'checkin_count_per_day',
    label: 'check-in frequency',
    readPatterns: [
      /^what(?:'?s| is)\s+my\s+check[\s-]?in\s+(?:frequency|count|schedule)\??$/i,
      /^how\s+(?:many|often)\s+(?:check[\s-]?ins|times)\s+per\s+day\??$/i,
    ],
    updatePatterns: [],
    parse: () => null,
    format: (u) => `${u.checkin_count_per_day ?? 1} per day`,
  },
  // Food dislikes — READ + ADD (REMOVE via settings URL)
  {
    key: 'food_dislikes',
    label: 'food dislikes',
    readPatterns: [
      /^what\s+(?:foods?\s+)?(?:do\s+i\s+)?(?:dislike|avoid|hate)\??$/i,
      /^what\s+(?:are\s+)?my\s+(?:food\s+)?(?:dislikes|allergies|aversions)\??$/i,
    ],
    updatePatterns: [], // handled below specially because adds vs replaces
    parse: () => null,
    format: (u) => {
      const d = u.food_dislikes ?? [];
      if (d.length === 0) return null;
      return d.join(', ');
    },
  },
];

// Food dislikes ADD patterns — separate because they APPEND not REPLACE.
const FOOD_DISLIKE_ADD_PATTERNS: RegExp[] = [
  /^i\s+don'?t\s+eat\s+(.+?)(?:\s+anymore)?\s*[.!?]?$/i,
  /^i\s+do\s+not\s+eat\s+(.+?)(?:\s+anymore)?\s*[.!?]?$/i,
  /^i\s+(?:hate|dislike|can'?t\s+stand|avoid)\s+(.+?)\s*[.!?]?$/i,
  /^i'?m\s+allergic\s+to\s+(.+?)\s*[.!?]?$/i,
  /^add\s+(.+?)\s+to\s+my\s+(?:dislikes|food\s+dislikes|allergies)\s*[.!?]?$/i,
  /^no\s+more\s+(.+?)\s+for\s+me\s*[.!?]?$/i,
];

function parseFoodToken(raw: string): string | null {
  const t = raw.trim().toLowerCase().replace(/[.,!?]+$/, '').trim();
  // Reject anything that looks like a sentence rather than a food token
  if (t.length < 2 || t.length > 40) return null;
  if (/^(it|that|those|them|things?|food|stuff|anything|everything|much|that\s+much)$/.test(t)) return null;
  if (/\b(because|since|when|why|how|the\s+other|today|yesterday|tomorrow)\b/.test(t)) return null;
  return t;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Inspect the user's message for a settings READ, UPDATE, or pending-update
 * CONFIRMATION/CANCELLATION. Returns the reply Grace should send, or null
 * when the message has nothing to do with settings (caller falls through
 * to the normal AI pipeline).
 *
 * MUST be called AFTER the existing webhook short-circuits (opt-out,
 * frequency change, injection day change) so their established UX
 * stays untouched.
 */
export async function tryHandleSettings(
  text: string,
  user: GraceUser,
  deps: SettingsHandlerDeps,
): Promise<string | null> {
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > 200) return null;

  const pendingKey = PENDING_KEY_PREFIX + user.phone;

  // 1. Pending update? Check confirmation/cancellation FIRST.
  let pending: PendingUpdate | null = null;
  try {
    const raw = await deps.redis.get(pendingKey);
    if (raw) pending = JSON.parse(raw) as PendingUpdate;
  } catch (err) {
    deps.logger.warn(
      { err: err instanceof Error ? err.message : String(err), userId: user.phone },
      'settings_flow.redis_get_failed',
    );
  }

  if (pending) {
    if (isConfirmation(trimmed)) {
      try {
        await applyPending(user.phone, pending, deps);
        await deps.redis.del(pendingKey).catch(() => undefined);
        deps.logger.info(
          { userId: user.phone, field: pending.field },
          'settings_flow.applied',
        );
        return `Done — your ${pending.label} is now ${pending.display}.`;
      } catch (err) {
        deps.logger.error(
          { err: err instanceof Error ? err.message : String(err), userId: user.phone, field: pending.field },
          'settings_flow.apply_failed',
        );
        await deps.redis.del(pendingKey).catch(() => undefined);
        return `I hit a hiccup saving that change. Try again, or update it at ${SETTINGS_URL}`;
      }
    }
    if (isCancellation(trimmed)) {
      await deps.redis.del(pendingKey).catch(() => undefined);
      deps.logger.info(
        { userId: user.phone, field: pending.field },
        'settings_flow.cancelled',
      );
      return `Got it — leaving your ${pending.label} as it was.`;
    }
    // Anything else: drop the pending update (user moved on) and treat the
    // current message as a fresh turn (falls through to detection below).
    await deps.redis.del(pendingKey).catch(() => undefined);
    deps.logger.info(
      { userId: user.phone, field: pending.field },
      'settings_flow.pending_dropped',
    );
  }

  // 2. READ request?
  for (const field of FIELDS) {
    if (field.readPatterns.some((re) => re.test(trimmed))) {
      const display = field.format(user);
      deps.logger.info(
        { userId: user.phone, field: field.key, action: 'read' },
        'settings_flow.read',
      );
      if (display !== null) {
        return `Your ${field.label} is ${display}.\nYou can change it at ${SETTINGS_URL}`;
      }
      return `You haven't set your ${field.label} yet. You can add it at ${SETTINGS_URL}`;
    }
  }

  // 3. UPDATE request?
  for (const field of FIELDS) {
    for (const pattern of field.updatePatterns) {
      const m = pattern.exec(trimmed);
      if (!m) continue;
      const rawValue = (m[1] ?? '').trim();
      if (!rawValue) continue;
      const parsed = field.parse(rawValue);
      if (!parsed) {
        return `I didn't catch the new ${field.label}. Try sending it like "set my ${field.label} to ___" or update it at ${SETTINGS_URL}`;
      }
      const update: PendingUpdate = {
        field: field.key,
        value: parsed.value,
        display: parsed.display,
        label: field.label,
        raw: trimmed,
        ts: Date.now(),
      };
      try {
        await deps.redis.set(pendingKey, JSON.stringify(update), 'EX', PENDING_TTL_SECONDS);
      } catch (err) {
        deps.logger.warn(
          { err: err instanceof Error ? err.message : String(err), userId: user.phone },
          'settings_flow.redis_set_failed',
        );
        return null;
      }
      deps.logger.info(
        { userId: user.phone, field: field.key, action: 'update_pending' },
        'settings_flow.update_pending',
      );
      return `Change your ${field.label} to ${parsed.display}? Reply yes to confirm.`;
    }
  }

  // 4. Food dislikes ADD?
  for (const pattern of FOOD_DISLIKE_ADD_PATTERNS) {
    const m = pattern.exec(trimmed);
    if (!m) continue;
    const token = parseFoodToken(m[1] ?? '');
    if (!token) continue;
    const existing = (user.food_dislikes ?? []).map((d) => d.toLowerCase());
    if (existing.includes(token)) {
      return `Already noted that you avoid ${token}. You can review all your preferences at ${SETTINGS_URL}`;
    }
    const update: PendingUpdate = {
      field: 'food_dislikes_add',
      value: token,
      display: token,
      label: 'food dislikes',
      raw: trimmed,
      ts: Date.now(),
    };
    try {
      await deps.redis.set(pendingKey, JSON.stringify(update), 'EX', PENDING_TTL_SECONDS);
    } catch (err) {
      deps.logger.warn(
        { err: err instanceof Error ? err.message : String(err), userId: user.phone },
        'settings_flow.redis_set_failed',
      );
      return null;
    }
    deps.logger.info(
      { userId: user.phone, field: 'food_dislikes_add', action: 'update_pending' },
      'settings_flow.update_pending',
    );
    return `Add ${token} to your food dislikes? Reply yes to confirm.`;
  }

  return null;
}

async function applyPending(
  phone: string,
  pending: PendingUpdate,
  deps: SettingsHandlerDeps,
): Promise<void> {
  if (pending.field === 'food_dislikes_add') {
    // Append to the existing array — fetch current to avoid race with admin edits.
    const fresh = await deps.users.getByPhone(phone);
    const current = fresh?.food_dislikes ?? [];
    const token = String(pending.value);
    if (current.map((d) => d.toLowerCase()).includes(token.toLowerCase())) return;
    await deps.users.update(phone, { food_dislikes: [...current, token] });
    return;
  }
  await deps.users.update(phone, { [pending.field]: pending.value } as Partial<GraceUser>);
}

// Test-only exports
export const __testing = {
  FIELDS,
  FOOD_DISLIKE_ADD_PATTERNS,
  isConfirmation,
  isCancellation,
  parseTimezone,
  parseMedication,
  parseSex,
  cmFromAnyHeight,
  formatHeight,
  parseFoodToken,
  TIMEZONE_MAP,
  PENDING_KEY_PREFIX,
  PENDING_TTL_SECONDS,
};
