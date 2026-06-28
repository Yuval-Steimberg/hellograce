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
