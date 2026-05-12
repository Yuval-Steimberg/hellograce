import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";

const FAQS = [
  {
    q: "Which GLP-1 medications does grace support?",
    a: "Wegovy and Ozempic (semaglutide), Mounjaro and Zepbound (tirzepatide), Saxenda (liraglutide), and compounded semaglutide/tirzepatide from any reputable pharmacy. grace knows the dose ladders, the typical side-effect timelines, and the protocol differences between them.",
  },
  {
    q: "Do I need to download an app?",
    a: "No. grace lives in WhatsApp (or SMS where WhatsApp isn't available). It's the messaging app on the phone you already carry — no login, no password, no notifications to manage.",
  },
  {
    q: "What happens on my injection day?",
    a: "grace texts you in the morning with a quick prep ritual (hydration target, lighter meals, ginger if nausea hit last time). She checks in after you've dosed, then again the next day to see how you're feeling. If you flag a side effect, she follows up 4 hours later — exactly when most people forget they're going to need help.",
  },
  {
    q: "Can grace help with nausea, fatigue, or constipation?",
    a: "Yes — and she remembers what worked last time. Plain crackers and ginger tea on day-after nausea. Magnesium citrate at night for constipation. Electrolytes when fatigue spikes. She'll never tell you to push through — only what's reasonable, and when to call your doctor.",
  },
  {
    q: "Does she actually know my history, or is it generic?",
    a: "She remembers everything you share — your goal weight, current dose week, the foods that make you queasy, which protein sources you actually eat, your last weigh-in, and whether you flagged a side effect this week. Every reply is shaped by that context. Generic check-ins are the one thing she won't do.",
  },
  {
    q: "What about plateau weeks?",
    a: "Plateaus around weeks 8–12 are normal on GLP-1s — grace knows this. When the scale stalls, she'll help you spot whether it's a real plateau (steady protein, consistent strength training, good sleep) or a missing variable. No motivational platitudes — actual diagnostic questions.",
  },
  {
    q: "Will grace replace my doctor?",
    a: "Absolutely not. grace is a wellness companion — she'll never adjust your dose, diagnose a side effect, or override your prescriber. If something sounds clinically serious (severe pain, dehydration, anything she's unsure about), she'll tell you to call your doctor or go to urgent care. That's a firm boundary, by design.",
  },
  {
    q: "How much does it cost?",
    a: "Your first 3 days are completely free — no card required to start. After that, $12/month, less than a single GLP-1 co-pay. Cancel any time by texting STOP. No retention dark patterns.",
  },
  {
    q: "How is my information protected?",
    a: "Encrypted in transit and at rest. We never sell your data, never share it with insurers or employers, and never run ads against your messages. You can request full deletion any time by texting DELETE — your record is gone within 24 hours.",
  },
];

const FAQSection = () => (
  <section className="py-16 md:py-32 px-6 md:px-10">
    <div className="max-w-2xl mx-auto">
      <div className="text-center mb-10 md:mb-14">
        <span className="block text-xs uppercase tracking-[0.2em] text-muted-foreground/60 font-semibold mb-3">
          Questions
        </span>
        <h2 className="font-serif text-2xl md:text-4xl text-foreground tracking-tight">
          Everything you might wonder.
        </h2>
      </div>

      <Accordion type="single" collapsible className="space-y-2 md:space-y-3">
        {FAQS.map((faq, i) => (
          <AccordionItem
            key={i}
            value={`faq-${i}`}
            className="rounded-xl md:rounded-2xl bg-card ring-1 ring-border/40 px-5 md:px-8 border-none"
          >
            <AccordionTrigger className="text-left text-sm md:text-lg font-medium text-foreground py-4 md:py-5 hover:no-underline">
              {faq.q}
            </AccordionTrigger>
            <AccordionContent className="text-muted-foreground leading-relaxed pb-4 md:pb-5 text-sm md:text-base">
              {faq.a}
            </AccordionContent>
          </AccordionItem>
        ))}
      </Accordion>
    </div>
  </section>
);

export default FAQSection;
