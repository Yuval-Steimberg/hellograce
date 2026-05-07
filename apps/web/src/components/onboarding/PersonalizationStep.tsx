import QuizButton from "./QuizButton";

interface PersonalizationStepProps {
  data: {
    wakeTime: string;
    sleepTime: string;
    foodDislikes: string;
    currentWeight: string;
    goalWeight: string;
  };
  onChange: (data: Partial<PersonalizationStepProps["data"]>) => void;
  onNext: () => void;
  saving?: boolean;
}

const inputClass =
  "h-16 w-full border-b-2 border-sand focus:border-primary outline-none bg-transparent text-lg text-foreground placeholder:text-muted-foreground/40 transition-colors rounded-none px-1";

const PersonalizationStep = ({ data, onChange, onNext, saving }: PersonalizationStepProps) => {
  return (
    <>
      <div className="flex-1 pt-4">
        <span className="uppercase tracking-widest text-xs font-semibold text-muted-foreground/60 block mb-4">
          Personalization
        </span>
        <h2 className="text-4xl font-serif text-foreground tracking-tight leading-[1.1] mb-3">
          Almost there.
        </h2>
        <p className="text-muted-foreground text-base leading-relaxed mb-8">
          A few more details so I can text you at the right time and give better advice.
        </p>

        <div className="space-y-6">
          <div className="grid grid-cols-2 gap-6">
            <label className="flex flex-col gap-2">
              <span className="text-foreground font-medium text-sm px-1">Wake time</span>
              <input
                type="time"
                value={data.wakeTime}
                onChange={(e) => onChange({ wakeTime: e.target.value })}
                className={inputClass}
              />
            </label>
            <label className="flex flex-col gap-2">
              <span className="text-foreground font-medium text-sm px-1">Bed time</span>
              <input
                type="time"
                value={data.sleepTime}
                onChange={(e) => onChange({ sleepTime: e.target.value })}
                className={inputClass}
              />
            </label>
          </div>

          <label className="flex flex-col gap-2">
            <span className="text-foreground font-medium text-sm px-1">Any foods you won't eat?</span>
            <input
              type="text"
              placeholder="e.g. I hate fish, I'm vegetarian"
              value={data.foodDislikes}
              onChange={(e) => onChange({ foodDislikes: e.target.value })}
              className={inputClass}
            />
            <span className="text-xs text-muted-foreground px-1">Optional</span>
          </label>

          <div className="grid grid-cols-2 gap-6">
            <label className="flex flex-col gap-2">
              <span className="text-foreground font-medium text-sm px-1">Current weight</span>
              <input
                type="number"
                placeholder="lbs"
                value={data.currentWeight}
                onChange={(e) => onChange({ currentWeight: e.target.value })}
                className={inputClass}
              />
              <span className="text-xs text-muted-foreground px-1">Optional</span>
            </label>
            <label className="flex flex-col gap-2">
              <span className="text-foreground font-medium text-sm px-1">Goal weight</span>
              <input
                type="number"
                placeholder="lbs"
                value={data.goalWeight}
                onChange={(e) => onChange({ goalWeight: e.target.value })}
                className={inputClass}
              />
              <span className="text-xs text-muted-foreground px-1">Optional</span>
            </label>
          </div>
        </div>
      </div>
      <div className="mt-auto pt-6">
        <QuizButton onClick={onNext} disabled={saving}>
          {saving ? "Saving..." : "Finish"}
        </QuizButton>
      </div>
    </>
  );
};

export default PersonalizationStep;