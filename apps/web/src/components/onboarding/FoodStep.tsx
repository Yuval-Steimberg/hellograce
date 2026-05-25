import QuizButton from "./QuizButton";

const DIETARY_OPTIONS: { value: string; label: string }[] = [
  { value: "none", label: "No restrictions" },
  { value: "vegetarian", label: "Vegetarian" },
  { value: "vegan", label: "Vegan" },
  { value: "pescatarian", label: "Pescatarian" },
  { value: "keto", label: "Keto / Low-carb" },
  { value: "halal", label: "Halal" },
  { value: "kosher", label: "Kosher" },
  { value: "gluten_free", label: "Gluten-free" },
  { value: "dairy_free", label: "Dairy-free" },
];

interface FoodStepProps {
  foodDislikes: string;
  dietaryRestriction: string;
  onChangeDislikes: (val: string) => void;
  onChangeDietary: (val: string) => void;
  onNext: () => void;
}

const FoodStep = ({ foodDislikes, dietaryRestriction, onChangeDislikes, onChangeDietary, onNext }: FoodStepProps) => {
  return (
    <>
      <div className="flex-1 pt-4">
        <span className="uppercase tracking-widest text-xs font-semibold text-muted-foreground/60 block mb-4">
          Food preferences
        </span>
        <h2 className="text-4xl font-serif text-foreground tracking-tight leading-[1.1] mb-4">
          How do you eat?
        </h2>
        <p className="text-muted-foreground text-base leading-relaxed mb-8">
          Helps me suggest meals you'll actually enjoy.
        </p>

        <div className="space-y-8">
          <div className="flex flex-col gap-3">
            <span className="text-foreground font-medium text-sm px-1">Dietary style</span>
            <div className="grid grid-cols-3 gap-2">
              {DIETARY_OPTIONS.map((opt) => {
                const active = dietaryRestriction === opt.value;
                return (
                  <button
                    type="button"
                    key={opt.value}
                    onClick={() => onChangeDietary(active ? "" : opt.value)}
                    className={`text-center rounded-2xl border-2 px-3 py-2.5 transition-all text-[13px] ${
                      active
                        ? "border-primary bg-primary/5 shadow-sm font-semibold"
                        : "border-sand hover:border-primary/50 hover:bg-card/50"
                    }`}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <span className="text-foreground font-medium text-sm px-1">Anything else you avoid?</span>
            <input
              type="text"
              placeholder="e.g. mushrooms, spicy food, shellfish"
              value={foodDislikes}
              onChange={(e) => onChangeDislikes(e.target.value)}
              className="w-full h-14 border-b-2 border-sand focus:border-primary outline-none bg-transparent text-lg text-foreground placeholder:text-muted-foreground/30 transition-colors rounded-none px-1"
            />
            <p className="text-xs text-muted-foreground px-1">
              Optional — skip if nothing comes to mind
            </p>
          </div>
        </div>
      </div>
      <div className="mt-auto pt-6">
        <QuizButton onClick={onNext}>Continue</QuizButton>
      </div>
    </>
  );
};

export default FoodStep;
