/**
 * Personalized daily protein target (grams) for GLP-1 users.
 *
 * Uses actual-body-weight multipliers in the evidence-informed 1.2–1.6 g/kg
 * range commonly recommended during weight loss. This is a planning estimate,
 * not a clinical prescription; explicit user/clinician targets always win.
 *
 * Returns null if inputs are insufficient so a generic fallback is never
 * represented as the user's personal target.
 */
export type FitnessGoal = 'fat_loss' | 'muscle_gain' | 'maintenance' | 'recomposition';

export interface ProteinInputs {
  weightLbs: number | null;     // current weight (lbs — what the schema uses)
  heightCm?: number | null;
  age?: number | null;
  goal?: FitnessGoal | string | null;
}

const MIN_TARGET = 60;
const MAX_TARGET = 180;

const G_PER_KG: Record<FitnessGoal, number> = {
  fat_loss: 1.2,
  muscle_gain: 1.6,
  maintenance: 1.2,
  recomposition: 1.4,
};

const AGE_FLOORS: { age: number; gPerKg: number }[] = [
  // Older adults need more protein to overcome anabolic resistance.
  { age: 65, gPerKg: 1.4 },
  { age: 50, gPerKg: 1.4 },
];

export function calculateProteinTarget(input: ProteinInputs): number | null {
  if (input.weightLbs == null || input.weightLbs <= 0) return null;
  const weightKg = input.weightLbs / 2.2046;

  const goal = normalizeGoal(input.goal);
  const goalGPerKg = goal ? G_PER_KG[goal] : 1.2;

  // Age-aware floor for older adults.
  const ageFloor = input.age
    ? AGE_FLOORS.find((f) => input.age! >= f.age)?.gPerKg ?? 0
    : 0;

  const gPerKg = Math.max(goalGPerKg, ageFloor);
  const raw = Math.round(weightKg * gPerKg);

  return Math.min(MAX_TARGET, Math.max(MIN_TARGET, raw));
}

function normalizeGoal(goal: ProteinInputs['goal']): FitnessGoal | null {
  if (!goal) return null;
  const g = goal.toString().toLowerCase().replace(/[\s-]/g, '_');
  if (g === 'fat_loss' || g === 'weight_loss' || g === 'lose_weight' || g === 'losing_weight') return 'fat_loss';
  if (g === 'muscle_gain' || g === 'gain_muscle' || g === 'build_muscle') return 'muscle_gain';
  if (g === 'maintenance' || g === 'maintain') return 'maintenance';
  if (g === 'recomposition' || g === 'recomp') return 'recomposition';
  return null;
}
