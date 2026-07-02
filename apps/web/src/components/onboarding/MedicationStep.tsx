import QuizButton from "./QuizButton";
import QuizTile from "./QuizTile";

const MEDICATIONS = [
  { label: "Ozempic", subtitle: "Semaglutide, weekly injection", frequency: "weekly" },
  { label: "Wegovy", subtitle: "Semaglutide, weekly injection", frequency: "weekly" },
  { label: "Mounjaro", subtitle: "Tirzepatide, weekly injection", frequency: "weekly" },
  { label: "Zepbound", subtitle: "Tirzepatide, weekly injection", frequency: "weekly" },
  { label: "Rybelsus", subtitle: "Oral semaglutide, daily pill", frequency: "daily" },
  { label: "Victoza", subtitle: "Liraglutide, daily injection", frequency: "daily" },
  { label: "Saxenda", subtitle: "Liraglutide, daily injection", frequency: "daily" },
  { label: "Compounded semaglutide", subtitle: "Compounding pharmacy, weekly", frequency: "weekly" },
  { label: "Compounded tirzepatide", subtitle: "Compounding pharmacy, weekly", frequency: "weekly" },
];

interface MedicationStepProps {
  selected: string;
  onSelect: (med: string, frequency: string) => void;
  onNext: () => void;
}

const MedicationStep = ({ selected, onSelect, onNext }: MedicationStepProps) => {
  return (
    <>
      <div className="flex-1 pt-4 overflow-y-auto">
        <span className="uppercase tracking-widest text-xs font-semibold text-muted-foreground/60 block mb-4">
          Your medication
        </span>
        <h2 className="text-4xl font-serif text-foreground tracking-tight leading-[1.1] mb-4">
          Which one are you on?
        </h2>
        <p className="text-muted-foreground text-base leading-relaxed mb-8">
          Every GLP-1 is a little different. Tell me yours and everything I share will actually fit you — not generic advice.
        </p>

        <div className="flex flex-col gap-3">
          {MEDICATIONS.map((med, i) => (
            <QuizTile
              key={med.label}
              label={med.label}
              subtitle={med.subtitle}
              selected={selected === med.label}
              onClick={() => onSelect(med.label, med.frequency)}
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

export default MedicationStep;
