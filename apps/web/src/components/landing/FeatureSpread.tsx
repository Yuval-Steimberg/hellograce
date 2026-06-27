import hydrationImg from "@/assets/editorial-hydration.jpg";
import nourishImg from "@/assets/editorial-nourish.jpg";
import { motion } from "framer-motion";

interface FeatureRowProps {
  label: string;
  title: string;
  description: string;
  quote: string;
  image: string;
  imageAlt: string;
  reversed?: boolean;
}

const FeatureRow = ({ label, title, description, quote, image, imageAlt, reversed }: FeatureRowProps) => (
  <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 lg:gap-16 items-center">
    <motion.div
      initial={{ opacity: 0, x: reversed ? 40 : -40 }}
      whileInView={{ opacity: 1, x: 0 }}
      viewport={{ once: true, amount: 0.3 }}
      transition={{ duration: 0.6, ease: [0.4, 0, 0.2, 1] }}
      className={`lg:col-span-5 ${reversed ? "lg:col-start-8 order-2" : "lg:col-start-1 order-2 lg:order-1"}`}
    >
      <span className="block text-xs uppercase tracking-[0.18em] text-accent mb-4 font-bold">
        {label}
      </span>
      <h3 className="text-2xl md:text-4xl font-extrabold tracking-tight text-foreground mb-4 md:mb-5 leading-tight">{title}</h3>
      <p className="text-muted-foreground leading-relaxed mb-6 md:mb-8 text-base md:text-lg">{description}</p>
      <motion.div
        whileHover={{ y: -4 }}
        transition={{ duration: 0.2 }}
        className="grace-card p-5 md:p-6 hover:border-accent/40 hover:shadow-[0_18px_50px_-18px_hsl(158_64%_30%/0.25)] transition-all"
      >
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent/12 text-accent text-sm">✦</span>
          <p className="font-serif italic text-foreground/90 text-base md:text-lg leading-relaxed">
            {quote}
          </p>
        </div>
        <span className="block text-[11px] md:text-xs text-muted-foreground/70 mt-3 pl-10 uppercase tracking-wider font-semibold">
          A real message from Grace
        </span>
      </motion.div>
    </motion.div>
    <motion.div
      initial={{ opacity: 0, x: reversed ? -40 : 40, scale: 0.95 }}
      whileInView={{ opacity: 1, x: 0, scale: 1 }}
      viewport={{ once: true, amount: 0.3 }}
      transition={{ duration: 0.7, ease: [0.4, 0, 0.2, 1] }}
      className={`lg:col-span-5 ${reversed ? "lg:col-start-1 order-1" : "lg:col-start-8 order-1 lg:order-2"}`}
    >
      <div className="rounded-2xl lg:rounded-[2rem] overflow-hidden shadow-xl shadow-primary/5 ring-1 ring-border/60">
        <img
          src={image}
          alt={imageAlt}
          loading="lazy"
          width={1200}
          height={900}
          className="w-full aspect-[4/3] object-cover hover:scale-105 transition-transform duration-700"
        />
      </div>
    </motion.div>
  </div>
);

const FeatureSpread = () => (
  <section className="py-20 md:py-32 px-6 md:px-14 max-w-[1320px] mx-auto space-y-20 md:space-y-36">
    <div className="text-center max-w-2xl mx-auto">
      <span className="grace-chip mb-5">Personal, every time</span>
      <h2 className="text-3xl md:text-5xl font-extrabold tracking-tight text-foreground leading-[1.08] mb-5">
        It learns you — and{" "}
        <span className="font-serif italic font-medium grace-gradient-text">stays with you.</span>
      </h2>
      <p className="text-muted-foreground text-lg leading-relaxed">
        Grace remembers what you've shared — your goals, your struggles, your
        wins. Every message is shaped by where you actually are, never a generic
        broadcast.
      </p>
    </div>

    <FeatureRow
      label="Mornings"
      title="Start with water, not worry."
      description="Your morning message arrives before the fatigue does. Based on your routine and how yesterday went, it's a warm, specific nudge — never a copy-paste reminder."
      quote="Morning! You mentioned feeling sluggish yesterday — a tall glass of water before your coffee really helps. Today's protein target is 90g. You've got this."
      image={hydrationImg}
      imageAlt="A glass of water with lemon on a calm, light surface"
    />
    <FeatureRow
      label="Evenings"
      title="Small bites, big difference."
      description="When appetite disappears, eating feels impossible. Grace remembers the foods you actually like and suggests tiny, doable options that protect your energy — nothing overwhelming, nothing preachy."
      quote="If dinner feels like too much tonight, that almond-butter toast you liked last week is a great call. Small wins count — you're doing better than you think."
      image={nourishImg}
      imageAlt="A warm, nourishing bowl of food with fresh herbs"
      reversed
    />
  </section>
);

export default FeatureSpread;
