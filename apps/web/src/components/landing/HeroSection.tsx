import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Check, ShieldCheck } from "lucide-react";
import { startWithGrace } from "@/lib/chatLinks";
import { motion, useReducedMotion } from "framer-motion";
import DesktopHeroScene from "./DesktopHeroScene";

/**
 * Chat-led hero — the conversation IS the hero. Grace introduces herself in a
 * few warm incoming bubbles, then offers two "which sounds more like you?"
 * choices the visitor can tap; either one drops them straight into onboarding.
 * Centered, airy, mobile-first — a friendly companion-app feel.
 */

const fadeUp = {
  hidden: { opacity: 0, y: 18 },
  show: (delay: number) => ({
    opacity: 1,
    y: 0,
    transition: { duration: 0.5, delay, ease: [0.4, 0, 0.2, 1] as const },
  }),
};

const bubble = {
  hidden: { opacity: 0, y: 14, scale: 0.96 },
  show: (delay: number) => ({
    opacity: 1,
    y: 0,
    scale: 1,
    transition: { type: "spring" as const, stiffness: 240, damping: 26, delay },
  }),
};

// Grace's opening lines (incoming, left-aligned). All original Grace copy.
const GRACE_LINES = [
  "Hey, I'm Grace 🌿",
  "Your GLP-1 companion — protein, meals, side effects, injection days, all over text.",
  "Where are you in your journey?",
];

// The two tappable "choose your vibe" options (outgoing, right-aligned).
const CHOICES = [
  "Just starting my GLP-1 💉",
  "A few months in",
];

const HeroSection = () => {
  const navigate = useNavigate();
  const prefersReduced = useReducedMotion();
  const [picked, setPicked] = useState<number | null>(null);

  const go = (i: number) => {
    setPicked(i);
    // brief beat so the tick registers, then into onboarding
    window.setTimeout(() => startWithGrace(() => navigate("/onboarding")), 280);
  };

  // Stagger timings (skipped when the user prefers reduced motion).
  const t = (n: number) => (prefersReduced ? 0 : n);

  return (
    <>
      {/* Desktop: dreamy sky scene with floating capability cards */}
      <DesktopHeroScene />

      {/* Mobile: clean chat-led hero */}
      <section className="relative lg:hidden px-5 sm:px-8 pt-4 pb-14">
      <div className="mx-auto w-full max-w-[620px]">
        {/* Eyebrow */}
        <motion.div
          initial="hidden"
          animate="show"
          custom={t(0)}
          variants={fadeUp}
          className="mb-6 flex justify-center"
        >
          <span className="grace-chip">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-70" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-accent" />
            </span>
            Right inside iMessage · no app
          </span>
        </motion.div>

        {/* SEO / a11y headline (visually subtle, sets the value prop) */}
        <motion.h1
          initial="hidden"
          animate="show"
          custom={t(0.08)}
          variants={fadeUp}
          className="mb-8 text-center text-[2rem] sm:text-[2.6rem] font-extrabold leading-[1.08] tracking-tight text-foreground text-balance"
        >
          Life on GLP-1 is easier with{" "}
          <span className="font-serif italic font-medium grace-gradient-text">
            someone in your corner.
          </span>
        </motion.h1>

        {/* The conversation */}
        <div className="space-y-2.5">
          {GRACE_LINES.map((line, i) => (
            <motion.div
              key={i}
              initial="hidden"
              animate="show"
              custom={t(0.3 + i * 0.45)}
              variants={bubble}
              className="flex justify-start"
            >
              <div className="max-w-[86%] rounded-[1.4rem] rounded-bl-md bg-secondary px-4 py-3 text-[15px] sm:text-base font-medium leading-snug text-foreground shadow-sm">
                {line}
              </div>
            </motion.div>
          ))}

          {/* Tappable choices */}
          <div className="space-y-2.5 pt-1">
            {CHOICES.map((choice, i) => {
              const active = picked === i;
              return (
                <motion.div
                  key={i}
                  initial="hidden"
                  animate="show"
                  custom={t(1.7 + i * 0.18)}
                  variants={bubble}
                  className="flex items-center justify-end gap-2.5"
                >
                  <span
                    className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2 transition-all duration-200 ${
                      active
                        ? "border-accent bg-accent text-white"
                        : "border-border bg-card text-transparent"
                    }`}
                    aria-hidden
                  >
                    <Check className="h-3.5 w-3.5" strokeWidth={3} />
                  </span>
                  <button
                    type="button"
                    onClick={() => go(i)}
                    aria-label={`${choice} — start with Grace`}
                    className={`max-w-[86%] rounded-[1.4rem] rounded-br-md px-4 py-3 text-[15px] sm:text-base font-semibold leading-snug shadow-sm transition-all duration-200 hover:-translate-y-0.5 active:scale-[0.99] ${
                      active
                        ? "bg-primary text-primary-foreground"
                        : "bg-accent/12 text-accent hover:bg-accent/18"
                    }`}
                  >
                    {choice}
                  </button>
                </motion.div>
              );
            })}
          </div>
        </div>

        {/* Primary CTA — friendly yellow chat pill */}
        <motion.div
          initial="hidden"
          animate="show"
          custom={t(2.15)}
          variants={fadeUp}
          className="mt-7"
        >
          <button
            onClick={() => startWithGrace(() => navigate("/onboarding"))}
            aria-label="Text Grace to get started"
            className="group inline-flex w-full items-center justify-center gap-3 rounded-full px-8 py-4 text-lg font-extrabold text-[hsl(192_44%_13%)] transition-all duration-200 hover:-translate-y-0.5 active:scale-[0.99]"
            style={{
              // Grace's own warm honey-gold (distinct from Tomo's lemon yellow).
              background: "linear-gradient(180deg, hsl(42 96% 62%), hsl(36 92% 52%))",
              boxShadow: "0 14px 32px -10px hsl(36 88% 42% / 0.6)",
            }}
          >
            Text Grace
            <IMessageGlyph />
          </button>
        </motion.div>

        {/* Social proof */}
        <motion.div
          initial="hidden"
          animate="show"
          custom={t(2.3)}
          variants={fadeUp}
          className="mt-5 flex items-center justify-center gap-3"
        >
          <div className="flex -space-x-2.5">
            {AVATARS.map((a, i) => (
              <span
                key={i}
                className="inline-flex h-8 w-8 items-center justify-center rounded-full border-2 border-background text-sm"
                style={{ background: a.bg }}
                aria-hidden
              >
                {a.emoji}
              </span>
            ))}
          </div>
          <span className="text-sm font-medium text-muted-foreground">
            Trusted by thousands on GLP-1
          </span>
        </motion.div>

        {/* Reassurance */}
        <motion.p
          initial="hidden"
          animate="show"
          custom={t(2.4)}
          variants={fadeUp}
          className="mt-5 flex items-center justify-center gap-2 text-center text-[13px] text-muted-foreground"
        >
          <ShieldCheck className="h-4 w-4 text-accent shrink-0" aria-hidden />
          A companion between appointments — not a replacement for medical care.
        </motion.p>
      </div>
    </section>
    </>
  );
};

/** Small iMessage-style glyph: green rounded square + white speech bubble. */
const IMessageGlyph = () => (
  <span
    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[0.7rem] shadow-sm transition-transform duration-200 group-hover:scale-105"
    style={{ background: "linear-gradient(180deg, #5BF675, #1FD256)" }}
    aria-hidden
  >
    <svg width="20" height="20" viewBox="0 0 24 24" fill="white">
      <path d="M12 3C6.9 3 3 6.4 3 10.6c0 2.4 1.3 4.5 3.3 5.9-.1.9-.6 2.2-1.5 3.1-.2.2 0 .5.3.5 1.9-.3 3.4-1 4.4-1.7.7.1 1.4.2 2.2.2 5.1 0 9-3.4 9-7.6S17.1 3 12 3z" />
    </svg>
  </span>
);

const AVATARS = [
  { emoji: "👩🏻", bg: "hsl(28 78% 86%)" },
  { emoji: "🧑🏽", bg: "hsl(158 45% 82%)" },
  { emoji: "👩🏾", bg: "hsl(346 70% 88%)" },
  { emoji: "🧑🏼", bg: "hsl(210 55% 86%)" },
];

export default HeroSection;
