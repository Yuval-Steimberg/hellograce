import { describe, it, expect } from 'vitest';
import type { ChatTurn } from '@grace/shared';
import {
  looksLikeRecommendation,
  isRecipeRequest,
  isRecommendationFollowUp,
  extractLastRecommendation,
  buildRecommendationAckAdvance,
  isMealSelection,
  extractSelectedFood,
  proteinAddOns,
} from './recommendation-context.js';

describe('looksLikeRecommendation', () => {
  it('flags recommendation-marker phrasing', () => {
    expect(looksLikeRecommendation("I'd recommend grilled salmon with quinoa.")).toBe(true);
    expect(looksLikeRecommendation('A few options: Greek yogurt, cottage cheese, eggs.')).toBe(true);
    expect(looksLikeRecommendation('You could try a tofu scramble for breakfast.')).toBe(true);
    expect(looksLikeRecommendation('How about a chicken-and-rice bowl tonight?')).toBe(true);
  });
  it('flags a comma list of short food phrases', () => {
    expect(looksLikeRecommendation('Greek yogurt, cottage cheese, edamame, hard-boiled eggs.')).toBe(true);
  });
  it('generalizes beyond food — flags exercise / wellness recommendations', () => {
    expect(looksLikeRecommendation('You could try resistance training a few times a week.')).toBe(true);
    expect(looksLikeRecommendation("I'd suggest a 10-minute walk after meals to help digestion.")).toBe(true);
    expect(looksLikeRecommendation('Consider sipping water throughout the day rather than gulping.')).toBe(true);
  });
  it('does NOT flag a plain acknowledgment or log confirmation', () => {
    expect(looksLikeRecommendation('Got it 👍')).toBe(false);
    expect(looksLikeRecommendation("You're at 45g protein today.")).toBe(false);
    expect(looksLikeRecommendation(null)).toBe(false);
  });
});

describe('isRecipeRequest', () => {
  for (const m of [
    'recipe?', "what's the recipe", 'how do I make it', 'how do I cook the salmon',
    'how should I prepare it', 'ingredients?', "what's in it", 'cooking instructions',
  ]) {
    it(`"${m}" → recipe request`, () => expect(isRecipeRequest(m)).toBe(true));
  }
  it('does not fire on unrelated text', () => {
    expect(isRecipeRequest('I had two eggs')).toBe(false);
  });
});

describe('isRecommendationFollowUp', () => {
  for (const m of [
    'recipe?', 'how do I make it?', 'any other ideas?', 'something else?',
    'tell me more', 'how much protein was in that?', 'that one', 'the first one',
    "I'm not a fan of that", 'what else?',
  ]) {
    it(`"${m}" → follow-up`, () => expect(isRecommendationFollowUp(m)).toBe(true));
  }
  it('does NOT fire on a fresh, unrelated request', () => {
    expect(isRecommendationFollowUp('what should I eat for dinner?')).toBe(false);
    expect(isRecommendationFollowUp('I weigh 180 lbs now')).toBe(false);
  });
  it('a long sentence that merely contains "it" is not a back-reference follow-up', () => {
    expect(
      isRecommendationFollowUp('I went to the store earlier today and it was really crowded so I left'),
    ).toBe(false);
  });
});

describe('extractLastRecommendation', () => {
  it('returns the most recent recommendation assistant turn', () => {
    const history: ChatTurn[] = [
      { role: 'user', content: 'dinner ideas?' } as ChatTurn,
      { role: 'assistant', content: "I'd recommend grilled salmon with quinoa and broccoli." } as ChatTurn,
      { role: 'user', content: 'okay' } as ChatTurn,
      { role: 'assistant', content: 'Got it 👍' } as ChatTurn,
    ];
    expect(extractLastRecommendation(history)).toMatch(/grilled salmon/);
  });
  it('returns null when no recommendation is present', () => {
    const history: ChatTurn[] = [
      { role: 'user', content: 'hi' } as ChatTurn,
      { role: 'assistant', content: 'Hey there.' } as ChatTurn,
    ];
    expect(extractLastRecommendation(history)).toBeNull();
  });
  it('builds a deterministic, advancing ack reply (offers recipe / more ideas)', () => {
    const r = buildRecommendationAckAdvance('+15551234567|sounds good');
    expect(r).toMatch(/recipe|ideas|options|make one/i);
    // Stable for the same seed.
    expect(buildRecommendationAckAdvance('+15551234567|sounds good')).toBe(r);
  });
  it('finds an exercise recommendation across a 10-message gap', () => {
    const history: ChatTurn[] = [
      { role: 'user', content: 'what workout should I do?' } as ChatTurn,
      { role: 'assistant', content: 'You could try resistance training 3x a week, starting light.' } as ChatTurn,
      ...Array.from({ length: 10 }, (_, i) =>
        (i % 2 === 0
          ? { role: 'user', content: `msg ${i}` }
          : { role: 'assistant', content: `reply ${i}` }) as ChatTurn,
      ),
    ];
    expect(extractLastRecommendation(history)).toMatch(/resistance training/);
  });
});

describe('meal selection (2026-06-15)', () => {
  it('detects a pick and extracts the food', () => {
    expect(isMealSelection('Lentil dal sounds good')).toBe(true);
    expect(extractSelectedFood('Lentil dal sounds good').toLowerCase()).toContain('lentil');
    expect(isMealSelection("I'll go with the omelet")).toBe(true);
    expect(extractSelectedFood("I'll go with the omelet").toLowerCase()).toContain('omelet');
  });
  it('is not a selection when it is a question or too long', () => {
    expect(isMealSelection('does that sound good?')).toBe(false);
    expect(isMealSelection('I had a really long day and I think lentil dal sounds good for many reasons honestly')).toBe(false);
  });
  it('diet-appropriate protein add-ons', () => {
    expect(proteinAddOns('vegan')).toMatch(/edamame|tofu|soy/i);
    expect(proteinAddOns('vegetarian')).toMatch(/yogurt|cottage|edamame/i);
    expect(proteinAddOns(null)).toMatch(/egg|yogurt|chicken/i);
  });
});
