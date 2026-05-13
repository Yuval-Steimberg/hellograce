import QuizButton from "./QuizButton";

interface WeightStepData {
  currentWeight?: string;
  goalWeight?: string;
  heightCm?: string;
  age?: string;
  primaryGoal?: string;
}

interface WeightStepProps {
  currentWeight: string;
  goalWeight: string;
  heightCm: string;
  age: string;
  primaryGoal: string;
  onChange: (data: WeightStepData) => void;
  onNext: () => void;
}

const inputClass =
  "h-16 w-full border-b-2 border-sand focus:border-primary outline-none bg-transparent text-lg text-foreground placeholder:text-muted-foreground/40 transition-colors rounded-none px-1";

const GOAL_OPTIONS: { value: string; label: string; sub: string }[] = [
  { value: 'fat_loss', label: 'Fat loss', sub: 'lose weight while protecting muscle' },
  { value: 'muscle_gain', label: 'Muscle gain', sub: 'build lean mass' },
  { value: 'maintenance', label: 'Maintenance', sub: 'stay where I am' },
  { value: 'recomposition', label: 'Recomposition', sub: 'lose fat + gain muscle' },
];

const WeightStep = ({
  currentWeight,
  goalWeight,
  heightCm,
  age,
  primaryGoal,
  onChange,
  onNext,
}: WeightStepProps) => {
  return (
    <>
      <div className="flex-1 pt-4">
        <span className="uppercase tracking-widest text-xs font-semibold text-muted-foreground/60 block mb-4">
          Your progress
        </span>
        <h2 className="text-4xl font-serif text-foreground tracking-tight leading-[1.1] mb-4">
          A few details so I can tailor things
        </h2>
        <p className="text-muted-foreground text-base leading-relaxed mb-10">
          This helps me calculate your protein target and celebrate the right milestones. Everything's optional.
        </p>

        <div className="space-y-7">
          <div className="grid grid-cols-2 gap-5">
            <label className="flex flex-col gap-2">
              <span className="text-foreground font-medium text-sm px-1">Current weight (lbs)</span>
              <input
                type="number"
                inputMode="numeric"
                placeholder="Optional"
                value={currentWeight}
                onChange={(e) => onChange({ currentWeight: e.target.value })}
                className={inputClass}
              />
            </label>
            <label className="flex flex-col gap-2">
              <span className="text-foreground font-medium text-sm px-1">Goal weight (lbs)</span>
              <input
                type="number"
                inputMode="numeric"
                placeholder="Optional"
                value={goalWeight}
                onChange={(e) => onChange({ goalWeight: e.target.value })}
                className={inputClass}
              />
            </label>
          </div>

          <div className="grid grid-cols-2 gap-5">
            <label className="flex flex-col gap-2">
              <span className="text-foreground font-medium text-sm px-1">Height (cm)</span>
              <input
                type="number"
                inputMode="numeric"
                placeholder="Optional"
                value={heightCm}
                onChange={(e) => onChange({ heightCm: e.target.value })}
                className={inputClass}
              />
            </label>
            <label className="flex flex-col gap-2">
              <span className="text-foreground font-medium text-sm px-1">Age</span>
              <input
                type="number"
                inputMode="numeric"
                placeholder="Optional"
                value={age}
                onChange={(e) => onChange({ age: e.target.value })}
                className={inputClass}
              />
            </label>
          </div>

          <div className="flex flex-col gap-3">
            <span className="text-foreground font-medium text-sm px-1">Your main goal right now</span>
            <div className="grid grid-cols-2 gap-2.5">
              {GOAL_OPTIONS.map((opt) => {
                const active = primaryGoal === opt.value;
                return (
                  <button
                    type="button"
                    key={opt.value}
                    onClick={() => onChange({ primaryGoal: active ? '' : opt.value })}
                    className={`text-left rounded-2xl border-2 px-4 py-3 transition-all ${
                      active
                        ? 'border-primary bg-primary/5 shadow-sm'
                        : 'border-sand hover:border-primary/50 hover:bg-card/50'
                    }`}
                  >
                    <div className="text-foreground font-medium text-[15px]">{opt.label}</div>
                    <div className="text-muted-foreground text-xs leading-snug mt-0.5">{opt.sub}</div>
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        <p className="text-xs text-muted-foreground mt-5 px-1">
          Everything's optional — skip anything you'd rather not share.
        </p>
      </div>
      <div className="mt-auto pt-6">
        <QuizButton onClick={onNext}>Continue</QuizButton>
      </div>
    </>
  );
};

export default WeightStep;
