/**
 * Unit parsing + conversion (2026-07-02).
 *
 * Grace stores weight in POUNDS and height in CENTIMETRES, but users think in
 * whatever unit they grew up with. These helpers let a user enter their data in
 * ANY common unit — kg / lb / stone for weight, cm / m / feet-inches for height —
 * and normalize to the canonical stored unit. Pure + fully unit-tested; used by
 * chat logging, the dashboard, Settings, and onboarding so every entry point
 * understands units the same way.
 */

export const KG_TO_LBS = 2.2046226218;
export const LBS_TO_KG = 1 / KG_TO_LBS;
export const CM_PER_INCH = 2.54;
export const INCH_PER_FOOT = 12;
export const LBS_PER_STONE = 14;

export type WeightUnit = 'lbs' | 'kg' | 'st';
export type HeightUnit = 'cm' | 'ftin';

export const kgToLbs = (kg: number): number => kg * KG_TO_LBS;
export const lbsToKg = (lbs: number): number => lbs * LBS_TO_KG;
export const cmToInches = (cm: number): number => cm / CM_PER_INCH;
export const inchesToCm = (inch: number): number => inch * CM_PER_INCH;

/** Split cm into whole feet + inches (rounded), e.g. 178 → { feet: 5, inches: 10 }. */
export function cmToFeetInches(cm: number): { feet: number; inches: number } {
  const totalInches = Math.round(cmToInches(cm));
  return { feet: Math.floor(totalInches / INCH_PER_FOOT), inches: totalInches % INCH_PER_FOOT };
}

export const feetInchesToCm = (feet: number, inches: number): number =>
  inchesToCm(feet * INCH_PER_FOOT + inches);

const round1 = (n: number): number => Math.round(n * 10) / 10;

/**
 * Parse a weight in any unit → pounds. Handles:
 *   "180", "180 lb", "180 lbs", "180 pounds"
 *   "82 kg", "82kg", "82.5 kilos", "82 kilograms"
 *   "12 st", "12 stone", "12 st 6", "12 st 6 lb", "12 stone 6 pounds"
 * A bare number uses `defaultUnit` (default 'lbs'). Returns null when no number
 * is found. Does NOT range-check — callers apply their own bounds.
 */
export function parseWeightToLbs(
  input: string | number,
  defaultUnit: WeightUnit = 'lbs',
): number | null {
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) return null;
    return round1(toLbs(input, defaultUnit));
  }
  const t = input.toLowerCase().trim();
  if (!t) return null;

  // Stone (+ optional pounds): "12 st 6", "12 stone 6 lb".
  const st = t.match(/(\d+(?:\.\d+)?)\s*(?:st|stone)s?\b(?:\s*(\d+(?:\.\d+)?)\s*(?:lb|lbs|pound|pounds)?)?/);
  if (st) {
    const stone = parseFloat(st[1]!);
    const extraLb = st[2] ? parseFloat(st[2]!) : 0;
    if (Number.isFinite(stone)) return round1(stone * LBS_PER_STONE + (Number.isFinite(extraLb) ? extraLb : 0));
  }

  const m = t.match(/(\d+(?:\.\d+)?)\s*(kilograms?|kilos?|kgs?|kg|pounds?|lbs?|lb)?/);
  if (!m) return null;
  const value = parseFloat(m[1]!);
  if (!Number.isFinite(value)) return null;
  const unitTok = m[2] ?? '';
  let unit: WeightUnit = defaultUnit;
  if (/^k/.test(unitTok)) unit = 'kg';
  else if (/^(lb|pound)/.test(unitTok)) unit = 'lbs';
  return round1(toLbs(value, unit));
}

function toLbs(value: number, unit: WeightUnit): number {
  if (unit === 'kg') return kgToLbs(value);
  if (unit === 'st') return value * LBS_PER_STONE;
  return value;
}

/**
 * Parse a height in any unit → centimetres. Handles:
 *   "178", "178 cm", "178cm"
 *   "1.78 m", "1,78 m"
 *   "5'10", "5' 10\"", "5 ft 10", "5 ft 10 in", "5 foot 10", "5 feet 10 inches"
 *   "5'", "5 ft"  (feet only)
 *   "70 in", "70 inches", "70\""
 * A bare number ≥ 90 is treated as cm; a bare number < 90 as inches (a person's
 * height in cm is ~90–250, in inches ~30–90). Returns null when nothing parses.
 */
export function parseHeightToCm(input: string | number): number | null {
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) return null;
    return input >= 90 ? round1(input) : round1(inchesToCm(input));
  }
  const t = input.toLowerCase().trim().replace(',', '.');
  if (!t) return null;

  // Feet + inches: 5'10, 5' 10", 5 ft 10 in, 5 foot 10, 5 feet 10 inches.
  const ftin = t.match(/(\d+)\s*(?:'|ft|foot|feet)\s*(\d+(?:\.\d+)?)?\s*(?:"|''|in|ins|inch|inches)?/);
  if (ftin && /'|ft|foot|feet/.test(ftin[0])) {
    const feet = parseInt(ftin[1]!, 10);
    const inches = ftin[2] ? parseFloat(ftin[2]!) : 0;
    if (Number.isFinite(feet)) return round1(feetInchesToCm(feet, Number.isFinite(inches) ? inches : 0));
  }

  // Metres: "1.78 m", "1.78m" (but not "178 m" which is nonsense → treat as cm below).
  const metres = t.match(/(\d\.\d+)\s*m\b/);
  if (metres) return round1(parseFloat(metres[1]!) * 100);

  // Explicit cm.
  const cm = t.match(/(\d+(?:\.\d+)?)\s*cm\b/);
  if (cm) return round1(parseFloat(cm[1]!));

  // Explicit inches.
  const inch = t.match(/(\d+(?:\.\d+)?)\s*(?:"|''|in|ins|inch|inches)\b/);
  if (inch) return round1(inchesToCm(parseFloat(inch[1]!)));

  // Bare number: cm if ≥ 90, else inches.
  const bare = t.match(/(\d+(?:\.\d+)?)/);
  if (bare) {
    const v = parseFloat(bare[1]!);
    if (Number.isFinite(v)) return v >= 90 ? round1(v) : round1(inchesToCm(v));
  }
  return null;
}

/** Format pounds in the user's preferred unit for display. */
export function formatWeight(lbs: number, unit: WeightUnit): string {
  if (unit === 'kg') return `${round1(lbsToKg(lbs))} kg`;
  if (unit === 'st') {
    const stone = Math.floor(lbs / LBS_PER_STONE);
    const rem = Math.round(lbs - stone * LBS_PER_STONE);
    return `${stone} st ${rem} lb`;
  }
  return `${round1(lbs)} lbs`;
}

/** Format centimetres in the user's preferred unit for display. */
export function formatHeight(cm: number, unit: HeightUnit): string {
  if (unit === 'ftin') {
    const { feet, inches } = cmToFeetInches(cm);
    return `${feet}'${inches}"`;
  }
  return `${round1(cm)} cm`;
}
