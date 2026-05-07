import QuizButton from "./QuizButton";

interface FoodStepProps {
  value: string;
  onChange: (val: string) => void;
  onNext: () => void;
}

const FoodStep = ({ value, onChange, onNext }: FoodStepProps) => {
  return (
    <>
      <div className="flex-1 pt-4">
        <span className="uppercase tracking-widest text-xs font-semibold text-muted-foreground/60 block mb-4">
          Food preferences
        </span>
        <h2 className="text-4xl font-serif text-foreground tracking-tight leading-[1.1] mb-4">
          Any foods you won't eat?
        </h2>
        <p className="text-muted-foreground text-base leading-relaxed mb-10">
          I'll never suggest something you hate. Tell me your deal-breakers.
        </p>

        <div className="w-full">
          <input
            type="text"
            placeholder="e.g. I'm vegetarian, I hate fish"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            className="w-full h-16 border-b-2 border-sand focus:border-primary outline-none bg-transparent font-serif text-xl text-foreground placeholder:text-muted-foreground/30 transition-colors rounded-none"
          />
          <p className="text-xs text-muted-foreground mt-3 px-1">
            Optional — skip if you eat everything
          </p>
        </div>
      </div>
      <div className="mt-auto pt-6">
        <QuizButton onClick={onNext}>Continue</QuizButton>
      </div>
    </>
  );
};

export default FoodStep;
