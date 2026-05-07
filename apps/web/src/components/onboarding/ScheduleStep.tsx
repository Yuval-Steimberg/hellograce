import QuizButton from "./QuizButton";

interface ScheduleStepProps {
  wakeTime: string;
  sleepTime: string;
  onChange: (data: { wakeTime?: string; sleepTime?: string }) => void;
  onNext: () => void;
}

const ScheduleStep = ({ wakeTime, sleepTime, onChange, onNext }: ScheduleStepProps) => {
  return (
    <>
      <div className="flex-1 pt-4">
        <span className="uppercase tracking-widest text-xs font-semibold text-muted-foreground/60 block mb-4">
          Your schedule
        </span>
        <h2 className="text-4xl font-serif text-foreground tracking-tight leading-[1.1] mb-4">
          When are you up?
        </h2>
        <p className="text-muted-foreground text-base leading-relaxed mb-10">
          I'll text at the right time — never too early, never too late.
        </p>

        <div className="space-y-8">
          <label className="flex flex-col gap-2">
            <span className="text-foreground font-medium text-sm px-1">I usually wake up around</span>
            <input
              type="time"
              value={wakeTime}
              onChange={(e) => onChange({ wakeTime: e.target.value })}
              className="h-16 w-full border-b-2 border-sand focus:border-primary outline-none bg-transparent text-lg text-foreground transition-colors rounded-none px-1"
            />
          </label>
          <label className="flex flex-col gap-2">
            <span className="text-foreground font-medium text-sm px-1">I'm usually in bed by</span>
            <input
              type="time"
              value={sleepTime}
              onChange={(e) => onChange({ sleepTime: e.target.value })}
              className="h-16 w-full border-b-2 border-sand focus:border-primary outline-none bg-transparent text-lg text-foreground transition-colors rounded-none px-1"
            />
          </label>
        </div>
      </div>
      <div className="mt-auto pt-6">
        <QuizButton onClick={onNext}>Continue</QuizButton>
      </div>
    </>
  );
};

export default ScheduleStep;
