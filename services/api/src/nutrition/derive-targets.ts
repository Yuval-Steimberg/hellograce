/**
 * Derive a user's personalized daily protein + calorie targets from their
 * profile, FILL-IF-MISSING.
 *
 * The two calculators (`calculateProteinTarget`, `calculateCalorieTarget`)
 * already existed but were only ever called on the deprecated web `/users/onboard`
 * route. Every user who signs up through the (now default) in-chat SMS onboarding
 * therefore never got a personalized target and silently fell back to a generic
 * ~80g everywhere. This helper centralizes the derivation so any path that learns
 * a user's weight/goal/body metrics can set the target once, without duplicating
 * the calculator wiring.
 *
 * Rule: FILL-IF-MISSING. We never overwrite a target the user already has —
 * Settings owns explicit edits, so a value that is already present is treated as
 * the user's choice and left alone. The protein target is only produced once we
 * have a real weight to personalize it (without a weight the calculator returns
 * the same ~80g default every read already falls back to, so writing it would
 * just masquerade as personalized). The calorie target is produced only when the
 * Mifflin-St Jeor inputs are all present (the calculator returns null otherwise).
 */
import { calculateProteinTarget } from './protein-target.js';
import { calculateCalorieTarget, type Sex, type ActivityLevel } from './calorie-target.js';

/** The profile fields the calculators read, plus the currently-stored targets so
 *  we can fill-if-missing without ever clobbering the user's own value. */
export interface TargetProfile {
  current_weight?: number | null; // lbs (schema unit)
  height_cm?: number | null;
  age?: number | null;
  sex?: string | null;
  activity_level?: string | null;
  primary_goal?: string | null;
  goals?: string[] | null;
  protein_goal_grams?: number | null;
  calorie_goal_kcal?: number | null;
}

export interface DerivedTargetUpdates {
  protein_goal_grams?: number;
  calorie_goal_kcal?: number;
}

const ACTIVITY_LEVELS: ReadonlySet<string> = new Set([
  'sedentary',
  'lightly_active',
  'moderate',
  'very_active',
]);
const SEXES: ReadonlySet<string> = new Set(['female', 'male', 'nonbinary', 'prefer_not_to_say']);

/** Best goal string for the g/kg + deficit multipliers: the explicit
 *  primary_goal, else the first non-empty free-text goal, else null (→ the
 *  calculators fall back to a safe maintenance-ish default). */
function goalOf(p: TargetProfile): string | null {
  if (p.primary_goal && p.primary_goal.trim()) return p.primary_goal;
  const first = p.goals?.find((g) => typeof g === 'string' && g.trim().length > 0);
  return first ?? null;
}

/**
 * Compute the personalized targets and return ONLY the target fields that should
 * be written now (empty object when there is nothing to fill). Pure + defensive:
 * unrecognized `activity_level`/`sex` strings are dropped (passed as null) so an
 * unexpected stored value can never yield a NaN calorie target.
 */
export function deriveMissingTargets(p: TargetProfile): DerivedTargetUpdates {
  const out: DerivedTargetUpdates = {};
  const weightLbs = p.current_weight ?? null;

  if (p.protein_goal_grams == null && weightLbs != null && weightLbs > 0) {
    const protein = calculateProteinTarget({
      weightLbs,
      heightCm: p.height_cm ?? null,
      age: p.age ?? null,
      goal: goalOf(p),
    });
    if (protein != null) out.protein_goal_grams = protein;
  }

  if (p.calorie_goal_kcal == null) {
    const sex = p.sex && SEXES.has(p.sex) ? (p.sex as Sex) : null;
    // Tolerate the legacy 'light' value some users have stored from before the
    // parser was normalized to 'lightly_active'.
    const normalizedActivity = p.activity_level === 'light' ? 'lightly_active' : p.activity_level;
    const activityLevel =
      normalizedActivity && ACTIVITY_LEVELS.has(normalizedActivity) ? (normalizedActivity as ActivityLevel) : null;
    const kcal = calculateCalorieTarget({
      weightLbs,
      heightCm: p.height_cm ?? null,
      age: p.age ?? null,
      sex,
      activityLevel,
      goal: goalOf(p),
    });
    if (kcal != null) out.calorie_goal_kcal = kcal;
  }

  return out;
}
