// Pre-seeded FAQ entries for the semantic cache. Sourced from the
// 2026-05-30 clinical-report "Verified Target Responses" table — these
// are the canonical answers Grace should produce for the most common
// GLP-1 questions.
//
// HARD RULE: every entry here must be PERSONALIZATION-FREE. No user name,
// no protein/calorie target, no current weight, no GLP-1 week number, no
// today's macros. If the response would change for a different user, do
// NOT cache it — let it go through the normal pipeline.
//
// Each entry is tagged with `category` so the cache lookup can be gated:
// the cache only fires for messages whose detected intent matches the
// entry's category, preventing a low-quality fuzzy match across topics.

export interface FaqSeed {
  /** Canonical user phrasing — what the report flagged as "User Input". */
  query: string;
  /** Verified target response (prose-only, plain text, ≤3 sentences). */
  response: string;
  /** Semantic category for additional safety gating beyond cosine score. */
  category:
    | 'nausea'
    | 'hair_loss'
    | 'constipation'
    | 'bloating'
    | 'fatigue'
    | 'plateau'
    | 'water'
    | 'muscle'
    | 'food_noise'
    | 'guilt'
    | 'relationship'
    | 'stress_eating'
    | 'protein_food';
}

export const FAQ_SEEDS: FaqSeed[] = [
  // ── Nausea ─────────────────────────────────────────────────────────────
  {
    query: 'I feel so nauseous after my shot.',
    category: 'nausea',
    response:
      'That timing makes sense, nausea peaks 24-48 hours after a weekly injection. Small bland meals, ginger tea, sip water between meals not with them. How long after your shot does it usually start?',
  },
  {
    query: 'What can I eat when I feel nauseous?',
    category: 'nausea',
    response:
      'Cold, bland, and small. Greek yogurt, crackers, banana, plain rice, a hard-boiled egg. Ginger tea or ginger chews have real evidence too. Avoid greasy or spicy, those slow digestion even more.',
  },

  // ── Hair loss ──────────────────────────────────────────────────────────
  {
    query: 'My hair is falling out. Is it the medication?',
    category: 'hair_loss',
    response:
      'What you are most likely seeing is called telogen effluvium, temporary shedding from the metabolic stress of rapid weight loss, not the medication damaging your follicles. It starts 2-3 months in and resolves within 6-9 months. Getting enough protein daily makes the biggest difference.',
  },
  {
    query: 'Will I go bald from Ozempic?',
    category: 'hair_loss',
    response:
      'No. The hair loss on GLP-1s is not the type that causes permanent baldness, the follicles are still alive. This temporary shedding, called telogen effluvium, is a reaction to rapid weight loss and typically resolves on its own within six to nine months.',
  },

  // ── Constipation ───────────────────────────────────────────────────────
  {
    query: "I'm so constipated. What do I do?",
    category: 'constipation',
    response:
      'Really common on GLP-1s, the medication slows digestion right down. Aim for 25-30g fiber daily, at least 64oz water, and daily movement. Warm liquids in the morning help get things moving. OTC MiraLax is commonly recommended if diet changes are not enough.',
  },

  // ── Bloating ───────────────────────────────────────────────────────────
  {
    query: 'I have bad bloating and gas.',
    category: 'bloating',
    response:
      'Food sits in your digestive system longer on GLP-1s, giving bacteria more time to ferment it. Main triggers include carbonated drinks, broccoli, beans, and sugar alcohols in protein bars. Smaller slower meals and thorough chewing make a real difference.',
  },

  // ── Fatigue ────────────────────────────────────────────────────────────
  {
    query: 'I feel exhausted all the time.',
    category: 'fatigue',
    response:
      'Ugh, exhaustion is really tough, and it is usually driven by critically low protein intake, low overall calories, or dehydration. When you eat less, your body has less fuel to burn, so focusing on protein first at every meal is vital. Is this exhaustion constant throughout the day, or does it come and go?',
  },

  // ── Plateau / weight loss stalls ───────────────────────────────────────
  {
    query: "The scale hasn't moved in 3 weeks. Is the medication stopping working?",
    category: 'plateau',
    response:
      'Yeah, a stall on the scale can be really frustrating, and it is natural to experience periods where your body adjusts and weight loss slows for a few weeks. This does not mean the medication has stopped working. How have you been feeling otherwise?',
  },
  {
    query: "I feel like Ozempic isn't working anymore.",
    category: 'plateau',
    response:
      'Slowing down is not the same as stopping working. The big early results set expectations that are genuinely hard to maintain, the medication is still suppressing appetite and supporting your metabolism even when the scale is still. Most people reach their biggest loss at months 12-18. You are in the middle phase, not the end.',
  },

  // ── Water / hydration ──────────────────────────────────────────────────
  {
    query: 'How much water should I drink?',
    category: 'water',
    response:
      '64-80oz daily. GLP-1s suppress thirst too, do not wait until you are thirsty. Sip between meals rather than with them. Start the morning with a full glass before anything else.',
  },

  // ── Muscle preservation ────────────────────────────────────────────────
  {
    query: 'Am I losing muscle on this medication?',
    category: 'muscle',
    response:
      'Yes, research shows roughly 25-35% of weight lost on GLP-1 therapy comes from lean mass rather than fat. That is not inevitable though. Protein (1.2-1.6g per kg of current body weight daily) and resistance training are the two things that shift that balance.',
  },
  {
    query: 'Do I need to lift weights on Ozempic?',
    category: 'muscle',
    response:
      'Resistance training is the most effective thing you can do alongside protein to protect muscle on GLP-1s. Even 2-3x a week of bodyweight exercises or resistance bands makes a real difference. Walking is good for health but does not give muscles the stimulus they need to stay.',
  },

  // ── Food noise / emotional voids ───────────────────────────────────────
  {
    query: 'The food noise is gone and I feel empty.',
    category: 'food_noise',
    response:
      'You just named something most people feel but nobody talks about. Food was not just food, it was comfort, ritual, reward. When the medication silences that, it removes all of it at once. What did food give you that you are missing now?',
  },
  {
    query: "I used to eat when stressed. Now I can't. I don't know what to do.",
    category: 'stress_eating',
    response:
      'Stress eating was not a character flaw, it was a coping mechanism that worked. The medication removed it without offering a replacement, and that gap is real. What does your evening look like now when the stress hits?',
  },

  // ── Guilt / cheating myth ──────────────────────────────────────────────
  {
    query: "I feel guilty for being on Ozempic like I'm cheating.",
    category: 'guilt',
    response:
      'You are not cheating. GLP-1s work by correcting real hormonal signals. Using a medication that fixes a biological problem is no more cheating than using reading glasses.',
  },

  // ── Relationship dynamics ──────────────────────────────────────────────
  {
    query: "My husband loves that I'm losing weight. That makes me angry.",
    category: 'relationship',
    response:
      'That anger makes complete sense. When he starts praising your body now, it can feel like confirmation that he was measuring you before. How are you feeling about this journey overall, separate from his reaction?',
  },

  // ── Protein-friendly food ideas (no personalization) ───────────────────
  {
    query: "Give me something high-protein that won't make me feel sick.",
    category: 'protein_food',
    response:
      'Greek yogurt, cottage cheese, a hard-boiled egg, cold sliced chicken, a protein shake. Cold foods sit better than hot ones when nausea is there. Even a few spoonfuls counts.',
  },
  {
    query: 'What are the best high-protein foods to eat on this medication?',
    category: 'protein_food',
    response:
      'Greek yogurt (15-20g per cup), cottage cheese, eggs, canned fish, protein shakes, all gentle on GLP-1 digestion and high in protein.',
  },
];
