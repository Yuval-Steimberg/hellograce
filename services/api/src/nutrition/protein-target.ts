/**
 * Personalized daily protein target (grams) for GLP-1 users.
 *
 * Uses lean-body-mass anchored multipliers, capped by goal-specific
 * grams-per-kg targets. GLP-1 users are at elevated risk of muscle loss,
 * so the floors are higher than the standard RDA (0.8 g/kg).
 *
 * Returns a sensible default (~80g) if inputs are insufficient.
 */
export type FitnessGoal = 'fat_loss' | 'muscle_gain' | 'maintenance' | 'recomposition';

export interface ProteinInputs {
  weightLbs: number | null;     // current weight (lbs — what the schema uses)
  heightCm?: number | null;
  age?: number | null;
  goal?: FitnessGoal | string | null;
}

const DEFAULT_TARGET = 80;
const MIN_TARGET = 60;
const MAX_TARGET = 220;

const G_PER_KG: Record<FitnessGoal, number> = {
  // Aggressive but safe; protects lean mass during weight loss.
  fat_loss: 1.8,
  // Higher demand for synthesis.
  muscle_gain: 2.0,
  // Standard active-adult target.
  maintenance: 1.4,
  // Mid-range — losing fat + gaining muscle simultaneously.
  recomposition: 1.8,
};

const AGE_FLOORS: { age: number; gPerKg: number }[] = [
  // Older adults need more protein to overcome anabolic resistance.
  { age: 65, gPerKg: 1.6 },
  { age: 50, gPerKg: 1.4 },
];

export function calculateProteinTarget(input: ProteinInputs): number {
  if (input.weightLbs == null || input.weightLbs <= 0) return DEFAULT_TARGET;
  const weightKg = input.weightLbs / 2.2046;

  const goal = normalizeGoal(input.goal);
  const goalGPerKg = goal ? G_PER_KG[goal] : 1.4;

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
