import QuizButton from "./QuizButton";

interface LifestyleData {
  exerciseHabits?: string[];
}

interface LifestyleProps {
  exerciseHabits: string[];
  onChange: (data: LifestyleData) => void;
  onNext: () => void;
}

const EXERCISE_OPTIONS: { value: string; label: string }[] = [
  { value: "none", label: "Not exercising yet" },
  { value: "walking", label: "Walking" },
  { value: "gym", label: "Gym / weights" },
  { value: "yoga_pilates", label: "Yoga / Pilates" },
  { value: "running", label: "Running / cardio" },
  { value: "swimming", label: "Swimming" },
  { value: "home_workouts", label: "Home workouts" },
  { value: "mixed", label: "A bit of everything" },
];

const LifestyleStep = ({
  exerciseHabits,
  onChange,
  onNext,
}: LifestyleProps) => {
  const toggleExercise = (value: string) => {
    if (value === "none") {
      onChange({ exerciseHabits: exerciseHabits.includes("none") ? [] : ["none"] });
      return;
    }
    const without = exerciseHabits.filter((v) => v !== "none" && v !== "mixed" && v !== value);
    if (exerciseHabits.includes(value)) {
      onChange({ exerciseHabits: without });
    } else {
      onChange({ exerciseHabits: [...without, value] });
    }
  };

  return (
    <>
      <div className="flex-1 pt-4">
        <span className="uppercase tracking-widest text-xs font-semibold text-muted-foreground/60 block mb-4">
          Daily life
        </span>
        <h2 className="text-4xl font-serif text-foreground tracking-tight leading-[1.1] mb-4">
          How do you move?
        </h2>
        <p className="text-muted-foreground text-base leading-relaxed mb-8">
          Select all that apply — helps me tailor advice to your routine.
        </p>

        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-2.5">
            {EXERCISE_OPTIONS.map((opt) => {
              const active = exerciseHabits.includes(opt.value);
              return (
                <button
                  type="button"
                  key={opt.value}
                  onClick={() => toggleExercise(opt.value)}
                  className={`text-left rounded-2xl border-2 px-4 py-3.5 transition-all ${
                    active
                      ? "border-primary bg-primary/5 shadow-sm"
                      : "border-sand hover:border-primary/50 hover:bg-card/50"
                  }`}
                >
                  <span className="text-foreground text-[15px] font-medium">{opt.label}</span>
                </button>
              );
            })}
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
