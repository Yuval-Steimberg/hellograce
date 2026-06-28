import { describe, it, expect } from 'vitest';
import { parseTimezone, isValidIanaTimezone } from './timezone-parse.js';

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
