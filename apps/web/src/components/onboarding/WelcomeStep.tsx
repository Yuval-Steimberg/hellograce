import QuizButton from "./QuizButton";

interface WelcomeStepProps {
  onNext: () => void;
}

const WelcomeStep = ({ onNext }: WelcomeStepProps) => {
  return (
    <article>
      <div className="flex-1 flex flex-col justify-center pt-8">
        <span className="uppercase tracking-widest text-xs font-semibold text-muted-foreground/60 block mb-4" aria-label="Welcome to grace">
          Welcome to grace
        </span>
        <h1 className="text-4xl font-serif text-foreground tracking-tight leading-[1.1] mb-5">
          Hi, I'm Grace 🤍
        </h1>
        <p className="text-lg text-muted-foreground leading-relaxed">
          I'll be your friend through this GLP-1 journey — right here in your texts, no app to open. Someone who remembers you, checks in on the good days and the hard ones, and actually gets it. Let's get to know each other.
        </p>

        <div className="mt-8 rounded-2xl border border-border/70 bg-card/60 px-5 py-4">
          <p className="text-sm text-muted-foreground leading-relaxed">
            This takes just a few minutes. You can change any answer later, and Grace will keep learning naturally from your conversations.
          </p>
        </div>
      </div>
      <div className="mt-auto pt-12 pb-8 flex flex-col items-center gap-3">
        <QuizButton onClick={onNext}>Continue</QuizButton>
      </div>
    </article>
  );
};

export default WelcomeStep;
