import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { ArrowRight } from "lucide-react";
import { startWithGrace } from "@/lib/chatLinks";

/**
 * Mobile + tablet hero — Grace's own brand, headline-first (not a chat clone).
 * Single column, content capped + centered so it reads well on phones AND
 * tablets (no full-width stretch). Order follows landing best practice:
 * eyebrow → serif headline → subhead → primary CTA → trust → a small branded
 * iMessage preview (warm peach/cream bubbles, Grace's palette). Shown below lg;
 * desktop uses the full scrolling landing.
 */

const ACCENT = "#C57A57";

type Msg = { from: "user" | "grace"; text: string };
const PREVIEW: Msg[] = [
  { from: "grace", text: "Morning 🌸 how'd you sleep?" },
  { from: "user", text: "good! had eggs + yogurt" },
  { from: "grace", text: "32g protein already — love that. You're ahead today." },
];

const TYPING = 1100;

const MobileHero = () => {
  const navigate = useNavigate();
  const reduce = useReducedMotion();
  const [shown, setShown] = useState(reduce ? PREVIEW.length : 0);
  const [typing, setTyping] = useState(false);

  useEffect(() => {
    if (reduce) return;
    let cancelled = false;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const wait = (ms: number) => new Promise<void>((r) => timers.push(setTimeout(r, ms)));

    const play = async () => {
      await wait(500);
      for (const msg of PREVIEW) {
        if (cancelled) return;
        if (msg.from === "grace") {
          setTyping(true);
          await wait(TYPING);
          if (cancelled) return;
          setTyping(false);
        } else {
          await wait(700);
        }
        if (cancelled) return;
        setShown((n) => n + 1);
      }
    };
    play();
    return () => {
      cancelled = true;
      timers.forEach(clearTimeout);
    };
  }, [reduce]);

  const start = () => startWithGrace(() => navigate("/onboarding"));

  return (
    <section
      className="lg:hidden flex min-h-[calc(100svh-64px)] flex-col justify-center bg-[#F6F1E8] px-5 py-6"
    >
      <div className="mx-auto flex w-full max-w-md flex-col gap-5 md:max-w-xl">
        {/* Eyebrow */}
        <span className="inline-flex w-fit items-center gap-2 rounded-full border border-[#E6DBC9] bg-white/70 px-3.5 py-1.5 text-[12px] font-semibold tracking-wide text-[#7E7567]">
          <span className="h-1.5 w-1.5 rounded-full" style={{ background: ACCENT }} />
          For Ozempic · Wegovy · Mounjaro · Zepbound
        </span>

        {/* Headline */}
        <h1
          className="font-serif text-[clamp(32px,8.5vw,44px)] leading-[1.06] tracking-tight text-[#2B2722]"
          style={{ letterSpacing: "-0.01em" }}
        >
          Your GLP-1 journey, with support that feels{" "}
          <em className="not-italic" style={{ fontStyle: "italic", color: ACCENT }}>
            personal
          </em>
          .
        </h1>

        {/* Subhead */}
        <p className="max-w-[44ch] text-[16px] leading-relaxed text-[#6F665B]">
          Food, protein, reminders, and the hard days — handled right in your texts,
          like a friend who actually gets it.
        </p>

        {/* Primary CTA */}
        <button
          onClick={start}
          className="flex h-14 w-full items-center justify-center gap-2 rounded-full bg-[#16110D] text-[17px] font-semibold text-white shadow-sm transition-transform active:scale-[0.99]"
        >
          Start with Grace
          <ArrowRight className="h-4.5 w-4.5" strokeWidth={2.4} />
        </button>

        {/* Trust */}
        <div className="flex items-center gap-3">
          <div className="flex -space-x-2">
            {["#F4C7A1", "#E9A7A0", "#B9D2B0"].map((c) => (
              <span key={c} className="h-7 w-7 rounded-full border-2 border-[#F6F1E8]" style={{ background: c }} />
            ))}
          </div>
          <span className="text-[13px] text-[#8C8377]">Trusted by thousands on GLP-1</span>
        </div>

        {/* Branded iMessage preview */}
        <div className="mt-1 rounded-[1.75rem] border border-[#EEE4D5] bg-white p-3.5 shadow-[0_12px_30px_-18px_rgba(43,39,34,0.4)]">
          <div className="mb-2 flex items-center gap-2 px-1">
            <span className="text-[13px] font-bold text-[#2B2722]">Grace</span>
            <span className="flex items-center gap-1 text-[11px] font-semibold text-[#8FA07E]">
              <span className="h-1.5 w-1.5 rounded-full bg-[#8FA07E]" />online
            </span>
          </div>
          <div className="flex min-h-[148px] flex-col justify-end gap-2">
            <AnimatePresence initial={false}>
              {PREVIEW.slice(0, shown).map((m, i) => (
                <motion.div
                  key={`${i}-${m.from}`}
                  initial={{ opacity: 0, y: 8, scale: 0.97 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  transition={{ type: "spring", stiffness: 320, damping: 26 }}
                  className={`flex ${m.from === "user" ? "justify-end" : "justify-start"}`}
                >
                  <span
                    className={`max-w-[82%] px-3.5 py-2 text-[14px] leading-snug ${
                      m.from === "user"
                        ? "rounded-[1.1rem] rounded-br-md bg-[#ECCDBC] text-[#3A2E26]"
                        : "rounded-[1.1rem] rounded-bl-md border border-[#EEE4D5] bg-[#FBF7F0] text-[#2B2722]"
                    }`}
                  >
                    {m.text}
                  </span>
                </motion.div>
              ))}
              {typing && (
                <motion.div
                  key="typing"
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  className="flex justify-start"
                >
                  <span className="flex items-center gap-1 rounded-[1.1rem] rounded-bl-md border border-[#EEE4D5] bg-[#FBF7F0] px-3.5 py-3">
                    {[0, 0.15, 0.3].map((d) => (
                      <motion.span
                        key={d}
                        className="block h-1.5 w-1.5 rounded-full bg-[#C2B8A8]"
                        animate={{ y: [0, -3, 0], opacity: [0.4, 1, 0.4] }}
                        transition={{ duration: 0.9, repeat: Infinity, delay: d, ease: "easeInOut" }}
                      />
                    ))}
                  </span>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
      </div>
    </section>
  );
};

export default MobileHero;
