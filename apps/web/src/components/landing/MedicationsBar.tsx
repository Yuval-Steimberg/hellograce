import { motion, useReducedMotion } from "framer-motion";

const MEDS = [
  "Wegovy",
  "Ozempic",
  "Mounjaro",
  "Zepbound",
  "Compounded semaglutide",
  "Compounded tirzepatide",
  "Saxenda",
];

const MedicationsBar = () => {
  const reduce = useReducedMotion();
  // Duplicate the list so the marquee can loop seamlessly.
  const loop = [...MEDS, ...MEDS];

  return (
    <section
      aria-label="Supported GLP-1 medications"
      className="relative border-y border-sand/30 bg-card/30 backdrop-blur-sm py-10 md:py-12 overflow-hidden"
    >
      <div className="max-w-[1440px] mx-auto px-5 sm:px-8 md:px-10">
        <motion.p
          initial={{ opacity: 0, y: 8 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.5 }}
          transition={{ duration: 0.5 }}
          className="text-center text-[11px] md:text-xs uppercase tracking-[0.25em] text-muted-foreground/80 font-semibold mb-5 md:mb-6"
        >
          Works with every GLP-1 medication
        </motion.p>

        {/* Marquee viewport with side fade masks */}
        <div
          className="relative"
          style={{
            WebkitMaskImage:
              "linear-gradient(90deg, transparent 0%, #000 8%, #000 92%, transparent 100%)",
            maskImage:
              "linear-gradient(90deg, transparent 0%, #000 8%, #000 92%, transparent 100%)",
          }}
        >
          <motion.div
            className="flex items-center gap-2 md:gap-3 w-max"
            animate={reduce ? undefined : { x: ["0%", "-50%"] }}
            transition={
              reduce
                ? undefined
                : { duration: 28, ease: "linear", repeat: Infinity }
            }
          >
            {loop.map((m, i) => (
              <span
                key={`${m}-${i}`}
                className="px-4 py-1.5 md:px-5 md:py-2 rounded-full bg-card border border-sand/70 text-foreground/85 text-sm md:text-[15px] font-medium tracking-tight whitespace-nowrap hover:border-accent/60 hover:shadow-md hover:shadow-accent/10 transition-colors"
              >
                {m}
              </span>
            ))}
          </motion.div>
        </div>
      </div>
    </section>
  );
};

export default MedicationsBar;
