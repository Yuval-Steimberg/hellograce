// Personalized daily calorie target (kcal) using Mifflin-St Jeor BMR + activity
// + GLP-1 deficit. Returns null if inputs are insufficient (caller falls back
// to a default range or asks the user for the missing field).
//
// Formula (per system prompt):
//   Men:   BMR = 10×kg + 6.25×cm − 5×age + 5
//   Women: BMR = 10×kg + 6.25×cm − 5×age − 161
//   TDEE = BMR × activity factor
//   Target = TDEE − deficit (300 for maintenance-leaning, 500 for fat loss)
//
// Floor: never go below BMR (GLP-1 users are vulnerable to under-eating).
// Cap:   never above 4000 kcal (safety guard against bad inputs).

export type Sex = 'female' | 'male' | 'nonbinary' | 'prefer_not_to_say';
export type ActivityLevel = 'sedentary' | 'lightly_active' | 'moderate' | 'very_active';
export type FitnessGoal = 'fat_loss' | 'muscle_gain' | 'maintenance' | 'recomposition';

export interface CalorieInputs {
  weightLbs: number | null;
  heightCm: number | null;
  age: number | null;
  sex: Sex | null;
  activityLevel: ActivityLevel | null;
  goal: FitnessGoal | string | null;
}

const ACTIVITY_FACTORS: Record<ActivityLevel, number> = {
  sedentary: 1.2,
  lightly_active: 1.35,
  moderate: 1.55,
  very_active: 1.75,
};

const MIN_KCAL = 1200;
const MAX_KCAL = 4000;

export function calculateCalorieTarget(input: CalorieInputs): number | null {
  if (!input.weightLbs || !input.heightCm || !input.age || !input.sex || !input.activityLevel) {
    return null;
  }
  const weightKg = input.weightLbs / 2.2046;
  // Mifflin-St Jeor BMR
  const male = input.sex === 'male';
  const bmr = 10 * weightKg + 6.25 * input.heightCm - 5 * input.age + (male ? 5 : -161);
  const tdee = bmr * ACTIVITY_FACTORS[input.activityLevel];

  // Deficit by goal — GLP-1 users get a softer deficit to protect lean mass
  const goal = normalizeGoal(input.goal);
  const deficit =
    goal === 'fat_loss' ? 500 :
    goal === 'recomposition' ? 350 :
    goal === 'muscle_gain' ? -200 :   // slight surplus
    300;                                // maintenance / default

  const target = Math.round(tdee - deficit);
  // Never go below BMR (per system prompt rule)
  const safeFloor = Math.max(Math.round(bmr), MIN_KCAL);
  return Math.min(MAX_KCAL, Math.max(safeFloor, target));
}

function normalizeGoal(goal: CalorieInputs['goal']): FitnessGoal | null {
  if (!goal) return null;
  const g = goal.toString().toLowerCase().replace(/[\s-]/g, '_');
  if (g === 'fat_loss' || g === 'weight_loss' || g === 'lose_weight' || g === 'losing_weight') return 'fat_loss';
  if (g === 'muscle_gain' || g === 'gain_muscle' || g === 'build_muscle') return 'muscle_gain';
  if (g === 'maintenance' || g === 'maintain') return 'maintenance';
  if (g === 'recomposition' || g === 'recomp') return 'recomposition';
  return null;
}
