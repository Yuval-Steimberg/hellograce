import QuizButton from "./QuizButton";
import QuizTile from "./QuizTile";

const GOALS = [
  { label: "Losing weight", subtitle: "Sustainable progress at a healthy pace" },
  { label: "Eating enough protein", subtitle: "Staying nourished and strong" },
  { label: "Staying hydrated", subtitle: "Building a consistent water habit" },
  { label: "Managing side effects", subtitle: "Navigating nausea, fatigue, and more" },
  { label: "Building better habits", subtitle: "Small daily wins that compound" },
  { label: "Feeling less alone in this", subtitle: "Having someone in your corner" },
  { label: "Hitting my fiber goals", subtitle: "Keeping digestion on track" },
  { label: "Protecting my muscle", subtitle: "Staying strong while losing weight" },
];

interface GoalsStepProps {
  selected: string[];
  onChange: (goals: string[]) => void;
  onNext: () => void;
}

const GoalsStep = ({ selected, onChange, onNext }: GoalsStepProps) => {
  const handleSelect = (goal: string) => {
    if (selected.includes(goal)) {
      onChange(selected.filter((g) => g !== goal));
    } else {
      onChange([...selected, goal]);
    }
  };

  return (
    <>
      <div className="flex-1 pt-4 overflow-y-auto">
        <span className="uppercase tracking-widest text-xs font-semibold text-muted-foreground/60 block mb-4">
          Your focus
        </span>
        <h2 className="text-4xl font-serif text-foreground tracking-tight leading-[1.1] mb-3">
          What matters most right now?
        </h2>
        <p className="text-muted-foreground text-base leading-relaxed mb-8">
          Pick all that feel right. I'll tailor my check-ins to match.
        </p>

        <div className="flex flex-col gap-3">
          {GOALS.map((goal, i) => (
            <QuizTile
              key={goal.label}
              label={goal.label}
              subtitle={goal.subtitle}
              selected={selected.includes(goal.label)}
              onClick={() => handleSelect(goal.label)}
              index={i}
              multiSelect
            />
          ))}
        </div>
      </div>
      <div className="mt-auto pt-6 bg-gradient-to-t from-card via-card to-transparent sticky bottom-0">
        <QuizButton onClick={onNext} disabled={selected.length === 0}>Continue</QuizButton>
      </div>
    </>
  );
};

export default GoalsStep;