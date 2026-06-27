import { motion } from "framer-motion";
import { Stethoscope, Lock, HeartHandshake, ShieldCheck } from "lucide-react";

const POINTS = [
  {
    icon: Stethoscope,
    title: "Supports your care, never replaces it",
    body: "Grace won't adjust your dose, diagnose, or override your prescriber. When something needs a professional, she says so — clearly.",
  },
  {
    icon: HeartHandshake,
    title: "Help between appointments",
    body: "For the everyday questions your doctor doesn't have time for — Grace is there in the moments that actually come up.",
  },
  {
    icon: Lock,
    title: "Private by design",
    body: "Your messages are encrypted in transit and at rest. We never sell your data or run ads against it — ever.",
  },
  {
    icon: ShieldCheck,
    title: "Knows its limits",
    body: "If anything sounds clinically serious, Grace points you to your doctor or urgent care right away. That's a firm boundary.",
  },
];

const TrustSafety = () => (
  <section className="py-20 md:py-32 px-6 md:px-14 max-w-[1320px] mx-auto">
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-10 lg:gap-16 items-start">
      <div className="lg:col-span-5">
        <span className="grace-chip mb-5">Trust & safety</span>
        <h2 className="text-3xl md:text-5xl font-extrabold tracking-tight text-foreground leading-[1.08] mb-5">
          Safe support you can{" "}
          <span className="font-serif italic font-medium grace-gradient-text">lean on.</span>
        </h2>
        <p className="text-lg text-muted-foreground leading-relaxed">
          Grace is a wellness companion built around clear boundaries. She gives
          you warm, practical, GLP-1-aware support — and always points you back
          to your medical team when it counts.
        </p>
      </div>

      <div className="lg:col-span-7 grid grid-cols-1 sm:grid-cols-2 gap-4 md:gap-5">
        {POINTS.map((p, i) => (
          <motion.div
            key={p.title}
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, amount: 0.4 }}
            transition={{ duration: 0.45, delay: (i % 2) * 0.08 }}
            className="grace-card p-6"
          >
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-accent/10 text-accent mb-4">
              <p.icon className="h-5 w-5" />
            </div>
            <h3 className="text-[17px] font-bold text-foreground mb-2 tracking-tight">{p.title}</h3>
            <p className="text-[14px] text-muted-foreground leading-relaxed">{p.body}</p>
          </motion.div>
        ))}
      </div>
    </div>
  </section>
);

export default TrustSafety;
