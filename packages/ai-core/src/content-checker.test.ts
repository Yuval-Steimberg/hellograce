import { describe, it, expect } from 'vitest';
import type { DietaryRestriction } from '@grace/shared';
import {
  checkContent,
  checkDietaryViolations,
  checkBannedPhrases,
  checkLinkPlaceholder,
  checkPrivacyLeak,
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
