import { describe, it, expect } from 'vitest';
import { classifyMessage } from './guard.js';

describe('classifyMessage', () => {
  it('passes safe messages', () => {
    expect(classifyMessage('had eggs for breakfast').class).toBe('safe');
  });
  it('flags emergencies', () => {
    expect(classifyMessage("I have chest pain right now").class).toBe('emergency');
  });
  it('flags crisis', () => {
    expect(classifyMessage('I want to die').class).toBe('crisis');
  });
  it('flags medical-advice asks', () => {
    expect(classifyMessage('should i increase my dose this week').class).toBe('medical_advice');
  });

  it('does NOT flag negated crisis statements', () => {
    // The crisis response sends 988 + 911 — a false positive on a clear
    // denial would be alarming and undermine trust.
    expect(classifyMessage("I don't want to die, I'm doing fine").class).toBe('safe');
    expect(classifyMessage('I have no thoughts of suicide').class).toBe('safe');
    expect(classifyMessage("I'm not going to hurt myself").class).toBe('safe');
    expect(classifyMessage('I never want to end my life').class).toBe('safe');
  });

  it('does NOT flag negated medical-advice patterns', () => {
    expect(classifyMessage("I'm not going to skip my dose").class).toBe('safe');
    expect(classifyMessage("I would never take extra").class).toBe('safe');
  });

  it('still flags non-negated crisis after a negated sentence', () => {
    // Negation should be scoped to a single sentence. A reset between sentences
    // means the second sentence still triggers.
    expect(classifyMessage("I told her I don't want to die. But honestly today, I want to die.").class)
      .toBe('crisis');
  });
});
