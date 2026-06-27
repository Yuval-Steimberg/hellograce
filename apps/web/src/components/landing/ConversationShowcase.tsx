import { motion } from "framer-motion";

type Turn = { from: "user" | "grace"; text: string };

const CONVERSATIONS: { tag: string; turns: Turn[] }[] = [
  {
    tag: "Logging food",
    turns: [
      { from: "user", text: "just had chicken and rice for lunch" },
      { from: "grace", text: "Nice — logged about 38g protein. That puts you at 64g today, 26g to go. A Greek yogurt this afternoon would close it easily. 🙌" },
    ],
  },
  {
    tag: "Side effects",
    turns: [
      { from: "user", text: "feeling really nauseous after my shot 😩" },
      { from: "grace", text: "Sorry you're feeling rough — day-after nausea peaks in the first 24–48h. Try plain crackers + ginger tea and skip anything fried today. Sipping water steadily helps too. I'll check in this afternoon." },
    ],
  },
  {
    tag: "Staying on track",
    turns: [
      { from: "user", text: "scale hasn't moved in 2 weeks, feeling discouraged" },
      { from: "grace", text: "That's so normal around now — plateaus are part of how GLP-1 works, not a sign it's failing. Your protein's been steady and you're logging consistently. Let's keep going — this usually breaks. 💚" },
    ],
  },
];

const ConversationShowcase = () => (
  <section className="py-20 md:py-32 px-6 md:px-14 max-w-[1320px] mx-auto">
    <div className="max-w-2xl mx-auto text-center mb-12 md:mb-16">
      <span className="grace-chip mb-5">Real conversations</span>
      <h2 className="text-3xl md:text-5xl font-extrabold tracking-tight text-foreground leading-[1.08] mb-5">
        See what it{" "}
        <span className="font-serif italic font-medium grace-gradient-text">actually feels like.</span>
      </h2>
      <p className="text-lg text-muted-foreground leading-relaxed">
        No commands to learn. Just say what's on your mind — Grace gets it.
      </p>
    </div>

    <div className="grid grid-cols-1 md:grid-cols-3 gap-5 md:gap-6">
      {CONVERSATIONS.map((c, i) => (
        <motion.div
          key={c.tag}
          initial={{ opacity: 0, y: 24 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.3 }}
          transition={{ duration: 0.5, delay: i * 0.1 }}
          className="grace-card p-5 md:p-6 flex flex-col"
        >
          <span className="self-start rounded-full bg-secondary px-3 py-1 text-[11px] font-bold uppercase tracking-wider text-foreground/60 mb-5">
            {c.tag}
          </span>
          <div className="space-y-2.5 flex-1">
            {c.turns.map((t, j) => (
              <div key={j} className={`flex ${t.from === "user" ? "justify-end" : "justify-start"}`}>
                <p
                  className={`max-w-[88%] rounded-2xl px-3.5 py-2.5 text-[13.5px] leading-snug ${
                    t.from === "user"
                      ? "bg-primary text-primary-foreground rounded-br-md"
                      : "bg-secondary text-foreground rounded-bl-md"
                  }`}
                >
                  {t.text}
                </p>
              </div>
            ))}
          </div>
        </motion.div>
      ))}
    </div>
  </section>
);

export default ConversationShowcase;
