import { describe, it, expect } from 'vitest';
import { buildTurnDirective } from './ai.service.js';

describe('buildTurnDirective — pain/symptom suppression of food context', () => {
  it('emits the suppression directive on "my stomach is killing me"', () => {
    const out = buildTurnDirective('Thanks. I slept well, but my stomach is killing me');
    expect(out).toContain('PHYSICAL PAIN');
    expect(out).toContain('DO NOT reference today');
    expect(out).toContain('DO NOT surface memory');
    expect(out).toContain('DO NOT ask a multi-item clinical-intake');
    expect(out).toContain('DO NOT chain two questions');
  });

  it('emits directive on "my head hurts so bad"', () => {
    expect(buildTurnDirective('my head hurts so bad')).toContain('PHYSICAL PAIN');
  });

  it('emits directive on "feel sick"', () => {
    expect(buildTurnDirective('I feel sick')).toContain('PHYSICAL PAIN');
  });

  it('emits directive on "throwing up"', () => {
    expect(buildTurnDirective("I can't stop throwing up")).toContain('PHYSICAL PAIN');
  });

  it('emits directive on "in a lot of pain"', () => {
    expect(buildTurnDirective("I'm in a lot of pain today")).toContain('PHYSICAL PAIN');
  });

  it('emits directive on "my back hurts"', () => {
    expect(buildTurnDirective('my back hurts')).toContain('PHYSICAL PAIN');
  });

  it('emits directive on "stomach hurts so bad"', () => {
    expect(buildTurnDirective('stomach hurts so bad')).toContain('PHYSICAL PAIN');
  });

  it('does NOT emit on food log', () => {
    expect(buildTurnDirective('I had eggs for breakfast')).toBe('');
  });

  it('does NOT emit on greeting', () => {
    expect(buildTurnDirective('hey grace')).toBe('');
  });

  it('does NOT emit on food question', () => {
    expect(buildTurnDirective('how much protein in eggs?')).toBe('');
  });

  it('does NOT emit on emotional venting (covered by other rules)', () => {
    expect(buildTurnDirective("I'm feeling really sad today")).toBe('');
  });

  it('does NOT emit on empty input', () => {
    expect(buildTurnDirective('')).toBe('');
  });

  it('does NOT emit on whitespace-only', () => {
    expect(buildTurnDirective('   ')).toBe('');
  });

  it('emits actionable next-step guidance for lower-left pain', () => {
    const out = buildTurnDirective('my stomach is killing me');
    expect(out).toContain('Lower-left');
    expect(out).toContain('call their prescriber TODAY');
  });

  it('includes the "one focused question OR one actionable next step" rule', () => {
    const out = buildTurnDirective('my stomach hurts');
    expect(out).toContain('one focused question');
    expect(out).toContain('actionable next step');
  });

  it('explicitly bans the production failure phrases', () => {
    const out = buildTurnDirective('my stomach is killing me');
    expect(out).toContain("you haven't logged any food today");
    expect(out).toContain('protein');
    expect(out).toContain("you've mentioned this before");
  });
});
