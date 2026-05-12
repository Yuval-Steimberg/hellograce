const HOW_IT_WORKS = [
  {
    step: "01",
    title: "Share your protocol",
    description: "Your medication, dose week, injection day, and goal weight. Two minutes — no medical history form.",
  },
  {
    step: "02",
    title: "grace learns your patterns",
    description: "She remembers what makes you nauseous, which protein hits land, when your energy dips, and when your weight stalls.",
  },
  {
    step: "03",
    title: "Text her like a friend",
    description: "Morning check-in. Injection-day prep. Real-time answers when you're at the grocery store or staring at a menu.",
  },
];

const PhilosophySection = () => (
  <section className="py-16 md:py-32 bg-secondary/40">
    <div className="max-w-[1440px] mx-auto px-6 md:px-10">
      <div className="text-center mb-10 md:mb-14">
        <span className="block text-xs uppercase tracking-[0.2em] text-muted-foreground/60 font-semibold mb-3">
          How it works
        </span>
        <h3 className="font-serif text-2xl md:text-4xl text-foreground tracking-tight">
          Three steps. Two minutes. <span className="italic text-accent">No apps.</span>
        </h3>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 md:gap-8 max-w-4xl mx-auto">
        {HOW_IT_WORKS.map((item) => (
          <div key={item.step} className="text-center md:px-4 bg-card/60 md:bg-transparent rounded-2xl p-6 md:p-0">
            <span className="inline-block font-serif text-4xl md:text-5xl text-accent/40 mb-3 md:mb-4">{item.step}</span>
            <h4 className="font-serif text-lg md:text-xl text-foreground mb-2 md:mb-3">{item.title}</h4>
            <p className="text-muted-foreground leading-relaxed text-sm md:text-base">{item.description}</p>
          </div>
        ))}
      </div>
    </div>
  </section>
);

export default PhilosophySection;
