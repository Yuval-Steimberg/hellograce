import { useState, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";

const TESTIMONIALS = [
  {
    quote: "Finally, something that asks how I feel — rather than telling me what I weigh.",
    name: "Elena M.",
    detail: "52, Austin TX",
  },
  {
    quote: "I forgot to drink water constantly before grace. Now it's like having a friend who gently reminds me.",
    name: "Sarah K.",
    detail: "48, Denver CO",
  },
  {
    quote: "I love that there's no app. Texts are perfect for me.",
    name: "Diane R.",
    detail: "61, Nashville TN",
  },
];

const TestimonialsSection = () => {
  const [current, setCurrent] = useState(0);

  const next = useCallback(() => {
    setCurrent((prev) => (prev + 1) % TESTIMONIALS.length);
  }, []);

  useEffect(() => {
    const timer = setInterval(next, 4500);
    return () => clearInterval(timer);
  }, [next]);

  return (
    <section className="py-16 md:py-32 bg-secondary/40 px-6 md:px-10">
      <div className="max-w-[1440px] mx-auto">
        <div className="text-center mb-10 md:mb-14">
          <span className="block text-xs uppercase tracking-[0.2em] text-muted-foreground/60 font-semibold mb-3">
            Real stories
          </span>
          <h2 className="font-serif text-2xl md:text-4xl text-foreground tracking-tight">
            Loved by people just like you.
          </h2>
        </div>

        {/* Mobile: animated carousel */}
        <div className="md:hidden relative min-h-[220px]">
          <AnimatePresence mode="wait">
            <motion.blockquote
              key={current}
              initial={{ opacity: 0, x: 40 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -40 }}
              transition={{ duration: 0.35, ease: "easeInOut" }}
              className="rounded-2xl bg-card p-6 ring-1 ring-border/40 flex flex-col"
            >
              <span className="font-serif text-3xl text-accent leading-none mb-3">&ldquo;</span>
              <p className="text-foreground leading-relaxed flex-1 mb-5 text-base">
                {TESTIMONIALS[current].quote}
              </p>
              <footer className="text-sm text-muted-foreground">
                <span className="font-semibold text-foreground">{TESTIMONIALS[current].name}</span> · {TESTIMONIALS[current].detail}
              </footer>
            </motion.blockquote>
          </AnimatePresence>

          {/* Dots */}
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
            <blockquote
              key={t.name}
              className="rounded-[2rem] bg-card p-10 ring-1 ring-border/40 flex flex-col"
            >
              <span className="font-serif text-4xl text-accent leading-none mb-4">&ldquo;</span>
              <p className="text-foreground leading-relaxed flex-1 mb-6 text-lg">
                {t.quote}
              </p>
              <footer className="text-sm text-muted-foreground">
                <span className="font-semibold text-foreground">{t.name}</span> · {t.detail}
              </footer>
            </blockquote>
          ))}
        </div>
      </div>
    </section>
  );
};

export default TestimonialsSection;
