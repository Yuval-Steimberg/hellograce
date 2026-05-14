const BASE_URL = "https://graceglp.com";

export const organizationSchema = {
  "@context": "https://schema.org",
  "@type": "Organization",
  name: "grace",
  legalName: "STEIMBROS, LLC",
  url: BASE_URL,
  logo: `${BASE_URL}/og-image.png`,
  description:
    "grace is a personalized WhatsApp companion for people on GLP-1 medications like Ozempic, Wegovy, Mounjaro, and Zepbound. Handles nausea, plateau weeks, protein math, and injection-day check-ins via text.",
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
    "Your daily GLP-1 companion on WhatsApp. Personalized check-ins for hydration, protein targets, injection days, and the dozen small questions GLP-1 throws at you.",
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
  operatingSystem: "WhatsApp, SMS",
  description:
    "A daily WhatsApp companion for GLP-1 protocols (Wegovy, Ozempic, Mounjaro, Zepbound, compounded sema/tirz). Side-effect coaching, protein math against goal weight, injection-day prep, plateau diagnostics — all via text.",
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
    "Side-effect coaching (nausea, fatigue, constipation)",
    "Injection-day prep + day-after follow-up",
    "Protein and hydration targets against your goal weight",
    "Plateau-week diagnostics",
    "Adaptive emotional support",
    "Dose-week awareness across all GLP-1 medications",
    "WhatsApp + SMS — no app required",
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
      name: "Which GLP-1 medications does grace support?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "Wegovy and Ozempic (semaglutide), Mounjaro and Zepbound (tirzepatide), Saxenda (liraglutide), and compounded semaglutide/tirzepatide from any reputable pharmacy. grace knows the dose ladders, the typical side-effect timelines, and the protocol differences between them.",
      },
    },
    {
      "@type": "Question",
      name: "Do I need to download an app?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "No. grace lives in WhatsApp (or SMS where WhatsApp isn't available). It's the messaging app on the phone you already carry — no login, no password, no notifications to manage.",
      },
    },
    {
      "@type": "Question",
      name: "What happens on my injection day?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "grace texts you in the morning with a quick prep ritual (hydration target, lighter meals, ginger if nausea hit last time). She checks in after you've dosed, then again the next day to see how you're feeling. If you flag a side effect, she follows up 4 hours later.",
      },
    },
    {
      "@type": "Question",
      name: "Can grace help with nausea, fatigue, or constipation?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "Yes — and she remembers what worked last time. Plain crackers and ginger tea on day-after nausea. Magnesium citrate at night for constipation. Electrolytes when fatigue spikes. She'll never tell you to push through — only what's reasonable, and when to call your doctor.",
      },
    },
    {
      "@type": "Question",
      name: "Does grace remember my history, or is it generic?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "She remembers everything you share — your goal weight, current dose week, the foods that make you queasy, which protein sources you actually eat, your last weigh-in, and whether you flagged a side effect this week. Every reply is shaped by that context.",
      },
    },
    {
      "@type": "Question",
      name: "Will grace replace my doctor?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "No. grace is a wellness companion — she'll never adjust your dose, diagnose a side effect, or override your prescriber. If something sounds clinically serious, she'll tell you to call your doctor or go to urgent care.",
      },
    },
    {
      "@type": "Question",
      name: "How much does grace cost?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "Your first 3 days are completely free — no card required to start. After that, $12/month, less than a single GLP-1 co-pay. Cancel any time by texting STOP.",
      },
    },
    {
      "@type": "Question",
      name: "How is my information protected?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "Encrypted in transit and at rest. We never sell your data, never share it with insurers or employers, and never run ads against your messages. You can request full deletion any time by texting DELETE — your record is gone within 24 hours.",
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
