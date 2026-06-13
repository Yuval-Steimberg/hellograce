/**
 * Settings & Profile READ + Redirect Flow.
 *
 * The Settings page is the SINGLE SOURCE OF TRUTH for every registration /
 * profile / dietary / reminder field. Grace may READ these values in chat,
 * but she must NEVER create, save, overwrite, or confirm a change to them
 * from a chat message — doing so creates a conflicting second source of
 * truth. This handler runs as a short-circuit in webhook.ts BEFORE the AI
 * pipeline:
 *
 *   READ → answer directly + point at Settings:
 *     user: "what is my timezone?"
 *     Grace: "Your timezone is Asia/Jerusalem (Jerusalem).
 *             You can change it at https://graceglp.com/settings"
 *
 *   UPDATE (any profile/dietary field) → detect intent + redirect, no write:
 *     user: "change my goal weight to 170"  /  "I'm vegetarian now"
 *     Grace: "To keep your profile information accurate, dietary preferences
 *             and profile settings can only be updated from the Settings
 *             page. ... : https://graceglp.com/settings"
 *
 * The FIELDS registry below drives both detection paths — each entry's
 * readPatterns answer a question, updatePatterns trigger the redirect.
 *
 * SOLE EXCEPTION: injection_day UPDATE is handled earlier in webhook.ts by
 * detectInjectionDayChange (the established, approved in-chat flow). Every
 * other field — including check-in / reminder frequency — redirects to
 * Settings. Reminder-frequency requests are detected separately in
 * webhook.ts (isFrequencyChangeRequest) and get the reminder-specific
 * redirect; this module covers the rest.
 */

import type { GraceUser } from '../user/user.service.js';

/** Minimal logger surface accepted by this module. Compatible with both
 *  pino's `Logger` and Fastify's `FastifyBaseLogger`. */
interface MinimalLogger {
  info: (obj: object, msg?: string) => void;
  warn: (obj: object, msg?: string) => void;
  error: (obj: object, msg?: string) => void;
}

const SETTINGS_URL = 'https://graceglp.com/settings';

// Verbatim redirect for any profile / dietary change attempt. Grace detects
// the intent and sends this instead of mutating the profile — the Settings
// page is the single source of truth.
const PROFILE_REDIRECT =
  `To keep your profile information accurate, dietary preferences and profile ` +
  `settings can only be updated from the Settings page. Please update it there ` +
  `and I'll use the updated information moving forward: ${SETTINGS_URL}`;

// General settings/profile MODIFICATION intent — a modify verb + a settings/
// goal/profile field. Field nouns are SETTING phrasings ("protein goal", not
// bare "protein") so nutrition questions are not caught.
const MODIFY_VERB_RE =
  /\b(change|update|edit|modify|adjust|set|lower|raise|increase|decrease|reduce|fix|correct|switch|reset|customize|customise)\b/i;
const SETTINGS_FIELD_RE =
  /(protein\s*(?:goal|target)|calorie\s*(?:goal|target)|macro\s*(?:goal|target)s?|(?:goal|current|starting)\s*weight|weight\s*goal|\bheight\b|\bmy\s+age\b|\bmy\s+(?:sex|gender)\b|\bmy\s+name\b|time\s?zone|wake[\s-]*(?:time|up)|sleep[\s-]*(?:time|schedule)|\bmedication\b|\bmy\s+dose\b|\bdosage\b|primary\s+goal|\bmy\s+goals?\b|\bmy\s+diet(?:ary)?\b|food\s+(?:dislikes?|preferences?|restrictions?)|dietary\s+(?:preference|restriction)s?|\breminders?\b|check[\s-]?ins?|\bmy\s+profile\b|\bmy\s+settings?\b|\bpreferences?\b)/i;

export interface SettingsHandlerDeps {
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
  // Starting weight (2026-06-06 — added per coverage audit Area 8)
  {
    key: 'starting_weight',
    label: 'starting weight',
    readPatterns: [
      /^what(?:'?s| is)\s+my\s+(?:starting|start|initial|baseline|original)\s+weight\??$/i,
      /^what did i (?:start|begin) (?:at|with)\??$/i,
    ],
    updatePatterns: [
      /^(?:change|update|set)\s+my\s+(?:starting|start|initial|baseline|original)\s+weight\s+to\s+(.+?)\s*[.!?]?$/i,
      /^my\s+(?:starting|start|initial|baseline|original)\s+weight\s+(?:was|is)\s+(.+?)\s*[.!?]?$/i,
      /^i\s+started\s+at\s+(\d+(?:\.\d+)?\s*(?:lbs?|pounds?|kg|kilos?)?)\s*[.!?]?$/i,
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
    format: (u) => (u.starting_weight ? `${u.starting_weight} lbs` : null),
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
  // Check-in frequency — READ only (cadence-change requests are detected in
  // webhook.ts by isFrequencyChangeRequest and redirected to Settings).
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

// Dietary identity / preference changes ("I'm vegan now", "change my diet to
// keto", "I no longer keep kosher", "remember I don't eat meat"). These are
// profile settings → always redirect, never stored from chat. Patterns are
// deliberately conservative (require an explicit change signal like "now",
// "went", "change my diet", "no longer") so a passing mention such as
// "I'm vegan, what should I eat?" still flows to the food-ideas path.
const DIETARY_CHANGE_PATTERNS: RegExp[] = [
  /^i'?m\s+(?:a\s+)?(?:vegetarian|vegan|pescatarian|pescetarian|keto|kosher|halal|gluten[\s-]?free|dairy[\s-]?free)\s+now\b/i,
  /^i\s+(?:just\s+)?(?:went|became|turned)\s+(?:vegetarian|vegan|keto|gluten[\s-]?free|kosher|halal)\b/i,
  /\b(?:change|update|set|switch)\s+my\s+(?:diet\b|dietary\s+(?:preferences?|restrictions?)|food\s+(?:preferences?|restrictions?))/i,
  /^(?:please\s+)?(?:remember|note)\s+(?:that\s+)?i\s+(?:don'?t|do\s+not|can'?t)\s+eat\b/i,
  /\bi\s+no\s+longer\s+(?:keep|do|eat)\s+(?:kosher|halal|meat|dairy|gluten)\b/i,
];

// Food dislikes ADD patterns — explicit "I don't eat X" / "I'm allergic to X".
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
 * Inspect the user's message for a settings READ or a profile/dietary UPDATE
 * request. Reads are answered directly; update requests are REDIRECTED to the
 * Settings page (never applied from chat). Returns the reply Grace should
 * send, or null when the message has nothing to do with settings (caller
 * falls through to the normal AI pipeline).
 *
 * MUST be called AFTER the existing webhook short-circuits (opt-out, reminder
 * frequency, injection day change) so their established UX stays untouched.
 */
export async function tryHandleSettings(
  text: string,
  user: GraceUser,
  deps: SettingsHandlerDeps,
): Promise<string | null> {
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > 200) return null;

  // 0. GENERAL settings/profile MODIFICATION intent (2026-06-13).
  // A modify verb + a settings/goal/profile field → redirect to Settings, even
  // without a target value ("change my protein goal", "I want to update my
  // reminders", "edit my goal weight"). This distinguishes an ACTION (modify →
  // Settings) from an INFO request ("what's my protein goal" → answered by the
  // READ loop below) BEFORE the read path, so a change request is never
  // answered with the current value. Excludes injection-day (its own in-chat
  // handler) and check-in frequency (REMINDER_REDIRECT) — both run earlier in
  // the webhook. Production failure 2026-06-13: "Change my protein goal" →
  // "Your daily protein target is 114g" (treated as a read), then a clarify
  // loop. The field nouns are the SETTING phrasings ("protein goal", not bare
  // "protein") so nutrition questions ("how do I increase my protein intake")
  // are untouched.
  if (MODIFY_VERB_RE.test(trimmed) && SETTINGS_FIELD_RE.test(trimmed) && !/\binjection\s+day\b/i.test(trimmed)) {
    deps.logger.info({ userId: user.phone, action: 'settings_modify_redirect' }, 'settings_flow.modify_redirect');
    return PROFILE_REDIRECT;
  }

  // 1. READ request? Always allowed — Grace may read and use settings.
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

  // 2. UPDATE request? Grace must NEVER modify a profile field from chat —
  //    detect the intent and redirect to Settings (single source of truth).
  //    No DB write, no confirmation flow.
  for (const field of FIELDS) {
    if (field.updatePatterns.some((re) => re.test(trimmed))) {
      deps.logger.info(
        { userId: user.phone, field: field.key, action: 'update_redirected' },
        'settings_flow.update_redirected',
      );
      return PROFILE_REDIRECT;
    }
  }

  // 3. Dietary identity / preference change ("I'm vegan now", "change my
  //    diet", "I no longer keep kosher")? Profile setting → redirect.
  if (DIETARY_CHANGE_PATTERNS.some((re) => re.test(trimmed))) {
    deps.logger.info(
      { userId: user.phone, field: 'dietary', action: 'update_redirected' },
      'settings_flow.update_redirected',
    );
    return PROFILE_REDIRECT;
  }

  // 4. Food dislikes / allergies ("I don't eat eggs", "I'm allergic to fish")?
  //    Same rule — redirect to Settings. parseFoodToken guards against firing
  //    on non-food sentences ("I hate waiting", pronouns, clauses).
  for (const pattern of FOOD_DISLIKE_ADD_PATTERNS) {
    const m = pattern.exec(trimmed);
    if (!m) continue;
    const token = parseFoodToken(m[1] ?? '');
    if (!token) continue;
    deps.logger.info(
      { userId: user.phone, field: 'food_dislikes', action: 'update_redirected' },
      'settings_flow.update_redirected',
    );
    return PROFILE_REDIRECT;
  }

  return null;
}

// Test-only exports
export const __testing = {
  FIELDS,
  FOOD_DISLIKE_ADD_PATTERNS,
  DIETARY_CHANGE_PATTERNS,
  parseTimezone,
  parseMedication,
  parseSex,
  cmFromAnyHeight,
  formatHeight,
  parseFoodToken,
  TIMEZONE_MAP,
  PROFILE_REDIRECT,
};
