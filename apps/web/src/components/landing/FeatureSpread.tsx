import hydrationImg from "@/assets/editorial-hydration.jpg";
import nourishImg from "@/assets/editorial-nourish.jpg";

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
    <div className={`lg:col-span-5 ${reversed ? "lg:col-start-8 order-2" : "lg:col-start-1 order-2 lg:order-1"}`}>
      <span className="block text-xs uppercase tracking-[0.2em] text-accent mb-3 md:mb-4 font-semibold">
        {label}
      </span>
      <h3 className="font-serif text-2xl md:text-4xl text-foreground mb-4 md:mb-5">{title}</h3>
      <p className="text-muted-foreground leading-relaxed mb-6 md:mb-8 text-base md:text-lg">{description}</p>
      <div className="bg-card rounded-xl md:rounded-2xl p-5 md:p-6 ring-1 ring-border/30">
        <p className="italic text-foreground/90 text-sm md:text-base font-serif leading-relaxed">
          "{quote}"
        </p>
        <span className="block text-[11px] md:text-xs text-muted-foreground/60 mt-2 md:mt-3 uppercase tracking-wider">
          Example message
        </span>
      </div>
    </div>
    <div className={`lg:col-span-5 ${reversed ? "lg:col-start-1 order-1" : "lg:col-start-8 order-1 lg:order-2"}`}>
      <div className="rounded-2xl lg:rounded-[2rem] overflow-hidden">
        <img
          src={image}
          alt={imageAlt}
          loading="lazy"
          width={1200}
          height={900}
          className="w-full aspect-[4/3] object-cover"
        />
      </div>
    </div>
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
