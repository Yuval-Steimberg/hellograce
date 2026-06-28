import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Check } from "lucide-react";
import { startWithGrace } from "@/lib/chatLinks";

/**
 * Mobile hero — chat-led, single screen, flat clean background, designer palette
 * (charcoal ink + clay accent, no green). Grace introduces herself, offers two
 * tappable choices, then a solid CTA. Compact so it never scrolls or clips.
 */

const LINES = [
  "Hey, I'm Grace 🌿",
  "Your GLP-1 companion — protein, meals, side effects, all over text.",
  "Where are you in your journey?",
];

const CHOICES = ["Just starting my GLP-1", "A few months in"];

const MobileHero = () => {
  const navigate = useNavigate();
  const [picked, setPicked] = useState<number | null>(null);

  const go = (i: number) => {
    setPicked(i);
    window.setTimeout(() => startWithGrace(() => navigate("/onboarding")), 240);
  };

  return (
    <section className="lg:hidden flex min-h-[calc(100svh-68px)] flex-col px-6 pb-6">
      <p className="mb-4 mt-1 text-[11px] font-semibold uppercase tracking-[0.2em] text-accent">
        Right inside iMessage · no app
      </p>

      <div className="space-y-2.5">
        {LINES.map((line, i) => (
          <div key={i} className="flex justify-start">
            <span className="max-w-[88%] rounded-[1.3rem] rounded-bl-md bg-secondary px-4 py-2.5 text-[15px] font-medium leading-snug text-foreground">
              {line}
            </span>
          </div>
        ))}

        <div className="space-y-2.5 pt-1">
          {CHOICES.map((choice, i) => {
            const active = picked === i;
            return (
              <div key={i} className="flex items-center justify-end gap-2.5">
                <span
                  className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 transition-colors ${
                    active ? "border-accent bg-accent text-white" : "border-border text-transparent"
                  }`}
                  aria-hidden
                >
                  <Check className="h-3 w-3" strokeWidth={3} />
                </span>
                <button
                  type="button"
                  onClick={() => go(i)}
                  className={`max-w-[88%] rounded-[1.3rem] rounded-br-md px-4 py-2.5 text-[15px] font-semibold leading-snug transition-colors ${
                    active
                      ? "bg-primary text-primary-foreground"
                      : "border border-border bg-card text-foreground hover:border-accent/60"
                  }`}
                >
                  {choice}
                </button>
              </div>
            );
          })}
        </div>
      </div>

      <div className="mt-auto pt-7">
        <button
          onClick={() => startWithGrace(() => navigate("/onboarding"))}
          className="grace-btn-accent w-full py-4 text-base"
        >
          Start free
        </button>
        <div className="mt-4 flex items-center justify-center gap-2.5">
          <div className="flex -space-x-2">
            {["🙂", "🌿", "💪"].map((e, i) => (
              <span
                key={i}
                className="inline-flex h-6 w-6 items-center justify-center rounded-full border border-border bg-secondary text-[11px]"
                aria-hidden
              >
                {e}
              </span>
            ))}
          </div>
          <span className="text-[13px] text-muted-foreground">Trusted by thousands on GLP-1</span>
        </div>
      </div>
    </section>
  );
};

export default MobileHero;
