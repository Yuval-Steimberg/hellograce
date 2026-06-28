/**
 * Parse a free-text timezone answer ("New York", "California", "Israel",
 * "pacific time", "EST", "London") into a valid IANA timezone name
 * ("America/New_York", …). Used by the conversational onboarding so a user's
 * reminders + daily totals run on their REAL local time from day one, instead
 * of the America/New_York default.
 *
 * Returns null when the answer can't be confidently mapped (the caller re-asks
 * or keeps the temporary default). Every result is validated against
 * Intl.DateTimeFormat, so we never store an invalid zone. IANA names mean DST is
 * handled automatically — we never store raw UTC offsets.
 */

/** True if `tz` is a real IANA zone the runtime accepts. */
export function isValidIanaTimezone(tz: string): boolean {
  if (!tz || !tz.includes('/')) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// Ordered keyword → IANA table. Each entry's regex is matched against the
// normalized answer; first hit wins, so put more-specific entries first.
const ZONE_PATTERNS: Array<[RegExp, string]> = [
  // ── United States ──────────────────────────────────────────────────────
  [/\b(hawaii|honolulu)\b/, 'Pacific/Honolulu'],
  [/\b(alaska|anchorage)\b/, 'America/Anchorage'],
  [/\b(arizona|phoenix)\b/, 'America/Phoenix'],
  [/\b(pacific(\s+time)?|pst|pdt|california|cali|los\s*angeles|\bla\b|san\s*francisco|sf|bay\s*area|seattle|portland|oregon|nevada|las\s*vegas|san\s*diego)\b/, 'America/Los_Angeles'],
  [/\b(mountain(\s+time)?|mst|mdt|denver|colorado|utah|salt\s*lake|new\s*mexico|albuquerque|boise|idaho|montana)\b/, 'America/Denver'],
  [/\b(central(\s+time)?|cst|cdt|chicago|texas|austin|dallas|houston|san\s*antonio|illinois|minnesota|minneapolis|missouri|kansas|oklahoma|louisiana|new\s*orleans|wisconsin|milwaukee|nashville|memphis)\b/, 'America/Chicago'],
  [/\b(eastern(\s+time)?|est|edt|new\s*york|nyc|new\s*jersey|boston|massachusetts|miami|florida|orlando|tampa|atlanta|georgia|washington\s*d\.?c|philadelphia|philly|pittsburgh|ohio|cleveland|columbus|michigan|detroit|north\s*carolina|charlotte|virginia|maryland|baltimore|connecticut|maine)\b/, 'America/New_York'],
  // ── Canada ─────────────────────────────────────────────────────────────
  [/\b(toronto|ottawa|montreal|quebec)\b/, 'America/Toronto'],
  [/\b(vancouver|british\s*columbia)\b/, 'America/Vancouver'],
  // ── Middle East ────────────────────────────────────────────────────────
  [/\b(israel|israeli|jerusalem|tel\s*aviv|tlv|haifa)\b/, 'Asia/Jerusalem'],
  [/\b(dubai|uae|abu\s*dhabi|united\s*arab)\b/, 'Asia/Dubai'],
  // ── UK / Europe ────────────────────────────────────────────────────────
  [/\b(uk|u\.k|england|english|london|britain|british|gmt|bst|scotland|wales)\b/, 'Europe/London'],
  [/\b(ireland|irish|dublin)\b/, 'Europe/Dublin'],
  [/\b(france|french|paris)\b/, 'Europe/Paris'],
  [/\b(germany|german|berlin|munich)\b/, 'Europe/Berlin'],
  [/\b(spain|spanish|madrid|barcelona)\b/, 'Europe/Madrid'],
  [/\b(italy|italian|rome|milan)\b/, 'Europe/Rome'],
  [/\b(netherlands|holland|amsterdam)\b/, 'Europe/Amsterdam'],
  [/\b(cet|central\s*european)\b/, 'Europe/Paris'],
  // ── Asia / Pacific ─────────────────────────────────────────────────────
  [/\b(india|indian|mumbai|delhi|bangalore|bengaluru|kolkata)\b/, 'Asia/Kolkata'],
  [/\b(japan|japanese|tokyo)\b/, 'Asia/Tokyo'],
  [/\b(singapore)\b/, 'Asia/Singapore'],
  [/\b(australia|sydney|melbourne|brisbane)\b/, 'Australia/Sydney'],
  [/\b(new\s*zealand|auckland)\b/, 'Pacific/Auckland'],
  // ── Latin America ──────────────────────────────────────────────────────
  [/\b(mexico\s*city|cdmx)\b/, 'America/Mexico_City'],
  [/\b(brazil|brasil|sao\s*paulo|são\s*paulo|rio)\b/, 'America/Sao_Paulo'],
];

// Country calling code → IANA zone, ONLY for single-timezone countries where the
// code alone is unambiguous. Multi-timezone countries (US/CA +1, AU +61, RU +7,
// BR +55, MX +52) are deliberately absent → we narrow +1 by area code and ask
// for the rest. China is officially single-zone (Asia/Shanghai).
const SINGLE_TZ_BY_CALLING_CODE: Record<string, string> = {
  '972': 'Asia/Jerusalem', '971': 'Asia/Dubai', '966': 'Asia/Riyadh', '90': 'Europe/Istanbul',
  '44': 'Europe/London', '353': 'Europe/Dublin', '33': 'Europe/Paris', '49': 'Europe/Berlin',
  '34': 'Europe/Madrid', '39': 'Europe/Rome', '31': 'Europe/Amsterdam', '32': 'Europe/Brussels',
  '41': 'Europe/Zurich', '43': 'Europe/Vienna', '351': 'Europe/Lisbon', '30': 'Europe/Athens',
  '48': 'Europe/Warsaw', '46': 'Europe/Stockholm', '47': 'Europe/Oslo', '45': 'Europe/Copenhagen',
  '358': 'Europe/Helsinki', '420': 'Europe/Prague', '36': 'Europe/Budapest', '40': 'Europe/Bucharest',
  '380': 'Europe/Kyiv', '65': 'Asia/Singapore', '852': 'Asia/Hong_Kong', '81': 'Asia/Tokyo',
  '82': 'Asia/Seoul', '91': 'Asia/Kolkata', '86': 'Asia/Shanghai', '64': 'Pacific/Auckland',
  '27': 'Africa/Johannesburg', '20': 'Africa/Cairo', '234': 'Africa/Lagos', '254': 'Africa/Nairobi',
};

// Major US/Canada area codes → zone (the common metros across every zone).
// Unknown area codes fall through to asking — we never guess wrong.
const NANP_AREA_TZ: Record<string, string> = {
  // Eastern
  '212': 'America/New_York', '646': 'America/New_York', '917': 'America/New_York', '718': 'America/New_York',
  '347': 'America/New_York', '516': 'America/New_York', '201': 'America/New_York', '973': 'America/New_York',
  '617': 'America/New_York', '857': 'America/New_York', '781': 'America/New_York', '305': 'America/New_York',
  '786': 'America/New_York', '954': 'America/New_York', '407': 'America/New_York', '813': 'America/New_York',
  '404': 'America/New_York', '470': 'America/New_York', '678': 'America/New_York', '202': 'America/New_York',
  '215': 'America/New_York', '267': 'America/New_York', '412': 'America/New_York', '614': 'America/New_York',
  '216': 'America/New_York', '313': 'America/New_York', '704': 'America/New_York', '919': 'America/New_York',
  '804': 'America/New_York', '410': 'America/New_York', '716': 'America/New_York', '585': 'America/New_York',
  '416': 'America/Toronto', '647': 'America/Toronto', '437': 'America/Toronto', '613': 'America/Toronto',
  // Central
  '312': 'America/Chicago', '773': 'America/Chicago', '872': 'America/Chicago', '214': 'America/Chicago',
  '469': 'America/Chicago', '972': 'America/Chicago', '713': 'America/Chicago', '281': 'America/Chicago',
  '832': 'America/Chicago', '512': 'America/Chicago', '210': 'America/Chicago', '737': 'America/Chicago',
  '615': 'America/Chicago', '901': 'America/Chicago', '504': 'America/Chicago', '314': 'America/Chicago',
  '816': 'America/Chicago', '612': 'America/Chicago', '763': 'America/Chicago', '402': 'America/Chicago',
  '405': 'America/Chicago', '918': 'America/Chicago', '608': 'America/Chicago', '414': 'America/Chicago',
  // Mountain
  '303': 'America/Denver', '720': 'America/Denver', '719': 'America/Denver', '801': 'America/Denver',
  '385': 'America/Denver', '505': 'America/Denver', '406': 'America/Denver', '208': 'America/Denver',
  // Arizona (no DST)
  '602': 'America/Phoenix', '480': 'America/Phoenix', '623': 'America/Phoenix', '520': 'America/Phoenix',
  // Pacific
  '213': 'America/Los_Angeles', '310': 'America/Los_Angeles', '323': 'America/Los_Angeles', '424': 'America/Los_Angeles',
  '818': 'America/Los_Angeles', '626': 'America/Los_Angeles', '714': 'America/Los_Angeles', '949': 'America/Los_Angeles',
  '619': 'America/Los_Angeles', '858': 'America/Los_Angeles', '415': 'America/Los_Angeles', '650': 'America/Los_Angeles',
  '408': 'America/Los_Angeles', '510': 'America/Los_Angeles', '925': 'America/Los_Angeles', '916': 'America/Los_Angeles',
  '206': 'America/Los_Angeles', '253': 'America/Los_Angeles', '425': 'America/Los_Angeles', '503': 'America/Los_Angeles',
  '971': 'America/Los_Angeles', '702': 'America/Los_Angeles', '725': 'America/Los_Angeles',
  '604': 'America/Vancouver', '778': 'America/Vancouver',
  // Alaska / Hawaii
  '907': 'America/Anchorage', '808': 'Pacific/Honolulu',
};

/**
 * Best-effort timezone from the user's phone number — no asking required:
 *   - single-timezone country code → that zone (reliable),
 *   - North American (+1) → narrowed by area code,
 *   - otherwise null (the caller asks).
 * Number portability means this is a strong default, not a guarantee; the user
 * can always correct it in Settings.
 */
export function timezoneFromPhone(phone: string | null | undefined): string | null {
  const digits = (phone ?? '').replace(/\D/g, '');
  if (digits.length < 7) return null;

  // North America (+1 / bare 10-digit US number).
  let area: string | null = null;
  if (digits.length === 11 && digits.startsWith('1')) area = digits.slice(1, 4);
  else if (digits.length === 10) area = digits.slice(0, 3);
  if (area) {
    const tz = NANP_AREA_TZ[area];
    return tz && isValidIanaTimezone(tz) ? tz : null;
  }

  // Other countries — longest calling-code match first (3 → 2 → 1 digits).
  for (const len of [3, 2, 1]) {
    const cc = digits.slice(0, len);
    const tz = SINGLE_TZ_BY_CALLING_CODE[cc];
    if (tz && isValidIanaTimezone(tz)) return tz;
  }
  return null;
}

/**
 * Map a free-text answer to an IANA timezone, or null if not confidently
 * mappable. Accepts an explicit IANA name ("America/Chicago") directly.
 */
export function parseTimezone(text: string): string | null {
  const raw = (text ?? '').trim();
  if (raw.length === 0) return null;

  // 1. Already an IANA zone? Accept it verbatim if the runtime knows it.
  const ianaCandidate = raw.replace(/\s+/g, '_');
  if (/^[A-Za-z]+\/[A-Za-z_]+(?:\/[A-Za-z_]+)?$/.test(ianaCandidate) && isValidIanaTimezone(ianaCandidate)) {
    return ianaCandidate;
  }

  // 2. Keyword map.
  const norm = raw.toLowerCase().replace(/[._]/g, ' ').replace(/\s+/g, ' ').trim();
  for (const [re, tz] of ZONE_PATTERNS) {
    if (re.test(norm) && isValidIanaTimezone(tz)) return tz;
  }
  return null;
}
