import { useNavigate } from "react-router-dom";
import { motion, useReducedMotion } from "framer-motion";
import { Drumstick, Flame, Syringe, TrendingDown, Droplet } from "lucide-react";
import { startWithGrace } from "@/lib/chatLinks";

/**
 * Desktop hero — editorial copy on the left, an interactive cluster of GLP-1
 * capability cards on the right. Each card drifts gently and, on hover, lifts
 * and reveals the text you'd send Grace to get it (Tomo-style pop-up, but built
 * with a consistent card system + the designer palette). Vibrant via a few
 * muted accent tints, not bright gradients.
 */

type Card = {
  icon: typeof Flame;
  tint: string; // soft icon-circle background
  ink: string; // icon color
  label: string;
  value: string;
  ask: string; // the text revealed on hover
  pos: string;
  drift: number;
};

const CARDS: Card[] = [
  {
    icon: Drumstick,
    tint: "hsl(14 50% 92%)",
    ink: "hsl(14 44% 44%)",
    label: "Protein today",
    value: "82g / 100g",
    ask: "just had 2 eggs and Greek yogurt",
    pos: "top-0 left-4",
    drift: 10,
  },
  {
    icon: Flame,
    tint: "hsl(32 70% 90%)",
    ink: "hsl(28 64% 44%)",
    label: "Calories left",
    value: "360 kcal",
    ask: "how many calories am I on so far?",
    pos: "top-24 right-0",
    drift: 13,
  },
  {
    icon: Syringe,
    tint: "hsl(204 50% 91%)",
    ink: "hsl(204 52% 40%)",
    label: "Next shot",
    value: "Thu · 9:00 AM",
    ask: "remind me to take my shot Thursday",
    pos: "top-56 left-0",
    drift: 9,
  },
  {
    icon: TrendingDown,
    tint: "hsl(150 32% 88%)",
    ink: "hsl(150 30% 34%)",
    label: "This week",
    value: "−2.4 lbs",
    ask: "how's my progress this week?",
    pos: "top-[19rem] right-10",
    drift: 12,
  },
  {
    icon: Droplet,
    tint: "hsl(196 56% 90%)",
    ink: "hsl(198 56% 40%)",
    label: "Water",
    value: "48 / 64 oz",
    ask: "log a glass of water",
    pos: "top-[27rem] left-20",
    drift: 11,
  },
];

const DesktopHero = () => {
  const navigate = useNavigate();
  const reduce = useReducedMotion();
  const start = () => startWithGrace(() => navigate("/onboarding"));

  return (
    <section className="relative hidden lg:flex min-h-[calc(100svh-72px)] items-center overflow-hidden">
      {/* soft warm backdrop — restrained, gives the scene some life */}
      <div
        className="absolute inset-0 -z-10"
        aria-hidden
        style={{
          background:
            "radial-gradient(ellipse 760px 520px at 78% 30%, hsl(28 60% 88% / 0.55) 0%, transparent 62%), radial-gradient(ellipse 640px 520px at 16% 88%, hsl(14 44% 86% / 0.4) 0%, transparent 60%)",
        }}
      />

      <div className="mx-auto grid w-full max-w-[1240px] grid-cols-2 items-center gap-16 px-12">
        {/* Copy */}
        <div>
          <p className="mb-6 text-[11px] font-semibold uppercase tracking-[0.22em] text-accent">
            Your daily GLP-1 companion
          </p>
          <h1 className="font-serif text-[4.2rem] leading-[1.04] tracking-[-0.02em] text-foreground">
            Life on GLP-1,
            <br />
            <span className="italic text-accent">made lighter.</span>
          </h1>
          <p className="mt-7 max-w-[44ch] text-lg leading-relaxed text-muted-foreground">
            Protein, meals, side effects, injection days and progress — handled
            in one quiet thread that remembers you. Right inside iMessage, no app
            to download.
          </p>
          <div className="mt-9 flex items-center gap-5">
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
              {["🙂", "🌿", "💪", "✦"].map((e, i) => (
                <span
                  key={i}
                  className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-border bg-secondary text-xs"
                  aria-hidden
                >
                  {e}
                </span>
              ))}
            </div>
            <span className="text-sm text-muted-foreground">Trusted by thousands on GLP-1</span>
          </div>
        </div>

        {/* Interactive capability cluster */}
        <div className="relative h-[560px]">
          {CARDS.map((c, i) => {
            const Icon = c.icon;
            return (
              <motion.div
                key={i}
                className={`group absolute ${c.pos} w-[224px]`}
                initial={{ opacity: 0, y: 16 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.5, delay: 0.1 + i * 0.1 }}
              >
                <motion.div
                  animate={reduce ? {} : { y: [0, -c.drift, 0] }}
                  transition={{ duration: 5 + i, repeat: Infinity, ease: "easeInOut" }}
                >
                  {/* hover-revealed text bubble */}
                  <div className="pointer-events-none mb-2 flex justify-end opacity-0 -translate-y-1 transition-all duration-300 group-hover:opacity-100 group-hover:translate-y-0">
                    <span className="max-w-[200px] rounded-2xl rounded-br-sm bg-primary px-3.5 py-2 text-[12.5px] font-medium leading-snug text-primary-foreground shadow-lg">
                      {c.ask}
                    </span>
                  </div>
                  {/* capability card */}
                  <div className="flex items-center gap-3.5 rounded-2xl border border-border bg-card p-4 shadow-[0_18px_40px_-26px_hsl(30_20%_20%/0.5)] transition-all duration-300 group-hover:-translate-y-1 group-hover:shadow-[0_28px_55px_-28px_hsl(30_20%_20%/0.6)]">
                    <span
                      className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl"
                      style={{ background: c.tint, color: c.ink }}
                    >
                      <Icon className="h-5 w-5" strokeWidth={2.2} />
                    </span>
                    <div className="leading-tight">
                      <div className="text-[12px] font-medium text-muted-foreground">{c.label}</div>
                      <div className="text-lg font-bold text-foreground">{c.value}</div>
                    </div>
                  </div>
                </motion.div>
              </motion.div>
            );
          })}
        </div>
      </div>
    </section>
  );
};

export default DesktopHero;
