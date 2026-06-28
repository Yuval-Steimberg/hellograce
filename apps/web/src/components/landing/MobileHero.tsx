import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { ArrowUp } from "lucide-react";
import { startWithGrace } from "@/lib/chatLinks";
import Logo from "@/components/Logo";

/**
 * Mobile hero — a real iMessage thread that plays out message after message.
 * White background (no color), grey incoming + blue outgoing bubbles, a typing
 * indicator before Grace replies, and an iMessage-style input bar that doubles
 * as the Start CTA. Single screen, no scroll.
 */

type Msg = { from: "user" | "grace"; text: string };

const SCRIPT: Msg[] = [
  { from: "grace", text: "Hey, I'm Grace 🌿 your GLP-1 companion." },
  { from: "user", text: "just had 2 eggs and Greek yogurt" },
  { from: "grace", text: "Logged — that's 32g protein, 68 to go today. Nice start." },
  { from: "user", text: "feeling nauseous after my shot" },
  { from: "grace", text: "Common in the first day or two. Small plain meals + ginger tea help — I'll check in tonight." },
  { from: "user", text: "when's my next reminder?" },
  { from: "grace", text: "Tomorrow at 8:00 AM, your wake-up time. Want it earlier?" },
];

const USER_DELAY = 1100;
const TYPING = 1500;
const LOOP_PAUSE = 4200;

const MobileHero = () => {
  const navigate = useNavigate();
  const reduce = useReducedMotion();
  const [visible, setVisible] = useState<Msg[]>(reduce ? SCRIPT : []);
  const [typing, setTyping] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (reduce) return;
    let cancelled = false;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const wait = (ms: number) =>
      new Promise<void>((r) => timers.push(setTimeout(r, ms)));

    const play = async () => {
      setVisible([]);
      setTyping(false);
      for (const msg of SCRIPT) {
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
      await wait(LOOP_PAUSE);
      if (!cancelled) play();
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

  return (
    <section className="lg:hidden flex h-[calc(100svh-64px)] flex-col bg-white">
      {/* iMessage-style contact header */}
      <div className="flex flex-col items-center gap-1.5 border-b border-black/5 px-4 pb-3 pt-1">
        <Logo size="default" markOnly />
        <div className="text-[15px] font-semibold text-[#111]">Grace</div>
        <div className="text-[11px] text-[#8e8e93]">GLP-1 companion</div>
      </div>

      {/* Thread */}
      <div ref={scrollRef} className="flex-1 space-y-1.5 overflow-y-auto px-3.5 py-4 scrollbar-hide">
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
                className={`max-w-[78%] rounded-[1.25rem] px-3.5 py-2 text-[15px] leading-snug ${
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

      {/* iMessage-style input bar → Start CTA */}
      <div className="px-3 pb-5 pt-2">
        <button
          onClick={() => startWithGrace(() => navigate("/onboarding"))}
          className="flex w-full items-center justify-between rounded-full border border-black/10 bg-white py-2 pl-5 pr-2 text-left shadow-sm"
        >
          <span className="text-[15px] font-medium text-[#111]">Start free — text Grace</span>
          <span className="flex h-8 w-8 items-center justify-center rounded-full bg-[#2C7DFA] text-white">
            <ArrowUp className="h-4 w-4" strokeWidth={2.6} />
          </span>
        </button>
        <p className="mt-2.5 text-center text-[12px] text-[#8e8e93]">
          Right inside iMessage · trusted by thousands on GLP-1
        </p>
      </div>
    </section>
  );
};

export default MobileHero;
