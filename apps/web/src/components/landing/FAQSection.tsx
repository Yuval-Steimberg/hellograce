import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";

const FAQS = [
  {
    q: "Which GLP-1 medications does Grace support?",
    a: "Wegovy and Ozempic (semaglutide), Mounjaro and Zepbound (tirzepatide), Saxenda (liraglutide), and compounded semaglutide/tirzepatide from any reputable pharmacy. Grace knows the dose ladders, the typical side-effect timelines, and the differences between them.",
  },
  {
    q: "Do I need to download an app?",
    a: "No. Grace lives in WhatsApp (or SMS where WhatsApp isn't available) — the messaging app already on your phone. No login, no password, nothing new to manage.",
  },
  {
    q: "How does Grace help with food and protein?",
    a: "Just text what you ate, or send a photo. Grace estimates the protein and calories, logs it, and tells you what you have left for the day against your personal target — no spreadsheets, no calorie-counting app.",
  },
  {
    q: "What happens on my injection day?",
    a: "Grace texts you a quick morning prep (hydration, lighter meals, ginger if nausea hit last time), checks in after you've dosed, and follows up the next day. If you flag a side effect, she circles back a few hours later — right when most people need it.",
  },
  {
    q: "Can Grace help with nausea, fatigue, or constipation?",
    a: "Yes — and she remembers what worked for you last time. Practical, GLP-1-aware suggestions for the common side effects, plus a clear nudge to call your doctor when something needs a professional.",
  },
  {
    q: "Does Grace really remember my history?",
    a: "Yes. Your goals, current dose week, the foods that make you queasy, what you actually eat, your last weigh-in — every reply is shaped by that context. Generic check-ins are the one thing she won't do.",
  },
  {
    q: "Will Grace replace my doctor?",
    a: "No — and she's clear about that. Grace is a wellness companion for the day-to-day. She'll never adjust your dose or diagnose a problem, and if anything sounds clinically serious she'll tell you to contact your doctor or urgent care. It's support between appointments, not medical care.",
  },
  {
    q: "How much does it cost?",
    a: "Your first 3 days are free — no card required to start. After that it's $12/month, less than a single GLP-1 co-pay. Cancel any time by texting STOP. No retention dark patterns.",
  },
  {
    q: "How is my information protected?",
    a: "Encrypted in transit and at rest. We never sell your data, never share it with insurers or employers, and never run ads against your messages. You can request full deletion any time by texting DELETE.",
  },
];

const FAQSection = () => (
  <section id="faq" className="py-20 md:py-32 px-6 md:px-10">
    <div className="max-w-2xl mx-auto">
      <div className="text-center mb-12 md:mb-16">
        <span className="grace-chip mb-5">Questions</span>
        <h2 className="text-3xl md:text-5xl font-extrabold tracking-tight text-foreground leading-[1.08]">
          Everything you{" "}
          <span className="font-serif italic font-medium grace-gradient-text">might wonder.</span>
        </h2>
      </div>

      <Accordion type="single" collapsible className="space-y-3">
        {FAQS.map((faq, i) => (
          <AccordionItem
            key={i}
            value={`faq-${i}`}
            className="grace-card px-5 md:px-7 border-none data-[state=open]:border-accent/30"
          >
            <AccordionTrigger className="text-left text-[15px] md:text-lg font-bold text-foreground py-5 hover:no-underline">
              {faq.q}
            </AccordionTrigger>
            <AccordionContent className="text-muted-foreground leading-relaxed pb-5 text-[15px] md:text-base">
              {faq.a}
            </AccordionContent>
          </AccordionItem>
        ))}
      </Accordion>
    </div>
  </section>
);

export default FAQSection;
