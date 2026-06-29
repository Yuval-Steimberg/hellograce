import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Check } from "lucide-react";
import { startWithGrace } from "@/lib/chatLinks";

/**
 * Mobile hero — Tomo-style intro flow. Grace introduces herself in a few chat
 * bubbles, asks one warm question, then shows selectable "which sounds like you"
 * option bubbles, and a "Get Started" button that's part of the same flow (the
 * natural next step in the conversation). Single screen, no scroll.
 */

const INTRO = [
  "Hey! I'm Grace 🌸",
  "Let's get you started",
  "Which sounds more like you?",
];

const OPTIONS = [
  "I just started GLP-1",
  "I've been on it a while",
];

const TYPING = 1100;

const MobileHero = () => {
  const navigate = useNavigate();
  const reduce = useReducedMotion();

  const [shown, setShown] = useState(reduce ? INTRO.length : 0);
  const [typing, setTyping] = useState(false);
  const [showOptions, setShowOptions] = useState(reduce);
  const [showCta, setShowCta] = useState(reduce);
  const [selected, setSelected] = useState(0);

  useEffect(() => {
    if (reduce) return;
    let cancelled = false;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const wait = (ms: number) =>
      new Promise<void>((r) => timers.push(setTimeout(r, ms)));

    const play = async () => {
      for (let i = 0; i < INTRO.length; i++) {
        if (cancelled) return;
        setTyping(true);
        await wait(TYPING);
        if (cancelled) return;
        setTyping(false);
        setShown((n) => n + 1);
        await wait(450);
      }
      if (cancelled) return;
      setShowOptions(true);
      await wait(600);
      if (cancelled) return;
      setShowCta(true);
    };
    play();
    return () => {
      cancelled = true;
      timers.forEach(clearTimeout);
    };
  }, [reduce]);

  const start = () => startWithGrace(() => navigate("/onboarding"));

  return (
    <section className="lg:hidden flex h-[calc(100svh-64px)] flex-col bg-white px-4 pb-6 pt-3">
      {/* Conversation */}
      <div className="flex-1 space-y-2.5 overflow-hidden">
        {/* Grace intro bubbles */}
        <AnimatePresence initial={false}>
          {INTRO.slice(0, shown).map((text, i) => (
            <motion.div
              key={`intro-${i}`}
              initial={{ opacity: 0, y: 10, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              transition={{ type: "spring", stiffness: 320, damping: 26 }}
              className="flex justify-start"
            >
              <span className="max-w-[80%] rounded-[1.4rem] rounded-bl-md bg-[#E9E9EB] px-4 py-2.5 text-[18px] leading-snug text-[#111]">
                {text}
              </span>
            </motion.div>
          ))}

          {typing && (
            <motion.div
              key="typing"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className="flex justify-start"
            >
              <span className="flex items-center gap-1 rounded-[1.4rem] rounded-bl-md bg-[#E9E9EB] px-4 py-3.5">
                {[0, 0.15, 0.3].map((d) => (
                  <motion.span
                    key={d}
                    className="block h-2 w-2 rounded-full bg-[#8e8e93]"
                    animate={{ y: [0, -3, 0], opacity: [0.4, 1, 0.4] }}
                    transition={{ duration: 0.9, repeat: Infinity, delay: d, ease: "easeInOut" }}
                  />
                ))}
              </span>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Selectable option bubbles */}
        <AnimatePresence>
          {showOptions &&
            OPTIONS.map((text, i) => (
              <motion.button
                key={`opt-${i}`}
                onClick={() => setSelected(i)}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.12, type: "spring", stiffness: 320, damping: 26 }}
                className="flex w-full items-center justify-end gap-2.5 pt-1"
              >
                <span
                  className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border transition-colors ${
                    selected === i
                      ? "border-[#2C7DFA] bg-[#2C7DFA] text-white"
                      : "border-[#c9c9cf] bg-white"
                  }`}
                >
                  {selected === i && <Check className="h-3.5 w-3.5" strokeWidth={3} />}
                </span>
                <span
                  className={`max-w-[80%] rounded-[1.4rem] rounded-br-md px-4 py-2.5 text-[18px] leading-snug transition-colors ${
                    selected === i ? "bg-[#2C7DFA] text-white" : "bg-[#AECBFA] text-white"
                  }`}
                >
                  {text}
                </span>
              </motion.button>
            ))}
        </AnimatePresence>
      </div>

      {/* Get Started — the natural next step in the flow */}
      <AnimatePresence>
        {showCta && (
          <motion.div
            key="cta"
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ type: "spring", stiffness: 280, damping: 28 }}
          >
            <button
              onClick={start}
              className="w-full rounded-full bg-[#16110D] py-4 text-center text-[18px] font-semibold text-white shadow-sm active:scale-[0.99] transition-transform"
            >
              Get Started
            </button>

            <div className="mt-4 flex items-center justify-center gap-3">
              <div className="flex -space-x-2">
                {["#F4C7A1", "#E9A7A0", "#B9D2B0"].map((c) => (
                  <span
                    key={c}
                    className="h-7 w-7 rounded-full border-2 border-white"
                    style={{ background: c }}
                  />
                ))}
              </div>
              <span className="text-[13px] text-[#8e8e93]">Trusted by thousands on GLP-1</span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
};

export default MobileHero;
