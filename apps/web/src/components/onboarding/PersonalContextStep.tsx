import { useState } from "react";
import QuizButton from "./QuizButton";

interface PersonalContextData {
  biggestChallenge?: string;
  whyStarted?: string;
  supportStyle?: string;
  exerciseHabits?: string[];
}

interface PersonalContextProps {
  biggestChallenge: string;
  whyStarted: string;
  supportStyle: string;
  exerciseHabits: string[];
  onChange: (data: PersonalContextData) => void;
  onNext: () => void;
}

const CHALLENGE_OPTIONS: { value: string; label: string }[] = [
  { value: "cravings", label: "Cravings & appetite" },
  { value: "side_effects", label: "Side effects" },
  { value: "cooking", label: "Meal prep / cooking" },
  { value: "motivation", label: "Staying motivated" },
  { value: "social_eating", label: "Social situations" },
  { value: "emotional_eating", label: "Emotional eating" },
  { value: "protein", label: "Hitting protein goals" },
  { value: "energy", label: "Low energy / fatigue" },
];

const WHY_OPTIONS: { value: string; label: string }[] = [
  { value: "doctor_recommended", label: "Doctor recommended" },
  { value: "health_condition", label: "Health condition (diabetes, PCOS, etc.)" },
  { value: "weight_management", label: "Weight management" },
  { value: "quality_of_life", label: "Better quality of life" },
  { value: "self_image", label: "Feel better about myself" },
  { value: "energy_mobility", label: "More energy & mobility" },
];

const SUPPORT_OPTIONS: { value: string; label: string; description: string }[] = [
  { value: "gentle", label: "Gentle & warm", description: "Encouragement and compassion first" },
  { value: "straight_facts", label: "Straight facts", description: "Give me the data, skip the fluff" },
  { value: "tough_love", label: "Push me", description: "Hold me accountable, be direct" },
  { value: "mix", label: "Mix it up", description: "Read the room and adapt" },
];

const EXERCISE_OPTIONS: { value: string; label: string }[] = [
  { value: "none", label: "Not exercising yet" },
  { value: "walking", label: "Walking" },
  { value: "gym", label: "Gym / weights" },
  { value: "yoga_pilates", label: "Yoga / Pilates" },
  { value: "running", label: "Running / cardio" },
  { value: "swimming", label: "Swimming" },
  { value: "home_workouts", label: "Home workouts" },
  { value: "mixed", label: "A bit of everything" },
];

function selectedLabel(value: string, options: { value: string; label: string }[]): string | null {
  if (!value) return null;
  return options.find((o) => o.value === value)?.label ?? null;
}

const PersonalContextStep = ({
  biggestChallenge,
  whyStarted,
  supportStyle,
  exerciseHabits,
  onChange,
  onNext,
}: PersonalContextProps) => {
  const [open, setOpen] = useState<string | null>(null);

  const toggle = (key: string) => setOpen((prev) => (prev === key ? null : key));

  const toggleExercise = (value: string) => {
    if (value === "none") {
      onChange({ exerciseHabits: exerciseHabits.includes("none") ? [] : ["none"] });
      return;
    }
    const without = exerciseHabits.filter((v) => v !== "none" && v !== "mixed" && v !== value);
    if (exerciseHabits.includes(value)) {
      onChange({ exerciseHabits: without });
    } else {
      onChange({ exerciseHabits: [...without, value] });
    }
  };

  const exerciseSummary = exerciseHabits.length > 0
    ? exerciseHabits.map((v) => EXERCISE_OPTIONS.find((o) => o.value === v)?.label).filter(Boolean).join(", ")
    : null;

  return (
    <>
      <div className="flex-1 pt-4">
        <span className="uppercase tracking-widest text-xs font-semibold text-muted-foreground/60 block mb-4">
          Your story
        </span>
        <h2 className="text-4xl font-serif text-foreground tracking-tight leading-[1.1] mb-4">
          What's this really about for you?
        </h2>
        <p className="text-primary font-medium text-lg leading-relaxed mb-2">
          Optional — but the more I know, the more I'll feel like your friend, not an app.
        </p>
        <p className="text-muted-foreground text-sm leading-relaxed mb-8">
          Tap anything you'd like to share. Skip what you'd rather keep to yourself — no pressure, ever.
        </p>

        <div className="space-y-3">
          {/* Challenge */}
          <div className="rounded-2xl border-2 border-sand overflow-hidden">
            <button
              type="button"
              onClick={() => toggle("challenge")}
              className="w-full flex items-center justify-between px-5 py-4 text-left"
            >
              <div className="flex-1 min-w-0">
                <span className="text-foreground font-medium text-[15px]">What's your biggest challenge?</span>
                {biggestChallenge && open !== "challenge" && (
                  <span className="block text-primary text-xs mt-0.5 truncate">
                    {selectedLabel(biggestChallenge, CHALLENGE_OPTIONS)}
                  </span>
                )}
              </div>
              <svg
                className={`w-5 h-5 text-muted-foreground/50 shrink-0 ml-3 transition-transform ${open === "challenge" ? "rotate-180" : ""}`}
                fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
              </svg>
            </button>
            {open === "challenge" && (
              <div className="px-4 pb-4">
                <div className="grid grid-cols-2 gap-2">
                  {CHALLENGE_OPTIONS.map((opt) => {
                    const active = biggestChallenge === opt.value;
                    return (
                      <button
                        type="button"
                        key={opt.value}
                        onClick={() => onChange({ biggestChallenge: active ? "" : opt.value })}
                        className={`text-left rounded-xl border-2 px-3 py-2.5 transition-all ${
                          active
                            ? "border-primary bg-primary/5 shadow-sm"
                            : "border-sand hover:border-primary/50 hover:bg-card/50"
                        }`}
                      >
                        <span className="text-foreground text-[13px] font-medium">{opt.label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          {/* Why started */}
          <div className="rounded-2xl border-2 border-sand overflow-hidden">
            <button
              type="button"
              onClick={() => toggle("why")}
              className="w-full flex items-center justify-between px-5 py-4 text-left"
            >
              <div className="flex-1 min-w-0">
                <span className="text-foreground font-medium text-[15px]">Why did you start GLP-1?</span>
                {whyStarted && open !== "why" && (
                  <span className="block text-primary text-xs mt-0.5 truncate">
                    {selectedLabel(whyStarted, WHY_OPTIONS)}
                  </span>
                )}
              </div>
              <svg
                className={`w-5 h-5 text-muted-foreground/50 shrink-0 ml-3 transition-transform ${open === "why" ? "rotate-180" : ""}`}
                fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
              </svg>
            </button>
            {open === "why" && (
              <div className="px-4 pb-4">
                <div className="grid grid-cols-2 gap-2">
                  {WHY_OPTIONS.map((opt) => {
                    const active = whyStarted === opt.value;
                    return (
                      <button
                        type="button"
                        key={opt.value}
                        onClick={() => onChange({ whyStarted: active ? "" : opt.value })}
                        className={`text-left rounded-xl border-2 px-3 py-2.5 transition-all ${
                          active
                            ? "border-primary bg-primary/5 shadow-sm"
                            : "border-sand hover:border-primary/50 hover:bg-card/50"
                        }`}
                      >
                        <span className="text-foreground text-[13px] font-medium">{opt.label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          {/* Exercise */}
          <div className="rounded-2xl border-2 border-sand overflow-hidden">
            <button
              type="button"
              onClick={() => toggle("exercise")}
              className="w-full flex items-center justify-between px-5 py-4 text-left"
            >
              <div className="flex-1 min-w-0">
                <span className="text-foreground font-medium text-[15px]">How do you move?</span>
                {exerciseSummary && open !== "exercise" && (
                  <span className="block text-primary text-xs mt-0.5 truncate">
                    {exerciseSummary}
                  </span>
                )}
              </div>
              <svg
                className={`w-5 h-5 text-muted-foreground/50 shrink-0 ml-3 transition-transform ${open === "exercise" ? "rotate-180" : ""}`}
                fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
              </svg>
            </button>
            {open === "exercise" && (
              <div className="px-4 pb-4">
                <p className="text-muted-foreground text-xs mb-2 px-1">Select all that apply</p>
                <div className="grid grid-cols-2 gap-2">
                  {EXERCISE_OPTIONS.map((opt) => {
                    const active = exerciseHabits.includes(opt.value);
                    return (
                      <button
                        type="button"
                        key={opt.value}
                        onClick={() => toggleExercise(opt.value)}
                        className={`text-left rounded-xl border-2 px-3 py-2.5 transition-all ${
                          active
                            ? "border-primary bg-primary/5 shadow-sm"
                            : "border-sand hover:border-primary/50 hover:bg-card/50"
                        }`}
                      >
                        <span className="text-foreground text-[13px] font-medium">{opt.label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          {/* Support style */}
          <div className="rounded-2xl border-2 border-sand overflow-hidden">
            <button
              type="button"
              onClick={() => toggle("support")}
              className="w-full flex items-center justify-between px-5 py-4 text-left"
            >
              <div className="flex-1 min-w-0">
                <span className="text-foreground font-medium text-[15px]">How should I talk to you?</span>
                {supportStyle && open !== "support" && (
                  <span className="block text-primary text-xs mt-0.5 truncate">
                    {selectedLabel(supportStyle, SUPPORT_OPTIONS)}
                  </span>
                )}
              </div>
              <svg
                className={`w-5 h-5 text-muted-foreground/50 shrink-0 ml-3 transition-transform ${open === "support" ? "rotate-180" : ""}`}
                fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
              </svg>
            </button>
            {open === "support" && (
              <div className="px-4 pb-4">
                <div className="grid grid-cols-2 gap-2.5">
                  {SUPPORT_OPTIONS.map((opt) => {
                    const active = supportStyle === opt.value;
                    return (
                      <button
                        type="button"
                        key={opt.value}
                        onClick={() => onChange({ supportStyle: active ? "" : opt.value })}
                        className={`text-left rounded-xl border-2 px-4 py-3 transition-all ${
                          active
                            ? "border-primary bg-primary/5 shadow-sm"
                            : "border-sand hover:border-primary/50 hover:bg-card/50"
                        }`}
                      >
                        <div className="text-foreground font-medium text-[15px]">{opt.label}</div>
                        <div className="text-muted-foreground text-xs mt-0.5">{opt.description}</div>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
      <div className="mt-auto pt-6">
        <QuizButton onClick={onNext}>Continue</QuizButton>
      </div>
    </>
  );
};

export default PersonalContextStep;
