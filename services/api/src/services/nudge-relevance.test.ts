import { describe, it, expect } from 'vitest';
import { isMealAdviceOrPlanningTurn } from './nudge-relevance.js';

describe('isMealAdviceOrPlanningTurn — Nudge advice/planning guard', () => {
  it('advice/planning is a planning turn (do not log)', () => {
    expect(isMealAdviceOrPlanningTurn('what should I eat for lunch?', [])).toBe(true);
    expect(isMealAdviceOrPlanningTurn('any snack ideas?', [])).toBe(true);
    expect(isMealAdviceOrPlanningTurn('is chicken good?', [])).toBe(true);
    expect(isMealAdviceOrPlanningTurn('thinking of having salmon later', [])).toBe(true);
    expect(isMealAdviceOrPlanningTurn('what should I have for dinner tomorrow', [])).toBe(true);
  });

  it('a reported meal is NOT planning (log it)', () => {
    expect(isMealAdviceOrPlanningTurn('I ate 2 eggs for breakfast and chicken and rice for lunch', [])).toBe(false);
    expect(isMealAdviceOrPlanningTurn('had a chicken sandwich', [])).toBe(false);
    expect(isMealAdviceOrPlanningTurn('2 eggs for breakfast', [])).toBe(false);
  });

  it('a bare food answer after Grace asked what she has in mind is planning', () => {
    const history = [{ role: 'assistant', content: 'nice — what kind of fish do you have in mind?' }];
    expect(isMealAdviceOrPlanningTurn('salmon', history)).toBe(true);
  });

  it('a bare food answer with NO planning context is not planning', () => {
    expect(isMealAdviceOrPlanningTurn('salmon', [{ role: 'assistant', content: 'how much chicken did you have?' }])).toBe(false);
  });
});
