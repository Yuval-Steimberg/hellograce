import { motion } from "framer-motion";
import { Brain, HandHeart, MessagesSquare, Sparkles } from "lucide-react";

const PILLARS = [
  {
    icon: HandHeart,
    title: "A companion, not a tracker",
    body: "Warm, judgment-free support that meets you where you are — on the good days and the rough ones.",
  },
  {
    icon: Brain,
    title: "It remembers you",
    body: "Your medication, your goals, what makes you queasy, what you ate yesterday. Every reply is personal.",
  },
  {
    icon: MessagesSquare,
    title: "Just text, like a friend",
    body: "Log food, ask anything, send a photo or voice note. Grace replies in seconds, any time of day.",
  },
];

const SolutionSection = () => (
  <section className="px-4 sm:px-6 md:px-10 py-4">
    <div className="relative max-w-[1320px] mx-auto overflow-hidden rounded-[2rem] md:rounded-[2.5rem] bg-ink text-primary-foreground px-6 sm:px-10 md:px-16 py-16 md:py-24">
      {/* glow */}
      <div
        className="absolute inset-0 pointer-events-none"
        aria-hidden
        style={{
          background:
            "radial-gradient(ellipse 700px 500px at 85% 0%, hsl(153 71% 55% / 0.18) 0%, transparent 60%), radial-gradient(ellipse 600px 500px at 0% 100%, hsl(188 60% 50% / 0.16) 0%, transparent 60%)",
        }}
      />
      <div className="relative">
        <div className="max-w-2xl mb-12 md:mb-16">
          <span className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/5 px-4 py-1.5 text-xs font-semibold uppercase tracking-[0.16em] text-mint mb-5">
            <Sparkles className="h-3.5 w-3.5" />
            Meet Grace
          </span>
          <motion.h2
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, amount: 0.5 }}
            transition={{ duration: 0.6 }}
            className="text-3xl md:text-5xl font-extrabold tracking-tight leading-[1.08] mb-5 text-balance"
          >
            A daily GLP-1 companion that{" "}
            <span className="font-serif italic font-medium text-mint">stays in your corner.</span>
          </motion.h2>
          <p className="text-lg md:text-xl text-white/70 leading-relaxed">
            Grace turns a confusing journey into a steady daily rhythm — gentle
            reminders, real answers, and someone who genuinely remembers where
            you are. Think of it as a supportive friend who happens to know GLP-1
            inside out.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-5 md:gap-7">
          {PILLARS.map((p, i) => (
            <motion.div
              key={p.title}
              initial={{ opacity: 0, y: 24 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, amount: 0.4 }}
              transition={{ duration: 0.5, delay: i * 0.1 }}
              className="rounded-2xl border border-white/10 bg-white/[0.04] p-6 md:p-7 backdrop-blur-sm"
            >
              <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-mint/15 text-mint mb-4">
                <p.icon className="h-5 w-5" />
              </div>
              <h3 className="text-lg font-bold mb-2 tracking-tight">{p.title}</h3>
              <p className="text-[15px] text-white/65 leading-relaxed">{p.body}</p>
            </motion.div>
          ))}
        </div>
      </div>
    </div>
  </section>
);

export default SolutionSection;
