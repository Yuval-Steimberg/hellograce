import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { ArrowRight } from "lucide-react";
import { startWithGrace } from "@/lib/chatLinks";

/**
 * Mobile + tablet hero — the START of the journey. Grace introduces herself and
 * the very first conversation plays out, building toward an invitation ("let's
 * set you up") so pressing "Start with Grace" is the natural next step. Plain
 * white (no background color). On tablets the thread is capped + centered so it
 * doesn't stretch full-width. Below lg; desktop uses the full scrolling landing.
 */

type Msg = { from: "user" | "grace"; text: string };

const INTRO: Msg[] = [
  { from: "grace", text: "Hi, I'm Grace 🌸" },
  { from: "grace", text: "Your all-in-one GLP-1 companion — food, protein, water, weight, habits, symptoms, and your shots, all in one place." },
  { from: "user", text: "how does it work?" },
  { from: "grace", text: "Just text me like a friend — what you ate, how you feel, when your shot is." },
  { from: "grace", text: "I'll track it all, show you the whole picture, and check in — so you're never doing this alone." },
  { from: "user", text: "okay, I'm in" },
  { from: "grace", text: "Love that. Let's set you up 💛" },
];

const USER_DELAY = 1300;
const TYPING = 1700;

const MobileHero = () => {
  const navigate = useNavigate();
  const reduce = useReducedMotion();
  const [visible, setVisible] = useState<Msg[]>(reduce ? INTRO : []);
  const [typing, setTyping] = useState(false);
  const [done, setDone] = useState(reduce);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (reduce) return;
    let cancelled = false;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const wait = (ms: number) =>
      new Promise<void>((r) => timers.push(setTimeout(r, ms)));

    const play = async () => {
      await wait(400);
      for (const msg of INTRO) {
        if (cancelled) return;
        if (msg.from === "grace") {
          setTyping(true);
          await wait(TYPING);
          if (cancelled) return;
          setTyping(false);
        } else {
          await wait(USER_DELAY);
        }
        if (cancelled) return;
        setVisible((v) => [...v, msg]);
      }
      if (!cancelled) setDone(true);
    };
    play();
    return () => {
      cancelled = true;
      timers.forEach(clearTimeout);
    };
  }, [reduce]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [visible, typing]);

  const start = () => startWithGrace(() => navigate("/onboarding"));

  return (
    <section className="lg:hidden flex h-[calc(100svh-64px)] flex-col bg-white">
      {/* Capped + centered so it reads as a phone-width column on tablets too */}
      <div className="mx-auto flex min-h-0 w-full max-w-md flex-1 flex-col md:max-w-lg">
        {/* Contact header */}
        <div className="flex flex-col items-center gap-1 border-b border-black/5 px-4 pb-3 pt-1">
          <div className="text-[20px] font-semibold text-[#111]">Grace</div>
          <div className="text-[12px] text-[#8e8e93]">GLP-1 companion</div>
        </div>

        {/* Thread */}
        <div ref={scrollRef} className="flex-1 space-y-2 overflow-y-auto px-3.5 py-4 scrollbar-hide">
          <AnimatePresence initial={false}>
            {visible.map((m, i) => (
              <motion.div
                key={`${i}-${m.text.slice(0, 8)}`}
                initial={{ opacity: 0, y: 10, scale: 0.96 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                transition={{ type: "spring", stiffness: 320, damping: 26 }}
                className={`flex ${m.from === "user" ? "justify-end" : "justify-start"}`}
              >
                <span
                  className={`max-w-[80%] rounded-[1.25rem] px-4 py-2.5 text-[17px] leading-snug ${
                    m.from === "user"
                      ? "rounded-br-md bg-[#2C7DFA] text-white"
                      : "rounded-bl-md bg-[#E9E9EB] text-[#111]"
                  }`}
                >
                  {m.text}
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
                <span className="flex items-center gap-1 rounded-[1.25rem] rounded-bl-md bg-[#E9E9EB] px-4 py-3">
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
        </div>

        {/* CTA — the user's next step in the conversation */}
        <div className="px-3.5 pb-5 pt-2">
          <motion.button
            onClick={start}
            animate={done ? { scale: [1, 1.02, 1] } : { scale: 1 }}
            transition={done ? { duration: 1.6, repeat: Infinity, ease: "easeInOut" } : {}}
            className="flex h-14 w-full items-center justify-center gap-2 rounded-full bg-[#16110D] text-[17px] font-semibold text-white shadow-sm transition-transform active:scale-[0.99]"
          >
            Start with Grace
            <ArrowRight className="h-4.5 w-4.5" strokeWidth={2.4} />
          </motion.button>
          <p className="mt-2.5 text-center text-[12px] text-[#8e8e93]">
            Free to start · right inside iMessage
          </p>
        </div>
      </div>
    </section>
  );
};

export default MobileHero;
