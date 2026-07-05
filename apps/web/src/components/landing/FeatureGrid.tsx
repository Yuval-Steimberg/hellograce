import { motion } from "framer-motion";
import {
  Beef,
  Target,
  Droplets,
  ListChecks,
  LineChart,
  CalendarClock,
  Syringe,
  Stethoscope,
  Mic,
  Brain,
  LayoutDashboard,
  MessageCircleHeart,
} from "lucide-react";

const FEATURES = [
  {
    icon: Beef,
    title: "Food & protein tracking",
    body: "Text what you ate — or snap a photo — and Grace logs it with protein and calories, then tells you what you have left against your personal target.",
  },
  {
    icon: Target,
    title: "Your own protein & calorie targets",
    body: "Personalized from your weight, goals, and activity — not a generic number you have to guess at.",
  },
  {
    icon: Droplets,
    title: "Water & hydration",
    body: "Log fluids with a tap or a text and see your daily range — so you stay ahead of the fatigue and headaches.",
  },
  {
    icon: ListChecks,
    title: "Quick daily checklist",
    body: "Tired of logging every bite? Just check off protein, fluids, and movement — a tap on the dashboard or a quick text.",
  },
  {
    icon: LineChart,
    title: "Weekly insights & plateau signals",
    body: "Weight trends and a weekly recap that connects your protein, fluids, and the scale — with honest encouragement through the plateau weeks.",
  },
  {
    icon: CalendarClock,
    title: "Medication & dose timeline",
    body: "See your dose journey — how your weight moved and how you felt at each step. Read-only history, never dosing advice.",
  },
  {
    icon: Syringe,
    title: "Injection-day support",
    body: "A morning prep ritual, a check-in after your dose, and a follow-up the next day — site rotation included.",
  },
  {
    icon: Stethoscope,
    title: "Side-effect pattern memory",
    body: "GLP-1-aware guidance for nausea, constipation and fatigue — and Grace learns what helped you last time.",
  },
  {
    icon: Mic,
    title: "Voice notes & photos",
    body: "Too tired to type? Send a voice note. Not sure about a meal? Send a picture. Grace handles both.",
  },
  {
    icon: Brain,
    title: "Personalized memory",
    body: "Grace remembers your medication, goals, dislikes and history — tell her once, and she remembers.",
  },
  {
    icon: LayoutDashboard,
    title: "One simple dashboard",
    body: "Meals, weight, water, habits, symptoms, and your dose journey — all in one place. Text “dashboard” anytime.",
  },
  {
    icon: MessageCircleHeart,
    title: "Natural conversation",
    body: "No menus, no commands. Just chat the way you'd text a friend — Grace understands and replies in seconds.",
  },
];

const FeatureGrid = () => (
  <section id="features" className="pt-10 pb-20 md:py-32 px-6 md:px-14 max-w-[1320px] mx-auto">
    <div className="max-w-2xl mx-auto text-center mb-12 md:mb-16">
      <span className="grace-chip mb-5">Your all-in-one GLP-1 command center</span>
      <h2 className="text-3xl md:text-5xl font-extrabold tracking-tight text-foreground leading-[1.08] mb-5">
        Everything you'd use four apps for,{" "}
        <span className="font-serif italic font-medium grace-gradient-text">in one place.</span>
      </h2>
      <p className="text-lg text-muted-foreground leading-relaxed">
        Medication, protein, water, habits, weight, symptoms, and weekly
        insights — Grace tracks it all through a friendly chat and brings it
        together in one simple dashboard.
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
