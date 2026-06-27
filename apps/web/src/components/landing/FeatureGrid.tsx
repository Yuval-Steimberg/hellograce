import { motion } from "framer-motion";
import {
  Beef,
  Droplets,
  Syringe,
  Stethoscope,
  Mic,
  Brain,
  LineChart,
  MessageCircleHeart,
} from "lucide-react";

const FEATURES = [
  {
    icon: Beef,
    title: "Food & protein tracking",
    body: "Text what you ate — or snap a photo — and Grace logs it with protein and calories, then tells you what you have left for the day.",
  },
  {
    icon: Droplets,
    title: "Hydration nudges",
    body: "Gentle, well-timed reminders to drink water, so you stay ahead of the fatigue and headaches.",
  },
  {
    icon: Syringe,
    title: "Injection-day support",
    body: "A morning prep ritual, a check-in after your dose, and a follow-up the next day — site rotation included.",
  },
  {
    icon: Stethoscope,
    title: "Side-effect help",
    body: "Practical, GLP-1-aware guidance for nausea, constipation and fatigue — and a clear nudge to your doctor when it matters.",
  },
  {
    icon: Mic,
    title: "Voice notes & photos",
    body: "Too tired to type? Send a voice note. Not sure about a meal? Send a picture. Grace handles both.",
  },
  {
    icon: Brain,
    title: "Personalized memory",
    body: "Grace remembers your medication, goals, dislikes and history — so you never have to repeat yourself.",
  },
  {
    icon: LineChart,
    title: "Progress & motivation",
    body: "Weight trends, weekly recaps and honest encouragement that keeps you going through the plateau weeks.",
  },
  {
    icon: MessageCircleHeart,
    title: "Natural conversation",
    body: "No menus, no commands. Just chat the way you'd text a friend — Grace understands and replies in seconds.",
  },
];

const FeatureGrid = () => (
  <section id="features" className="py-20 md:py-32 px-6 md:px-14 max-w-[1320px] mx-auto">
    <div className="max-w-2xl mx-auto text-center mb-12 md:mb-16">
      <span className="grace-chip mb-5">Everything in one chat</span>
      <h2 className="text-3xl md:text-5xl font-extrabold tracking-tight text-foreground leading-[1.08] mb-5">
        One companion for{" "}
        <span className="font-serif italic font-medium grace-gradient-text">every part of your day.</span>
      </h2>
      <p className="text-lg text-muted-foreground leading-relaxed">
        From your morning water to your injection-day jitters, Grace quietly
        handles the details so staying on track feels effortless.
      </p>
    </div>

    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 md:gap-5">
      {FEATURES.map((f, i) => (
        <motion.div
          key={f.title}
          initial={{ opacity: 0, y: 24 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.3 }}
          transition={{ duration: 0.45, delay: (i % 4) * 0.06, ease: [0.4, 0, 0.2, 1] }}
          className="group grace-card p-6 hover:-translate-y-1 hover:border-accent/40 hover:shadow-[0_18px_50px_-18px_hsl(158_64%_30%/0.28)] transition-all duration-300"
        >
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-accent/10 text-accent mb-4 group-hover:bg-accent group-hover:text-accent-foreground transition-colors duration-300">
            <f.icon className="h-5.5 w-5.5" style={{ width: 22, height: 22 }} />
          </div>
          <h3 className="text-[17px] font-bold text-foreground mb-2 tracking-tight">{f.title}</h3>
          <p className="text-[14px] text-muted-foreground leading-relaxed">{f.body}</p>
        </motion.div>
      ))}
    </div>
  </section>
);

export default FeatureGrid;
