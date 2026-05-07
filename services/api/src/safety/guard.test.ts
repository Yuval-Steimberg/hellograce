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
});
