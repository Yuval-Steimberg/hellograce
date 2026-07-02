// Unit conversion for the user-facing forms. Grace stores weight in POUNDS and
// height in CENTIMETRES; these let the user enter/read their data in kg/lbs and
// cm/ft-in. Mirrors services/api/src/nutrition/units.ts.

export const KG_TO_LBS = 2.2046226218;
export const CM_PER_INCH = 2.54;

export type WeightUnit = "lbs" | "kg";
export type HeightUnit = "cm" | "ftin";

const round1 = (n: number) => Math.round(n * 10) / 10;

export const kgToLbs = (kg: number) => round1(kg * KG_TO_LBS);
export const lbsToKg = (lbs: number) => round1(lbs / KG_TO_LBS);

/** Convert a value the user typed (in `unit`) to pounds for storage. */
export const toLbs = (value: number, unit: WeightUnit) => (unit === "kg" ? value * KG_TO_LBS : value);
/** Convert stored pounds to the user's chosen unit for display in an input. */
export const fromLbs = (lbs: number, unit: WeightUnit) => (unit === "kg" ? lbsToKg(lbs) : round1(lbs));

/** cm → { feet, inches } (rounded). */
export function cmToFeetInches(cm: number): { feet: number; inches: number } {
  const totalInches = Math.round(cm / CM_PER_INCH);
  return { feet: Math.floor(totalInches / 12), inches: totalInches % 12 };
}
export const feetInchesToCm = (feet: number, inches: number) => round1((feet * 12 + inches) * CM_PER_INCH);

/** Persisted user unit preferences (local only — the API stores canonical units). */
const WEIGHT_UNIT_KEY = "grace_weight_unit";
const HEIGHT_UNIT_KEY = "grace_height_unit";
export const getWeightUnit = (): WeightUnit => (localStorage.getItem(WEIGHT_UNIT_KEY) === "kg" ? "kg" : "lbs");
export const setWeightUnit = (u: WeightUnit) => localStorage.setItem(WEIGHT_UNIT_KEY, u);
export const getHeightUnit = (): HeightUnit => (localStorage.getItem(HEIGHT_UNIT_KEY) === "ftin" ? "ftin" : "cm");
export const setHeightUnit = (u: HeightUnit) => localStorage.setItem(HEIGHT_UNIT_KEY, u);
