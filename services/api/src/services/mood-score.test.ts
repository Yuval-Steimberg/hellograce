import { describe, it, expect } from 'vitest';
import { parseMoodScore } from './ai.service.js';

describe('parseMoodScore — only an EXPLICIT 1-10 mood, never casual small talk', () => {
  it('parses an N/10 or N out of 10', () => {
    expect(parseMoodScore('7/10', null)).toBe(7);
    expect(parseMoodScore("I'd say a 4 out of 10 today", null)).toBe(4);
    expect(parseMoodScore('feeling like a 3/10', null)).toBe(3);
    expect(parseMoodScore('10/10 today', null)).toBe(10);
  });

  it('parses a labelled mood number', () => {
    expect(parseMoodScore('my mood is a 6', null)).toBe(6);
    expect(parseMoodScore('mood: 8', null)).toBe(8);
    expect(parseMoodScore('feeling 2 honestly', null)).toBe(2);
  });

  it('parses a bare 1-10 ONLY when Grace just asked about mood on a scale', () => {
    const asked = 'On a scale of 1-10, how would you rate your mood today?';
    expect(parseMoodScore('7', asked)).toBe(7);
    expect(parseMoodScore("I'm a 5", asked)).toBe(5);
    expect(parseMoodScore('maybe 4', asked)).toBe(4);
    // Without the mood question, a bare number is NOT a mood log.
    expect(parseMoodScore('7', 'How many eggs did you have?')).toBeNull();
    expect(parseMoodScore('7', null)).toBeNull();
  });

  it('never logs casual feeling small talk as a mood score', () => {
    expect(parseMoodScore("I'm feeling good", null)).toBeNull();
    expect(parseMoodScore('feeling great today', null)).toBeNull();
    expect(parseMoodScore('not bad', null)).toBeNull();
    expect(parseMoodScore('pretty tired', null)).toBeNull();
  });

  it('rejects out-of-range or non-mood numbers', () => {
    expect(parseMoodScore('I ate 200 calories', null)).toBeNull();
    expect(parseMoodScore('my mood is 50', null)).toBeNull(); // 50 not 1-10
    expect(parseMoodScore('I weigh 185', null)).toBeNull();
  });
});
