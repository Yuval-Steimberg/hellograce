import { useState, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Star } from "lucide-react";

const TESTIMONIALS = [
  {
    quote: "Finally, something that asks how I feel instead of just telling me what I weigh. It's the support I wish my clinic had time for.",
    name: "Elena M.",
    detail: "On Wegovy · Austin, TX",
  },
  {
    quote: "I used to forget water and protein constantly. Now it's like having a friend who gently keeps me on track all day.",
    name: "Sarah K.",
    detail: "On Zepbound · Denver, CO",
  },
  {
    quote: "No app, no logins — just texts. On my nausea days, having Grace answer right away made all the difference.",
    name: "Diane R.",
    detail: "On Ozempic · Nashville, TN",
  },
];

const Stars = () => (
  <div className="flex gap-0.5 mb-4" aria-label="5 out of 5 stars">
    {Array.from({ length: 5 }).map((_, i) => (
      <Star key={i} className="h-4 w-4 fill-accent text-accent" />
    ))}
  </div>
);

const TestimonialsSection = () => {
  const [current, setCurrent] = useState(0);

  const next = useCallback(() => {
    setCurrent((prev) => (prev + 1) % TESTIMONIALS.length);
  }, []);

  useEffect(() => {
    const timer = setInterval(next, 4800);
    return () => clearInterval(timer);
  }, [next]);

  return (
    <section className="py-20 md:py-32 bg-secondary/40 px-6 md:px-14">
      <div className="max-w-[1320px] mx-auto">
        <div className="text-center mb-12 md:mb-16">
          <span className="grace-chip mb-5">Loved by members</span>
          <h2 className="text-3xl md:text-5xl font-extrabold tracking-tight text-foreground leading-[1.08]">
            People who feel{" "}
            <span className="font-serif italic font-medium grace-gradient-text">truly supported.</span>
          </h2>
        </div>

        {/* Mobile: animated carousel */}
        <div className="md:hidden relative min-h-[260px]">
          <AnimatePresence mode="wait">
            <motion.blockquote
              key={current}
              initial={{ opacity: 0, x: 40 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -40 }}
              transition={{ duration: 0.35, ease: "easeInOut" }}
              className="grace-card p-7 flex flex-col"
            >
              <Stars />
              <p className="text-foreground leading-relaxed flex-1 mb-5 text-base">
                {TESTIMONIALS[current].quote}
              </p>
              <footer className="text-sm text-muted-foreground">
                <span className="font-bold text-foreground">{TESTIMONIALS[current].name}</span>
                <span className="block text-[13px] mt-0.5">{TESTIMONIALS[current].detail}</span>
              </footer>
            </motion.blockquote>
          </AnimatePresence>

          <div className="flex justify-center gap-2 mt-5">
            {TESTIMONIALS.map((_, i) => (
              <button
                key={i}
                onClick={() => setCurrent(i)}
                aria-label={`Go to testimonial ${i + 1}`}
                className={`h-2 rounded-full transition-all duration-300 ${
                  i === current ? "w-6 bg-accent" : "w-2 bg-border"
                }`}
              />
            ))}
          </div>
        </div>

        {/* Desktop: grid */}
        <div className="hidden md:grid md:grid-cols-3 gap-6 max-w-5xl mx-auto">
          {TESTIMONIALS.map((t) => (
            <blockquote key={t.name} className="grace-card p-8 flex flex-col">
              <Stars />
              <p className="text-foreground leading-relaxed flex-1 mb-6 text-[17px]">{t.quote}</p>
              <footer className="text-sm text-muted-foreground">
                <span className="font-bold text-foreground">{t.name}</span>
                <span className="block text-[13px] mt-0.5">{t.detail}</span>
              </footer>
            </blockquote>
          ))}
        </div>
      </div>
    </section>
  );
};

export default TestimonialsSection;
