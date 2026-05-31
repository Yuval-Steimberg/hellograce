import { describe, it, expect } from 'vitest';
import { classifyMessage } from './classify.js';

describe('classifyMessage — appointment_prep (session 3 production fix)', () => {
  it('matches "I have my endo appointment. Help me write my questions" (cross-sentence)', () => {
    // This was the exact production failure from session 3: trigger phrase
    // and appointment word were in different sentences, so the same-sentence
    // patterns didn't bridge them.
    const result = classifyMessage('I have my endocrinologist appointment next week. Help me write my questions');
    expect(result.type).toBe('appointment_prep');
  });

  it('matches same-sentence variant', () => {
    const result = classifyMessage('Help me write my questions for my endocrinologist appointment');
    expect(result.type).toBe('appointment_prep');
  });

  it('matches reversed order (appointment first, then help)', () => {
    const result = classifyMessage('My doctor visit is next week. I want help preparing the questions');
    expect(result.type).toBe('appointment_prep');
  });

  it('matches standalone "help me write my questions" without appointment context', () => {
    // The standalone trigger fires too — "write my questions" is unambiguous.
    const result = classifyMessage('help me write my questions');
    expect(result.type).toBe('appointment_prep');
  });

  it('matches "prepare me to the appointment"', () => {
    const result = classifyMessage('prepare me to the appointment');
    expect(result.type).toBe('appointment_prep');
  });

  it('does NOT match unrelated messages with the word "questions"', () => {
    const result = classifyMessage('I have so many questions about my new puppy');
    expect(result.type).not.toBe('appointment_prep');
  });

  it('does NOT match "what should I eat tonight?"', () => {
    const result = classifyMessage('what should I eat tonight?');
    expect(result.type).not.toBe('appointment_prep');
  });
});
