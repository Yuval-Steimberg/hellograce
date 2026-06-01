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
    | 'dose_error'
    // Phase 1 (coverage expansion plan): high-frequency gap topics
    | 'travel'
    | 'injection_site_rotation'
    | 'dose_timing'
    | 'exercise_during_nausea'
    | 'sleep_quality'
    | 'pregnancy_redirect'
    | 'diarrhea'
    | 'heartburn'
    | 'alcohol_expanded'
    | 'hangover_recovery';
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
  // Comprehensive scientific answer — covers the "tell me everything about
  // muscle loss + how protein helps" style query with specific trial citations.
  // Same 3-sentence length as the canned fallback that previously fired but
  // dramatically more scientific (production failure 2026-06-01: user asked
  // "Tell me everything about muscle loss on GLP-1 and how protein helps"
  // and Grace returned the soft typed-fallback with no citations).
  {
    query: 'Tell me everything about muscle loss on GLP-1 and how protein helps',
    category: 'muscle',
    response:
      'Research consistently shows roughly 25-40% of weight lost on GLP-1s is lean mass — the STEP-1 semaglutide trial found ~40%, the 2024 COURAGE study found ~35%. Protein at 1.2-1.6g per kg of current body weight combined with resistance training 2-3x a week shifts that balance toward fat loss because it maintains the anabolic signal muscle needs to stay. Front-loading 25-30g of protein at breakfast matters most since GLP-1 appetite suppression usually hits hardest later in the day.',
  },
  {
    query: 'What does the research say about muscle loss on GLP-1?',
    category: 'muscle',
    response:
      'The STEP-1 trial on semaglutide reported ~40% of weight lost as lean mass, and the 2024 COURAGE tirzepatide study found ~35%. Without intervention that means roughly a third of your loss comes from muscle rather than fat. Protein at 1.2-1.6g per kg of current body weight plus resistance training 2-3x a week is the evidence-based countermeasure that shifts the balance.',
  },
  {
    query: 'How much muscle do you lose on Ozempic?',
    category: 'muscle',
    response:
      'Research puts it at roughly 25-40% of total weight lost — STEP-1 found ~40%, the 2024 COURAGE study ~35%. That ratio comes down sharply with adequate protein (1.2-1.6g per kg of current body weight) and resistance training 2-3 times a week. Front-load 25-30g of protein at breakfast since GLP-1 appetite suppression usually peaks later in the day.',
  },
  {
    query: 'How does protein help with muscle on GLP-1?',
    category: 'muscle',
    response:
      'Protein gives muscle the anabolic signal it needs to stay during a calorie deficit. On GLP-1s the target is 1.2-1.6g per kg of current body weight daily — higher than a sedentary baseline because the deficit + slowed digestion together accelerate lean-mass loss. Front-load 25-30g at breakfast and pair it with resistance training 2-3x a week for the strongest protective effect.',
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

  // ── Travel (Phase 1 coverage expansion — flights, time zones, storage) ──
  {
    query: 'Can I travel with my Ozempic?',
    category: 'travel',
    response:
      "Yes, pens travel fine. Keep them in your carry-on (cargo holds can freeze), in their original box for ID, with a small insulated bag if the flight is long. TSA is used to seeing them, no prescription paperwork needed in the US. Once you're settled, refrigerate again.",
  },
  {
    query: 'How do I carry my injection pen on a flight?',
    category: 'travel',
    response:
      "Yes, pens travel fine. Keep them in your carry-on (cargo holds can freeze), in their original box for ID, with a small insulated bag if the flight is long. TSA is used to seeing them, no prescription paperwork needed in the US. Once you're settled, refrigerate again.",
  },
  {
    query: "I'm traveling across time zones, when should I inject?",
    category: 'travel',
    response:
      'For a 1-3 hour shift, take your weekly dose on the same calendar day you usually would, local time. For bigger shifts, your prescriber may suggest splitting the difference over one or two weeks. The medication has a long half-life, a few hours of drift is fine.',
  },

  // ── Injection site rotation ──────────────────────────────────────────────
  {
    query: 'Where should I inject my Ozempic?',
    category: 'injection_site_rotation',
    response:
      "Thigh, belly (an inch away from the navel), or upper outer arm. Rotate sites week to week so the same spot doesn't get firm or develop lipohypertrophy. Most people pick one zone per side and alternate.",
  },
  {
    query: 'Can I inject in the same spot every week?',
    category: 'injection_site_rotation',
    response:
      "Better to rotate. Repeating the same exact spot can lead to firm bumps (lipohypertrophy) that slow absorption. Use thigh, belly, or upper outer arm and shift at least an inch each time.",
  },
  {
    query: 'How do I rotate injection sites?',
    category: 'injection_site_rotation',
    response:
      "Pick three zones, thigh, belly, upper outer arm, and rotate week to week. Within a zone shift at least an inch from your last spot. Some people keep a simple note on their phone so the rotation stays consistent.",
  },

  // ── Dose timing (separate from missed-dose) ──────────────────────────────
  {
    query: 'What time of day should I take my shot?',
    category: 'dose_timing',
    response:
      "Whenever fits your routine, the medication works on a weekly cycle, not a daily one. Most people pick mornings or evenings on the same weekday each week. Consistency matters more than the specific hour.",
  },
  {
    query: 'Can I change my injection day?',
    category: 'dose_timing',
    response:
      "Yes. As long as the gap between doses is at least 48 hours, you can shift your weekly day. Pick the new day, take your dose, and stick with that day going forward.",
  },

  // ── Exercise during nausea (high-frequency cross-topic Q) ────────────────
  {
    query: 'Can I work out when I feel nauseous?',
    category: 'exercise_during_nausea',
    response:
      "Light movement like walking usually helps, intense workouts often make nausea worse on injection day or the day after. Listen to your body, dial back when it's peaking, and ease back in once it settles. Hydration first, fuel second.",
  },
  {
    query: 'Should I skip the gym on injection day?',
    category: 'exercise_during_nausea',
    response:
      'If you usually feel rough that day, swap your hard session for a walk or mobility work. Save the heavier lifts for 2-3 days post-injection when side effects are usually mildest.',
  },

  // ── Sleep quality on GLP-1s ──────────────────────────────────────────────
  {
    query: 'Is it normal to sleep poorly on Ozempic?',
    category: 'sleep_quality',
    response:
      "Some people do experience disrupted sleep, especially early on. Common triggers include nausea waking you up, low blood sugar in the night, or vivid dreams that the medication seems to amplify in some users. A small protein snack before bed and earlier injections can help.",
  },
  {
    query: 'Why am I waking up at 3am on Ozempic?',
    category: 'sleep_quality',
    response:
      "A few possibilities, the medication can shift blood sugar, cause mild nausea that breaks sleep, or amplify dream activity. A small protein snack (Greek yogurt, cottage cheese) an hour before bed often helps if it's blood sugar related.",
  },

  // ── Pregnancy / breastfeeding (HARD redirect, no medical detail) ─────────
  {
    query: 'Is Ozempic safe during pregnancy?',
    category: 'pregnancy_redirect',
    response:
      "That one I'd genuinely leave to your doctor or OB. Pregnancy planning on a GLP-1 needs a personal conversation with someone who knows your full picture. Worth calling them this week.",
  },
  {
    query: 'Can I take Ozempic while breastfeeding?',
    category: 'pregnancy_redirect',
    response:
      "That's a call your doctor needs to make with you, breastfeeding decisions on GLP-1s are individual and depend on your specific situation. Please reach out to them before continuing.",
  },
  {
    query: "I'm trying to get pregnant, should I stop Ozempic?",
    category: 'pregnancy_redirect',
    response:
      "That one I'd genuinely leave to your doctor or OB. Most prescribers recommend stopping a couple of months before conception, but the exact timing needs to come from someone who knows your history. Worth calling them this week.",
  },

  // ── Diarrhea (parallel to constipation seed; common but under-covered) ───
  {
    query: 'I have diarrhea on Ozempic, what helps?',
    category: 'diarrhea',
    response:
      "Common in the first few weeks and around dose increases. Stick with bland low-fat foods (rice, toast, banana, plain chicken), sip water with a pinch of salt to replace electrolytes, and avoid fatty or sugary foods which make it worse. If it lasts more than 2-3 days or you can't keep fluids down, call your doctor.",
  },
  {
    query: 'Why do I have diarrhea on Mounjaro?',
    category: 'diarrhea',
    response:
      "GLP-1s and GIP agonists speed digestion in some people while slowing it in others. It tends to settle as your body adjusts, usually within a few weeks. Bland low-fat foods, electrolytes, and avoiding fried/spicy food help in the meantime.",
  },

  // ── Heartburn / GERD / acid reflux ───────────────────────────────────────
  {
    query: "I'm getting heartburn on Ozempic, is that normal?",
    category: 'heartburn',
    response:
      "Yes, slowed stomach emptying means food sits longer which can cause reflux. Smaller meals, eat slowly, stay upright for 30-60 min after eating, and avoid trigger foods (spicy, citrus, tomato, fried, caffeine close to meals). An OTC like Pepcid or omeprazole short-term is often fine, but check with your pharmacist on timing if you take other meds.",
  },
  {
    query: 'Why do I have acid reflux on Mounjaro?',
    category: 'heartburn',
    response:
      "The medication slows how fast your stomach empties, so food and acid can back up more easily. Smaller meals, eating slowly, staying upright for 30-60 min after meals, and avoiding common triggers (spicy, fried, citrus, caffeine near meals) help most.",
  },

  // ── Alcohol — expanded beyond the single existing entry ──────────────────
  {
    query: 'How does alcohol affect me on Ozempic?',
    category: 'alcohol_expanded',
    response:
      "It hits harder. The medication slows digestion, so alcohol can absorb unevenly and intensify nausea or low blood sugar. Most people can have a drink with food and water alongside, but it's not the same as before, plan for a smaller amount and pace yourself.",
  },
  {
    query: 'Can I drink wine at dinner on Ozempic?',
    category: 'alcohol_expanded',
    response:
      "Usually yes, in moderation, with food. The medication can intensify the effects so one glass may feel like two. Eat protein with it, hydrate, and skip drinks on injection day if you tend to feel nauseous then.",
  },

  // ── Hangover recovery (related, distinct Q) ──────────────────────────────
  {
    query: 'I drank too much last night, will it affect my injection?',
    category: 'hangover_recovery',
    response:
      "Your injection day itself is fine, but you may feel worse than usual because GLP-1s already slow digestion and alcohol amplifies that. Sip water with electrolytes, eat small bland meals, skip caffeine until you've rehydrated. The shot itself doesn't need to shift.",
  },
  {
    query: "I have a bad hangover, what should I eat on Ozempic?",
    category: 'hangover_recovery',
    response:
      "Small bland portions, eggs, plain toast, Greek yogurt, banana, broth. Hydrate steadily with water plus a pinch of salt or an electrolyte drink. The medication will keep you full longer than usual, so don't force a big meal.",
  },
];
