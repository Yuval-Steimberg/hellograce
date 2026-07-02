import { describe, it, expect } from 'vitest';
import {
  parseWeightToLbs, parseHeightToCm, kgToLbs, lbsToKg,
  cmToFeetInches, feetInchesToCm, formatWeight, formatHeight,
} from './units.js';

describe('parseWeightToLbs', () => {
  it('parses pounds (default + explicit)', () => {
    expect(parseWeightToLbs('180')).toBe(180);
    expect(parseWeightToLbs('180 lbs')).toBe(180);
    expect(parseWeightToLbs('180 pounds')).toBe(180);
    expect(parseWeightToLbs('184.6 lb')).toBe(184.6);
  });

  it('parses kilograms → lbs', () => {
    expect(parseWeightToLbs('82 kg')).toBe(180.8);
    expect(parseWeightToLbs('82kg')).toBe(180.8);
    expect(parseWeightToLbs('82.5 kilos')).toBe(181.9);
    expect(parseWeightToLbs('80 kilograms')).toBe(176.4);
  });

  it('parses stone (+ optional pounds) → lbs', () => {
    expect(parseWeightToLbs('12 st')).toBe(168);
    expect(parseWeightToLbs('12 stone 6')).toBe(174);
    expect(parseWeightToLbs('12 st 6 lb')).toBe(174);
  });

  it('honors a non-default unit for a bare number', () => {
    expect(parseWeightToLbs('82', 'kg')).toBe(180.8);
    expect(parseWeightToLbs(82, 'kg')).toBe(180.8);
  });

  it('returns null when there is no number', () => {
    expect(parseWeightToLbs('heavy')).toBeNull();
    expect(parseWeightToLbs('')).toBeNull();
  });
});

describe('parseHeightToCm', () => {
  it('parses cm', () => {
    expect(parseHeightToCm('178 cm')).toBe(178);
    expect(parseHeightToCm('178cm')).toBe(178);
    expect(parseHeightToCm('178')).toBe(178);
  });

  it('parses metres', () => {
    expect(parseHeightToCm('1.78 m')).toBe(178);
    expect(parseHeightToCm('1,78m')).toBe(178);
  });

  it('parses feet + inches in many forms', () => {
    expect(parseHeightToCm("5'10")).toBe(177.8);
    expect(parseHeightToCm('5 ft 10 in')).toBe(177.8);
    expect(parseHeightToCm('5 foot 10')).toBe(177.8);
    expect(parseHeightToCm('5 feet 10 inches')).toBe(177.8);
    expect(parseHeightToCm("5'")).toBe(152.4); // feet only
  });

  it('parses inches', () => {
    expect(parseHeightToCm('70 in')).toBe(177.8);
    expect(parseHeightToCm('70 inches')).toBe(177.8);
  });

  it('bare number heuristic: >=90 cm, <90 inches', () => {
    expect(parseHeightToCm('165')).toBe(165);
    expect(parseHeightToCm('66')).toBe(167.6); // inches → cm
  });

  it('returns null when nothing parses', () => {
    expect(parseHeightToCm('tall')).toBeNull();
  });
});

describe('conversions + formatting', () => {
  it('kg <-> lbs round trip', () => {
    expect(Math.round(kgToLbs(lbsToKg(200)))).toBe(200);
  });

  it('cm <-> feet/inches', () => {
    expect(cmToFeetInches(177.8)).toEqual({ feet: 5, inches: 10 });
    expect(Math.round(feetInchesToCm(5, 10))).toBe(178);
  });

  it('formats weight per unit', () => {
    expect(formatWeight(180.8, 'kg')).toBe('82 kg');
    expect(formatWeight(200, 'lbs')).toBe('200 lbs');
    expect(formatWeight(168, 'st')).toBe('12 st 0 lb');
  });

  it('formats height per unit', () => {
    expect(formatHeight(177.8, 'ftin')).toBe(`5'10"`);
    expect(formatHeight(178, 'cm')).toBe('178 cm');
  });
});
