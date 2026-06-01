import { describe, it, expect } from 'vitest';
import { tryFastPath } from './fast-path.js';

const USER = '+15551234567';

describe('tryFastPath — greeting prefix + typo normalization (2026-06-01 fix)', () => {
  it('matches "Morning, feeling good" (greeting prefix + brief_positive)', () => {
    const result = tryFastPath('Morning, feeling good', USER);
    expect(result).not.toBeNull();
    expect(result?.category).toBe('brief_positive');
  });

  it('matches "Morning, felling good" (typo: felling → feeling)', () => {
    // Exact production failure: this missed fast-path → full LLM → 6-sentence
    // response that surfaced stale "40g" context from a previous day.
    const result = tryFastPath('Morning, felling good', USER);
    expect(result).not.toBeNull();
    expect(result?.category).toBe('brief_positive');
  });

  it('matches "Good morning, feeling great"', () => {
    const result = tryFastPath('Good morning, feeling great', USER);
    expect(result).not.toBeNull();
    expect(result?.category).toBe('brief_positive');
  });

  it('matches "Evening, doing good"', () => {
    const result = tryFastPath('Evening, doing good', USER);
    expect(result).not.toBeNull();
    expect(result?.category).toBe('brief_positive');
  });

  it('matches "Good morning. Feeling tired" → brief_negative (greeting + tired)', () => {
    const result = tryFastPath('Good morning. Feeling tired', USER);
    expect(result).not.toBeNull();
    expect(result?.category).toBe('brief_negative');
  });

  it('still matches plain "Morning" → greeting (no positive suffix)', () => {
    const result = tryFastPath('Morning', USER);
    expect(result).not.toBeNull();
    expect(result?.category).toBe('greeting');
  });

  it('still matches plain "feeling good" without a greeting prefix', () => {
    const result = tryFastPath('feeling good', USER);
    expect(result).not.toBeNull();
    expect(result?.category).toBe('brief_positive');
  });

  it('does NOT match medical or food-related messages even with greeting prefix', () => {
    // The NEVER_FAST_PATH_RE keyword guard must still apply after normalization.
    expect(tryFastPath('Morning, feeling nauseous', USER)).toBeNull();
    expect(tryFastPath('Morning, I had two eggs for breakfast', USER)).toBeNull();
    expect(tryFastPath('Good morning, my injection is due today', USER)).toBeNull();
  });

  it('does NOT match a message ending with a question mark', () => {
    expect(tryFastPath('Morning, feeling good?', USER)).toBeNull();
  });
});
