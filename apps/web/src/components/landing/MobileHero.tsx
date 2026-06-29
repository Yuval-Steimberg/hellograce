import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { ArrowUp } from "lucide-react";
import { startWithGrace } from "@/lib/chatLinks";

/**
 * Mobile hero — a real iMessage thread that plays out message after message,
 * cycling through several little scenes so you feel the different ways Grace
 * shows up: food wins, rough days, no-judgment moments, injection-day nerves,
 * and milestones. White background (no color), grey incoming + blue outgoing
 * bubbles, a typing indicator before Grace replies, and an iMessage-style input
 * bar that doubles as the Start CTA. Single screen, no scroll.
 */

type Msg = { from: "user" | "grace"; text: string };

/** Each scene is a self-contained little exchange. They rotate so the hero
 *  feels alive and shows Grace's range — encouraging, gentle, never judgy. */
const SCENES: Msg[][] = [
  [
    { from: "grace", text: "Morning 🌸 how'd you sleep?" },
    { from: "user", text: "pretty good actually!" },
    { from: "grace", text: "Love that. Had anything yet?" },
    { from: "user", text: "just 2 eggs + greek yogurt" },
    { from: "grace", text: "32g protein before 9am — you're already ahead today." },
    { from: "user", text: "ohh nice didn't realize" },
    { from: "grace", text: "Yep, 48 to go. I'll nudge you at lunch so it's easy." },
  ],
  [
    { from: "user", text: "feeling queasy after my shot" },
    { from: "grace", text: "Aw, I'm sorry. Super common the first day or two." },
    { from: "user", text: "is it normal to feel this off?" },
    { from: "grace", text: "Totally. Your body's still adjusting to the dose." },
    { from: "grace", text: "Small plain bites + ginger tea help a ton. Skip the greasy stuff today." },
    { from: "user", text: "ok i'll try that" },
    { from: "grace", text: "Good. I'll check on you tonight to make sure it eased up." },
  ],
  [
    { from: "user", text: "i caved and had ice cream at 11pm" },
    { from: "grace", text: "Hey — one scoop isn't a setback, it's a Tuesday." },
    { from: "user", text: "i feel kinda guilty though" },
    { from: "grace", text: "Don't. One treat doesn't undo your week." },
    { from: "grace", text: "You logged 6 days straight and hit protein every time. That's the real story." },
    { from: "user", text: "true. thanks for not judging" },
    { from: "grace", text: "Never. Fresh start tomorrow, I've got you." },
  ],
  [
    { from: "grace", text: "It's injection day 💉 want me to walk you through it?" },
    { from: "user", text: "yes please, kinda nervous" },
    { from: "grace", text: "Totally normal. Let's go slow." },
    { from: "grace", text: "Pen at room temp, pick a fresh spot, rotate from last week." },
    { from: "user", text: "did it! that wasn't bad" },
    { from: "grace", text: "You've done this 7 times now. Want a reminder for next week?" },
    { from: "user", text: "yes please" },
    { from: "grace", text: "Set for next Sunday morning. Proud of you." },
  ],
  [
    { from: "user", text: "down 3 lbs this week!! 🎉" },
    { from: "grace", text: "YES! That's huge — week 6 and you're flying." },
    { from: "user", text: "i honestly didn't think i could" },
    { from: "grace", text: "But you did — small consistent choices, every day." },
    { from: "grace", text: "Let's keep protein up to protect that muscle while the fat comes off." },
    { from: "user", text: "what's a good target?" },
    { from: "grace", text: "Around 100g a day for you. I'll help you get there without thinking about it." },
  ],
  [
    { from: "user", text: "what should i eat tonight?" },
    { from: "grace", text: "Craving anything in particular?" },
    { from: "user", text: "not sure, something light" },
    { from: "grace", text: "You love Mediterranean — a salmon + chickpea bowl is ~38g protein and easy on the stomach." },
    { from: "user", text: "ooh that sounds perfect" },
    { from: "grace", text: "Want me to log it once you've had it?" },
    { from: "user", text: "yes please, thank you" },
  ],
];

const USER_DELAY = 1500;
const TYPING = 2000;
const SCENE_PAUSE = 4200;

const MobileHero = () => {
  const navigate = useNavigate();
  const reduce = useReducedMotion();
  const [visible, setVisible] = useState<Msg[]>(reduce ? SCENES[0] : []);
  const [typing, setTyping] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (reduce) return;
    let cancelled = false;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const wait = (ms: number) =>
      new Promise<void>((r) => timers.push(setTimeout(r, ms)));

    const playScene = async (scene: Msg[]) => {
      setVisible([]);
      setTyping(false);
      for (const msg of scene) {
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
    };

    const run = async () => {
      let i = 0;
      // eslint-disable-next-line no-constant-condition
      while (!cancelled) {
        await playScene(SCENES[i % SCENES.length]);
        if (cancelled) return;
        await wait(SCENE_PAUSE);
        i += 1;
      }
    };
    run();
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
      <div className="flex flex-col items-center gap-1 border-b border-black/5 px-4 pb-3 pt-1">
        <div className="text-[20px] font-semibold text-[#111]">Grace</div>
        <div className="text-[12px] text-[#8e8e93]">GLP-1 companion</div>
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

      {/* iMessage-style input bar → Start CTA */}
      <div className="px-3 pb-5 pt-2">
        <button
          onClick={() => startWithGrace(() => navigate("/onboarding"))}
          className="flex w-full items-center justify-between rounded-full border border-black/10 bg-white py-2 pl-5 pr-2 text-left shadow-sm"
        >
          <span className="text-[16px] font-medium text-[#111]">Let's get started</span>
          <span className="flex h-8 w-8 items-center justify-center rounded-full bg-[#2C7DFA] text-white">
            <ArrowUp className="h-4 w-4" strokeWidth={2.6} />
          </span>
        </button>
        <p className="mt-2.5 text-center text-[12px] text-[#8e8e93]">
          Free to start · right inside iMessage
        </p>
      </div>
    </section>
  );
};

export default MobileHero;
