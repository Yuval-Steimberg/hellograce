import QuizButton from "./QuizButton";

interface PersonalContextData {
  biggestChallenge?: string;
  whyStarted?: string;
  supportStyle?: string;
}

interface PersonalContextProps {
  biggestChallenge: string;
  whyStarted: string;
  supportStyle: string;
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

const PersonalContextStep = ({
  biggestChallenge,
  whyStarted,
  supportStyle,
  onChange,
  onNext,
}: PersonalContextProps) => {
  return (
    <>
      <div className="flex-1 pt-4">
        <span className="uppercase tracking-widest text-xs font-semibold text-muted-foreground/60 block mb-4">
          Your story
        </span>
        <h2 className="text-4xl font-serif text-foreground tracking-tight leading-[1.1] mb-4">
          Help me understand you better
        </h2>
        <p className="text-muted-foreground text-base leading-relaxed mb-8">
          So I know what to focus on and how to talk to you.
        </p>

        <div className="space-y-8">
          <div className="flex flex-col gap-3">
            <span className="text-foreground font-medium text-sm px-1">What's your biggest challenge right now?</span>
            <div className="grid grid-cols-2 gap-2">
              {CHALLENGE_OPTIONS.map((opt) => {
                const active = biggestChallenge === opt.value;
                return (
                  <button
                    type="button"
                    key={opt.value}
                    onClick={() => onChange({ biggestChallenge: active ? "" : opt.value })}
                    className={`text-left rounded-2xl border-2 px-3 py-2.5 transition-all ${
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

          <div className="flex flex-col gap-3">
            <span className="text-foreground font-medium text-sm px-1">Why did you start GLP-1?</span>
            <div className="grid grid-cols-2 gap-2">
              {WHY_OPTIONS.map((opt) => {
                const active = whyStarted === opt.value;
                return (
                  <button
                    type="button"
                    key={opt.value}
                    onClick={() => onChange({ whyStarted: active ? "" : opt.value })}
                    className={`text-left rounded-2xl border-2 px-3 py-2.5 transition-all ${
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

          <div className="flex flex-col gap-3">
            <span className="text-foreground font-medium text-sm px-1">How should I talk to you?</span>
            <div className="grid grid-cols-2 gap-2.5">
              {SUPPORT_OPTIONS.map((opt) => {
                const active = supportStyle === opt.value;
                return (
                  <button
                    type="button"
                    key={opt.value}
                    onClick={() => onChange({ supportStyle: active ? "" : opt.value })}
                    className={`text-left rounded-2xl border-2 px-4 py-3 transition-all ${
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
        </div>
      </div>
      <div className="mt-auto pt-6">
        <QuizButton onClick={onNext}>Continue</QuizButton>
      </div>
    </>
  );
};

export default PersonalContextStep;
