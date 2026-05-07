import QuizButton from "./QuizButton";
import QuizTile from "./QuizTile";

const DAYS = [
  { label: "Monday", short: "Mon" },
  { label: "Tuesday", short: "Tue" },
  { label: "Wednesday", short: "Wed" },
  { label: "Thursday", short: "Thu" },
  { label: "Friday", short: "Fri" },
  { label: "Saturday", short: "Sat" },
  { label: "Sunday", short: "Sun" },
];

interface InjectionDayStepProps {
  selected: string;
  onSelect: (day: string) => void;
  onNext: () => void;
}

const InjectionDayStep = ({ selected, onSelect, onNext }: InjectionDayStepProps) => {
  return (
    <>
      <div className="flex-1 pt-4">
        <span className="uppercase tracking-widest text-xs font-semibold text-muted-foreground/60 block mb-4">
          Injection schedule
        </span>
        <h2 className="text-4xl font-serif text-foreground tracking-tight leading-[1.1] mb-4">
          What day is your shot?
        </h2>
        <p className="text-muted-foreground text-base leading-relaxed mb-8">
          I'll remind you the day before so you're always prepared.
        </p>

        <div className="flex flex-col gap-3">
          {DAYS.map((day, i) => (
            <QuizTile
              key={day.short}
              label={day.label}
              selected={selected === day.short}
              onClick={() => onSelect(day.short)}
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

export default InjectionDayStep;