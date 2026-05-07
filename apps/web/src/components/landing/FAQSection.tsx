import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";

const FAQS = [
  {
    q: "Do I need to download an app?",
    a: "Not at all. grace works entirely through SMS — plain text messages on the phone you already carry. No app, no login, no password to remember.",
  },
  {
    q: "What kind of texts will I receive?",
    a: "Personalized daily check-ins based on your goals, your schedule, and what you've shared with us. Morning hydration prompts, meal ideas using foods you actually like, encouragement when you're having a tough day, and injection-day reminders. Every message is written for you — grace remembers your history and adapts over time.",
  },
  {
    q: "Does grace really remember what I tell it?",
    a: "Yes. grace learns from every conversation — your food preferences, how you've been feeling, what's working and what isn't. Over time, your messages become more and more tailored to you. It's like texting a friend who actually pays attention.",
  },
  {
    q: "What if I'm having a rough day?",
    a: "That's exactly when grace shows up. If you share that you're struggling, grace adjusts — offering gentler check-ins, lighter suggestions, and genuine encouragement. We're here to cheer you on, not pile on more to-dos.",
  },
  {
    q: "Is this medical advice?",
    a: "No. grace is a wellness companion, not a medical provider. We offer supportive reminders about hydration, protein, and how you're feeling — but always encourage you to follow your doctor's guidance.",
  },
  {
    q: "How much does it cost?",
    a: "Your first 3 days are completely free. After that, grace is $12/month — less than a single co-pay. Cancel anytime with a simple text.",
  },
  {
    q: "Can I pause or stop the texts?",
    a: "Of course. Reply PAUSE at any time to take a break, or STOP to cancel entirely. We respect your space — always.",
  },
  {
    q: "How is my information protected?",
    a: "Your phone number and responses are encrypted and never shared with third parties. We don't sell data, run ads, or ask you to perform your health for an audience.",
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
