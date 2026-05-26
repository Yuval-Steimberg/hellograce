import QuizButton from "./QuizButton";

interface GLP1DetailData {
  glp1StartDate?: string;
  doseMg?: string;
}

interface GLP1DetailProps {
  glp1StartDate: string;
  doseMg: string;
  onChange: (data: GLP1DetailData) => void;
  onNext: () => void;
}

const inputClass =
  "h-16 w-full border-b-2 border-sand focus:border-primary outline-none bg-transparent text-lg text-foreground placeholder:text-muted-foreground/40 transition-colors rounded-none px-1";

const GLP1DetailStep = ({
  glp1StartDate,
  doseMg,
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
          </label>

          <label className="flex flex-col gap-2">
            <span className="text-foreground font-medium text-sm px-1">Current dose (mg)</span>
            <input
              type="text"
              inputMode="decimal"
              pattern="[0-9]*\.?[0-9]*"
              placeholder="e.g. 0.5 or 2.5"
              value={doseMg}
              onChange={(e) => {
                const v = e.target.value.replace(',', '.');
                if (v === '' || /^\d*\.?\d*$/.test(v)) onChange({ doseMg: v });
              }}
              className={inputClass}
            />
            <span className="text-xs text-muted-foreground px-1">Optional — helps with dose-specific side effect guidance</span>
          </label>

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
