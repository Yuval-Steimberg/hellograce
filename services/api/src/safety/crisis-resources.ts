/**
 * Crisis resource localization (2026-06-06).
 *
 * Replaces the hard-coded US-only 988/911 in guard.ts SAFETY_RESPONSE with
 * a country-aware lookup. Per the coverage audit, this is gated by the
 * CRISIS_RESOURCES_REVIEWED env var (default FALSE) so production behavior
 * is byte-identical to today until clinical + legal review approves every
 * entry below and the flag is flipped.
 *
 * ──────────────────────────────────────────────────────────────────────
 * PRE-LAUNCH GATE: clinician + legal review required for every entry
 * below. Track in docs/PRE_LAUNCH_GATES.md.
 *
 * REVIEW CHECKLIST (each row):
 *   - Crisis line is currently in service in that country (24/7 ideally).
 *   - Emergency line is the official medical emergency number.
 *   - Wording is acceptable per local mental-health authority guidance.
 *
 * DO NOT flip CRISIS_RESOURCES_REVIEWED to true until the table is
 * approved by Grace's clinician + legal owners.
 * ──────────────────────────────────────────────────────────────────────
 */

import type { GraceUser } from '../user/user.service.js';

export interface CrisisResources {
  /** Crisis hotline contact (call/text/chat — short label + number). */
  crisisLine: string;
  /** Local medical emergency number. */
  emergencyLine: string;
  /** ISO-3166-1 alpha-2 the resources are for. */
  countryCode: string;
}

/** US fallback — preserved verbatim from the original SAFETY_RESPONSE
 *  hard-coding so that day-1 behavior (with CRISIS_RESOURCES_REVIEWED=false)
 *  ships exactly the same text every user sees today. */
const US_DEFAULT: CrisisResources = {
  crisisLine: '988',
  emergencyLine: '911',
  countryCode: 'US',
};

/** Country → resources. ALL entries below pending clinical + legal review. */
const COUNTRY_MAP: Record<string, CrisisResources> = {
  US: US_DEFAULT,
  CA: { crisisLine: '9-8-8', emergencyLine: '911', countryCode: 'CA' },
  GB: { crisisLine: 'Samaritans 116 123', emergencyLine: '999', countryCode: 'GB' },
  IE: { crisisLine: 'Samaritans 116 123', emergencyLine: '112', countryCode: 'IE' },
  IL: { crisisLine: 'ERAN 1201', emergencyLine: '101', countryCode: 'IL' },
  AU: { crisisLine: 'Lifeline 13 11 14', emergencyLine: '000', countryCode: 'AU' },
  NZ: { crisisLine: 'Lifeline 0800 543 354', emergencyLine: '111', countryCode: 'NZ' },
  DE: { crisisLine: 'Telefonseelsorge 0800 111 0 111', emergencyLine: '112', countryCode: 'DE' },
  FR: { crisisLine: '3114', emergencyLine: '112', countryCode: 'FR' },
  IT: { crisisLine: 'Telefono Amico 02 2327 2327', emergencyLine: '112', countryCode: 'IT' },
  ES: { crisisLine: '024', emergencyLine: '112', countryCode: 'ES' },
  NL: { crisisLine: '113 Zelfmoordpreventie 0800 0113', emergencyLine: '112', countryCode: 'NL' },
};

/** Lightweight IANA timezone → country inference for users with a tz but no
 *  explicit country_code. Conservative — only covers timezones whose
 *  country is unambiguous. Anything else falls back to US default. */
const TZ_TO_COUNTRY: Record<string, string> = {
  'America/New_York': 'US',
  'America/Chicago': 'US',
  'America/Denver': 'US',
  'America/Los_Angeles': 'US',
  'America/Anchorage': 'US',
  'America/Honolulu': 'US',
  'America/Phoenix': 'US',
  'America/Toronto': 'CA',
  'America/Vancouver': 'CA',
  'America/Edmonton': 'CA',
  'America/Halifax': 'CA',
  'Europe/London': 'GB',
  'Europe/Dublin': 'IE',
  'Asia/Jerusalem': 'IL',
  'Asia/Tel_Aviv': 'IL',
  'Australia/Sydney': 'AU',
  'Australia/Melbourne': 'AU',
  'Australia/Brisbane': 'AU',
  'Australia/Perth': 'AU',
  'Pacific/Auckland': 'NZ',
  'Europe/Berlin': 'DE',
  'Europe/Paris': 'FR',
  'Europe/Rome': 'IT',
  'Europe/Madrid': 'ES',
  'Europe/Amsterdam': 'NL',
};

export function inferCountryFromTimezone(tz: string | null | undefined): string | null {
  if (!tz) return null;
  return TZ_TO_COUNTRY[tz] ?? null;
}

/**
 * Returns the appropriate crisis resources for the user. When the env flag
 * `CRISIS_RESOURCES_REVIEWED` is false (default), ALWAYS returns the US
 * default — preserves today's behavior byte-for-byte.
 *
 * When the flag is true, uses (in order): explicit user.country_code,
 * inferred-from-timezone country, US default fallback.
 */
export function getCrisisResourcesForUser(
  user: Pick<GraceUser, 'country_code' | 'timezone'> | null | undefined,
  opts: { reviewed: boolean },
): CrisisResources {
  if (!opts.reviewed) return US_DEFAULT;
  if (!user) return US_DEFAULT;
  const explicit = user.country_code?.toUpperCase();
  if (explicit && COUNTRY_MAP[explicit]) return COUNTRY_MAP[explicit];
  const inferred = inferCountryFromTimezone(user.timezone);
  if (inferred && COUNTRY_MAP[inferred]) return COUNTRY_MAP[inferred];
  return US_DEFAULT;
}

/**
 * Render the SAFETY_RESPONSE template with the given resources. The
 * template wording is locked verbatim — only the two phone numbers
 * substitute in. Identity check: with US_DEFAULT this returns the exact
 * same string as the original guard.ts SAFETY_RESPONSE constant.
 */
export function buildSafetyResponse(resources: CrisisResources): string {
  return `Please reach out for support right now. Call or text ${resources.crisisLine} to talk to someone trained to help. They're available 24/7. If you're in immediate physical danger, call ${resources.emergencyLine}. I care about you and want you to get real help immediately.`;
}

// Test-only exports
export const __testing = {
  US_DEFAULT,
  COUNTRY_MAP,
  TZ_TO_COUNTRY,
};
