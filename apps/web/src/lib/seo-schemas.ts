const BASE_URL = (import.meta.env.VITE_SITE_URL || "https://graceglp.com").replace(/\/+$/, "");

export const organizationSchema = {
  "@context": "https://schema.org",
  "@type": "Organization",
  name: "grace",
  legalName: "STEIMBROS, LLC",
  url: BASE_URL,
  logo: `${BASE_URL}/og-image.png`,
  description:
    "grace is an all-in-one GLP-1 command center for people on Ozempic, Wegovy, Mounjaro, and Zepbound. Track medication, protein, water, weight, habits, and symptoms — with personalized targets, weekly insights, and injection-day check-ins — right inside iMessage, WhatsApp, or SMS.",
  sameAs: [],
  contactPoint: {
    "@type": "ContactPoint",
    contactType: "customer support",
    availableLanguage: "English",
  },
};

export const websiteSchema = {
  "@context": "https://schema.org",
  "@type": "WebSite",
  name: "grace",
  url: BASE_URL,
  description:
    "Your all-in-one GLP-1 companion. Track protein, water, weight, habits, symptoms, and your medication timeline — with personalized targets and weekly insights — through a simple daily chat and one dashboard.",
  publisher: {
    "@type": "Organization",
    name: "grace",
  },
};

export const softwareApplicationSchema = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "grace",
  applicationCategory: "HealthApplication",
  applicationSubCategory: "GLP-1 Support",
  operatingSystem: "iMessage, WhatsApp, SMS",
  description:
    "An all-in-one GLP-1 command center for Wegovy, Ozempic, Mounjaro, Zepbound and compounded sema/tirz. Personalized protein & calorie targets, food/water/weight/habit tracking, a medication & dose timeline, weekly insights and plateau signals, side-effect pattern memory, and injection-day support — all via iMessage, WhatsApp, or SMS, with one simple dashboard.",
  url: BASE_URL,
  offers: {
    "@type": "Offer",
    price: "0",
    priceCurrency: "USD",
    description: "Free 3-day trial, then $12/month",
    priceValidUntil: new Date(new Date().getFullYear() + 1, 0, 1).toISOString().split("T")[0],
  },
  audience: {
    "@type": "PeopleAudience",
    suggestedMinAge: 25,
    suggestedMaxAge: 75,
    healthCondition: {
      "@type": "MedicalCondition",
      name: "Obesity",
    },
  },
  featureList: [
    "All-in-one dashboard: protein, calories, water, weight, habits, symptoms",
    "Personalized protein & calorie targets from your weight and goals",
    "Food logging by text, voice note, or photo",
    "Quick daily habit checklist",
    "Water & hydration tracking",
    "Weight trends, weekly insights & plateau signals",
    "Medication & dose timeline",
    "Side-effect pattern memory (nausea, fatigue, constipation)",
    "Injection-day prep + day-after follow-up",
    "iMessage, WhatsApp + SMS — no app required",
  ],
  keywords:
    "GLP-1, Ozempic, Wegovy, Mounjaro, Zepbound, semaglutide, tirzepatide, weight loss, WhatsApp companion, injection day, nausea, protein, daily check-in",
};

export const faqSchema = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: [
    {
      "@type": "Question",
      name: "Which GLP-1 medications does Grace support?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "Wegovy and Ozempic (semaglutide), Mounjaro and Zepbound (tirzepatide), Saxenda (liraglutide), and compounded semaglutide/tirzepatide from any reputable pharmacy. Grace knows the dose ladders, the typical side-effect timelines, and the differences between them.",
      },
    },
    {
      "@type": "Question",
      name: "Do I need to download an app?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "No. Grace lives in WhatsApp (or SMS where WhatsApp isn't available) — the messaging app already on your phone. No login, no password, nothing new to manage.",
      },
    },
    {
      "@type": "Question",
      name: "How does Grace help with food and protein?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "Just text what you ate, or send a photo. Grace estimates the protein and calories, logs it, and tells you what you have left for the day against your personal target — no spreadsheets, no calorie-counting app.",
      },
    },
    {
      "@type": "Question",
      name: "What happens on my injection day?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "Grace texts you a quick morning prep (hydration, lighter meals, ginger if nausea hit last time), checks in after you've dosed, and follows up the next day. If you flag a side effect, she circles back a few hours later.",
      },
    },
    {
      "@type": "Question",
      name: "Can Grace help with nausea, fatigue, or constipation?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "Yes — and she remembers what worked for you last time. Practical, GLP-1-aware suggestions for the common side effects, plus a clear nudge to call your doctor when something needs a professional.",
      },
    },
    {
      "@type": "Question",
      name: "Does Grace really remember my history?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "Yes. Your goals, current dose week, the foods that make you queasy, what you actually eat, your last weigh-in — every reply is shaped by that context. Generic check-ins are the one thing she won't do.",
      },
    },
    {
      "@type": "Question",
      name: "Will Grace replace my doctor?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "No. Grace is a wellness companion for the day-to-day. She'll never adjust your dose or diagnose a problem, and if anything sounds clinically serious she'll tell you to contact your doctor or urgent care. It's support between appointments, not medical care.",
      },
    },
    {
      "@type": "Question",
      name: "How much does Grace cost?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "Your first 3 days are free — no card required to start. After that it's $12/month, less than a single GLP-1 co-pay. Cancel any time by texting STOP.",
      },
    },
    {
      "@type": "Question",
      name: "How is my information protected?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "Encrypted in transit and at rest. We never sell your data, never share it with insurers or employers, and never run ads against your messages. You can request full deletion any time by texting DELETE.",
      },
    },
  ],
};

export const breadcrumbSchema = (items: { name: string; path: string }[]) => ({
  "@context": "https://schema.org",
  "@type": "BreadcrumbList",
  itemListElement: items.map((item, index) => ({
    "@type": "ListItem",
    position: index + 1,
    name: item.name,
    item: `${BASE_URL}${item.path}`,
  })),
});

export const serviceSchema = {
  "@context": "https://schema.org",
  "@type": "Service",
  name: "grace GLP-1 Text Companion",
  provider: {
    "@type": "Organization",
    name: "STEIMBROS, LLC",
  },
  description:
    "Daily personalized SMS support for people taking GLP-1 medications like Ozempic, Wegovy, Mounjaro, and Zepbound. Includes hydration reminders, meal suggestions, injection tracking, and emotional support.",
  serviceType: "Wellness Support",
  areaServed: {
    "@type": "Country",
    name: "United States",
  },
  hasOfferCatalog: {
    "@type": "OfferCatalog",
    name: "grace Plans",
    itemListElement: [
      {
        "@type": "Offer",
        itemOffered: {
          "@type": "Service",
          name: "grace Free Trial",
          description: "3 days of free personalized GLP-1 text support",
        },
        price: "0",
        priceCurrency: "USD",
      },
      {
        "@type": "Offer",
        itemOffered: {
          "@type": "Service",
          name: "grace Monthly",
          description: "Unlimited personalized daily SMS check-ins",
        },
        price: "12",
        priceCurrency: "USD",
        billingIncrement: "P1M",
      },
    ],
  },
};
