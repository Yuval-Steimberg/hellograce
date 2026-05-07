import QuizButton from "./QuizButton";
import QuizTile from "./QuizTile";

const TIMES = [
  { label: "Morning", subtitle: "With breakfast or after waking up", value: "morning" },
  { label: "Evening", subtitle: "With dinner or before bed", value: "evening" },
  { label: "I decide each day", subtitle: "No fixed time yet", value: "flexible" },
];

interface MedicationTimeStepProps {
  selected: string;
  onSelect: (time: string) => void;
  onNext: () => void;
}

const MedicationTimeStep = ({ selected, onSelect, onNext }: MedicationTimeStepProps) => {
  return (
    <>
      <div className="flex-1 pt-4">
        <span className="uppercase tracking-widest text-xs font-semibold text-muted-foreground/60 block mb-4">
          Medication timing
        </span>
        <h2 className="text-4xl font-serif text-foreground tracking-tight leading-[1.1] mb-4">
          When do you take it?
        </h2>
        <p className="text-muted-foreground text-base leading-relaxed mb-8">
          I'll remind you at the right time and check in on how you're feeling.
        </p>

        <div className="flex flex-col gap-3">
          {TIMES.map((time, i) => (
            <QuizTile
              key={time.value}
              label={time.label}
              subtitle={time.subtitle}
              selected={selected === time.value}
              onClick={() => onSelect(time.value)}
              onAutoAdvance={onNext}
              index={i}
            />
          ))}
        </div>
      </div>
      <div className="mt-auto pt-6 bg-gradient-to-t from-card via-card to-transparent sticky bottom-0">
        <QuizButton onClick={onNext} disabled={!selected}>Continue</QuizButton>
      </div>
    </>
  );
};

export default MedicationTimeStep;
