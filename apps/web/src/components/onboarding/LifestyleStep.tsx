import QuizButton from "./QuizButton";

interface LifestyleData {
  exerciseHabits?: string;
  cookingComfort?: string;
  dailyWaterIntake?: string;
}

interface LifestyleProps {
  exerciseHabits: string;
  cookingComfort: string;
  dailyWaterIntake: string;
  onChange: (data: LifestyleData) => void;
  onNext: () => void;
}

const EXERCISE_OPTIONS: { value: string; label: string; emoji: string }[] = [
  { value: "none", label: "Not exercising yet", emoji: "🛋️" },
  { value: "walking", label: "Walking", emoji: "🚶‍♀️" },
  { value: "gym", label: "Gym / weights", emoji: "🏋️" },
  { value: "yoga_pilates", label: "Yoga / Pilates", emoji: "🧘" },
  { value: "running", label: "Running / cardio", emoji: "🏃‍♀️" },
  { value: "swimming", label: "Swimming", emoji: "🏊" },
  { value: "home_workouts", label: "Home workouts", emoji: "🏠" },
  { value: "mixed", label: "A bit of everything", emoji: "🔄" },
];

const COOKING_OPTIONS: { value: string; label: string; description: string }[] = [
  { value: "dont_cook", label: "I don't really cook", description: "Takeout, prepared meals, simple assembly" },
  { value: "basic", label: "Basic cooking", description: "Simple recipes, 15-20 min meals" },
  { value: "comfortable", label: "Pretty comfortable", description: "Can follow most recipes, enjoy cooking" },
  { value: "love_cooking", label: "Love cooking", description: "Enjoy experimenting, complex recipes welcome" },
];

const WATER_OPTIONS: { value: string; label: string; emoji: string }[] = [
  { value: "less_than_4", label: "Less than 4 cups", emoji: "🥤" },
  { value: "4_to_6", label: "4–6 cups", emoji: "💧" },
  { value: "6_to_8", label: "6–8 cups", emoji: "💧💧" },
  { value: "more_than_8", label: "8+ cups", emoji: "🌊" },
];

const LifestyleStep = ({
  exerciseHabits,
  cookingComfort,
  dailyWaterIntake,
  onChange,
  onNext,
}: LifestyleProps) => {
  return (
    <>
      <div className="flex-1 pt-4">
        <span className="uppercase tracking-widest text-xs font-semibold text-muted-foreground/60 block mb-4">
          Daily life
        </span>
        <h2 className="text-4xl font-serif text-foreground tracking-tight leading-[1.1] mb-4">
          Your everyday habits
        </h2>
        <p className="text-muted-foreground text-base leading-relaxed mb-8">
          So my suggestions actually fit your life — not someone else's.
        </p>

        <div className="space-y-8">
          <div className="flex flex-col gap-3">
            <span className="text-foreground font-medium text-sm px-1">What exercise do you do?</span>
            <div className="grid grid-cols-2 gap-2">
              {EXERCISE_OPTIONS.map((opt) => {
                const active = exerciseHabits === opt.value;
                return (
                  <button
                    type="button"
                    key={opt.value}
                    onClick={() => onChange({ exerciseHabits: active ? "" : opt.value })}
                    className={`text-left rounded-2xl border-2 px-3 py-2.5 transition-all ${
                      active
                        ? "border-primary bg-primary/5 shadow-sm"
                        : "border-sand hover:border-primary/50 hover:bg-card/50"
                    }`}
                  >
                    <span className="mr-1.5">{opt.emoji}</span>
                    <span className="text-foreground text-[13px] font-medium">{opt.label}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="flex flex-col gap-3">
            <span className="text-foreground font-medium text-sm px-1">Cooking comfort level</span>
            <div className="grid grid-cols-2 gap-2.5">
              {COOKING_OPTIONS.map((opt) => {
                const active = cookingComfort === opt.value;
                return (
                  <button
                    type="button"
                    key={opt.value}
                    onClick={() => onChange({ cookingComfort: active ? "" : opt.value })}
                    className={`text-left rounded-2xl border-2 px-4 py-3 transition-all ${
                      active
                        ? "border-primary bg-primary/5 shadow-sm"
                        : "border-sand hover:border-primary/50 hover:bg-card/50"
                    }`}
                  >
                    <div className="text-foreground font-medium text-[15px]">{opt.label}</div>
                    <div className="text-muted-foreground text-xs mt-0.5">{opt.description}</div>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="flex flex-col gap-3">
            <span className="text-foreground font-medium text-sm px-1">How much water do you drink daily?</span>
            <div className="grid grid-cols-2 gap-2">
              {WATER_OPTIONS.map((opt) => {
                const active = dailyWaterIntake === opt.value;
                return (
                  <button
                    type="button"
                    key={opt.value}
                    onClick={() => onChange({ dailyWaterIntake: active ? "" : opt.value })}
                    className={`text-left rounded-2xl border-2 px-3 py-2.5 transition-all ${
                      active
                        ? "border-primary bg-primary/5 shadow-sm"
                        : "border-sand hover:border-primary/50 hover:bg-card/50"
                    }`}
                  >
                    <span className="mr-1.5">{opt.emoji}</span>
                    <span className="text-foreground text-[13px] font-medium">{opt.label}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </div>
      <div className="mt-auto pt-6">
        <QuizButton onClick={onNext}>Continue</QuizButton>
      </div>
    </>
  );
};

export default LifestyleStep;
