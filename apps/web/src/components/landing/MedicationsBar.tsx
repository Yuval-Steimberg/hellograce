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

const MedicationsBar = () => (
  <section
    aria-label="Supported GLP-1 medications"
    className="border-y border-sand/60 bg-secondary/30 py-8 md:py-10"
  >
    <div className="max-w-[1440px] mx-auto px-5 sm:px-8 md:px-10">
      <p className="text-center text-[11px] md:text-xs uppercase tracking-[0.25em] text-muted-foreground/70 font-semibold mb-5 md:mb-6">
        Built fluent in every GLP-1 protocol
      </p>
      <div className="flex flex-wrap items-center justify-center gap-2 md:gap-3">
        {MEDS.map((m) => (
          <span
            key={m}
            className="px-4 py-1.5 md:px-5 md:py-2 rounded-full bg-card border border-sand/70 text-foreground/80 text-sm md:text-[15px] font-medium tracking-tight"
          >
            {m}
          </span>
        ))}
      </div>
    </div>
  </section>
);

export default MedicationsBar;
