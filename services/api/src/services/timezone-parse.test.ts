import { describe, it, expect } from 'vitest';
import { parseTimezone, isValidIanaTimezone, timezoneFromPhone } from './timezone-parse.js';

describe('timezoneFromPhone — auto-detect without asking', () => {
  it('single-timezone country codes resolve reliably', () => {
    expect(timezoneFromPhone('+972547722420')).toBe('Asia/Jerusalem'); // Israel
    expect(timezoneFromPhone('+447911123456')).toBe('Europe/London');   // UK
    expect(timezoneFromPhone('+33123456789')).toBe('Europe/Paris');     // France
    expect(timezoneFromPhone('+919812345678')).toBe('Asia/Kolkata');    // India
  });
  it('US/Canada narrowed by area code', () => {
    expect(timezoneFromPhone('+12125551234')).toBe('America/New_York');    // 212 NYC
    expect(timezoneFromPhone('+13105551234')).toBe('America/Los_Angeles'); // 310 LA
    expect(timezoneFromPhone('+13125551234')).toBe('America/Chicago');     // 312 Chicago
    expect(timezoneFromPhone('+18085551234')).toBe('Pacific/Honolulu');    // 808 Hawaii
    expect(timezoneFromPhone('2125551234')).toBe('America/New_York');      // bare 10-digit
  });
  it('returns null when it cannot tell (unknown area / multi-tz country / junk)', () => {
    expect(timezoneFromPhone('+15555551234')).toBeNull(); // unknown area code → ask
    expect(timezoneFromPhone('+61412345678')).toBeNull(); // Australia (multi-tz) → ask
    expect(timezoneFromPhone('')).toBeNull();
    expect(timezoneFromPhone(null)).toBeNull();
  });
});

describe('parseTimezone', () => {
  // The spec's required test locations.
  const CASES: Array<[string, string]> = [
    ['New York', 'America/New_York'],
    ['nyc', 'America/New_York'],
    ['eastern time', 'America/New_York'],
    ['EST', 'America/New_York'],
    ['Florida', 'America/New_York'],
    ['California', 'America/Los_Angeles'],
    ['LA', 'America/Los_Angeles'],
    ['pacific time', 'America/Los_Angeles'],
    ['Seattle', 'America/Los_Angeles'],
    ['Texas', 'America/Chicago'],
    ['central', 'America/Chicago'],
    ['Denver', 'America/Denver'],
    ['Arizona', 'America/Phoenix'],
    ['Israel', 'Asia/Jerusalem'],
    ['tel aviv', 'Asia/Jerusalem'],
    ['London', 'Europe/London'],
    ['UK', 'Europe/London'],
    ['I live in london', 'Europe/London'],
    ['Tokyo', 'Asia/Tokyo'],
    ['Sydney', 'Australia/Sydney'],
    ['india', 'Asia/Kolkata'],
  ];
  for (const [input, expected] of CASES) {
    it(`"${input}" → ${expected}`, () => expect(parseTimezone(input)).toBe(expected));
  }

  it('accepts an explicit IANA name', () => {
    expect(parseTimezone('America/Chicago')).toBe('America/Chicago');
    expect(parseTimezone('Asia/Jerusalem')).toBe('Asia/Jerusalem');
  });

  it('returns null for unmappable / junk answers', () => {
    expect(parseTimezone('idk')).toBeNull();
    expect(parseTimezone('the moon')).toBeNull();
    expect(parseTimezone('')).toBeNull();
    expect(parseTimezone('Made/Up_Zone')).toBeNull(); // shape-valid but not a real zone
  });
});

describe('isValidIanaTimezone', () => {
  it('accepts real zones, rejects fakes', () => {
    expect(isValidIanaTimezone('America/New_York')).toBe(true);
    expect(isValidIanaTimezone('Asia/Jerusalem')).toBe(true);
    expect(isValidIanaTimezone('Not/AZone')).toBe(false);
    expect(isValidIanaTimezone('EST')).toBe(false); // not an IANA name
  });
});
