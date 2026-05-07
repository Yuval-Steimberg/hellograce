import QuizButton from "./QuizButton";

interface WeightStepProps {
  currentWeight: string;
  goalWeight: string;
  onChange: (data: { currentWeight?: string; goalWeight?: string }) => void;
  onNext: () => void;
}

const inputClass =
  "h-16 w-full border-b-2 border-sand focus:border-primary outline-none bg-transparent text-lg text-foreground placeholder:text-muted-foreground/40 transition-colors rounded-none px-1";

const WeightStep = ({ currentWeight, goalWeight, onChange, onNext }: WeightStepProps) => {
  return (
    <>
      <div className="flex-1 pt-4">
        <span className="uppercase tracking-widest text-xs font-semibold text-muted-foreground/60 block mb-4">
          Your progress
        </span>
        <h2 className="text-4xl font-serif text-foreground tracking-tight leading-[1.1] mb-4">
          Where are you headed?
        </h2>
        <p className="text-muted-foreground text-base leading-relaxed mb-10">
          I'll celebrate milestones with you along the way. Totally optional.
        </p>

        <div className="space-y-8">
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

        <p className="text-xs text-muted-foreground mt-4 px-1">
          Both optional — skip if you'd rather not share
        </p>
      </div>
      <div className="mt-auto pt-6">
        <QuizButton onClick={onNext}>Continue</QuizButton>
      </div>
    </>
  );
};

export default WeightStep;
