import { useState } from "react";
import QuizButton from "./QuizButton";

interface NameStepProps {
  value: string;
  onChange: (name: string) => void;
  onNext: () => void;
}

const NameStep = ({ value, onChange, onNext }: NameStepProps) => {
  const [error, setError] = useState("");

  const handleNext = () => {
    if (!value.trim()) {
      setError("What should I call you?");
      return;
    }
    setError("");
    onNext();
  };

  return (
    <>
      <div className="flex-1 pt-4">
        <span className="uppercase tracking-widest text-xs font-semibold text-muted-foreground/60 block mb-4">
          Nice to meet you
        </span>
        <h2 className="text-4xl font-serif text-foreground tracking-tight leading-[1.1] mb-4">
          What should I call you?
        </h2>
        <p className="text-muted-foreground text-base leading-relaxed mb-10">
          I want this to feel personal from our very first text — so tell me the name you'd love to be greeted by.
        </p>

        <div className="w-full">
          <input
            type="text"
            placeholder="Your preferred name"
            value={value}
            onChange={(e) => { onChange(e.target.value); setError(""); }}
            className="w-full h-16 border-b-2 border-sand focus:border-primary outline-none bg-transparent font-serif text-3xl text-foreground placeholder:text-muted-foreground/30 transition-colors rounded-none"
          />
          {error && <p className="text-destructive text-sm mt-3">{error}</p>}
        </div>
      </div>
      <div className="mt-auto pt-8">
        <QuizButton onClick={handleNext}>Continue</QuizButton>
      </div>
    </>
  );
};

export default NameStep;