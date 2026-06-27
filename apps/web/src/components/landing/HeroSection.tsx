import { useNavigate } from "react-router-dom";
import { ChevronRight, ShieldCheck, MessageCircle, Sparkles, Check } from "lucide-react";
import { motion } from "framer-motion";
import ChatMockup from "./ChatMockup";
import MagneticButton from "./MagneticButton";

const fadeUp = {
  hidden: { opacity: 0, y: 24 },
  show: (delay: number) => ({
    opacity: 1,
    y: 0,
    transition: { duration: 0.6, delay, ease: [0.4, 0, 0.2, 1] as const },
  }),
};

// Word-by-word reveal for the headline.
const wordContainer = {
  hidden: {},
  show: { transition: { delayChildren: 0.12, staggerChildren: 0.06 } },
};
const word = {
  hidden: { opacity: 0, y: 24, filter: "blur(6px)" },
  show: {
    opacity: 1,
    y: 0,
    filter: "blur(0px)",
    transition: { duration: 0.5, ease: [0.2, 0.65, 0.3, 1] as const },
  },
};

const HEADLINE_LEAD = ["Life", "on", "GLP-1", "is", "easier", "with"];

const TRUST = [
  "Works with every GLP-1",
  "Remembers your history",
  "Private & secure",
];

const HeroSection = () => {
  const navigate = useNavigate();

  return (
    <section className="relative px-6 sm:px-10 md:px-14 max-w-[1320px] mx-auto pt-6 pb-16 lg:pt-4 lg:pb-24 lg:min-h-[calc(100dvh-100px)] flex items-center">
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-12 lg:gap-16 items-center w-full">
        {/* Copy */}
        <div className="lg:col-span-6 order-1 text-left">
          <motion.div
            initial="hidden"
            animate="show"
            custom={0}
            variants={fadeUp}
            className="grace-chip mb-6"
          >
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-mint opacity-70" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-mint" />
            </span>
            Your daily GLP-1 companion
          </motion.div>

          <motion.h1
            variants={wordContainer}
            initial="hidden"
            animate="show"
            className="text-[2.6rem] sm:text-6xl lg:text-[4.2rem] font-extrabold leading-[1.04] tracking-tight text-balance mb-6 text-foreground"
          >
            {HEADLINE_LEAD.map((w, i) => (
              <motion.span key={i} variants={word} className="inline-block mr-[0.28em]">
                {w}
              </motion.span>
            ))}
            <motion.span
              variants={word}
              className="inline-block font-serif italic font-medium grace-gradient-text pr-1"
            >
              someone in your corner.
            </motion.span>
          </motion.h1>

          <motion.p
            initial="hidden"
            animate="show"
            custom={0.6}
            variants={fadeUp}
            className="text-lg sm:text-xl text-muted-foreground leading-relaxed max-w-[52ch] mb-8"
          >
            Grace helps you stay on track with protein, hydration, injection days,
            side effects and progress — through a simple daily chat that actually
            remembers you. Right inside WhatsApp. No app to download.
          </motion.p>

          {/* Trust ticks */}
          <motion.ul
            initial="hidden"
            animate="show"
            custom={0.72}
            variants={fadeUp}
            className="flex flex-wrap gap-x-5 gap-y-2 mb-8"
          >
            {TRUST.map((t) => (
              <li key={t} className="flex items-center gap-2 text-sm font-medium text-foreground/80">
                <span className="flex h-5 w-5 items-center justify-center rounded-full bg-accent/12 text-accent">
                  <Check className="h-3 w-3" strokeWidth={3} />
                </span>
                {t}
              </li>
            ))}
          </motion.ul>

          <motion.div
            initial="hidden"
            animate="show"
            custom={0.84}
            variants={fadeUp}
            className="flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-4"
          >
            <div className="grace-btn-glow">
              <MagneticButton
                onClick={() => navigate("/onboarding")}
                aria-label="Start with Grace"
                className="grace-btn-accent text-base px-9 py-5 w-full sm:w-auto"
              >
                Start with Grace
                <ChevronRight className="ml-0.5 h-5 w-5" />
              </MagneticButton>
            </div>
            <button
              onClick={() => navigate("/onboarding")}
              className="inline-flex items-center justify-center gap-2 text-base font-semibold text-foreground/80 hover:text-foreground px-4 py-3 transition-colors"
            >
              <MessageCircle className="h-4 w-4 text-accent" />
              Free to start, no card
            </button>
          </motion.div>

          <motion.p
            initial="hidden"
            animate="show"
            custom={0.95}
            variants={fadeUp}
            className="mt-5 flex items-center gap-2 text-sm text-muted-foreground"
          >
            <ShieldCheck className="h-4 w-4 text-accent shrink-0" aria-hidden />
            A supportive companion between appointments — not a replacement for medical care.
          </motion.p>
        </div>

        {/* Chat mockup */}
        <motion.div
          initial={{ opacity: 0, x: 30, scale: 0.97 }}
          animate={{ opacity: 1, x: 0, scale: 1 }}
          transition={{ duration: 0.7, ease: [0.4, 0, 0.2, 1] }}
          className="lg:col-span-6 order-2 relative"
        >
          {/* Floating capability badges around the phone */}
          <FloatingBadge className="-top-2 -left-1 sm:left-2" delay={1.1} icon="🥚" label="+32g protein logged" />
          <FloatingBadge className="bottom-10 -right-1 sm:-right-2" delay={1.4} icon="💧" label="Hydration on track" />

          <div className="grace-float max-w-[420px] mx-auto">
            <ChatMockup />
          </div>
        </motion.div>
      </div>
    </section>
  );
};

const FloatingBadge = ({
  className,
  label,
  icon,
  delay,
}: {
  className: string;
  label: string;
  icon: string;
  delay: number;
}) => (
  <motion.div
    initial={{ opacity: 0, y: 12, scale: 0.9 }}
    animate={{ opacity: 1, y: 0, scale: 1 }}
    transition={{ duration: 0.5, delay, ease: [0.4, 0, 0.2, 1] }}
    className={`hidden md:flex absolute z-10 items-center gap-2 rounded-2xl border border-border bg-card/95 px-3.5 py-2 shadow-xl shadow-primary/10 backdrop-blur-sm ${className}`}
  >
    <span className="text-base leading-none">{icon}</span>
    <span className="text-xs font-semibold text-foreground whitespace-nowrap">{label}</span>
    <Sparkles className="h-3 w-3 text-accent" />
  </motion.div>
);

export default HeroSection;
