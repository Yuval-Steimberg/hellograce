import QuizButton from "./QuizButton";

interface GLP1DetailData {
  glp1StartDate?: string;
  doseMg?: string;
  dietaryRestriction?: string;
}

interface GLP1DetailProps {
  glp1StartDate: string;
  doseMg: string;
  dietaryRestriction: string;
  onChange: (data: GLP1DetailData) => void;
  onNext: () => void;
}

const inputClass =
  "h-16 w-full border-b-2 border-sand focus:border-primary outline-none bg-transparent text-lg text-foreground placeholder:text-muted-foreground/40 transition-colors rounded-none px-1";

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

const GLP1DetailStep = ({
  glp1StartDate,
  doseMg,
  dietaryRestriction,
  onChange,
  onNext,
}: GLP1DetailProps) => {
  return (
    <>
      <div className="flex-1 pt-4">
        <span className="uppercase tracking-widest text-xs font-semibold text-muted-foreground/60 block mb-4">
          Your medication
        </span>
        <h2 className="text-4xl font-serif text-foreground tracking-tight leading-[1.1] mb-4">
          A bit more about your journey
        </h2>
        <p className="text-muted-foreground text-base leading-relaxed mb-10">
          This helps me track your milestones and tailor advice to where you are.
        </p>

        <div className="space-y-7">
          <label className="flex flex-col gap-2">
            <span className="text-foreground font-medium text-sm px-1">When did you start your GLP-1?</span>
            <input
              type="date"
              value={glp1StartDate}
              onChange={(e) => onChange({ glp1StartDate: e.target.value })}
              className={inputClass}
            />
            <span className="text-xs text-muted-foreground px-1">Approximate is fine — helps me say things like "you're in week 8"</span>
          </label>

          <label className="flex flex-col gap-2">
            <span className="text-foreground font-medium text-sm px-1">Current dose (mg)</span>
            <input
              type="number"
              inputMode="decimal"
              step="0.25"
              placeholder="e.g. 0.5 or 2.5"
              value={doseMg}
              onChange={(e) => onChange({ doseMg: e.target.value })}
              className={inputClass}
            />
            <span className="text-xs text-muted-foreground px-1">Optional — helps with dose-specific side effect guidance</span>
          </label>

          <div className="flex flex-col gap-3">
            <span className="text-foreground font-medium text-sm px-1">Dietary style</span>
            <div className="grid grid-cols-3 gap-2">
              {DIETARY_OPTIONS.map((opt) => {
                const active = dietaryRestriction === opt.value;
                return (
                  <button
                    type="button"
                    key={opt.value}
                    onClick={() => onChange({ dietaryRestriction: active ? "" : opt.value })}
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
        </div>

        <p className="text-xs text-muted-foreground mt-5 px-1">
          All optional — skip anything you're not sure about.
        </p>
      </div>
      <div className="mt-auto pt-6">
        <QuizButton onClick={onNext}>Continue</QuizButton>
      </div>
    </>
  );
};

export default GLP1DetailStep;
