import { describe, it, expect } from 'vitest';
import {
  detectMealConsumption,
  detectConsumptionFeedback,
  extractFoodMention,
  foodSpanFromConsumption,
  isConsumptionConfirmed,
  isPreferenceLanguage,
  isBareConsumptionBackReference,
  mentionsFood,
} from './meal-lifecycle.js';

describe('foodSpanFromConsumption — never-drop backstop for "I ate X … <question>"', () => {
  it('extracts the eaten meal, slicing off the trailing question (prod: salmon)', () => {
    expect(
      foodSpanFromConsumption('I had salmon with potatoes and salad. How much protein is that roughly, and what should I eat later?'),
    ).toBe('I had salmon with potatoes and salad');
  });
  it('handles a mid-sentence question clause with no period', () => {
    expect(foodSpanFromConsumption('I ate chicken and rice how much protein was that')).toBe('I ate chicken and rice');
    expect(foodSpanFromConsumption('just had a greek yogurt, any idea what to eat next?')).toBe('just had a greek yogurt');
  });
  it('returns null for a PURE question (nothing eaten)', () => {
    expect(foodSpanFromConsumption('what should I eat later?')).toBeNull();
    expect(foodSpanFromConsumption('what did I eat today?')).toBeNull();
    expect(foodSpanFromConsumption('how much protein is in salmon?')).toBeNull();
  });
  it('returns null for preference / planning language (never log interest)', () => {
    expect(foodSpanFromConsumption('salmon sounds good, maybe later')).toBeNull();
    expect(foodSpanFromConsumption("I think I'll have the salmon")).toBeNull();
  });
  it('returns null when a consumption verb names no real food', () => {
    expect(foodSpanFromConsumption('I had a really rough day, any advice?')).toBeNull();
    expect(foodSpanFromConsumption('I had a great time at the gym')).toBeNull();
  });
  it('is voided by negation ("I did not eat")', () => {
    expect(foodSpanFromConsumption("I haven't had lunch yet, what should I make?")).toBeNull();
  });
  it('keeps a plain consumption statement intact when there is no question', () => {
    expect(foodSpanFromConsumption('I ate 3 eggs and a banana')).toBe('I ate 3 eggs and a banana');
  });
});

describe('detectConsumptionFeedback — follow-up after trying a suggestion', () => {
  // The exact production failure + the spec's example set. General across
  // phrasing, not hardcoded to "smoothie".
  const YES = [
    'Thanks I feel good after drinking smoothie',
    'Thanks, I tried it',
    'I feel better after eating that',
    'The smoothie was good',
    'That worked',
    'I drank the one you suggested',
    'I feel good after that',
    'It helped',
    'the oatmeal was great',
    'I tried the omelet you recommended',
    'feeling full after the wrap, that worked well',
  ];
  for (const m of YES) {
    it(`"${m}" → consumption feedback`, () => expect(detectConsumptionFeedback(m)).toBe(true));
  }

  const NO = [
    'What should I have for breakfast?', // new request
    'Can you give me dinner ideas', // new request
    "I don't feel good after eating that", // negated → symptom, not positive feedback
    "I haven't tried it yet", // negated
    'I ate two eggs and toast', // plain food log, no feedback phrasing
    'what kind of smoothie is best', // question / new request
  ];
  for (const m of NO) {
    it(`"${m}" → NOT consumption feedback`, () => expect(detectConsumptionFeedback(m)).toBe(false));
  }
});

describe('extractFoodMention', () => {
  it('pulls the named dish for echo-back', () => {
    expect(extractFoodMention('I feel good after drinking smoothie')).toBe('smoothie');
    expect(extractFoodMention('the omelet was great')).toBe('omelet');
  });
  it('returns null for generic meal words (no concrete dish)', () => {
    expect(extractFoodMention('that breakfast was great')).toBeNull();
    expect(extractFoodMention('it worked')).toBeNull();
  });
});

describe('mentionsFood — food-context gate', () => {
  it('detects named foods / dishes', () => {
    expect(mentionsFood('halloumi and roasted vegetable plate')).toBe(true);
    expect(mentionsFood('the omelet')).toBe(true);
    expect(mentionsFood('lentil dal')).toBe(true);
    expect(mentionsFood('chicken bowl')).toBe(true);
  });
  it('returns false for bare affirmations with no food', () => {
    expect(mentionsFood('that sounds good')).toBe(false);
    expect(mentionsFood('that works')).toBe(false);
    expect(mentionsFood('might make')).toBe(false);
  });
});

describe('detectMealConsumption — preference (never log)', () => {
  const PREFERENCE = [
    'That sounds good.',
    'Halloumi and roasted vegetable plate sounds good',
    'Maybe the lentil dal.',
    'I like the omelet option.',
    'I might make that.',
    'Sounds good',
    'Looks good',
    'I like that',
    'Maybe',
    "I'll try that",
    "I think I'll have that",
    'Considering it',
    'Planning to eat that',
    'I might make it',
    'That works',
    "I'll go with the omelet",
    "I'm gonna have the salmon",
    'Going with the chicken bowl',
    // Picking a suggested option (production: user replied to breakfast ideas).
    'Overnight oats will work',
    'The oats work for me',
    'Greek yogurt works for now',
    "That'll do",
  ];
  for (const m of PREFERENCE) {
    it(`"${m}" → preference`, () => {
      expect(detectMealConsumption(m)).toBe('preference');
      expect(isPreferenceLanguage(m)).toBe(true);
      expect(isConsumptionConfirmed(m)).toBe(false);
    });
  }
});

describe('detectMealConsumption — consumption (log)', () => {
  const CONSUMED = [
    'I ate the lentil dal.',
    'Just finished dinner.',
    'Log the halloumi plate.',
    'Had the omelet.',
    'I ended up eating it.',
    'I had two eggs',
    'For dinner I had chicken and rice',
    'Finished eating my lunch',
    'Ended up having the salmon',
    'Track my lunch — a chicken wrap',
    'Add that to my log',
    "I'm eating a protein shake",
  ];
  for (const m of CONSUMED) {
    it(`"${m}" → consumed`, () => {
      expect(detectMealConsumption(m)).toBe('consumed');
      expect(isConsumptionConfirmed(m)).toBe(true);
    });
  }
});

describe('detectMealConsumption — consumption wins over preference', () => {
  it('eating phrasing dominates an embedded "sounds good"', () => {
    expect(detectMealConsumption('I ended up eating the dal that sounded good')).toBe('consumed');
  });
  it('"I had it, it was good" is consumption not preference', () => {
    expect(detectMealConsumption('I had the omelet, it was good')).toBe('consumed');
  });
});

describe('detectMealConsumption — negation voids consumption', () => {
  it('"I didn\'t eat it" is not consumption', () => {
    expect(isConsumptionConfirmed("I didn't eat the dal")).toBe(false);
  });
  it('"haven\'t had it yet" is not consumption', () => {
    expect(isConsumptionConfirmed("I haven't had it yet")).toBe(false);
  });
});

describe('detectMealConsumption — neither (plain logs / unrelated)', () => {
  // A plain food log has no preference words — the dedicated food-log paths
  // handle it, so the lifecycle classifier returns 'neither'.
  it('a bare food list is neither preference nor (lifecycle) consumption-phrase', () => {
    // "2 eggs and toast" has no eat verb and no preference word.
    expect(detectMealConsumption('2 eggs and toast')).toBe('neither');
  });
  it('unrelated chatter is neither', () => {
    expect(detectMealConsumption('how are you today')).toBe('neither');
    expect(detectMealConsumption('')).toBe('neither');
  });
});

describe('isBareConsumptionBackReference', () => {
  const YES = [
    'I ended up making it',
    'had it',
    'ate it',
    'I finished it',
    'made it',
    'I ended up having it.',
    'finished the dish',
  ];
  for (const m of YES) {
    it(`"${m}" → bare back-reference`, () => expect(isBareConsumptionBackReference(m)).toBe(true));
  }
  const NO = [
    'I ate two eggs and toast', // names a food
    "I'll make it", // future preference, not consumption
    "I didn't make it", // negated
    'I ended up making a big pot of chili with beans and rice for the week', // too long / names food
  ];
  for (const m of NO) {
    it(`"${m}" → NOT a bare back-reference`, () => expect(isBareConsumptionBackReference(m)).toBe(false));
  }
});
