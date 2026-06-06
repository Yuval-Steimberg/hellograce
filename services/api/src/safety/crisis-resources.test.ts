import { describe, it, expect } from 'vitest';
import {
  getCrisisResourcesForUser,
  buildSafetyResponse,
  inferCountryFromTimezone,
  __testing,
} from './crisis-resources.js';
import type { GraceUser } from '../user/user.service.js';

const PARTIAL = (overrides: Partial<GraceUser>): Pick<GraceUser, 'country_code' | 'timezone'> => ({
  country_code: overrides.country_code ?? null,
  timezone: overrides.timezone ?? 'America/New_York',
});

describe('crisis-resources gate (CRISIS_RESOURCES_REVIEWED)', () => {
  it('returns US_DEFAULT when reviewed=false, regardless of country_code', () => {
    const r = getCrisisResourcesForUser(PARTIAL({ country_code: 'IL', timezone: 'Asia/Jerusalem' }), { reviewed: false });
    expect(r).toEqual(__testing.US_DEFAULT);
  });

  it('returns US_DEFAULT when reviewed=false, even with no user', () => {
    const r = getCrisisResourcesForUser(null, { reviewed: false });
    expect(r).toEqual(__testing.US_DEFAULT);
  });

  it('returns the explicit country_code map when reviewed=true', () => {
    const r = getCrisisResourcesForUser(PARTIAL({ country_code: 'IL', timezone: 'Asia/Jerusalem' }), { reviewed: true });
    expect(r.countryCode).toBe('IL');
    expect(r.crisisLine).toContain('1201');
    expect(r.emergencyLine).toBe('101');
  });

  it('falls back to inferred-from-timezone when country_code is null', () => {
    const r = getCrisisResourcesForUser(PARTIAL({ country_code: null, timezone: 'Europe/London' }), { reviewed: true });
    expect(r.countryCode).toBe('GB');
    expect(r.crisisLine).toMatch(/Samaritans/);
  });

  it('falls back to US_DEFAULT when country and timezone are unknown', () => {
    const r = getCrisisResourcesForUser(PARTIAL({ country_code: null, timezone: 'Mars/Olympus' }), { reviewed: true });
    expect(r).toEqual(__testing.US_DEFAULT);
  });

  it('case-insensitive country_code', () => {
    const r = getCrisisResourcesForUser(PARTIAL({ country_code: 'il', timezone: 'America/New_York' }), { reviewed: true });
    expect(r.countryCode).toBe('IL');
  });
});

describe('buildSafetyResponse', () => {
  it('US default produces the EXACT verbatim historical SAFETY_RESPONSE', () => {
    // CRITICAL: this string MUST match the original hard-coded SAFETY_RESPONSE
    // in guard.ts byte-for-byte. Day-1 behavior change is zero when the flag
    // is false (which is the default).
    const expected = "Please reach out for support right now. Call or text 988 to talk to someone trained to help. They're available 24/7. If you're in immediate physical danger, call 911. I care about you and want you to get real help immediately.";
    expect(buildSafetyResponse(__testing.US_DEFAULT)).toBe(expected);
  });

  it('UK resources produce the same template with Samaritans + 999', () => {
    const uk = __testing.COUNTRY_MAP.GB;
    expect(uk).toBeDefined();
    const body = buildSafetyResponse(uk!);
    expect(body).toContain('Samaritans 116 123');
    expect(body).toContain('999');
    expect(body).not.toContain('988');
    expect(body).not.toContain('911');
  });

  it('Israeli resources produce ERAN 1201 + 101', () => {
    const il = __testing.COUNTRY_MAP.IL;
    expect(il).toBeDefined();
    const body = buildSafetyResponse(il!);
    expect(body).toContain('ERAN 1201');
    expect(body).toContain('101');
  });
});

describe('inferCountryFromTimezone', () => {
  it('maps common timezones correctly', () => {
    expect(inferCountryFromTimezone('America/New_York')).toBe('US');
    expect(inferCountryFromTimezone('America/Los_Angeles')).toBe('US');
    expect(inferCountryFromTimezone('Asia/Jerusalem')).toBe('IL');
    expect(inferCountryFromTimezone('Europe/London')).toBe('GB');
    expect(inferCountryFromTimezone('Australia/Sydney')).toBe('AU');
    expect(inferCountryFromTimezone('America/Toronto')).toBe('CA');
  });

  it('returns null for unknown timezones', () => {
    expect(inferCountryFromTimezone('Mars/Olympus')).toBeNull();
    expect(inferCountryFromTimezone(null)).toBeNull();
    expect(inferCountryFromTimezone(undefined)).toBeNull();
  });
});

describe('crisis-resources table review marker', () => {
  it('every entry has crisisLine + emergencyLine + countryCode', () => {
    for (const [k, v] of Object.entries(__testing.COUNTRY_MAP)) {
      expect(v.crisisLine.length).toBeGreaterThan(0);
      expect(v.emergencyLine.length).toBeGreaterThan(0);
      expect(v.countryCode).toBe(k);
    }
  });

  it('all entries are pending clinical+legal review (audit marker)', () => {
    // Sanity check: when reviewed=false the gate ALWAYS returns US_DEFAULT,
    // which means none of the other rows can leak to production yet.
    for (const country of Object.keys(__testing.COUNTRY_MAP)) {
      const r = getCrisisResourcesForUser(
        { country_code: country, timezone: 'Asia/Jerusalem' },
        { reviewed: false },
      );
      expect(r).toEqual(__testing.US_DEFAULT);
    }
  });
});
