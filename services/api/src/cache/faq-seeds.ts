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
    | 'protein_food'
    | 'mechanism'
    | 'comparison'
    | 'ozempic_face'
    | 'drug_interaction'
    | 'dose_error';
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

  // ── Mechanism of action (session 3 feedback) ───────────────────────────
  {
    query: 'How does Ozempic actually work?',
    category: 'mechanism',
    response:
      "It mimics a hormone your gut releases when you eat, called GLP-1. This tells your brain you're full, slows how quickly food leaves your stomach, and keeps that fullness signal on for hours. That's why appetite drops and food thoughts quiet down, and why nausea and constipation can show up too.",
  },
  {
    query: 'How does semaglutide work in the body?',
    category: 'mechanism',
    response:
      "It mimics a hormone your gut releases when you eat, called GLP-1. This tells your brain you're full, slows how quickly food leaves your stomach, and keeps that fullness signal on for hours. That's why appetite drops and food thoughts quiet down, and why nausea and constipation can show up too.",
  },
  {
    query: 'Why did my food obsession just disappear?',
    category: 'mechanism',
    response:
      "The medication acts on receptors in your brain, not just your gut. For many people the constant background hum of food thoughts was partly driven by how the brain's appetite and reward systems were calibrated. The medication recalibrates them, which can feel like freedom for some and strangely empty for others.",
  },
  {
    query: 'Why did my food noise go away?',
    category: 'mechanism',
    response:
      "The medication acts on receptors in your brain, not just your gut. For many people the constant background hum of food thoughts was partly driven by how the brain's appetite and reward systems were calibrated. The medication recalibrates them, which can feel like freedom for some and strangely empty for others.",
  },

  // ── Medication comparison ──────────────────────────────────────────────
  {
    query: 'How is Mounjaro different from Ozempic?',
    category: 'comparison',
    response:
      'Different drugs, same class. Ozempic contains semaglutide and targets one receptor (GLP-1). Mounjaro contains tirzepatide and targets two: GLP-1 and GIP. That dual action is why Mounjaro tends to produce more weight loss on average, around 20-22% vs 14-15% for Ozempic. Side effects are similar on both.',
  },
  {
    query: 'Mounjaro vs Ozempic?',
    category: 'comparison',
    response:
      'Different drugs, same class. Ozempic contains semaglutide and targets one receptor (GLP-1). Mounjaro contains tirzepatide and targets two: GLP-1 and GIP. That dual action is why Mounjaro tends to produce more weight loss on average, around 20-22% vs 14-15% for Ozempic. Side effects are similar on both.',
  },
  {
    query: "What's the difference between Wegovy and Zepbound?",
    category: 'comparison',
    response:
      'Same active ingredients as their diabetes counterparts — Wegovy is semaglutide (like Ozempic), Zepbound is tirzepatide (like Mounjaro). The dose schedule and FDA approval differs but the medication action is identical. Tirzepatide tends to produce more weight loss on average than semaglutide.',
  },

  // ── Ozempic face / facial changes (mechanism, not concerning) ──────────
  {
    query: 'My face is looking saggy on Ozempic.',
    category: 'ozempic_face',
    response:
      "It's not the medication directly, it's the rate of weight loss. Subcutaneous facial fat depletes when you lose weight fast, so faces look hollower or softer. Adequate protein, hydration, and slowing the loss rate help. Fillers and treatments are personal choice, not medical.",
  },
  {
    query: 'Why is my face changing on Ozempic?',
    category: 'ozempic_face',
    response:
      "It's not the medication directly, it's the rate of weight loss. Subcutaneous facial fat depletes when you lose weight fast, so faces look hollower or softer. Adequate protein, hydration, and slowing the loss rate help. Fillers and treatments are personal choice, not medical.",
  },

  // ── Drug interaction → warm clinical redirect (NOT preachy) ────────────
  // Replaces the production failure: "These are absolutely critical questions
  // that you MUST discuss" — that warning-label tone was wrong. Same situation,
  // same tone as the gold-standard "Should I lower my dose?" response.
  {
    query: 'Can I take another medication with my injection?',
    category: 'drug_interaction',
    response:
      'Drug interactions are something your doctor or pharmacist need to check specifically — please ask them before taking anything else alongside your injection.',
  },
  {
    query: 'Is it safe to take Ozempic with other medications?',
    category: 'drug_interaction',
    response:
      'Drug interactions are something your doctor or pharmacist need to check specifically — please ask them before taking anything else alongside your injection.',
  },
  {
    query: 'Can I drink alcohol on Ozempic?',
    category: 'drug_interaction',
    response:
      'Most people can have a drink or two, but it can intensify nausea and hit lower-blood-sugar harder, so go slow and eat with it. If you take other medications, it is worth asking your pharmacist whether alcohol changes how they work.',
  },

  // ── Dosing error → urgent but calm (matches production SUCCESS) ────────
  {
    query: 'I think I injected too much.',
    category: 'dose_error',
    response:
      "That's something your doctor needs to hear about right away. Please reach out to them today to discuss what happened.",
  },
  {
    query: 'I accidentally took a double dose.',
    category: 'dose_error',
    response:
      "That's something your doctor needs to hear about right away. Please reach out to them today to discuss what happened.",
  },
  {
    query: 'I missed my dose, what should I do?',
    category: 'dose_error',
    response:
      "General guideline: if it's been less than 5 days since the missed dose, take it as soon as you remember and continue your normal weekly schedule. If it's been longer, wait for your next scheduled day. When in doubt, check with your prescriber.",
  },
];
