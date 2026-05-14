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
  <section className="py-24 md:py-40 bg-secondary/30">
    <div className="max-w-[1440px] mx-auto px-8 md:px-14">
      <div className="text-center mb-14 md:mb-20">
        <span className="block text-xs uppercase tracking-[0.22em] text-muted-foreground/50 font-semibold mb-4">
          How it works
        </span>
        <h3 className="font-serif text-2xl md:text-4xl text-foreground tracking-tight">
          Three steps. Two minutes. <span className="italic text-accent">No apps.</span>
        </h3>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-8 md:gap-12 max-w-4xl mx-auto">
        {HOW_IT_WORKS.map((item) => (
          <div key={item.step} className="text-center md:px-6 bg-card/50 md:bg-transparent rounded-2xl p-8 md:p-0">
            <span className="inline-block font-serif text-5xl md:text-6xl text-accent/30 mb-4 md:mb-5">{item.step}</span>
            <h4 className="font-serif text-lg md:text-xl text-foreground mb-3 md:mb-4">{item.title}</h4>
            <p className="text-muted-foreground leading-relaxed text-sm md:text-base">{item.description}</p>
          </div>
        ))}
      </div>
    </div>
  </section>
);

export default PhilosophySection;
