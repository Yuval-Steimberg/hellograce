import { useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import { Check, ChevronRight } from "lucide-react";

const INCLUDED = [
  "Unlimited daily chat & check-ins",
  "Food, protein & hydration tracking",
  "Injection-day prep & follow-ups",
  "Side-effect & symptom support",
  "Photo & voice-note understanding",
  "Personal memory of your journey",
  "Weekly progress recaps",
];

const PricingSection = () => {
  const navigate = useNavigate();
  return (
    <section id="pricing" className="py-20 md:py-32 px-6 md:px-14 max-w-[1320px] mx-auto">
      <div className="max-w-2xl mx-auto text-center mb-12 md:mb-14">
        <span className="grace-chip mb-5">Simple pricing</span>
        <h2 className="text-3xl md:text-5xl font-extrabold tracking-tight text-foreground leading-[1.08] mb-5">
          Start free.{" "}
          <span className="font-serif italic font-medium grace-gradient-text">Stay if you love it.</span>
        </h2>
        <p className="text-lg text-muted-foreground leading-relaxed">
          Try Grace free for 3 days — no card required. Cancel any time by texting STOP.
        </p>
      </div>

      <motion.div
        initial={{ opacity: 0, y: 28 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, amount: 0.3 }}
        transition={{ duration: 0.55 }}
        className="relative max-w-md mx-auto"
      >
        <div className="absolute -inset-2 rounded-[2.2rem] bg-gradient-to-br from-mint/30 via-transparent to-accent/20 blur-2xl opacity-60" aria-hidden />
        <div className="relative grace-card overflow-hidden">
          {/* header */}
          <div className="bg-ink text-primary-foreground px-7 md:px-9 pt-8 pb-7 text-center">
            <span className="inline-flex items-center gap-2 rounded-full bg-mint/15 px-3 py-1 text-xs font-bold uppercase tracking-wider text-mint mb-4">
              3 days free
            </span>
            <div className="flex items-end justify-center gap-1.5">
              <span className="text-5xl font-extrabold tracking-tight">$12</span>
              <span className="text-white/60 font-medium mb-1.5">/ month</span>
            </div>
            <p className="text-sm text-white/60 mt-2">after your free trial · less than one co-pay</p>
          </div>

          {/* body */}
          <div className="px-7 md:px-9 py-7">
            <ul className="space-y-3 mb-7">
              {INCLUDED.map((item) => (
                <li key={item} className="flex items-start gap-3 text-[15px] text-foreground">
                  <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent/12 text-accent">
                    <Check className="h-3 w-3" strokeWidth={3} />
                  </span>
                  {item}
                </li>
              ))}
            </ul>

            <button
              onClick={() => navigate("/onboarding")}
              className="grace-btn-accent w-full text-base"
            >
              Start your free trial
              <ChevronRight className="ml-0.5 h-5 w-5" />
            </button>
            <p className="text-center text-xs text-muted-foreground mt-4">
              No card to start · Cancel any time · No retention tricks
            </p>
          </div>
        </div>
      </motion.div>
    </section>
  );
};

export default PricingSection;
