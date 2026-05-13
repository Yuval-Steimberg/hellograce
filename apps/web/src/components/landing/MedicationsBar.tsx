import { motion } from "framer-motion";

/**
 * Slim bar reinforcing GLP-1 medication specificity. Sits between the
 * hero and the philosophy section.
 */
const MEDS = [
  "Wegovy",
  "Ozempic",
  "Mounjaro",
  "Zepbound",
  "Compounded semaglutide",
  "Compounded tirzepatide",
  "Saxenda",
];

const stagger = {
  hidden: {},
  show: { transition: { staggerChildren: 0.06, delayChildren: 0.1 } },
};

const item = {
  hidden: { opacity: 0, y: 12, scale: 0.95 },
  show: { opacity: 1, y: 0, scale: 1, transition: { duration: 0.4, ease: [0.4, 0, 0.2, 1] } },
};

const MedicationsBar = () => (
  <section
    aria-label="Supported GLP-1 medications"
    className="relative border-y border-sand/40 bg-card/40 backdrop-blur-md py-8 md:py-10"
  >
    <div className="max-w-[1440px] mx-auto px-5 sm:px-8 md:px-10">
      <motion.p
        initial={{ opacity: 0, y: 8 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, amount: 0.5 }}
        transition={{ duration: 0.5 }}
        className="text-center text-[11px] md:text-xs uppercase tracking-[0.25em] text-muted-foreground/80 font-semibold mb-5 md:mb-6"
      >
        Built fluent in every GLP-1 protocol
      </motion.p>
      <motion.div
        variants={stagger}
        initial="hidden"
        whileInView="show"
        viewport={{ once: true, amount: 0.3 }}
        className="flex flex-wrap items-center justify-center gap-2 md:gap-3"
      >
        {MEDS.map((m) => (
          <motion.span
            key={m}
            variants={item}
            whileHover={{ y: -3, scale: 1.04 }}
            className="px-4 py-1.5 md:px-5 md:py-2 rounded-full bg-card border border-sand/70 text-foreground/85 text-sm md:text-[15px] font-medium tracking-tight cursor-default transition-colors hover:border-accent/60 hover:bg-card hover:shadow-md hover:shadow-accent/10"
          >
            {m}
          </motion.span>
        ))}
      </motion.div>
    </div>
  </section>
);

export default MedicationsBar;
