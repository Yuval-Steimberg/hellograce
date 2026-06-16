import { describe, it, expect } from 'vitest';
import {
  detectHypoglycemiaWarning,
  mightBeHypoSymptom,
  isWhatShouldIDo,
} from './hypoglycemia-warning.js';

const NO_DIAGNOSIS_AS_FACT = /\byour blood sugar (is|might be|may be) (low|high)\b|that sounds like (your )?(low |)blood sugar|this is (likely|probably) (low blood sugar|hypoglycemia)/i;

describe('detectHypoglycemiaWarning — direct symptom cluster', () => {
  it('the exact production case fires (shaky + sweaty + lightheaded)', () => {
    const r = detectHypoglycemiaWarning("I'm shaky, sweaty and light headed");
    expect(r.warning).toBe(true);
    // Actionable + hedged + empathetic + escalation.
    expect(r.response).toMatch(/quick sugar/i);
    expect(r.response).toMatch(/call your doctor/i);
    expect(r.response).toMatch(/could be|can sometimes be/i); // hedged label
    expect(r.response).toMatch(/911/);
    expect(r.response).not.toMatch(NO_DIAGNOSIS_AS_FACT); // never states the diagnosis as fact
  });

  it('fires on other 2+ symptom combos', () => {
    expect(detectHypoglycemiaWarning('feeling really shaky and weak').warning).toBe(true);
    expect(detectHypoglycemiaWarning('sweaty and dizzy all of a sudden').warning).toBe(true);
    expect(detectHypoglycemiaWarning('my heart is racing and I feel confused').warning).toBe(true);
  });

  it('does NOT fire on a single ambiguous symptom', () => {
    expect(detectHypoglycemiaWarning('I feel shaky').warning).toBe(false);
    expect(detectHypoglycemiaWarning("I'm a little dizzy").warning).toBe(false);
  });

  it('does NOT fire on unrelated messages', () => {
    expect(detectHypoglycemiaWarning('I had eggs for breakfast').warning).toBe(false);
    expect(detectHypoglycemiaWarning('when is my next reminder?').warning).toBe(false);
  });
});

describe('detectHypoglycemiaWarning — "what should I do?" follow-up', () => {
  it('fires after Grace mentioned low blood sugar', () => {
    const r = detectHypoglycemiaWarning(
      'What should I do',
      'You might be experiencing symptoms of low blood sugar or dehydration.',
    );
    expect(r.warning).toBe(true);
    expect(r.followUp).toBe(true);
    expect(r.response).toMatch(/quick sugar/i);
    expect(r.response).toMatch(/call your doctor immediately/i);
    expect(r.response).toMatch(/could be low blood sugar/i);
  });

  it('fires after the user themselves reported the symptom cluster', () => {
    const r = detectHypoglycemiaWarning('what do I do', undefined, "I'm shaky, sweaty and lightheaded");
    expect(r.warning).toBe(true);
    expect(r.followUp).toBe(true);
  });

  it('does NOT fire when there is no hypo context', () => {
    expect(detectHypoglycemiaWarning('what should I do', 'Your protein today is 80g.').warning).toBe(false);
    expect(detectHypoglycemiaWarning('what should I do').warning).toBe(false);
  });
});

describe('cheap gates', () => {
  it('mightBeHypoSymptom matches any warning word', () => {
    expect(mightBeHypoSymptom('shaky')).toBe(true);
    expect(mightBeHypoSymptom('I had a sandwich')).toBe(false);
  });
  it('isWhatShouldIDo matches the follow-up shapes', () => {
    expect(isWhatShouldIDo('What should I do')).toBe(true);
    expect(isWhatShouldIDo('what do I do?')).toBe(true);
    expect(isWhatShouldIDo('help')).toBe(true);
    expect(isWhatShouldIDo('what should I eat for dinner with my family tonight')).toBe(false);
  });
});
