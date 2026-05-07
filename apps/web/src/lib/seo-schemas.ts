const BASE_URL = "https://graceglp.com";

export const organizationSchema = {
  "@context": "https://schema.org",
  "@type": "Organization",
  name: "grace",
  legalName: "STEIMBROS, LLC",
  url: BASE_URL,
  logo: `${BASE_URL}/og-image.png`,
  description:
    "grace is a personalized SMS companion for people on GLP-1 medications like Ozempic, Wegovy, Mounjaro, and Zepbound.",
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
    "Your daily GLP-1 text companion. Personalized SMS check-ins for hydration, meals, injection reminders, and emotional support.",
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
  applicationSubCategory: "Weight Loss Support",
  operatingSystem: "SMS",
  description:
    "A daily SMS companion for GLP-1 weight loss journeys. Personalized check-ins, protein tracking, injection reminders, and emotional support — all via text message.",
  url: BASE_URL,
  offers: {
    "@type": "Offer",
    price: "0",
    priceCurrency: "USD",
    description: "Free 7-day trial, then $12/month",
    priceValidUntil: new Date(new Date().getFullYear() + 1, 0, 1).toISOString().split("T")[0],
  },
  aggregateRating: {
    "@type": "AggregateRating",
    ratingValue: "4.9",
    ratingCount: "12000",
    bestRating: "5",
    worstRating: "1",
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
    "Personalized morning check-ins",
    "Hydration reminders",
    "Protein tracking suggestions",
    "Injection day reminders",
    "Evening wind-down messages",
    "Adaptive emotional support",
    "Weekly milestone summaries",
    "No app required — SMS only",
  ],
  keywords:
    "GLP-1, Ozempic, Wegovy, Mounjaro, Zepbound, weight loss, SMS companion, text buddy, daily check-in, hydration, protein tracking, injection reminder",
};

export const faqSchema = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: [
    {
      "@type": "Question",
      name: "Do I need to download an app?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "Not at all. grace works entirely through SMS — plain text messages on the phone you already carry. No app, no login, no password to remember.",
      },
    },
    {
      "@type": "Question",
      name: "What kind of texts will I receive from grace?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "Personalized daily check-ins based on your goals, your schedule, and what you've shared with us. Morning hydration prompts, meal ideas using foods you actually like, encouragement when you're having a tough day, and injection-day reminders.",
      },
    },
    {
      "@type": "Question",
      name: "Does grace really remember what I tell it?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "Yes. grace learns from every conversation — your food preferences, how you've been feeling, what's working and what isn't. Over time, your messages become more and more tailored to you.",
      },
    },
    {
      "@type": "Question",
      name: "What if I'm having a rough day on GLP-1?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "That's exactly when grace shows up. If you share that you're struggling, grace adjusts — offering gentler check-ins, lighter suggestions, and genuine encouragement.",
      },
    },
    {
      "@type": "Question",
      name: "Is grace medical advice?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "No. grace is a wellness companion, not a medical provider. We offer supportive reminders about hydration, protein, and how you're feeling — but always encourage you to follow your doctor's guidance.",
      },
    },
    {
      "@type": "Question",
      name: "How much does grace cost?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "Your first 7 days are completely free. After that, grace is $12/month — less than a single co-pay. Cancel anytime with a simple text.",
      },
    },
    {
      "@type": "Question",
      name: "Can I pause or stop the texts?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "Of course. Reply PAUSE at any time to take a break, or STOP to cancel entirely. We respect your space — always.",
      },
    },
    {
      "@type": "Question",
      name: "How is my information protected?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "Your phone number and responses are encrypted and never shared with third parties. We don't sell data, run ads, or ask you to perform your health for an audience.",
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
          description: "7 days of free personalized GLP-1 text support",
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
