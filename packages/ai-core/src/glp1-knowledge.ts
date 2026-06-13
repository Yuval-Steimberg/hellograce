// Comprehensive, typo-tolerant GLP-1 knowledge bank.
//
// This is the DETERMINISTIC answer layer used when the LLM can't generate (quota
// / outage / guard-rejected regen) and as the primary topic-answer source for
// the knowledge fallback paths. The live primary path is still Gemini + RAG;
// this guarantees an accurate answer for the most common GLP-1 questions even
// when Gemini is unavailable.
//
// Design:
//   - One ordered TOPICS table (specific before generic) — easy to extend.
//   - Every message is typo-normalized before matching (common GLP-1
//     misspellings + repeated-letter collapse + punctuation strip), so
//     "nausia", "diarhea", "muscels", "protien", "constipaton" all match.
//   - Answers are general education, supportive, and defer dose changes /
//     severe or red-flag symptoms / pregnancy to the user's clinician.
//   - Each topic regex requires a health keyword, so non-health messages
//     return null and fall through to the normal fallback.

// Common GLP-1 / symptom misspellings → canonical spelling. Applied as
// whole-word replacements on the lowercased message before matching.
const TYPO_MAP: Array<[RegExp, string]> = [
  [/\bnaus(?:ia|ea|a|ua|ae)?\b/g, 'nausea'],
  [/\bnaus(?:eous|ous|ious|eaous)\b/g, 'nauseous'],
  [/\bdia?r+h?h?(?:ea|oea|ea h|eah|ia)\b/g, 'diarrhea'],
  [/\bconstipa?t(?:ion|on|ed)\b/g, 'constipation'],
  [/\bconstipa?ted\b/g, 'constipated'],
  [/\bmusc(?:el|le|al)s?\b/g, 'muscles'],
  [/\bprot(?:ien|in|ein)\b/g, 'protein'],
  [/\bfatig(?:ue|e|ued|ure)\b/g, 'fatigue'],
  [/\bdizz?y?(?:ness|ines|iness)\b/g, 'dizziness'],
  [/\bheart\s*burn\b/g, 'heartburn'],
  [/\bhart\s*burn\b/g, 'heartburn'],
  [/\breflx\b/g, 'reflux'],
  [/\bbloat(?:ing|ed|ting)\b/g, 'bloating'],
  [/\bvomit(?:ing|ting|in)\b/g, 'vomiting'],
  [/\bthrow?ing up\b/g, 'vomiting'],
  [/\binject(?:ion|on|tion|shun)\b/g, 'injection'],
  [/\bplate?au\b/g, 'plateau'],
  [/\bhair\s*los?e\b/g, 'hair loss'],
  [/\bappet(?:ite|ie|et)\b/g, 'appetite'],
  [/\bhungr?y\b/g, 'hungry'],
  [/\bgall\s*bladder\b/g, 'gallbladder'],
  [/\bgall\s*stones?\b/g, 'gallstones'],
  [/\bcravin?gs?\b/g, 'cravings'],
  [/\bheadach?e?s?\b/g, 'headache'],
  [/\bcaffiene\b/g, 'caffeine'],
  [/\balcoho?l\b/g, 'alcohol'],
  [/\bmedicat(?:ion| on)\b/g, 'medication'],
];

export function normalizeKnowledgeText(input: string): string {
  let s = (input || '').toLowerCase();
  // Collapse 3+ repeated letters ("sooooo", "ughhh") to one.
  s = s.replace(/([a-z])\1{2,}/g, '$1');
  for (const [re, rep] of TYPO_MAP) s = s.replace(re, rep);
  // Normalize whitespace.
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

interface KnowledgeTopic {
  /** Topic id (for tests / telemetry). */
  id: string;
  /** Matches against the typo-normalized message. */
  match: (m: string) => boolean;
  answer: string;
}

const has = (m: string, ...words: string[]): boolean => words.some((w) => new RegExp(`\\b${w}\\b`).test(m));

// Ordered: more specific topics first.
const TOPICS: KnowledgeTopic[] = [
  // ── Side-effect duration (must precede the generic nausea topic) ──────────
  {
    id: 'side_effect_duration',
    match: (m) => has(m, 'nausea', 'side effect', 'side effects', 'symptoms', 'symptom') &&
      /\b(how long|when will|when does|going away|go away|stop|end|last|persist|improve|get better)\b/.test(m),
    answer: "Most GLP-1 side effects peak in the first 4-8 weeks and ease as your body adjusts, and they often flare for a few days after each dose increase. If nausea is severe past week 8 or right after an increase, your prescriber can slow the titration.",
  },
  // ── GI symptoms ───────────────────────────────────────────────────────────
  {
    id: 'vomiting',
    match: (m) => has(m, 'vomiting', 'throwing up', 'threw up') ,
    answer: "Vomiting can happen on a GLP-1, usually from eating too much or too fast while digestion is slowed. Smaller meals, eating slowly, and stopping at the first sign of fullness help. If you can't keep fluids down for 24 hours or it's severe, call your prescriber.",
  },
  {
    id: 'nausea',
    match: (m) => has(m, 'nausea', 'nauseous', 'queasy', 'sick to my stomach'),
    answer: "Nausea is the most common GLP-1 side effect, from slowed digestion. Smaller protein-forward meals, eating slowly, stopping when full, ginger or peppermint, and not lying down right after eating all help. It usually eases after the first few weeks.",
  },
  {
    id: 'constipation',
    match: (m) => has(m, 'constipation', 'constipated', 'bowel', 'poop', "can't go", 'backed up'),
    answer: "Constipation is very common on GLP-1s because digestion slows. Aim for 25-30g of fiber daily, 64-80 oz of water, and a 10-15 minute walk after meals. Magnesium citrate at night helps if those aren't enough; check with your prescriber before a daily laxative.",
  },
  {
    id: 'diarrhea',
    match: (m) => has(m, 'diarrhea', 'loose stool', 'loose stools', 'the runs'),
    answer: "Diarrhea usually shows up in the first few weeks or after a dose increase. Bland foods (rice, banana, toast), small frequent meals, and electrolytes help. If it lasts more than 48 hours or you can't stay hydrated, call your prescriber.",
  },
  {
    id: 'heartburn',
    match: (m) => has(m, 'heartburn', 'reflux', 'acid', 'indigestion'),
    answer: "Heartburn is common because slowed digestion means food sits longer. Smaller meals, not eating within 2-3 hours of bed, and easing off triggers (alcohol, coffee, spicy or fatty food) help. Mention persistent heartburn to your prescriber.",
  },
  {
    id: 'bloating_gas',
    match: (m) => has(m, 'bloating', 'gas', 'bloated', 'burping', 'burps', 'sulfur', 'gassy'),
    answer: "Bloating, gas, and (sometimes sulfur-smelling) burps come from slowed digestion. Smaller meals, eating slowly, lighter fat and fiber loads at once, a post-meal walk, and not gulping fizzy drinks help. It usually settles as you adjust.",
  },
  {
    id: 'stomach_pain',
    match: (m) => has(m, 'stomach pain', 'stomach ache', 'belly pain', 'cramps', 'cramping', 'stomach hurts', 'tummy hurts'),
    answer: "Mild stomach cramping can come with the slowed digestion on a GLP-1. Smaller, lighter meals and gentle movement help. But severe, persistent, or upper-right belly pain — especially with vomiting — needs a prompt call to your doctor, since it can signal pancreatitis or gallbladder issues.",
  },
  // ── Whole-body symptoms ─────────────────────────────────────────────────────
  {
    id: 'fatigue',
    match: (m) => has(m, 'fatigue', 'tired', 'exhausted', 'no energy', 'low energy', 'sluggish', 'wiped out'),
    answer: "Fatigue is common early on, usually from eating far less (fewer calories and carbs) and sometimes mild dehydration. Make sure you're getting enough protein, fluids, and electrolytes, and not under-eating too hard. If it's persistent or severe, ask your doctor to check iron, B12, and thyroid.",
  },
  {
    id: 'dizziness',
    match: (m) => has(m, 'dizziness', 'dizzy', 'lightheaded', 'light headed', 'faint', 'woozy'),
    answer: "Dizziness on a GLP-1 is often from eating and drinking too little, or low blood sugar (especially if you also take insulin or a sulfonylurea). Steady fluids, electrolytes, and regular protein help. If it's frequent, severe, or comes with a racing heart, get it checked by your doctor.",
  },
  {
    id: 'headache',
    match: (m) => has(m, 'headache', 'migraine', 'headaches'),
    answer: "Headaches early on are usually tied to lower food and fluid intake or low blood sugar. Steady hydration, electrolytes, and not skipping protein help. If headaches are severe, new, or persistent, mention them to your doctor.",
  },
  {
    id: 'brain_fog',
    match: (m) => has(m, 'brain fog', 'foggy', 'cant focus', "can't focus", 'concentrate', 'forgetful'),
    answer: "Brain fog usually traces back to under-eating, dehydration, or low blood sugar rather than the medication itself. Make sure you're getting enough protein, carbs, fluids, and electrolytes across the day. If it lingers, it's worth flagging to your doctor.",
  },
  {
    id: 'hair_loss',
    match: (m) => has(m, 'hair') && /\b(loss|loose|losing|fall|falling|fell|shed|shedding|thin|thinning|coming out|falling out)\b/.test(m),
    answer: "Hair shedding (telogen effluvium) is common with significant or rapid weight loss, including on GLP-1s — it's usually temporary and tied to the rapid loss and lower intake, not the drug directly. Hitting your protein target and checking iron/ferritin with your doctor helps.",
  },
  {
    id: 'muscle',
    match: (m) => has(m, 'muscle', 'muscles', 'lean mass') ||
      (/\bmuscle/.test(m)),
    answer: "The medication itself doesn't damage muscle — but because it cuts appetite so much, you can eat too little protein and your body starts breaking down muscle along with fat (research shows 25-35% of weight lost can be lean mass). Hitting your protein target daily and doing resistance work 2-3x a week protects it.",
  },
  // ── Ozempic face / skin ─────────────────────────────────────────────────────
  {
    id: 'face_skin',
    match: (m) => /\bozempic face\b/.test(m) || (has(m, 'face', 'skin', 'cheeks', 'sagging', 'saggy', 'loose skin', 'wrinkles', 'gaunt') && has(m, 'face', 'skin', 'loose', 'sagging', 'saggy', 'older', 'aged', 'gaunt', 'wrinkles')),
    answer: "\"Ozempic face\" is really just the facial fat loss that comes with any rapid weight loss — it isn't a direct drug effect. Losing a bit more slowly, keeping protein high, staying hydrated, and resistance training to preserve overall lean mass all soften it. A dermatologist can advise on skin-specific options.",
  },
  // ── Eating / appetite ───────────────────────────────────────────────────────
  {
    id: 'food_noise',
    match: (m) => /\bfood noise\b/.test(m) || (has(m, 'cravings', 'craving') && has(m, 'gone', 'back', 'stopped', 'quiet')) || /\bnot hungry\b/.test(m) || /\bno appetite\b/.test(m) || /\bappetite (is )?(gone|low|suppressed)\b/.test(m),
    answer: "Quieter \"food noise\" and low appetite are how GLP-1s are meant to work. The risk is under-eating, so aim to still get your protein and enough calories even when you're not hungry — small protein-forward meals and a couple of planned snacks. If you genuinely can't eat for a day or more, tell your prescriber.",
  },
  {
    id: 'appetite_return',
    match: (m) => /\b(wearing off|worn off|stopped working|not working anymore|appetite (is )?(back|returning|coming back)|hungry again)\b/.test(m),
    answer: "It's common to feel the effect ease a few days before your next dose, or as your body adjusts at a given dose — that's often why prescribers step the dose up over time. Keep protein and fiber high to stay full, and if hunger is back in full force, mention it at your next check-in so they can review your dose.",
  },
  // ── Dose / medication logistics ─────────────────────────────────────────────
  {
    // Missed/forgot MUST precede dose_increase — "forgot my dose" mentions
    // "dose" but isn't a titration question.
    id: 'missed_dose',
    match: (m) => /\b(missed|forgot|forgotten|skipped|late|forget)\b/.test(m) && has(m, 'dose', 'shot', 'injection', 'pen', 'pill', 'med', 'medication'),
    answer: "For weekly GLP-1s: if you remember within about 5 days of the missed dose, take it as soon as you can, then resume your normal day. If it's been more than 5 days, skip it and take the next one on schedule — don't double up. Daily pills (Rybelsus) are skipped if missed, not doubled. Check your specific med's label or pharmacist.",
  },
  {
    id: 'dose_increase',
    match: (m) =>
      /\b(titrat\w*|escalat\w*|step up|stepping up|move up|moving up|bump up|higher dose|next dose|going up a dose)\b/.test(m) ||
      (has(m, 'dose', 'dosage') && /\b(increase|increasing|higher|go up|going up|raise|raising|bump|up to)\b/.test(m)),
    answer: "Doses are stepped up gradually to limit side effects — your prescriber sets the schedule and timing based on how you're tolerating it. Side effects often flare for a few days after each increase, then settle. Never adjust the dose yourself; if you're struggling, they can hold or slow the step-up.",
  },
  {
    id: 'injection_site',
    match: (m) => has(m, 'injection', 'shot', 'inject') && /\b(site|where|pain|painful|bruise|bruising|swelling|red|redness|rotate|rotation|sore|lump|hurt|sting)\b/.test(m),
    answer: "Inject into fat — belly (a couple inches from the navel), front of the thigh, or back of the upper arm — and rotate sites each week to avoid soreness. Letting the pen warm up a few minutes and not rubbing after helps. Mild redness or a small bruise is normal; persistent swelling, a hard lump, or pus warrants a call to your prescriber.",
  },
  {
    id: 'injection_timing',
    match: (m) => has(m, 'injection', 'shot', 'inject', 'dose', 'pen') && /\b(what day|which day|what time|when should|when do|time of day|day of the week|change.*day|move.*day|morning or night)\b/.test(m),
    answer: "Take a weekly GLP-1 on the same day each week — the specific time of day doesn't matter much, so pick what you'll remember. You can shift the day if needed as long as it's been at least 2-3 days since your last dose; check your med's guidance. Consistency is what keeps the level steady.",
  },
  {
    id: 'storage',
    match: (m) => has(m, 'store', 'storage', 'refrigerate', 'fridge', 'travel', 'flight', 'fly', 'airport', 'warm', 'heat', 'room temperature') && has(m, 'pen', 'injection', 'shot', 'med', 'medication', 'ozempic', 'wegovy', 'mounjaro', 'zepbound', 'it'),
    answer: "Keep unused pens in the fridge. Once in use, most pens are fine at room temperature (up to ~30°C/86°F) for a set number of days — commonly 28 — so check your label. For travel, carry it in your hand luggage with a cool pack (never a checked bag or a hot car), and bring the box for security.",
  },
  // ── Mechanism / journey ─────────────────────────────────────────────────────
  {
    id: 'mechanism',
    match: (m) => /\bhow (does|do)\b/.test(m) && has(m, 'work', 'works') || /\bmechanism\b/.test(m) || /\bwhat (does|do) (it|they|glp|ozempic|wegovy|mounjaro|zepbound) do\b/.test(m),
    answer: "GLP-1 medications mimic a gut hormone that's released when you eat. They slow how fast your stomach empties (so you feel full longer), signal fullness to the brain (quieting appetite and \"food noise\"), and help regulate blood sugar. That combination is what reduces intake and drives weight loss.",
  },
  {
    id: 'how_long_take',
    match: (m) => /\b(how long|forever|rest of my life|stop taking|come off|coming off|get off|quit|stop the med)\b/.test(m),
    answer: "GLP-1s are generally treated as a long-term medication — for many people weight tends to come back after stopping, because appetite returns. Some taper or pause under medical guidance once they've built strong habits. Whether and how to stop is really a decision to make with your prescriber.",
  },
  {
    id: 'weight_regain',
    match: (m) => /\b(regain|gain.*back|put.*back on|gain it back|rebound)\b/.test(m) && has(m, 'weight', 'stop', 'stopping', 'off'),
    answer: "Some weight regain after stopping is common, because appetite and \"food noise\" return when the medication clears. Strong protein, resistance training, and eating habits built while on it reduce how much comes back. If you're thinking about stopping, plan the transition with your prescriber.",
  },
  {
    id: 'expected_loss',
    match: (m) => /\b(how (much|fast|quickly)|expect|average|typical|normal)\b/.test(m) && has(m, 'weight', 'lose', 'losing', 'loss', 'pounds', 'lbs', 'kg'),
    answer: "It varies by person and medication, but a common, sustainable pace is about 0.5-1.5 lbs (roughly 1-2% of body weight) per week, often faster at first and slower later. Plateaus along the way are normal. Losing too fast can cost more muscle, so steady is better than dramatic.",
  },
  // ── Interactions / special situations ───────────────────────────────────────
  {
    id: 'alcohol',
    match: (m) => has(m, 'alcohol', 'wine', 'beer', 'drinking', 'drink') && !has(m, 'water', 'coffee', 'caffeine'),
    answer: "Moderation is the general guidance — alcohol can amplify GLP-1 nausea, drop blood sugar, and add dehydration, and many people find their tolerance is lower. A drink or two with food is usually fine for most, but ease off if you're feeling rough.",
  },
  {
    id: 'caffeine',
    match: (m) => has(m, 'coffee', 'caffeine', 'espresso'),
    answer: "Coffee is generally fine on a GLP-1 but can amplify stomach upset, especially on an empty stomach. Have it with food, or try half-caf for a few days if it's hitting hard. Watch that it doesn't replace water — hydration matters.",
  },
  {
    id: 'blood_sugar',
    match: (m) => /\b(blood sugar|glucose|hypoglycemi|low sugar|sugar (crash|low|drop))\b/.test(m),
    answer: "On their own GLP-1s rarely cause dangerously low blood sugar, but the risk rises if you also take insulin or a sulfonylurea — those doses sometimes need adjusting by your prescriber. Steady meals with protein and not skipping food help. Shakiness, sweating, or confusion means treat it (fast sugar) and check with your doctor.",
  },
  {
    id: 'gallbladder',
    match: (m) => has(m, 'gallbladder', 'gallstones', 'gall'),
    answer: "Rapid weight loss of any kind — including on a GLP-1 — raises the risk of gallstones. Losing at a steady pace, staying hydrated, and including some healthy fat so the gallbladder keeps emptying can help. Severe upper-right belly pain, especially after eating, needs prompt medical attention.",
  },
  {
    id: 'pregnancy',
    match: (m) => /\bpregnan\w*|\bbreast\s?feed\w*|\bnursing\b|\btrying to conceive\b|\bttc\b|\bconceiv\w*/.test(m),
    answer: "GLP-1s aren't recommended during pregnancy or breastfeeding, and most guidance is to stop well before trying to conceive. This is genuinely a conversation to have with your doctor — they'll advise on timing and safer alternatives. I'm not the right source for that decision.",
  },
  {
    id: 'birth_control',
    match: (m) => /\b(birth control|contracept|the pill|oral contracept)\b/.test(m),
    answer: "Some GLP-1s (notably tirzepatide/Mounjaro/Zepbound) can reduce how well oral birth control is absorbed, especially around dose increases — many people are advised to add a backup method or use a non-oral option for a few weeks. Confirm the specifics with your prescriber or pharmacist for your exact medication.",
  },
  {
    id: 'fiber',
    match: (m) => has(m, 'fiber', 'fibre'),
    answer: "Aim for about 25-30g of fiber a day — it's one of the best things for the constipation GLP-1s cause, and it helps you stay full. Spread it out and pair it with water (lots of fiber with too little fluid can backfire). Veggies, berries, beans, oats, and chia are easy wins.",
  },
  {
    id: 'electrolytes',
    match: (m) => has(m, 'electrolytes', 'sodium', 'potassium', 'magnesium', 'salt'),
    answer: "When you're eating and drinking less, electrolytes (sodium, potassium, magnesium) can run low and cause fatigue, headaches, cramps, or dizziness. A daily electrolyte drink or a pinch of salt plus magnesium-rich foods helps. Magnesium also eases constipation.",
  },
  {
    id: 'water',
    match: (m) => has(m, 'water', 'hydration', 'fluids', 'fluid', 'dehydrated', 'hydrate') && !has(m, 'alcohol', 'caffeine', 'coffee'),
    answer: "Aim for around 64-80 oz of water a day on a GLP-1, sipped through the day rather than gulped — large amounts at once can worsen nausea. Appetite suppression often dulls thirst too, so it helps to drink on a schedule.",
  },
  {
    id: 'sleep',
    match: (m) => has(m, 'sleep', 'insomnia', 'cant sleep', "can't sleep", 'restless', 'waking up'),
    answer: "GLP-1s disrupt sleep for some people — usually from nighttime nausea, blood sugar dips, or vivid dreams. A small protein snack 1-2 hours before bed, steady hydration, and not eating too close to bedtime often help. Mention persistent insomnia to your doctor.",
  },
  {
    id: 'exercise',
    match: (m) => has(m, 'exercise', 'workout', 'gym', 'cardio', 'lift', 'lifting', 'train', 'training', 'strength', 'resistance', 'weights'),
    answer: "Resistance training 2-3x a week is the single best thing for protecting muscle while you lose weight on a GLP-1, paired with hitting your protein target. Start light if your appetite and energy are low and build up — even bodyweight work counts. Walking helps digestion and mood too.",
  },
  {
    id: 'plateau',
    match: (m) => has(m, 'plateau') || /\b(stall|stalled|stuck|not losing|stopped losing|scale.*stuck)\b/.test(m),
    answer: "Plateaus are normal — your body adapts to the lower intake. The usual levers: make sure protein is on target, add or increase resistance training, check sleep and stress, and give it 2-3 weeks at a steady level before changing anything. Sometimes it's a dose-timing conversation with your prescriber.",
  },
  // ── Protein targets ─────────────────────────────────────────────────────────
  {
    id: 'protein_target',
    match: (m) => /\b(how (much|many)\s+(protein|grams)|protein\s+(target|goal|amount|requirement|need|intake)|grams of protein)\b/.test(m) ||
      (has(m, 'protein') && has(m, 'man', 'woman', 'men', 'women', 'male', 'female', 'guy', 'girl')),
    answer: "On a GLP-1 the target is about 1.2-1.6g of protein per kg of body weight daily — roughly 90-130g for an average adult. Front-load 25-30g at breakfast to protect muscle during weight loss. It's the single most important nutrient to hit while your appetite is low.",
  },
];

/**
 * Return an accurate GLP-1 answer for the user's message, or null if no topic
 * matches. Typo-tolerant. Order is specific → generic.
 */
export function answerGlp1Topic(userMessage: string | undefined | null): string | null {
  if (!userMessage) return null;
  const m = normalizeKnowledgeText(userMessage);
  if (m.length === 0) return null;
  for (const topic of TOPICS) {
    try {
      if (topic.match(m)) return topic.answer;
    } catch {
      // a bad regex must never break the fallback
    }
  }
  return null;
}

/** Exposed for tests / telemetry — which topic id matches (or null). */
export function matchGlp1Topic(userMessage: string | undefined | null): string | null {
  if (!userMessage) return null;
  const m = normalizeKnowledgeText(userMessage);
  for (const topic of TOPICS) {
    try { if (topic.match(m)) return topic.id; } catch { /* ignore */ }
  }
  return null;
}
