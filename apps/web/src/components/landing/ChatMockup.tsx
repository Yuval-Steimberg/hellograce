import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";

type Message = { from: "user" | "grace"; text: string; time: string };

const SCRIPT: Message[] = [
  { from: "user",  text: "feeling really nauseous after my wegovy shot last night 😩", time: "8:14 AM" },
  { from: "grace", text: "Sorry you're feeling rough. Day-after nausea is most intense in the first 24–48h. Try plain crackers + ginger tea, and skip anything fried today. How's your hydration looking?", time: "8:14 AM" },
  { from: "user",  text: "barely drank anything yesterday", time: "8:15 AM" },
  { from: "grace", text: "That's playing a role. Aim for 16oz before lunch — small sips, not chugs. I'll check on you again at 1pm. Also: what's your protein target today?", time: "8:15 AM" },
  { from: "user",  text: "90g right?", time: "8:16 AM" },
  { from: "grace", text: "Yep — for your goal weight, 90g. Two eggs + Greek yogurt = a stress-free 35g start. You've got this. 🤍", time: "8:16 AM" },
];

// Per-message timing: user messages appear after a natural pause, grace gets a
// realistic typing delay. LOOP_PAUSE holds the completed conversation before restart.
const USER_DELAY = 1800;
const GRACE_TYPING = 2400;
const LOOP_PAUSE = 7000;

const ChatMockup = () => {
  const prefersReduced = useReducedMotion();
  const [visible, setVisible] = useState<Message[]>(prefersReduced ? SCRIPT : []);
  const [typing, setTyping] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (prefersReduced) return;

    let cancelled = false;
    const timers: ReturnType<typeof setTimeout>[] = [];

    const play = async () => {
      // restart each loop
      setVisible([]);
      setTyping(false);

      for (let i = 0; i < SCRIPT.length; i++) {
        if (cancelled) return;
        const msg = SCRIPT[i]!;

        if (msg.from === "grace") {
          setTyping(true);
          await wait(GRACE_TYPING, timers);
          if (cancelled) return;
          setTyping(false);
          setVisible((v) => [...v, msg]);
        } else {
          await wait(USER_DELAY, timers);
          if (cancelled) return;
          setVisible((v) => [...v, msg]);
        }
      }

      await wait(LOOP_PAUSE, timers);
      if (!cancelled) play();
    };

    play();
    return () => {
      cancelled = true;
      timers.forEach(clearTimeout);
    };
  }, [prefersReduced]);

  // Auto-scroll to bottom whenever a new message or typing dot appears.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [visible, typing]);

  return (
    <div className="relative">
      <div className="bg-[#0e1b1d] rounded-[2.5rem] p-3 shadow-2xl shadow-primary/10">
        <div className="bg-[#e6dfd5] rounded-[2rem] overflow-hidden">
          {/* Chat header */}
          <div className="bg-[#075e54] text-white px-5 py-4 flex items-center gap-3">
            <div className="w-9 h-9 rounded-full bg-[#f3eee7] flex items-center justify-center">
              <span className="font-serif text-lg text-[#075e54]">g</span>
            </div>
            <div className="flex-1">
              <div className="font-medium text-sm">grace</div>
              <div className="text-[11px] text-white/70">
                {typing ? "typing…" : "online · daily GLP-1 companion"}
              </div>
            </div>
          </div>

          {/* Messages */}
          <div
            ref={scrollRef}
            className="px-3 py-4 space-y-2 h-[360px] sm:h-[420px] md:h-[480px] overflow-y-auto scrollbar-hide"
            style={{
              backgroundImage:
                "repeating-linear-gradient(0deg, rgba(255,255,255,0.04) 0 1px, transparent 1px 6px)",
            }}
          >
            <AnimatePresence initial={false}>
              {visible.map((m, i) => (
                <motion.div
                  key={`${i}-${m.text.slice(0, 12)}`}
                  initial={{ opacity: 0, y: 10, scale: 0.97 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ type: "spring", stiffness: 220, damping: 28 }}
                  className={`flex ${m.from === "user" ? "justify-end" : "justify-start"}`}
                >
                  <div
                    className={`max-w-[78%] rounded-2xl px-3.5 py-2 text-[13px] leading-snug shadow-sm ${
                      m.from === "user"
                        ? "bg-[#d9fdd3] text-[#111b21] rounded-br-sm"
                        : "bg-white text-[#111b21] rounded-bl-sm"
                    }`}
                  >
                    <p>{m.text}</p>
                    <span className="block text-[10px] text-[#667781] mt-0.5 text-right">
                      {m.time}
                    </span>
                  </div>
                </motion.div>
              ))}

              {typing && (
                <motion.div
                  key="typing-bubble"
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.2 }}
                  className="flex justify-start"
                >
                  <div className="bg-white rounded-2xl rounded-bl-sm px-4 py-3 shadow-sm">
                    <div className="flex items-center gap-1">
                      <Dot delay={0} />
                      <Dot delay={0.15} />
                      <Dot delay={0.3} />
                    </div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
      </div>

      <div className="absolute -bottom-3 left-1/2 -translate-x-1/2 bg-card border border-border rounded-full px-4 py-2 shadow-lg shadow-primary/10 flex items-center gap-2">
        <span className="flex h-4 w-4 items-center justify-center rounded-full bg-accent/15 text-accent text-[10px]">✦</span>
        <span className="text-xs font-semibold text-foreground whitespace-nowrap">Right inside iMessage</span>
      </div>
    </div>
  );
};

const Dot = ({ delay }: { delay: number }) => (
  <motion.span
    className="block w-1.5 h-1.5 rounded-full bg-[#667781]"
    animate={{ y: [0, -3, 0], opacity: [0.4, 1, 0.4] }}
    transition={{ duration: 0.9, repeat: Infinity, delay, ease: "easeInOut" }}
  />
);

function wait(ms: number, store: ReturnType<typeof setTimeout>[]) {
  return new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    store.push(t);
  });
}

export default ChatMockup;
