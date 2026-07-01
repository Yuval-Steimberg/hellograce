import { describe, it, expect } from 'vitest';
import { isAcceptableRephrase, buildRephraseSystem } from './rephrase.js';

describe('isAcceptableRephrase — never ship a bad rewrite (fall back to the grounded template)', () => {
  it('accepts a normal warm rewrite', () => {
    expect(isAcceptableRephrase("Nice — you're at 82g protein today, almost at your 100g goal.")).toBe(true);
  });

  it('rejects empty / stub output', () => {
    expect(isAcceptableRephrase('')).toBe(false);
    expect(isAcceptableRephrase('   ')).toBe(false);
    expect(isAcceptableRephrase('ok')).toBe(false);
    expect(isAcceptableRephrase(null)).toBe(false);
    expect(isAcceptableRephrase(undefined)).toBe(false);
  });

  it('rejects robotic AI-speak', () => {
    expect(isAcceptableRephrase('As an AI, I can help you with that.')).toBe(false);
    expect(isAcceptableRephrase("I'm just an AI language model, but here goes.")).toBe(false);
  });

  it('rejects data / capability denials (the cardinal sin)', () => {
    expect(isAcceptableRephrase("I can't access your personal data, sorry.")).toBe(false);
    expect(isAcceptableRephrase("I don't have access to your logs.")).toBe(false);
    expect(isAcceptableRephrase('I cannot see your diary or health data.')).toBe(false);
  });
});

describe('buildRephraseSystem', () => {
  it('embeds the grounded message and the intercept-specific guide, and forbids changing facts', () => {
    const sys = buildRephraseSystem('You have 82g protein today.', 'Keep the numbers exact.');
    expect(sys).toContain('You have 82g protein today.');
    expect(sys).toContain('Keep the numbers exact.');
    expect(sys.toLowerCase()).toMatch(/never add, drop, or change a number/);
    expect(sys.toLowerCase()).toMatch(/no markdown|no bullet points/);
  });
});
