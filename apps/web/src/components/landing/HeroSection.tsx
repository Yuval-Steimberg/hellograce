import { useNavigate } from "react-router-dom";
import { ChevronRight, ShieldCheck, Sparkles } from "lucide-react";
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

// Stagger config for word-by-word reveal on the headline.
const wordContainer = {
  hidden: {},
  show: { transition: { delayChildren: 0.15, staggerChildren: 0.08 } },
};
const word = {
  hidden: { opacity: 0, y: 28, filter: "blur(6px)" },
  show: {
    opacity: 1,
    y: 0,
    filter: "blur(0px)",
    transition: { duration: 0.55, ease: [0.2, 0.65, 0.3, 1] as const },
  },
};

const HEADLINE_LEAD = ["The", "friend", "who", "knows"];
const HEADLINE_ITALIC = ["your", "medication."];

const HeroSection = () => {
  const navigate = useNavigate();

  return (
    <section className="relative px-6 sm:px-10 md:px-14 max-w-[1440px] mx-auto min-h-[85svh] lg:min-h-[calc(100dvh-88px)] flex items-center">
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-12 lg:gap-20 items-center w-full py-14 lg:py-0 relative">
        {/* Chat mockup — desktop left, mobile below copy */}
        <motion.div
          initial={{ opacity: 0, x: -30 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.7, ease: [0.4, 0, 0.2, 1] }}
          className="lg:col-span-5 lg:col-start-1 order-2 lg:order-1"
        >
          <div className="grace-float">
            <ChatMockup />
          </div>
        </motion.div>

        {/* Copy */}
        <div className="lg:col-span-6 lg:col-start-7 order-1 lg:order-2 text-left">
          <motion.div
            initial="hidden"
            animate="show"
            custom={0}
            variants={fadeUp}
            className="inline-flex items-center gap-2 mb-5 md:mb-6"
          >
            <Sparkles className="h-4 w-4 text-accent animate-pulse" />
            <span className="inline-block text-sm sm:text-base md:text-lg uppercase tracking-[0.2em] font-semibold grace-shimmer">
              For Wegovy · Ozempic · Mounjaro · Zepbound
            </span>
          </motion.div>

          <motion.h1
            variants={wordContainer}
            initial="hidden"
            animate="show"
            className="font-serif text-5xl sm:text-6xl md:text-7xl lg:text-7xl leading-[1.08] tracking-tight text-balance mb-6 md:mb-7 text-foreground"
          >
            {HEADLINE_LEAD.map((w, i) => (
              <motion.span key={i} variants={word} className="inline-block mr-3">
                {w}
              </motion.span>
            ))}
            {HEADLINE_ITALIC.map((w, i) => (
              <motion.span
                key={`it-${i}`}
                variants={word}
                className="inline-block mr-3 italic text-accent"
              >
                {w}
              </motion.span>
            ))}
          </motion.h1>

          <motion.p
            initial="hidden"
            animate="show"
            custom={0.7}
            variants={fadeUp}
            className="text-lg sm:text-xl md:text-xl text-muted-foreground leading-relaxed max-w-[48ch] lg:mx-0 mb-10 md:mb-12"
          >
            grace is a daily companion on WhatsApp — handling nausea, plateau weeks, protein targets, injection-day check-ins and the dozen small questions GLP-1 throws at you. No app. No login. Just text.
          </motion.p>

          <motion.div
            initial="hidden"
            animate="show"
            custom={0.85}
            variants={fadeUp}
            className="w-fit"
          >
            <div className="grace-btn-glow">
              <MagneticButton
                onClick={() => navigate("/onboarding")}
                className="grace-btn text-lg md:text-lg px-12 py-5 md:py-5 w-full hover:scale-[1.02] transition-transform"
              >
                Start your free 3-day trial
                <ChevronRight className="ml-1 h-5 w-5" />
              </MagneticButton>
            </div>
            <div className="mt-5 flex items-center gap-2 bg-secondary/80 backdrop-blur-sm rounded-full px-5 py-2.5 w-full justify-center">
              <ShieldCheck className="h-4 w-4 text-accent" aria-hidden />
              <span className="text-sm sm:text-base text-foreground/70 font-medium whitespace-nowrap">
                No card required. Cancel any time by texting STOP.
              </span>
            </div>
          </motion.div>
        </div>
      </div>
    </section>
  );
};

export default HeroSection;
