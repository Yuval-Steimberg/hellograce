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
      <span className="block text-xs uppercase tracking-[0.2em] text-accent mb-3 md:mb-4 font-semibold">
        {label}
      </span>
      <h3 className="font-serif text-2xl md:text-4xl text-foreground mb-4 md:mb-5">{title}</h3>
      <p className="text-muted-foreground leading-relaxed mb-6 md:mb-8 text-base md:text-lg">{description}</p>
      <motion.div
        whileHover={{ y: -4 }}
        transition={{ duration: 0.2 }}
        className="bg-card/90 backdrop-blur-sm rounded-xl md:rounded-2xl p-5 md:p-6 ring-1 ring-border/30 hover:ring-accent/40 hover:shadow-lg hover:shadow-accent/10 transition-all"
      >
        <p className="italic text-foreground/90 text-sm md:text-base font-serif leading-relaxed">
          "{quote}"
        </p>
        <span className="block text-[11px] md:text-xs text-muted-foreground/60 mt-2 md:mt-3 uppercase tracking-wider">
          Example message
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
      <div className="rounded-2xl lg:rounded-[2rem] overflow-hidden shadow-xl shadow-foreground/5">
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
  <section className="py-16 md:py-32 px-6 md:px-10 max-w-[1440px] mx-auto space-y-16 md:space-y-40">
    <div className="text-center max-w-2xl mx-auto mb-2 md:mb-4">
      <span className="block text-xs uppercase tracking-[0.2em] text-muted-foreground/60 font-semibold mb-3">
        What you'll receive
      </span>
      <h2 className="font-serif text-2xl md:text-4xl text-foreground tracking-tight">
        A companion that learns you — and stays with you.
      </h2>
      <p className="text-muted-foreground text-base md:text-lg mt-4 leading-relaxed">
        grace remembers what you've shared — your goals, your struggles, your wins. Every message is personalized to where you are in your journey, not a generic broadcast.
      </p>
    </div>

    <FeatureRow
      label="Morning"
      title="Start with water, not worry."
      description="Your morning text arrives before the fatigue does. Based on what you told us about your routine and how yesterday went, it's a warm, specific reminder — not a copy-paste broadcast."
      quote="Good morning, Claire. You mentioned feeling sluggish yesterday — a tall glass of water before your coffee can really help. You've got this."
      image={hydrationImg}
      imageAlt="Glass of water with lemon on a linen tablecloth"
    />
    <FeatureRow
      label="Evening"
      title="Small bites, big difference."
      description="When appetite disappears, eating feels impossible. We remember what foods you like and suggest tiny, nourishing options that protect your energy — nothing overwhelming, nothing preachy."
      quote="If dinner feels like too much tonight, how about that almond butter toast you liked last week? Small wins count, and you're doing better than you think."
      image={nourishImg}
      imageAlt="Bowl of warm bone broth with herbs"
      reversed
    />
  </section>
);

export default FeatureSpread;
