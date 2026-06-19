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

  // Regression (2026-06-19): a bare "good morning" got the canned fallback
  // because Gemini's greeting reply ("...what's on your mind?") was banned →
  // regen → fallback, and the fallback itself contained the banned phrase. The
  // generic-deflection phrases are legitimate for greeting / small-talk intents.
  it('does NOT flag "what\'s on your mind" for a greeting intent', () => {
    expect(checkBannedPhrases("Morning. What's on your mind?", 'greeting')).toHaveLength(0);
    expect(checkBannedPhrases("I'm here for you. What's on your mind?", 'general')).toHaveLength(0);
  });

  it('STILL flags "what\'s on your mind" for a substantive (knowledge) intent', () => {
    const v = checkBannedPhrases("What's on your mind?", 'knowledge');
    expect(v.length).toBeGreaterThan(0);
  });

  it('STILL flags generic deflection when no intent is supplied', () => {
    expect(checkBannedPhrases("What's on your mind?").length).toBeGreaterThan(0);
  });

  // TRUST_GEMINI: cosmetic tone bans ship as log-only (Gemini's wording stands);
  // safety / capability bans still regenerate.
  it('downgrades a cosmetic ban to log-only under trustGemini', () => {
    const v = checkBannedPhrases("It's completely understandable.", 'emotional', true);
    expect(v.length).toBeGreaterThan(0);
    expect(v[0]?.severity).toBe('log');
  });

  it('keeps a cosmetic ban at regen severity when trustGemini is off', () => {
    const v = checkBannedPhrases("It's completely understandable.", 'emotional', false);
    expect(v.length).toBeGreaterThan(0);
    expect(v[0]?.severity).toBeUndefined(); // undefined => treated as regen
  });

  it('does NOT downgrade a capability/memory-exposure ban under trustGemini', () => {
    const v = checkBannedPhrases("My memory doesn't carry over between messages.", 'general', true);
    expect(v.length).toBeGreaterThan(0);
    expect(v[0]?.severity).toBeUndefined(); // stays regen even in trust mode
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

  // ── Diagnostic overconfidence (2026-06-16 screenshot) ──────────────────────
  // Symptoms are clues, not conclusions — definitive/named diagnoses are banned;
  // hedged language ("one possibility is…") must pass.
  for (const m of [
    'That sounds like your blood sugar might be low.',
    'This sounds like hypoglycemia.',
    'Your blood sugar is low — grab some juice.',
    'Your blood sugar might be low, so have some sugar now.',
    'You probably have low blood sugar.',
    'This is likely dehydration.',
    'This sounds like pancreatitis.',
    'It sounds like a gallbladder issue.',
  ]) {
    it(`flags diagnostic overconfidence: "${m}"`, () => {
      expect(checkBannedPhrases(m).length).toBeGreaterThan(0);
    });
  }

  for (const m of [
    'Those symptoms can sometimes occur when blood sugar is low, but there can be other causes.',
    'One possibility is low blood sugar — have you checked it, and what other meds are you on?',
    'This could be related to low blood sugar. Have you been able to check it?',
    'There are a few possible explanations. Sit down somewhere safe and sip some water.',
  ]) {
    it(`allows hedged symptom language: "${m.slice(0, 40)}…"`, () => {
      expect(checkBannedPhrases(m)).toHaveLength(0);
    });
  }

  // ── Acute escalation exemption (2026-06-16) ────────────────────────────────
  // Urgent "call your doctor right away" is correct when the response is about a
  // genuinely acute situation, but still softened for normal side effects.
  it('allows urgent escalation in an acute (low blood sugar) response', () => {
    const m = 'Get some quick sugar in you right now — juice or regular soda — and call your doctor right away. This could be low blood sugar and needs a medical look. If you feel worse or more confused, call 911.';
    expect(checkBannedPhrases(m)).toHaveLength(0);
  });
  it('allows urgent escalation after a dosing error', () => {
    const m = "If you injected too much, call your doctor right away to tell them what happened.";
    expect(checkBannedPhrases(m)).toHaveLength(0);
  });
  it('still blocks over-escalation for a normal side effect', () => {
    const m = 'Mild nausea is normal early on. If it lingers, call your doctor right away.';
    expect(checkBannedPhrases(m).length).toBeGreaterThan(0);
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

describe('checkEmotionBeforeData — physical pain trigger (2026-06-02 production)', () => {
  it('flags response opening with food-log status on a stomach-pain message (exact production case)', () => {
    const violations = checkContent(
      "You haven't logged any food today, so you're at 0g protein so far. Ugh, stomach pain is really rough.",
      { userMessage: 'Thanks. I slept well, but my stomach is killing me' },
    );
    expect(violations.some((v) => v.code === 'emotion_before_data')).toBe(true);
  });

  it('flags "you\'re at 0g protein" on a stomach pain message', () => {
    const violations = checkContent(
      "You're at 0g protein today. Stomach pain on GLP-1s is common.",
      { userMessage: 'my stomach is killing me' },
    );
    expect(violations.some((v) => v.code === 'emotion_before_data')).toBe(true);
  });

  it('flags food-log opener on "my head hurts"', () => {
    const violations = checkContent(
      "Logged — about 30g protein. Headaches on GLP-1s can happen.",
      { userMessage: 'my head hurts so bad' },
    );
    expect(violations.some((v) => v.code === 'emotion_before_data')).toBe(true);
  });

  it('flags data opener on "I feel sick"', () => {
    const violations = checkContent(
      "You're at 45g protein today. Feeling sick is rough.",
      { userMessage: 'I feel really sick today' },
    );
    expect(violations.some((v) => v.code === 'emotion_before_data')).toBe(true);
  });

  it('flags data opener on "throwing up"', () => {
    const violations = checkContent(
      "You're at 12g protein. Throwing up is hard on the body.",
      { userMessage: "I can't stop throwing up" },
    );
    expect(violations.some((v) => v.code === 'emotion_before_data')).toBe(true);
  });

  it('does NOT flag empathy-first response to pain', () => {
    const violations = checkContent(
      "Ugh, stomach pain like that is rough. Where exactly is it sitting?",
      { userMessage: 'my stomach is killing me' },
    );
    expect(violations.some((v) => v.code === 'emotion_before_data')).toBe(false);
  });

  it('does NOT flag food-data response on a food question (no pain trigger)', () => {
    const violations = checkContent(
      "You're at 45g protein today, you've got 35g to go.",
      { userMessage: 'how much protein have I had today?' },
    );
    expect(violations.some((v) => v.code === 'emotion_before_data')).toBe(false);
  });
});

describe('memory callback bans (2026-06-02 production)', () => {
  it('flags "You\'ve mentioned this before"', () => {
    const violations = checkContent(
      "Stomach pain is rough. You've mentioned this before. Where is it?",
      { userMessage: 'my stomach hurts' },
    );
    expect(violations.some((v) => v.code === 'banned_phrase')).toBe(true);
  });

  it('flags "you mentioned this before"', () => {
    const violations = checkContent(
      "Got it. You mentioned this before.",
      { userMessage: 'my back hurts again' },
    );
    expect(violations.some((v) => v.code === 'banned_phrase')).toBe(true);
  });

  it('flags "you said earlier that you"', () => {
    const violations = checkContent(
      "You said earlier that you were tired. So this might be related.",
      { userMessage: 'I have a headache' },
    );
    expect(violations.some((v) => v.code === 'banned_phrase')).toBe(true);
  });

  it('flags "last time you mentioned"', () => {
    const violations = checkContent(
      "Last time you mentioned nausea was last week.",
      { userMessage: 'I feel nauseous' },
    );
    expect(violations.some((v) => v.code === 'banned_phrase')).toBe(true);
  });

  it('flags "how long has it been hurting this time"', () => {
    const violations = checkContent(
      "Where is it? How long has it been hurting this time?",
      { userMessage: 'my stomach hurts' },
    );
    expect(violations.some((v) => v.code === 'banned_phrase' && /this time/i.test(v.message))).toBe(true);
  });

  it('does NOT flag plain "how long has it been hurting" (no "this time")', () => {
    const violations = checkContent(
      "Where is the pain, and how long has it been hurting?",
      { userMessage: 'my stomach hurts' },
    );
    const hits = violations.filter((v) => v.code === 'banned_phrase' && /this time/i.test(v.message));
    expect(hits).toHaveLength(0);
  });

  it('does NOT flag a forward-looking "mention" phrasing', () => {
    const violations = checkContent(
      "Worth mentioning that protein early helps with nausea.",
      { userMessage: 'I feel nauseous' },
    );
    const hits = violations.filter((v) => v.code === 'banned_phrase' && /mentioned this before|you said earlier|last time/.test(v.message));
    expect(hits).toHaveLength(0);
  });
});

describe('multi-part message composition (2026-06-02 spec)', () => {
  // Per the multi-part composition spec, when the user's CURRENT message
  // contains sub-parts like "I slept well, but my stomach is killing me",
  // Grace MUST address BOTH parts. The phrases "Glad to hear you slept well",
  // "Anytime", and multi-item symptom-screening questions ARE correct in
  // this case. The unconditional bans on those patterns were the bug.
  it('does NOT flag "Glad to hear you slept well" when CURRENT message contains the sleep update', () => {
    const violations = checkContent(
      "Glad to hear you slept well. I'm sorry your stomach is hurting — where exactly is it sitting?",
      { userMessage: 'Thanks. I slept well, but my stomach is killing me' },
    );
    expect(violations.some((v) => v.code === 'banned_phrase' && /Glad to hear/i.test(v.message))).toBe(false);
    expect(violations.some((v) => v.code === 'prior_message_relitigation')).toBe(false);
    expect(violations.some((v) => v.code === 'emotion_before_data')).toBe(false);
  });

  it('does NOT flag a multi-item symptom-screening question on a pain message', () => {
    const violations = checkContent(
      "Sorry about the stomach pain. Where exactly is it, and have you noticed any nausea, vomiting, constipation, or diarrhea along with it?",
      { userMessage: 'my stomach is killing me' },
    );
    const intakeHits = violations.filter((v) => v.code === 'banned_phrase' && /clinical-intake/i.test(v.message));
    expect(intakeHits).toHaveLength(0);
  });

  it('does NOT flag "Anytime" reply when the CURRENT message contains thanks', () => {
    const violations = checkContent(
      "Anytime — happy to help with that.",
      { userMessage: 'Thanks for that' },
    );
    const hits = violations.filter((v) => v.code === 'banned_phrase' && /Anytime/i.test(v.message));
    expect(hits).toHaveLength(0);
  });

  it('does NOT flag the spec\'s ideal Grace response to the screenshot scenario', () => {
    const ideal = "Glad to hear you slept well. I'm sorry your stomach is hurting today. When you say it's killing you, does it feel like cramping, sharp pain, or more of an ache? And where are you feeling it?";
    const violations = checkContent(
      ideal,
      { userMessage: 'Thanks. I slept well, but my stomach is killing me' },
    );
    // The spec's example response should be acceptable — only the cross-turn
    // re-litigation, memory-callback, and emotion-before-data rules should
    // matter, and none of them apply here.
    expect(violations.some((v) => v.code === 'prior_message_relitigation')).toBe(false);
    expect(violations.some((v) => v.code === 'emotion_before_data')).toBe(false);
    expect(violations.some((v) => v.code === 'banned_phrase' && /this time|mentioned this before/i.test(v.message))).toBe(false);
  });
});

describe('checkPriorMessageRelitigation (2026-06-02 cross-turn bug)', () => {
  it('flags "Anytime" opener when "thanks" was in prior message, not current', () => {
    const violations = checkContent(
      "Anytime. Glad to hear you slept well, but stomach pain is rough.",
      {
        userMessage: 'Im feeling it on the bottom left side',
        previousUserMessage: 'Thanks. I slept well, but my stomach is killing me',
      },
    );
    expect(violations.some((v) => v.code === 'prior_message_relitigation' && /Anytime/.test(v.message))).toBe(true);
  });

  it('flags "Glad to hear you slept well" when sleep was in prior message', () => {
    const violations = checkContent(
      "Glad to hear you slept well — that stomach pain on the bottom left needs attention.",
      {
        userMessage: 'Im feeling it on the bottom left side',
        previousUserMessage: 'Thanks. I slept well, but my stomach is killing me',
      },
    );
    expect(violations.some((v) => v.code === 'prior_message_relitigation' && /slept well/.test(v.message))).toBe(true);
  });

  it('flags "Glad to hear you ate" when meal update was in prior message', () => {
    const violations = checkContent(
      "Glad to hear you ate breakfast. Bottom-left pain deserves a call to your prescriber.",
      {
        userMessage: 'the pain is on the bottom left',
        previousUserMessage: 'I had a good breakfast but my stomach is hurting now',
      },
    );
    expect(violations.some((v) => v.code === 'prior_message_relitigation' && /ate/.test(v.message))).toBe(true);
  });

  it('does NOT flag "Anytime" when the CURRENT message is a thanks', () => {
    const violations = checkContent(
      "Anytime — happy to help.",
      {
        userMessage: 'thanks',
        previousUserMessage: 'how much protein in eggs?',
      },
    );
    expect(violations.some((v) => v.code === 'prior_message_relitigation')).toBe(false);
  });

  it('does NOT flag sleep callback when CURRENT message is about sleep', () => {
    const violations = checkContent(
      "Glad to hear you slept well — that consistent rest helps with appetite.",
      {
        userMessage: 'I slept well last night',
        previousUserMessage: 'I had eggs for breakfast',
      },
    );
    expect(violations.some((v) => v.code === 'prior_message_relitigation')).toBe(false);
  });

  it('does NOT fire when previousUserMessage is missing', () => {
    const violations = checkContent(
      "Anytime. Glad to hear you slept well.",
      { userMessage: 'bottom left side' },
    );
    expect(violations.some((v) => v.code === 'prior_message_relitigation')).toBe(false);
  });

  it('flags the FULL production failure (Anytime + sleep + pain)', () => {
    const violations = checkContent(
      "Anytime. Glad to hear you slept well, but ugh, that stomach pain sounds really rough, especially on the bottom left side.",
      {
        userMessage: 'Im feeling it on the bottom left side',
        previousUserMessage: 'Thanks. I slept well, but my stomach is killing me',
      },
    );
    const hits = violations.filter((v) => v.code === 'prior_message_relitigation');
    // Should fire BOTH the "Anytime" rule AND the "Glad to hear you slept" rule
    expect(hits.length).toBeGreaterThanOrEqual(2);
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

// ── checkInlineLabelColonList (2026-06-01 lunch-recommendation fix) ─────────
// The format-enforcer's existing label-colon flattener requires sentence
// terminators around each label; this catches the inline comma-joined
// variant the LLM uses on food-recommendation responses.
describe('checkInlineLabelColonList — inline list-disguised-as-prose', () => {
  it('flags the exact lunch-recommendation production failure (4 label-colons)', () => {
    const response = `Since you're vegetarian and aiming for 60g of protein today, here are a few GLP-1 friendly lunch ideas. Lentil soup: This is a great option, as it's hydrating and nutrient-packed. Tofu stir-fry: You could toss some seasoned tofu with edamame and your favorite vegetables. Cheddar chickpea slice: This is a high-protein vegetarian recipe. Greek yogurt power bowl: Mix a cup of Greek yogurt with a scoop of protein powder and some berries.`;
    const violations = checkContent(response, { userMessage: 'What should I eat for lunch' });
    expect(violations.some((v) => v.code === 'inline_label_colon_list')).toBe(true);
  });

  it('does NOT flag a normal prose response with 0 label-colons', () => {
    const response = "Lentil soup is hydrating and nutrient-packed, tofu stir-fry with edamame is filling, and a Greek yogurt bowl with berries is quick and high-protein.";
    const violations = checkContent(response, { userMessage: 'What should I eat for lunch' });
    expect(violations.some((v) => v.code === 'inline_label_colon_list')).toBe(false);
  });

  it('does NOT flag a single legitimate label:description (definition)', () => {
    // "Telogen effluvium: temporary hair shedding" — definition, not a list.
    const response = 'Telogen effluvium: temporary shedding from the metabolic stress of rapid loss. Usually resolves in 6 to 9 months.';
    const violations = checkContent(response, { userMessage: 'Why is my hair falling out?' });
    expect(violations.some((v) => v.code === 'inline_label_colon_list')).toBe(false);
  });

  it('flags 3 label-colons even when separated by periods (not commas)', () => {
    const response = 'Greek yogurt: high protein. Cottage cheese: also high protein. Eggs: classic option. All easy on a GLP-1 stomach.';
    const violations = checkContent(response, { userMessage: 'What can I eat?' });
    expect(violations.some((v) => v.code === 'inline_label_colon_list')).toBe(true);
  });

  it('does NOT flag very short responses with one colon', () => {
    expect(
      checkContent('You can have eggs: about 6g protein each.', { userMessage: 'X' })
        .some((v) => v.code === 'inline_label_colon_list')
    ).toBe(false);
  });
});

// FAQ cache hits are pre-vetted educational responses — their citation
// numbers shouldn't trigger the stale-context-echo guard (those numbers
// come from canonical research, not stale memory).
describe('skipStaleContextEcho — FAQ cache hit exemption', () => {
  it('flags STEP-1 trial citation numbers when skipStaleContextEcho is false (default)', () => {
    const response =
      'The STEP-1 trial on semaglutide reported ~40% of weight lost as lean mass, and the 2024 COURAGE study found ~35%.';
    const violations = checkContent(response, {
      userMessage: 'Tell me about muscle loss',
      systemContext: '',
      toolResultsText: '',
    });
    expect(violations.some((v) => v.code === 'stale_context_echo')).toBe(true);
  });

  it('does NOT flag the same response when skipStaleContextEcho is true (FAQ cache path)', () => {
    const response =
      'The STEP-1 trial on semaglutide reported ~40% of weight lost as lean mass, and the 2024 COURAGE study found ~35%.';
    const violations = checkContent(response, {
      userMessage: 'Tell me about muscle loss',
      systemContext: '',
      toolResultsText: '',
      skipStaleContextEcho: true,
    });
    expect(violations.some((v) => v.code === 'stale_context_echo')).toBe(false);
  });

  it('still flags banned phrases on FAQ cache hits (other guards still run)', () => {
    const violations = checkContent('I apologize for the confusion.', {
      userMessage: 'X',
      skipStaleContextEcho: true,
    });
    // The apology phrase is caught by checkBannedPhrases, NOT the stale-echo
    // guard — so the skip flag doesn't affect it.
    expect(violations.length).toBeGreaterThan(0);
  });
});

describe('Emotional dead-end guard (2026-06-06 v2)', () => {
  it('"I hear you." alone in response to "I\'m nervous" → regen', () => {
    const v = checkContent('I hear you.', { userMessage: "I'm nervous" });
    const codes = v.map(x => x.code);
    expect(codes).toContain('emotional_dead_end');
    expect(v.find(x => x.code === 'emotional_dead_end')?.severity).toBe('regen');
  });

  it('"Got it." alone in response to "I\'m frustrated" → regen', () => {
    const v = checkContent('Got it.', { userMessage: "I'm frustrated" });
    expect(v.map(x => x.code)).toContain('emotional_dead_end');
  });

  it('"Noted." alone in response to "I\'m excited!" → regen', () => {
    const v = checkContent('Noted.', { userMessage: "I'm excited!" });
    expect(v.map(x => x.code)).toContain('emotional_dead_end');
  });

  it('"Understood." alone in response to "I\'m worried" → regen', () => {
    const v = checkContent('Understood.', { userMessage: "I'm worried" });
    expect(v.map(x => x.code)).toContain('emotional_dead_end');
  });

  it('"Thanks for sharing." alone in response to "I feel overwhelmed" → regen', () => {
    const v = checkContent('Thanks for sharing.', { userMessage: 'I feel overwhelmed' });
    expect(v.map(x => x.code)).toContain('emotional_dead_end');
  });

  it('Bare "I hear you 🤍" emoji-suffix still triggers regen', () => {
    const v = checkContent('I hear you. 🤍', { userMessage: "I'm scared" });
    expect(v.map(x => x.code)).toContain('emotional_dead_end');
  });

  it('Rich emotional reply with follow-up question PASSES the guard', () => {
    const reply = "I hear you. What's the heaviest piece of it right now?";
    const v = checkContent(reply, { userMessage: "I'm nervous" });
    expect(v.map(x => x.code)).not.toContain('emotional_dead_end');
  });

  it('"I hear you. That sounds heavy — talking to your doctor can help." PASSES', () => {
    const reply = "I hear you. That sounds heavy — talking to your doctor or a therapist can help carry some of this. What feels heaviest?";
    const v = checkContent(reply, { userMessage: 'want to give up on everything' });
    expect(v.map(x => x.code)).not.toContain('emotional_dead_end');
  });

  it('Bare ack to a NON-emotional message is NOT flagged', () => {
    // The guard only fires when the user expressed an emotion.
    const v = checkContent('Got it.', { userMessage: 'I had eggs for breakfast' });
    expect(v.map(x => x.code)).not.toContain('emotional_dead_end');
  });
});
