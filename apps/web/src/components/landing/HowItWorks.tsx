import { useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import { startWithGrace } from "@/lib/chatLinks";
import { ChevronRight } from "lucide-react";

const STEPS = [
  {
    step: "1",
    title: "Start with Grace",
    body: "Answer a few quick questions about your medication, goals and routine. Two minutes — no medical history form.",
  },
  {
    step: "2",
    title: "Tell Grace what's going on",
    body: "Text what you ate, how you're feeling, or anything you're unsure about. Photos and voice notes work too.",
  },
  {
    step: "3",
    title: "Get personal daily support",
    body: "Grace checks in, keeps you on track, and answers in seconds — personalized to exactly where you are.",
  },
];

const HowItWorks = () => {
  const navigate = useNavigate();
  return (
    <section id="how-it-works" className="py-20 md:py-32 px-6 md:px-14 max-w-[1320px] mx-auto">
      <div className="max-w-2xl mx-auto text-center mb-14 md:mb-20">
        <span className="grace-chip mb-5">How it works</span>
        <h2 className="text-3xl md:text-5xl font-extrabold tracking-tight text-foreground leading-[1.08] mb-5">
          Up and running in{" "}
          <span className="font-serif italic font-medium grace-gradient-text">two minutes.</span>
        </h2>
        <p className="text-lg text-muted-foreground leading-relaxed">
          No app store, no passwords, no learning curve. If you can send a text,
          you can use Grace.
        </p>
      </div>

      <div className="relative grid grid-cols-1 md:grid-cols-3 gap-8 md:gap-6 max-w-5xl mx-auto">
        {/* connector line on desktop */}
        <div
          className="hidden md:block absolute top-7 left-[16%] right-[16%] h-px bg-gradient-to-r from-border via-accent/40 to-border"
          aria-hidden
        />
        {STEPS.map((s, i) => (
          <motion.div
            key={s.step}
            initial={{ opacity: 0, y: 24 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, amount: 0.4 }}
            transition={{ duration: 0.5, delay: i * 0.12 }}
            className="relative text-center px-2"
          >
            <div className="relative z-10 mx-auto mb-6 flex h-14 w-14 items-center justify-center rounded-full bg-primary text-primary-foreground text-xl font-extrabold shadow-lg shadow-primary/25">
              {s.step}
            </div>
            <h3 className="text-xl font-bold text-foreground mb-3 tracking-tight">{s.title}</h3>
            <p className="text-[15px] text-muted-foreground leading-relaxed max-w-xs mx-auto">{s.body}</p>
          </motion.div>
        ))}
      </div>

      <div className="mt-14 md:mt-16 flex justify-center">
        <button
          onClick={() => startWithGrace(() => navigate("/onboarding"))}
          className="grace-btn-accent text-base px-9"
        >
          Start with Grace
          <ChevronRight className="ml-0.5 h-5 w-5" />
        </button>
      </div>
    </section>
  );
};

export default HowItWorks;
