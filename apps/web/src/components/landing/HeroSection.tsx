import { useNavigate } from "react-router-dom";
import { startWithGrace } from "@/lib/chatLinks";

/**
 * Editorial hero — one screen, no scroll. Restrained ivory/charcoal/clay
 * palette, a serif display headline, a single solid CTA, and one quiet chat
 * card. Designed, not "vibe-coded": no gradients, glows, blobs, or bright
 * colors.
 */

const THREAD = [
  { from: "user", text: "What should I eat today?" },
  { from: "grace", text: "You're at 82g protein, 360 cals left. A Greek-yogurt bowl with berries gets you to goal — want the recipe?" },
  { from: "user", text: "feeling nauseous after my shot" },
  { from: "grace", text: "Common in the first day or two. Small, plain meals + ginger tea help. I'll check in tonight." },
];

const HeroSection = () => {
  const navigate = useNavigate();
  const start = () => startWithGrace(() => navigate("/onboarding"));

  return (
    <section className="relative flex min-h-[calc(100svh-72px)] items-center px-6 sm:px-10">
      <div className="mx-auto grid w-full max-w-[1180px] grid-cols-1 items-center gap-12 lg:grid-cols-2 lg:gap-20">
        {/* Copy */}
        <div className="order-2 lg:order-1">
          <p className="mb-6 text-[11px] font-semibold uppercase tracking-[0.22em] text-accent">
            Your daily GLP-1 companion
          </p>
          <h1 className="font-serif text-[2.8rem] leading-[1.05] tracking-[-0.02em] text-foreground sm:text-[3.6rem] lg:text-[4.1rem]">
            Life on GLP-1,
            <br />
            <span className="italic text-accent">made lighter.</span>
          </h1>
          <p className="mt-7 max-w-[46ch] text-lg leading-relaxed text-muted-foreground">
            Protein, meals, side effects, injection days and progress — handled
            in one quiet thread that remembers you. Right inside iMessage, no app
            to download.
          </p>

          <div className="mt-9 flex flex-col items-start gap-4 sm:flex-row sm:items-center">
            <button onClick={start} className="grace-btn-accent px-9 py-4 text-base">
              Start free
            </button>
            <button
              onClick={() => navigate("/how-it-works")}
              className="text-base font-semibold text-foreground underline-offset-4 transition-colors hover:text-accent hover:underline"
            >
              See how it works
            </button>
          </div>

          <div className="mt-10 flex items-center gap-3">
            <div className="flex -space-x-2">
              {AVATARS.map((a, i) => (
                <span
                  key={i}
                  className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-border bg-secondary text-xs"
                  aria-hidden
                >
                  {a}
                </span>
              ))}
            </div>
            <span className="text-sm text-muted-foreground">
              Trusted by thousands on GLP-1
            </span>
          </div>
        </div>

        {/* Quiet chat card */}
        <div className="order-1 lg:order-2">
          <div className="mx-auto max-w-[400px] rounded-3xl border border-border bg-card p-5 shadow-[0_24px_60px_-30px_hsl(30_20%_20%/0.35)]">
            <div className="mb-4 flex items-center gap-3 border-b border-border/70 pb-4">
              <span className="flex h-9 w-9 items-center justify-center rounded-full bg-primary font-serif text-base text-primary-foreground">
                g
              </span>
              <div className="leading-tight">
                <div className="text-sm font-semibold text-foreground">Grace</div>
                <div className="text-[11px] text-muted-foreground">GLP-1 companion</div>
              </div>
            </div>
            <div className="space-y-2.5">
              {THREAD.map((m, i) => (
                <div key={i} className={`flex ${m.from === "user" ? "justify-end" : "justify-start"}`}>
                  <span
                    className={`max-w-[82%] rounded-2xl px-3.5 py-2 text-[13.5px] leading-snug ${
                      m.from === "user"
                        ? "rounded-br-md bg-primary text-primary-foreground"
                        : "rounded-bl-md bg-secondary text-foreground"
                    }`}
                  >
                    {m.text}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};

const AVATARS = ["🙂", "🌿", "💪", "✦"];

export default HeroSection;
