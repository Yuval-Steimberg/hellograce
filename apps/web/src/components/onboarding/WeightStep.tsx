import QuizButton from "./QuizButton";

interface AboutYouData {
  sex?: string;
  currentWeight?: string;
  goalWeight?: string;
  heightCm?: string;
}

interface AboutYouProps {
  sex: string;
  currentWeight: string;
  goalWeight: string;
  heightCm: string;
  onChange: (data: AboutYouData) => void;
  onNext: () => void;
}

const inputClass =
  "h-16 w-full border-b-2 border-sand focus:border-primary outline-none bg-transparent text-lg text-foreground placeholder:text-muted-foreground/40 transition-colors rounded-none px-1";

const SEX_OPTIONS: { value: string; label: string }[] = [
  { value: 'female', label: 'Female' },
  { value: 'male', label: 'Male' },
  { value: 'nonbinary', label: 'Non-binary' },
  { value: 'prefer_not_to_say', label: 'Prefer not to say' },
];

const WeightStep = ({
  sex,
  currentWeight,
  goalWeight,
  heightCm,
  onChange,
  onNext,
}: AboutYouProps) => {
  return (
    <>
      <div className="flex-1 pt-4">
        <span className="uppercase tracking-widest text-xs font-semibold text-muted-foreground/60 block mb-4">
          About you
        </span>
        <h2 className="text-4xl font-serif text-foreground tracking-tight leading-[1.1] mb-4">
          A few basics so I can tailor things
        </h2>
        <p className="text-muted-foreground text-base leading-relaxed mb-10">
          Just the essentials. Everything else I'll pick up naturally as we chat.
        </p>

        <div className="space-y-7">
          <div className="flex flex-col gap-3">
            <span className="text-foreground font-medium text-sm px-1">Sex</span>
            <div className="grid grid-cols-2 gap-2.5">
              {SEX_OPTIONS.map((opt) => {
                const active = sex === opt.value;
                return (
                  <button
                    type="button"
                    key={opt.value}
                    onClick={() => onChange({ sex: active ? '' : opt.value })}
                    className={`text-left rounded-2xl border-2 px-4 py-3 transition-all ${
                      active
                        ? 'border-primary bg-primary/5 shadow-sm'
                        : 'border-sand hover:border-primary/50 hover:bg-card/50'
                    }`}
                  >
                    <div className="text-foreground font-medium text-[15px]">{opt.label}</div>
                  </button>
                );
              })}
            </div>
          </div>

          <label className="flex flex-col gap-2">
            <span className="text-foreground font-medium text-sm px-1">Height (cm)</span>
            <input
              type="number"
              inputMode="numeric"
              placeholder="e.g. 168"
              value={heightCm}
              onChange={(e) => onChange({ heightCm: e.target.value })}
              className={inputClass}
            />
          </label>

          <div className="grid grid-cols-2 gap-5">
            <label className="flex flex-col gap-2">
              <span className="text-foreground font-medium text-sm px-1">Current weight (lbs)</span>
              <input
                type="number"
                inputMode="numeric"
                placeholder="e.g. 175"
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
                placeholder="e.g. 150"
                value={goalWeight}
                onChange={(e) => onChange({ goalWeight: e.target.value })}
                className={inputClass}
              />
            </label>
          </div>
        </div>

        <p className="text-xs text-muted-foreground mt-5 px-1">
          Everything's optional — skip anything you'd rather not share. I'll learn the rest as we go.
        </p>
      </div>
      <div className="mt-auto pt-6">
        <QuizButton onClick={onNext}>Continue</QuizButton>
      </div>
    </>
  );
};

export default WeightStep;
