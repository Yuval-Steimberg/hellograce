import { motion } from "framer-motion";
import { Utensils, Droplets, Syringe, CalendarClock, HelpCircle, HeartPulse } from "lucide-react";

const STRUGGLES = [
  {
    icon: Utensils,
    title: "Hitting protein feels impossible",
    body: "Appetite is gone, meals get skipped, and the protein math is exhausting to track on your own.",
  },
  {
    icon: Droplets,
    title: "Forgetting to drink enough",
    body: "Hydration slips when you're not hungry — and dehydration makes the side effects worse.",
  },
  {
    icon: HeartPulse,
    title: "Nausea and side effects hit",
    body: "Day-after nausea, fatigue, constipation — and no one to ask what's normal at 9pm.",
  },
  {
    icon: Syringe,
    title: "Injection day sneaks up",
    body: "Which day was it again? Did you rotate the site? A little prep makes it so much smoother.",
  },
  {
    icon: CalendarClock,
    title: "Easy to drift off track",
    body: "The motivation of week one fades. Plateaus happen. Small habits quietly slip away.",
  },
  {
    icon: HelpCircle,
    title: "So many small questions",
    body: "What can I eat? Is this side effect okay? Your doctor is months away — and you need an answer now.",
  },
];

const ProblemSection = () => (
  <section className="pt-10 pb-20 md:py-32 px-6 md:px-14 max-w-[1320px] mx-auto">
    <div className="max-w-2xl mb-12 md:mb-16">
      <span className="grace-chip mb-5">The hard part</span>
      <h2 className="text-3xl md:text-5xl font-extrabold tracking-tight text-foreground leading-[1.08] mb-5">
        The shot is the easy part.
        <br />
        <span className="font-serif italic font-medium text-muted-foreground">The day-to-day is where it gets hard.</span>
      </h2>
      <p className="text-lg text-muted-foreground leading-relaxed">
        Your prescription came with a dose schedule — not a plan for the nausea,
        the protein, the plateau weeks, or the dozen small questions that come up
        between appointments.
      </p>
    </div>

    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 md:gap-5">
      {STRUGGLES.map((s, i) => (
        <motion.div
          key={s.title}
          initial={{ opacity: 0, y: 24 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.4 }}
          transition={{ duration: 0.45, delay: (i % 3) * 0.08, ease: [0.4, 0, 0.2, 1] }}
          className="grace-card p-6 md:p-7 hover:-translate-y-1 hover:shadow-[0_18px_50px_-18px_hsl(188_40%_20%/0.22)] transition-all duration-300"
        >
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-secondary text-foreground/70 mb-4">
            <s.icon className="h-5 w-5" />
          </div>
          <h3 className="text-lg font-bold text-foreground mb-2 tracking-tight">{s.title}</h3>
          <p className="text-[15px] text-muted-foreground leading-relaxed">{s.body}</p>
        </motion.div>
      ))}
    </div>
  </section>
);

export default ProblemSection;
