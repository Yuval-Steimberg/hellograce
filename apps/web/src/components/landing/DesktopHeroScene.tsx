import { useNavigate } from "react-router-dom";
import { motion, useReducedMotion } from "framer-motion";
import { startWithGrace } from "@/lib/chatLinks";

/**
 * Desktop hero — a dreamy "sky over a meadow" scene (inspired by Tomo's playful
 * desktop), reimagined for Grace: floating GLP-1 capability cards drift in the
 * sky, each paired with a real text-message bubble showing how you'd ask Grace
 * for it. Bold headline + yellow "Text Grace" pill anchored bottom-left.
 *
 * Desktop only (the mobile hero is the clean chat thread). All original Grace
 * content — no Tomo artwork, copy, or layout is reused.
 */

const IMessageGlyph = ({ size = 26 }: { size?: number }) => (
  <span
    className="flex shrink-0 items-center justify-center rounded-[0.7rem] shadow-sm"
    style={{ width: size + 16, height: size + 16, background: "linear-gradient(180deg, #5BF675, #1FD256)" }}
    aria-hidden
  >
    <svg width={size} height={size} viewBox="0 0 24 24" fill="white">
      <path d="M12 3C6.9 3 3 6.4 3 10.6c0 2.4 1.3 4.5 3.3 5.9-.1.9-.6 2.2-1.5 3.1-.2.2 0 .5.3.5 1.9-.3 3.4-1 4.4-1.7.7.1 1.4.2 2.2.2 5.1 0 9-3.4 9-7.6S17.1 3 12 3z" />
    </svg>
  </span>
);

/** A user→Grace exchange that floats in the sky. */
type SkyItem = {
  ask: string; // the blue outgoing bubble (what you text Grace)
  card: React.ReactNode; // Grace's answer card
  pos: string; // absolute positioning classes
  drift: number; // px of gentle vertical drift
};

const Card = ({
  tint,
  children,
}: {
  tint: "white" | "mint" | "ink" | "sky" | "gold";
  children: React.ReactNode;
}) => {
  const styles: Record<string, string> = {
    white: "bg-white text-foreground",
    mint: "bg-[hsl(158_55%_42%)] text-white",
    ink: "bg-[hsl(192_44%_13%)] text-white",
    sky: "bg-[hsl(204_90%_94%)] text-[hsl(204_60%_24%)]",
    gold: "bg-[hsl(42_96%_62%)] text-[hsl(36_70%_18%)]",
  };
  return (
    <div className={`rounded-2xl px-4 py-3 shadow-xl shadow-black/10 ${styles[tint]}`}>
      {children}
    </div>
  );
};

const ITEMS: SkyItem[] = [
  {
    ask: "how many calories am I on so far?",
    pos: "top-[15%] left-[5%]",
    drift: 10,
    card: (
      <Card tint="mint">
        <div className="text-[11px] font-semibold uppercase tracking-wider opacity-90">Today so far</div>
        <div className="mt-1 flex items-baseline gap-3">
          <span className="text-2xl font-extrabold">1,840</span>
          <span className="text-xs opacity-90">kcal · goal 2,200</span>
        </div>
        <div className="mt-0.5 text-sm font-semibold">82g protein</div>
      </Card>
    ),
  },
  {
    ask: "what should I eat today?",
    pos: "top-[9%] left-[37%]",
    drift: 14,
    card: (
      <Card tint="white">
        <div className="text-sm font-bold">🥗 Greek yogurt + berries</div>
        <div className="mt-0.5 text-xs text-muted-foreground">~18g protein · easy on the stomach</div>
      </Card>
    ),
  },
  {
    ask: "remind me to take my shot Thursday",
    pos: "top-[13%] right-[6%]",
    drift: 12,
    card: (
      <Card tint="ink">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-mint">Reminder set</div>
        <div className="mt-1 text-lg font-extrabold">💉 Shot day</div>
        <div className="text-xs opacity-80">Thursday · 9:00 AM</div>
      </Card>
    ),
  },
  {
    ask: "how's my progress this week?",
    pos: "top-[40%] right-[28%]",
    drift: 9,
    card: (
      <Card tint="white">
        <div className="text-sm font-bold text-foreground">↓ 2.4 lbs this week</div>
        <div className="mt-1 flex items-end gap-1" aria-hidden>
          {[10, 8, 9, 6, 7, 4, 3].map((h, i) => (
            <span key={i} className="w-1.5 rounded-full bg-accent/70" style={{ height: h + 6 }} />
          ))}
        </div>
      </Card>
    ),
  },
  {
    ask: "feeling nauseous after my shot 😩",
    pos: "top-[44%] right-[4%]",
    drift: 13,
    card: (
      <Card tint="white">
        <div className="text-sm font-bold">Ginger tea + small meals 🤍</div>
        <div className="mt-0.5 text-xs text-muted-foreground">skip fried food today — I'll check in at 1pm</div>
      </Card>
    ),
  },
  {
    ask: "log a glass of water",
    pos: "top-[64%] left-[41%]",
    drift: 11,
    card: (
      <Card tint="sky">
        <div className="flex items-center gap-2">
          <span className="text-lg">💧</span>
          <div>
            <div className="text-sm font-bold">48 / 64 oz today</div>
            <div className="text-[11px] opacity-80">nice — almost there</div>
          </div>
        </div>
      </Card>
    ),
  },
];

const DesktopHeroScene = () => {
  const navigate = useNavigate();
  const reduce = useReducedMotion();

  return (
    <section className="relative hidden lg:block overflow-hidden">
      {/* Sky */}
      <div
        className="absolute inset-0"
        style={{
          background:
            "linear-gradient(180deg, hsl(204 80% 72%) 0%, hsl(202 78% 80%) 34%, hsl(200 70% 88%) 62%, hsl(150 40% 86%) 100%)",
        }}
        aria-hidden
      />
      {/* Clouds */}
      <div className="absolute inset-0 pointer-events-none" aria-hidden>
        <Cloud className="top-[8%] left-[6%]" scale={1.1} />
        <Cloud className="top-[26%] right-[12%]" scale={1.4} />
        <Cloud className="top-[58%] left-[24%]" scale={1} />
        <Cloud className="top-[68%] right-[20%]" scale={1.25} />
      </div>
      {/* Meadow */}
      <div
        className="absolute inset-x-0 bottom-0 h-[22%]"
        style={{
          background:
            "linear-gradient(180deg, transparent, hsl(135 45% 64% / 0.55) 40%, hsl(132 48% 52% / 0.85))",
        }}
        aria-hidden
      />

      <div className="relative mx-auto max-w-[1320px] px-10 min-h-[88vh]">
        {/* Floating capability cards */}
        <div className="absolute inset-0">
          {ITEMS.map((item, i) => (
            <motion.div
              key={i}
              className={`group absolute ${item.pos} w-[230px]`}
              initial={{ opacity: 0, y: 18, scale: 0.94 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              transition={{ duration: 0.6, delay: 0.15 + i * 0.12, ease: [0.4, 0, 0.2, 1] }}
            >
              <motion.div
                animate={reduce ? {} : { y: [0, -item.drift, 0] }}
                transition={{ duration: 5 + i, repeat: Infinity, ease: "easeInOut" }}
                className="transition-transform duration-300 group-hover:scale-[1.04]"
              >
                {/* Outgoing text bubble */}
                <div className="mb-2 flex justify-end">
                  <span className="max-w-[200px] rounded-[1.1rem] rounded-br-sm bg-[hsl(214_90%_56%)] px-3.5 py-2 text-[13px] font-medium leading-snug text-white shadow-md">
                    {item.ask}
                  </span>
                </div>
                {item.card}
              </motion.div>
            </motion.div>
          ))}
        </div>

        {/* Headline + CTA, bottom-left */}
        <div className="absolute bottom-[11%] left-10 max-w-[46ch]">
          <motion.h1
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.2 }}
            className="text-[3rem] xl:text-[3.6rem] font-extrabold leading-[1.03] tracking-tight text-[hsl(200_55%_16%)]"
          >
            <span className="whitespace-nowrap">Life on GLP-1,</span>
            <br />
            <span className="font-serif italic font-medium text-[hsl(192_44%_16%)]">
              made lighter.
            </span>
          </motion.h1>
          <motion.p
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.32 }}
            className="mt-4 max-w-[40ch] text-lg font-medium text-[hsl(200_45%_22%)]"
          >
            Protein, meals, side effects, injection days, progress — all in one
            simple thread that remembers you. Right inside iMessage.
          </motion.p>
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.44 }}
            className="mt-7 flex items-center gap-4"
          >
            <button
              onClick={() => startWithGrace(() => navigate("/onboarding"))}
              aria-label="Text Grace to get started"
              className="inline-flex shrink-0 items-center gap-3 whitespace-nowrap rounded-full px-8 py-4 text-lg font-extrabold text-[hsl(36_70%_16%)] transition-all duration-200 hover:-translate-y-0.5 active:scale-[0.99]"
              style={{
                background: "linear-gradient(180deg, hsl(42 96% 64%), hsl(36 92% 54%))",
                boxShadow: "0 14px 34px -10px hsl(36 88% 40% / 0.6)",
              }}
            >
              Text Grace
              <IMessageGlyph size={22} />
            </button>
            <div className="flex items-center gap-2.5">
              <div className="flex -space-x-2.5">
                {["👩🏻", "🧑🏽", "👩🏾", "🧑🏼"].map((e, i) => (
                  <span
                    key={i}
                    className="inline-flex h-8 w-8 items-center justify-center rounded-full border-2 border-white/80 bg-white/70 text-sm shadow-sm"
                  >
                    {e}
                  </span>
                ))}
              </div>
              <span className="text-sm font-semibold text-[hsl(200_45%_24%)]">
                Trusted by thousands on GLP-1
              </span>
            </div>
          </motion.div>
        </div>
      </div>
    </section>
  );
};

const Cloud = ({ className, scale = 1 }: { className: string; scale?: number }) => (
  <div className={`absolute ${className}`} style={{ transform: `scale(${scale})` }}>
    <div className="relative">
      <span className="block h-12 w-36 rounded-full bg-white/70 blur-[2px]" />
      <span className="absolute -top-5 left-8 h-16 w-16 rounded-full bg-white/70 blur-[2px]" />
      <span className="absolute -top-3 left-20 h-12 w-12 rounded-full bg-white/70 blur-[2px]" />
    </div>
  </div>
);

export default DesktopHeroScene;
