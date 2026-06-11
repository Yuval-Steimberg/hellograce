// Specific-food fit evaluation — deterministic, diet-aware.
//
// Production failure (2026-06-11 WhatsApp): "How about burger for dinner?" →
// curated meal bank shipped four unrelated meals (lentil dal, chickpea curry…).
// The user asked about a SPECIFIC food; the recommendation generator overrode
// the direct question. Intent hierarchy fix: when the user asks about a
// particular food, answer about THAT food first — can it fit, how to make it
// GLP-1 friendly — never replace it with unrelated suggestions.
//
// Runs BEFORE the curated bank in handleFoodQuestionDirect and inside the
// resilient fallback, so the behavior is identical whether Gemini is up or not.

export interface FoodFitEntry {
  /** Omnivore answer: can it fit + GLP-1-friendly version. */
  answer: string;
  /** Replacement answer when the user is vegetarian/vegan and the food is meat-based. */
  plantAnswer?: string;
  /** True when the food contains meat/fish (triggers plantAnswer). */
  meatBased?: boolean;
}

const FOOD_FIT: Record<string, FoodFitEntry> = {
  burger: {
    answer: "A burger can absolutely work. Go for a lean beef or chicken patty, load it with veggies, and consider a smaller bun or half the fries. Protein first, stop when comfortably full.",
    plantAnswer: "A burger can work — go for a bean or veggie patty, add plenty of veggies, and keep the bun or fries on the smaller side. Protein first, stop when comfortably full.",
    meatBased: true,
  },
  pizza: {
    answer: "Pizza can fit. One or two slices with a protein topping (chicken, extra cheese) plus a side salad beats half a pie — GLP-1 fullness usually kicks in faster than you expect anyway.",
  },
  pasta: {
    answer: "Pasta works — keep the portion to about a cup, add a real protein (chicken, shrimp, or white beans), and you've got a balanced plate. Tomato-based sauces sit lighter than cream on most stomachs.",
    plantAnswer: "Pasta works — keep the portion to about a cup and add white beans, lentils, or tofu for protein. Tomato-based sauces sit lighter than cream on most stomachs.",
  },
  fries: {
    answer: "Fries are fine as a side, not the star. Pair a small portion with a solid protein so the meal still moves you toward your target.",
  },
  steak: {
    answer: "Steak is a great pick — high protein, very GLP-1 friendly. A 4-6 oz cut with roasted veg covers a big chunk of your daily protein in one plate.",
    plantAnswer: "Since you're plant-based, a portobello steak or grilled tempeh hits a similar spot — pair with roasted veg and you're set.",
    meatBased: true,
  },
  sushi: {
    answer: "Sushi works well. Sashimi and fish-forward rolls give you the most protein per bite; go easy on tempura and heavy mayo rolls if your stomach's been sensitive.",
    plantAnswer: "Veggie rolls work — add edamame or inari for protein, and miso soup sits gently. Go easy on tempura if your stomach's been sensitive.",
    meatBased: true,
  },
  taco: {
    answer: "Tacos can fit nicely. Two with a protein filling (chicken, steak, fish, or beans), heavier on the filling than the shell, and you're in good shape.",
    plantAnswer: "Tacos can fit nicely — two with black beans or lentil filling, heavier on the filling than the shell, and you're in good shape.",
  },
  burrito: {
    answer: "A burrito can work — bowl form (skip the tortilla) stretches further on protein and sits lighter. Double protein, light on rice, and you're set.",
  },
  sandwich: {
    answer: "A sandwich is a solid choice. Pile the protein (turkey, chicken, tuna, or egg), add veg, and consider open-faced if bread fills you up fast these days.",
    plantAnswer: "A sandwich is a solid choice — hummus, grilled tofu, or egg (if you eat them) with plenty of veg. Open-faced works well if bread fills you up fast these days.",
    meatBased: true,
  },
  'ice cream': {
    answer: "Ice cream's fine as a treat — a small bowl, eaten slowly, ideally after some protein so it doesn't spike-and-crash. High-protein frozen yogurt is a nice middle ground if you want it more often.",
  },
  chocolate: {
    answer: "Chocolate is fine in moderation — a square or two of dark after a meal is the easiest way to enjoy it without it running the show.",
  },
  cake: {
    answer: "Cake can fit — a small slice, ideally after protein, enjoyed slowly. One planned treat beats grazing on it later.",
  },
  donut: {
    answer: "A donut now and then is fine — have it after some protein rather than on an empty stomach, and one usually satisfies more than you'd expect on a GLP-1.",
  },
  ramen: {
    answer: "Ramen can fit — add an egg or extra chicken/pork for protein, go lighter on the noodles, and the broth is actually great for hydration.",
    plantAnswer: "Ramen can fit — add tofu and extra veg for protein, go lighter on the noodles, and the broth is great for hydration.",
  },
  'fast food': {
    answer: "Fast food can fit if you anchor on protein: grilled chicken sandwich or burger patty, skip or split the fries, water or diet drink. One decent choice beats skipping the meal entirely.",
  },
};

// Aliases → canonical key.
const ALIASES: Record<string, string> = {
  burgers: 'burger', cheeseburger: 'burger', hamburger: 'burger',
  pizzas: 'pizza', 'slice of pizza': 'pizza',
  tacos: 'taco', burritos: 'burrito', sandwiches: 'sandwich',
  donuts: 'donut', doughnut: 'donut', doughnuts: 'donut',
  spaghetti: 'pasta', noodles: 'pasta', lasagna: 'pasta',
  'french fries': 'fries', chips: 'fries',
  'mcdonalds': 'fast food', "mcdonald's": 'fast food', kfc: 'fast food',
  takeout: 'fast food', 'take out': 'fast food',
};

// Consideration framing — same family as vague-food's CONSIDERATION_RE.
const ASKING_ABOUT_RE =
  /\b(how about|what about|thinking (?:about|of)|considering|can i (?:have|eat|get|order)|could i (?:have|eat|get)|should i (?:have|eat|get|order|try)|is (?:it ok|.{0,24}(?:ok|okay|fine|good|bad|healthy|allowed|alright))|what if i|craving|i want|fancy|in the mood for)\b/i;

/**
 * If the message is asking about a SPECIFIC food ("how about burger for
 * dinner?", "can I have pizza?"), return a direct food-fit answer for that
 * food (diet-aware). Returns null when no specific food is being asked about —
 * caller proceeds to general recommendations.
 */
export function buildFoodFitAnswer(
  text: string,
  opts: { dietLabel?: string | null } = {},
): string | null {
  const lower = text.toLowerCase();
  if (!ASKING_ABOUT_RE.test(lower)) return null;

  let entry: FoodFitEntry | null = null;
  // Longest-key-first so "ice cream" wins over hypothetical "cream".
  const keys = [...Object.keys(FOOD_FIT), ...Object.keys(ALIASES)].sort((a, b) => b.length - a.length);
  for (const k of keys) {
    const re = new RegExp(`\\b${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    if (re.test(lower)) {
      entry = FOOD_FIT[ALIASES[k] ?? k] ?? null;
      break;
    }
  }
  if (!entry) return null;

  const diet = (opts.dietLabel ?? '').toLowerCase();
  const plantBased = diet === 'vegan' || diet === 'vegetarian';
  if (plantBased && entry.plantAnswer) return entry.plantAnswer;
  if (plantBased && entry.meatBased) {
    return "That one's meat-based, but a bean or veggie version scratches the same itch — want me to suggest a plant take on it?";
  }
  return entry.answer;
}
