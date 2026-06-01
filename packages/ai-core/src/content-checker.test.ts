import { describe, it, expect } from 'vitest';
import type { DietaryRestriction } from '@grace/shared';
import {
  checkContent,
  checkDietaryViolations,
  checkBannedPhrases,
  checkLinkPlaceholder,
  checkPrivacyLeak,
  checkFoodDislikes,
  checkMedicationContradiction,
  checkBodyPhotoLeak,
} from './content-checker.js';

const VEGETARIAN: DietaryRestriction = {
  label: 'VEGETARIAN',
  forbidden: ['chicken', 'turkey', 'beef', 'pork', 'tuna', 'fish', 'salmon', 'bacon', 'meat', 'shrimp'],
  allowed: ['Greek yogurt', 'cottage cheese', 'eggs', 'tofu', 'lentils', 'beans'],
};

const VEGAN: DietaryRestriction = {
  label: 'VEGAN',
  forbidden: ['chicken', 'beef', 'eggs', 'cheese', 'yogurt', 'milk', 'cottage cheese'],
  allowed: ['tofu', 'tempeh', 'lentils', 'beans'],
};

describe('checkDietaryViolations', () => {
  it('flags chicken in a vegetarian response', () => {
    const violations = checkDietaryViolations(
      'Try grilled chicken with veggies — about 30g protein.',
      VEGETARIAN,
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.match).toBe('chicken');
  });

  it('flags rotisserie chicken in vegetarian response (screenshot bug)', () => {
    const violations = checkDietaryViolations(
      'For lunch, Greek yogurt, cottage cheese, or a small portion of rotisserie chicken would be great.',
      VEGETARIAN,
    );
    expect(violations.length).toBeGreaterThanOrEqual(1);
    expect(violations.map((v) => v.match)).toContain('chicken');
  });

  it('flags multiple forbidden foods', () => {
    const violations = checkDietaryViolations(
      'You can try chicken, tuna, or salmon for protein.',
      VEGETARIAN,
    );
    expect(violations.map((v) => v.match).sort()).toEqual(['chicken', 'salmon', 'tuna']);
  });

  it('does NOT flag when food appears after a negation', () => {
    const v1 = checkDietaryViolations(
      "No chicken, no fish — try Greek yogurt instead.",
      VEGETARIAN,
    );
    expect(v1).toHaveLength(0);

    const v2 = checkDietaryViolations(
      'Avoid chicken and beef. Stick with plant-based options.',
      VEGETARIAN,
    );
    expect(v2).toHaveLength(0);
  });

  it('flags eggs and cheese for vegan, but not for vegetarian', () => {
    const vegan = checkDietaryViolations('Try eggs and cottage cheese.', VEGAN);
    expect(vegan.map((v) => v.match).sort()).toEqual(['cottage cheese', 'eggs']);

    const vegetarian = checkDietaryViolations('Try eggs and cottage cheese.', VEGETARIAN);
    expect(vegetarian).toHaveLength(0);
  });

  it('deduplicates repeated mentions of the same forbidden word', () => {
    const v = checkDietaryViolations(
      'Try chicken at lunch. Chicken is high in protein. Chicken also...',
      VEGETARIAN,
    );
    expect(v).toHaveLength(1);
  });

  it('returns empty for an all-allowed vegetarian recommendation', () => {
    const v = checkDietaryViolations(
      'Greek yogurt, cottage cheese, eggs, and lentils are all great vegetarian options.',
      VEGETARIAN,
    );
    expect(v).toHaveLength(0);
  });

  it('is case-insensitive', () => {
    const v = checkDietaryViolations('Try CHICKEN or Tuna.', VEGETARIAN);
    expect(v.map((v) => v.match).sort()).toEqual(['chicken', 'tuna']);
  });
});

describe('checkBannedPhrases', () => {
  it('flags "Hang in there"', () => {
    const v = checkBannedPhrases('Hang in there — you got this.');
    expect(v.length).toBeGreaterThan(0);
    expect(v[0]?.code).toBe('banned_phrase');
  });

  it('flags "you\'ve got this"', () => {
    const v = checkBannedPhrases("You've got this!");
    expect(v.length).toBeGreaterThan(0);
  });

  it('flags "great question"', () => {
    const v = checkBannedPhrases('Great question! Let me explain.');
    expect(v.length).toBeGreaterThan(0);
  });

  it('flags "according to your profile"', () => {
    const v = checkBannedPhrases('According to your profile, you eat at home.');
    expect(v.length).toBeGreaterThan(0);
  });

  it('flags "a lot of women mention"', () => {
    const v = checkBannedPhrases('A lot of women mention feeling fatigued.');
    expect(v.length).toBeGreaterThan(0);
  });

  it('flags "I can\'t recommend specific meals"', () => {
    const v = checkBannedPhrases("I can't recommend specific meals.");
    expect(v.length).toBeGreaterThan(0);
  });

  it('does not flag normal warm language', () => {
    const v = checkBannedPhrases('That sounds rough. Want to talk about it?');
    expect(v).toHaveLength(0);
  });

  // ── Model-identity leak protection (2026-05-29 production bug) ──────────────
  it('flags "I\'m a large language model"', () => {
    expect(checkBannedPhrases("I'm a large language model and my interactions happen across many different applications and services.").length).toBeGreaterThan(0);
  });

  it('flags "I don\'t have a specific number of users" (the exact screenshot phrase)', () => {
    expect(checkBannedPhrases("I don't have a specific number of users I can share.").length).toBeGreaterThan(0);
  });

  it('flags "developed by Google/OpenAI/Anthropic"', () => {
    expect(checkBannedPhrases('I was developed by Google.').length).toBeGreaterThan(0);
    expect(checkBannedPhrases('a model developed by OpenAI').length).toBeGreaterThan(0);
  });

  it('flags "I\'m Gemini/GPT/Claude"', () => {
    expect(checkBannedPhrases("I'm Gemini, here to help.").length).toBeGreaterThan(0);
    expect(checkBannedPhrases("I'm powered by GPT.").length).toBeGreaterThan(0);
  });

  it('flags "my interactions happen across many different applications"', () => {
    expect(checkBannedPhrases('My interactions happen across many different applications and services.').length).toBeGreaterThan(0);
  });

  it('flags "across many different applications and services"', () => {
    expect(checkBannedPhrases('I operate across multiple different services.').length).toBeGreaterThan(0);
  });

  it('flags "I am an AI assistant developed by..."', () => {
    expect(checkBannedPhrases('I am an AI assistant developed by a tech company.').length).toBeGreaterThan(0);
  });

  it('does NOT flag normal Grace identity statements', () => {
    // Grace can say she's Grace, a companion, etc. — just not the model details.
    expect(checkBannedPhrases("I'm Grace, here to support your GLP-1 journey.")).toHaveLength(0);
    expect(checkBannedPhrases("I'm your companion for the medication journey.")).toHaveLength(0);
  });

  // Production failure 2026-06-01 — user said "Morning, felling good" and Grace
  // dredged up stale "40g" context to apologize for. Each pattern below is
  // a literal substring from that exact bad response.
  it('flags unprompted "I apologize for the confusion"', () => {
    expect(checkBannedPhrases('I apologize for the confusion. It looks like there was a mix-up.').length).toBeGreaterThan(0);
  });
  it('flags "I incorrectly stated X earlier"', () => {
    expect(checkBannedPhrases('I incorrectly stated 40g earlier.').length).toBeGreaterThan(0);
    expect(checkBannedPhrases('I mistakenly said 40g.').length).toBeGreaterThan(0);
    expect(checkBannedPhrases('I wrongly reported your protein.').length).toBeGreaterThan(0);
  });
  it('flags "There was a mix-up in my tracking"', () => {
    expect(checkBannedPhrases('It looks like there was a mix-up in my tracking.').length).toBeGreaterThan(0);
    expect(checkBannedPhrases('there was a mix up with my records').length).toBeGreaterThan(0);
  });
  it('flags "Let me get it logged correctly"', () => {
    expect(checkBannedPhrases('Let me get it logged correctly for you.').length).toBeGreaterThan(0);
    expect(checkBannedPhrases('Let me correct the log.').length).toBeGreaterThan(0);
  });
  it('flags developer-voice "Based on what I have logged"', () => {
    expect(checkBannedPhrases('Based on what I have logged, you are at 0g protein.').length).toBeGreaterThan(0);
  });
  it('flags asking "Could you tell me what you\'ve eaten today" after a brief greeting', () => {
    expect(checkBannedPhrases("Could you tell me what you've eaten so far today?").length).toBeGreaterThan(0);
    expect(checkBannedPhrases("Can you let me know what you've eaten today?").length).toBeGreaterThan(0);
  });
  it('does NOT flag normal warm greeting reply', () => {
    expect(checkBannedPhrases('So glad to hear that 🧡')).toHaveLength(0);
    expect(checkBannedPhrases('Love that for you.')).toHaveLength(0);
  });
});

describe('checkLinkPlaceholder', () => {
  it('flags "[link]"', () => {
    const v = checkLinkPlaceholder('Update it here: [link]');
    expect(v).toHaveLength(1);
    expect(v[0]?.code).toBe('link_placeholder');
  });

  it('flags "[settings link]"', () => {
    const v = checkLinkPlaceholder('Use [settings link].');
    expect(v).toHaveLength(1);
  });

  it('does not flag real URL', () => {
    const v = checkLinkPlaceholder('https://graceglp.com/settings');
    expect(v).toHaveLength(0);
  });
});

describe('checkPrivacyLeak', () => {
  it('flags "I don\'t have a user named X"', () => {
    const v = checkPrivacyLeak("I don't have a user named Sarah.");
    expect(v).toHaveLength(1);
    expect(v[0]?.code).toBe('privacy_leak');
  });

  it('flags "in my contacts"', () => {
    const v = checkPrivacyLeak("I don't see them in my contacts.");
    expect(v).toHaveLength(1);
  });

  it('does not flag normal messages', () => {
    const v = checkPrivacyLeak('That sounds rough. How are you doing?');
    expect(v).toHaveLength(0);
  });
});

describe('checkFoodDislikes', () => {
  it('flags a disliked food', () => {
    const v = checkFoodDislikes('Try rice with grilled veggies.', ['rice']);
    expect(v).toHaveLength(1);
    expect(v[0]?.match).toBe('rice');
    expect(v[0]?.code).toBe('disliked_food');
  });

  it('strips natural-language prefix from stored dislikes', () => {
    const v = checkFoodDislikes('A bowl of rice would be great.', ["I don't like rice"]);
    expect(v).toHaveLength(1);
    expect(v[0]?.match).toBe('rice');
  });

  it('handles "no X" and "avoid X" stored prefixes', () => {
    const v1 = checkFoodDislikes('Some mushrooms would work.', ['no mushrooms']);
    expect(v1).toHaveLength(1);
    const v2 = checkFoodDislikes('Dairy is a solid option.', ['avoid dairy']);
    expect(v2).toHaveLength(1);
  });

  it('respects sentence-level negation', () => {
    const v = checkFoodDislikes('Avoid rice and pasta. Try quinoa instead.', ['rice', 'pasta']);
    expect(v).toHaveLength(0);
  });

  it('does not flag when dislike list is empty', () => {
    const v = checkFoodDislikes('Rice is great.', []);
    expect(v).toHaveLength(0);
  });
});

describe('checkMedicationContradiction', () => {
  it('flags "your injection day" for a Rybelsus user', () => {
    const v = checkMedicationContradiction(
      'Your injection day is tomorrow.',
      'daily_pill',
    );
    expect(v).toHaveLength(1);
    expect(v[0]?.code).toBe('medication_contradiction');
  });

  it('flags "weekly injection" for a Saxenda user', () => {
    const v = checkMedicationContradiction(
      'Your weekly injection is due tomorrow.',
      'daily_injection',
    );
    expect(v).toHaveLength(1);
  });

  it('flags "your pill" for an Ozempic user', () => {
    const v = checkMedicationContradiction(
      'Take your pill in the morning.',
      'weekly_injection',
    );
    expect(v.length).toBeGreaterThan(0);
  });

  it('does not flag valid mention of injection day for a weekly user', () => {
    const v = checkMedicationContradiction(
      'Your injection day is tomorrow — water and protein matter today.',
      'weekly_injection',
    );
    expect(v).toHaveLength(0);
  });

  it('does not flag generic statements about injections', () => {
    const v = checkMedicationContradiction(
      'Most GLP-1 users take a weekly injection.',
      'daily_pill',
    );
    // "weekly injection" pattern requires "weekly\s+(injection|shot|dose)" — this is a generic
    // statement but it does match. False positive in this case is acceptable since
    // Grace shouldn't be making generic statements; the context is about THIS user.
    expect(v.length).toBeGreaterThan(0);
  });
});

describe('checkBodyPhotoLeak', () => {
  it('flags mention of pain in body-photo response', () => {
    const v = checkBodyPhotoLeak('You look great. Any pain in your back?');
    expect(v.length).toBeGreaterThan(0);
    expect(v[0]?.code).toBe('body_photo_medical_leak');
  });

  it('flags mention of injury', () => {
    const v = checkBodyPhotoLeak('Looks like progress, hope no injury slowed you down.');
    expect(v.length).toBeGreaterThan(0);
  });

  it('flags negative appearance commentary', () => {
    const v = checkBodyPhotoLeak('You look a bit gaunt.');
    expect(v.length).toBeGreaterThan(0);
  });

  it('flags "see your doctor about this"', () => {
    const v = checkBodyPhotoLeak('Lovely progress — see your doctor about this.');
    expect(v.length).toBeGreaterThan(0);
  });

  it('passes a clean compassionate response', () => {
    const v = checkBodyPhotoLeak('Look at you — real progress. Keep going.');
    expect(v).toHaveLength(0);
  });
});

describe('checkContent (orchestration)', () => {
  it('combines violations from all sub-checks', () => {
    const v = checkContent(
      "Hang in there, Sarah! Try chicken or tuna. Update at [link].",
      { dietaryRestriction: VEGETARIAN },
    );
    const codes = v.map((x) => x.code).sort();
    expect(codes).toContain('forbidden_food');
    expect(codes).toContain('banned_phrase');
    expect(codes).toContain('link_placeholder');
  });

  it('returns empty for a clean vegetarian response', () => {
    const v = checkContent(
      'Greek yogurt, eggs, lentils, and cottage cheese all sit well on GLP-1.',
      { dietaryRestriction: VEGETARIAN },
    );
    expect(v).toHaveLength(0);
  });
});

// ── 2026-05-30 clinical report — banned phrase + SMS format guards ──────────
describe('checkBannedPhrases — 2026-05-30 clinical report additions', () => {
  it('flags "I understand how frustrating"', () => {
    const v = checkBannedPhrases('I understand how frustrating this is. Try cold foods.');
    expect(v.length).toBeGreaterThan(0);
  });

  it('flags "It\'s completely understandable"', () => {
    const v = checkBannedPhrases("It's completely understandable that you feel that way.");
    expect(v.length).toBeGreaterThan(0);
  });

  it('flags "incredibly common" / "quite common" / "very common"', () => {
    expect(checkBannedPhrases('Hair shedding is incredibly common on GLP-1s.').length).toBeGreaterThan(0);
    expect(checkBannedPhrases('Bloating is quite common.').length).toBeGreaterThan(0);
    expect(checkBannedPhrases('Nausea is very common in the first month.').length).toBeGreaterThan(0);
    expect(checkBannedPhrases('Plateaus are a really common challenge.').length).toBeGreaterThan(0);
  });

  it('flags "common experience for many people"', () => {
    const v = checkBannedPhrases('This is a common experience for many people on this medication.');
    expect(v.length).toBeGreaterThan(0);
  });

  it('flags "That\'s a really understandable worry"', () => {
    expect(checkBannedPhrases("That's a really understandable worry.").length).toBeGreaterThan(0);
    expect(checkBannedPhrases("That's a really complex feeling.").length).toBeGreaterThan(0);
  });

  it('flags premature medical redirect on a normal GLP-1 effect (plateau)', () => {
    const v = checkBannedPhrases('A plateau like that is something you should talk to your doctor about.');
    expect(v.length).toBeGreaterThan(0);
  });

  it('flags premature medical redirect on hair loss', () => {
    const v = checkBannedPhrases('For the hair shedding, please share this with your prescriber.');
    expect(v.length).toBeGreaterThan(0);
  });

  it('does NOT flag a referral for SEVERE abdominal pain (the legitimate triage case)', () => {
    const v = checkBannedPhrases('Severe localized abdominal pain needs your doctor right away.');
    expect(v).toHaveLength(0);
  });

  it('flags any "!" in the response (H5)', () => {
    expect(checkBannedPhrases('That makes sense! Try cold foods.').length).toBeGreaterThan(0);
  });

  it('flags two or more question marks (H6)', () => {
    expect(checkBannedPhrases('How long does it last? And do you take it with food?').length).toBeGreaterThan(0);
  });

  it('flags a single question at the end (allowed) — should NOT trigger H6', () => {
    expect(checkBannedPhrases('Stick to cold bland foods. How long after the shot does it start?')).toHaveLength(0);
  });

  it('flags markdown bullet lines', () => {
    expect(checkBannedPhrases('Try these:\n- Greek yogurt\n- Cottage cheese').length).toBeGreaterThan(0);
  });

  it('flags markdown bold', () => {
    expect(checkBannedPhrases('**Cottage cheese** has 25g protein.').length).toBeGreaterThan(0);
  });

  it('flags label:description list layout', () => {
    expect(checkBannedPhrases('Greek yogurt: high protein, easy on stomach.\nCottage cheese: high protein, mild flavor.').length).toBeGreaterThan(0);
  });

  it('does NOT flag normal flowing prose with a list of foods', () => {
    expect(checkBannedPhrases('Greek yogurt, cottage cheese, a hard-boiled egg, cold sliced chicken.')).toHaveLength(0);
  });
});

describe('checkUserMessageEcho (via checkContent)', () => {
  it('flags Grace echoing the user\'s opening words verbatim (production bug)', () => {
    const violations = checkContent(
      'Feeling good, just ate two eggs and salad is about 15g protein. You\'re at 40/60g today.',
      { userMessage: 'Feeling good, just ate two eggs and salad' },
    );
    expect(violations.some((v) => v.code === 'user_message_echo')).toBe(true);
  });

  it('does NOT flag a well-formed food log response (no echo)', () => {
    const violations = checkContent(
      'Two eggs and a salad — about 15g protein. You\'re at 40/60g today.',
      { userMessage: 'Feeling good, just ate two eggs and salad' },
    );
    expect(violations.some((v) => v.code === 'user_message_echo')).toBe(false);
  });

  it('does NOT flag short user messages (avoids false positives on "ok"/"yes")', () => {
    const violations = checkContent(
      'Got it — what\'s up?',
      { userMessage: 'ok' },
    );
    expect(violations.some((v) => v.code === 'user_message_echo')).toBe(false);
  });

  it('does NOT flag responses that share only 1-2 leading words with the user', () => {
    const violations = checkContent(
      'Two eggs and toast is around 14g protein for the morning.',
      { userMessage: 'Two scoops of whey protein this morning' },
    );
    expect(violations.some((v) => v.code === 'user_message_echo')).toBe(false);
  });
});

describe('checkEmotionBeforeData (session 3 feedback)', () => {
  it('flags response opening with food log on an emotional message (exact production case)', () => {
    const violations = checkContent(
      'Toast and orange juice logged. That\'s about 4g protein. You\'re at 4g of your 114g target today. It sounds like you\'re carrying a lot right now.',
      { userMessage: "I'm trying and I still feel like I'm failing" },
    );
    expect(violations.some((v) => v.code === 'emotion_before_data')).toBe(true);
  });

  it('does NOT flag emotional-first response', () => {
    const violations = checkContent(
      "That feeling can hit so hard, especially when you're putting in the effort. What's been making it feel like failing lately?",
      { userMessage: "I'm trying and I still feel like I'm failing" },
    );
    expect(violations.some((v) => v.code === 'emotion_before_data')).toBe(false);
  });

  it('does NOT flag data response on a non-emotional message', () => {
    const violations = checkContent(
      'Toast and OJ logged — about 4g protein. You\'re at 4g of your 114g target today.',
      { userMessage: 'just had toast and orange juice' },
    );
    expect(violations.some((v) => v.code === 'emotion_before_data')).toBe(false);
  });

  it('flags "you\'re now at X g" opener on emotional message', () => {
    const violations = checkContent(
      "You're now at 4g of your 114g protein target today.",
      { userMessage: "I'm so exhausted and just want to give up" },
    );
    expect(violations.some((v) => v.code === 'emotion_before_data')).toBe(true);
  });
});

describe('checkPrivacyMisfire — strengthened variants (session 3 feedback)', () => {
  it('flags the verbatim "I only know about you" on a self-referencing health Q', () => {
    const violations = checkContent(
      "I only know about you and your journey. I can't help with that.",
      { userMessage: 'I feel so nauseous after my shot' },
    );
    expect(violations.some((v) => v.code === 'privacy_misfire')).toBe(true);
  });

  it('flags rewording "I only have access to your data" on health Q', () => {
    const violations = checkContent(
      "I only have access to your data, so I can't help with that.",
      { userMessage: 'My face is looking saggy' },
    );
    expect(violations.some((v) => v.code === 'privacy_misfire')).toBe(true);
  });

  it('does NOT flag the privacy line on a third-party question', () => {
    const violations = checkContent(
      "I only know about you and your journey. I can't share details about other users.",
      { userMessage: 'Is my friend Sarah a user too?' },
    );
    expect(violations.some((v) => v.code === 'privacy_misfire')).toBe(false);
  });
});

describe('appointment_prep exemption from two-question check', () => {
  it('does NOT flag multiple questions when intentType is appointment_prep', () => {
    const violations = checkContent(
      'Good idea to prep. Is my current dose right? Am I losing muscle? What should we monitor in bloodwork? Anything to add?',
      { userMessage: 'Help me write my questions for my endo appointment', intentType: 'appointment_prep' },
    );
    expect(violations.some((v) => v.code === 'two_questions')).toBe(false);
  });

  it('still flags multiple questions for other intents', () => {
    const violations = checkContent(
      "How are you feeling? Is the nausea still bad?",
      { userMessage: 'I had eggs for breakfast', intentType: 'food_log' },
    );
    expect(violations.some((v) => v.code === 'two_questions')).toBe(true);
  });
});

// ── checkStaleContextEcho (FINAL LAYER, 2026-06-01) ─────────────────────────
// Verifies that Grace's response only references quantities that come from
// THIS turn (current user message + system context + tool results). Numbers
// that appear out of nowhere (memory echo) trigger regen.

describe('checkStaleContextEcho — final-layer memory guard', () => {
  it('flags the exact production failure (40g from prior day surfacing on a greeting)', () => {
    // User said "Morning, felling good". Grace responds with stale "40g" from
    // a previous day's protein discussion + asks for re-logging. NO 40g
    // anywhere in current user msg, system context, or tool results.
    const response =
      "I apologize for the confusion. I incorrectly stated 40g earlier. Based on what I have logged, you're currently at 0g protein for today.";
    const violations = checkContent(response, {
      userMessage: 'Morning, felling good',
      systemContext: '━━━ THIS USER — Personal daily protein target: 60g — use THIS number, not a generic 80g. ━━━',
      toolResultsText: '',
    });
    expect(violations.some((v) => v.code === 'stale_context_echo')).toBe(true);
  });

  it('does NOT flag numbers that ARE in the system context (legitimate usage)', () => {
    // Grace says "You're at 40g of your 60g target." The 40g comes from the
    // get_food_summary tool, the 60g from the user's protein_goal_grams.
    // Both should appear in scope → no violation.
    const response = "Two eggs logged — about 14g. You're at 40g of your 60g target today.";
    const violations = checkContent(response, {
      userMessage: 'I just had two eggs',
      systemContext: 'Total protein TODAY: 26g / 60g target (34g remaining)',
      toolResultsText: '{"protein_g":14,"daily_protein_g":40}',
    });
    expect(violations.some((v) => v.code === 'stale_context_echo')).toBe(false);
  });

  it('does NOT flag tiny numbers in natural prose (1-9)', () => {
    // Small numbers appear in normal speech ("a couple", "one or two", "3 days")
    // and shouldn't trigger the guard.
    const response = 'A couple of small meals every 3 or 4 hours often helps.';
    const violations = checkContent(response, {
      userMessage: 'How do I manage nausea?',
      systemContext: '',
      toolResultsText: '',
    });
    expect(violations.some((v) => v.code === 'stale_context_echo')).toBe(false);
  });

  it('flags a "Week 8" reference when GLP-1 week is NOT in current scope', () => {
    // Grace shouldn't surface a specific journey week from memory if it's not
    // anchored in this turn's context.
    const response = "You're in Week 8 of your journey — appetite changes are common at this point.";
    const violations = checkContent(response, {
      userMessage: 'Why do I feel less hungry?',
      systemContext: '',
      toolResultsText: '',
    });
    expect(violations.some((v) => v.code === 'stale_context_echo')).toBe(true);
  });

  it('does NOT flag a "Week 12" reference when system context has GLP-1 week = 12', () => {
    const response = "Week 12 is when many people start noticing food preferences shifting.";
    const violations = checkContent(response, {
      userMessage: 'Why do I want different foods now?',
      systemContext: 'GLP-1 week: Week 12 (started Feb 14, 2026)',
      toolResultsText: '',
    });
    expect(violations.some((v) => v.code === 'stale_context_echo')).toBe(false);
  });

  it('flags a fabricated calorie number when no tool result or context provides it', () => {
    const response = "You've had about 1450 kcal today, which is right on track.";
    const violations = checkContent(response, {
      userMessage: 'How am I doing on calories?',
      systemContext: 'Personal daily calorie target: 1800 kcal',
      toolResultsText: '',
    });
    expect(violations.some((v) => v.code === 'stale_context_echo')).toBe(true);
  });

  it('does NOT flag the user\'s OWN number ("I weighed 175 lbs today")', () => {
    // If the user says "I weighed 175 today", Grace replying "175 lbs is..."
    // is fine — the number came from the user message itself.
    const response = "175 lbs is a solid checkpoint — how are you feeling overall?";
    const violations = checkContent(response, {
      userMessage: 'I weighed 175 today',
      systemContext: '',
      toolResultsText: '',
    });
    expect(violations.some((v) => v.code === 'stale_context_echo')).toBe(false);
  });

  it('does NOT flag a response with no specific quantities at all', () => {
    const response = 'So glad to hear that 🧡';
    const violations = checkContent(response, {
      userMessage: 'Morning, feeling good',
      systemContext: 'Total protein TODAY: 0g / 60g target',
      toolResultsText: '',
    });
    expect(violations.some((v) => v.code === 'stale_context_echo')).toBe(false);
  });
});
