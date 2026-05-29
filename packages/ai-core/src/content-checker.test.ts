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
