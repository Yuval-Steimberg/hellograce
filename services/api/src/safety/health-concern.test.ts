import { describe, it, expect } from 'vitest';
import { detectHealthConcern } from './health-concern.js';

describe('detectHealthConcern — out-of-scope vitals concerns (2026-06-13)', () => {
  it('the exact production failure: "I\'m having blood pressure problems what should I do"', () => {
    const r = detectHealthConcern("I'm having blood pressure problems what should I do");
    expect(r.concern).toBe(true);
    expect(r.vital).toBe('blood pressure');
    // supportive + clarifying + scope-aware referral, NOT "Logged."
    expect(r.response).toMatch(/blood pressure/i);
    expect(r.response).toMatch(/high readings|low readings|dizziness|symptoms/i);
    expect(r.response).toMatch(/doctor|clinician|provider/i);
    expect(r.response).not.toMatch(/^logged/i);
  });

  it('"How about my bp?" → personal question → clarify (not generic education)', () => {
    const r = detectHealthConcern('How about my bp?');
    expect(r.concern).toBe(true);
    expect(r.vital).toBe('blood pressure');
  });

  it('"How about my blood pressure?" → concern', () => {
    expect(detectHealthConcern('How about my blood pressure?').concern).toBe(true);
  });

  it('heart rate / palpitations / cholesterol concerns fire', () => {
    expect(detectHealthConcern('my heart rate is running high').concern).toBe(true);
    expect(detectHealthConcern("I'm having heart palpitations").concern).toBe(true);
    expect(detectHealthConcern('my cholesterol is too high, what should I do').concern).toBe(true);
  });

  it('pure education questions do NOT fire (let the AI educate)', () => {
    expect(detectHealthConcern('Does GLP-1 affect blood pressure?').concern).toBe(false);
    expect(detectHealthConcern('can these meds lower cholesterol').concern).toBe(false);
    expect(detectHealthConcern('is GLP-1 good for heart rate').concern).toBe(false);
  });

  it('non-vitals messages do NOT fire', () => {
    expect(detectHealthConcern('I had pizza').concern).toBe(false);
    expect(detectHealthConcern('what should I do for dinner').concern).toBe(false);
  });

  it('follow-up after our clarification → refer-focused, no repeat ask', () => {
    const prior = "Sorry you're dealing with that. Can you tell me a bit more about what's going on with your blood pressure? Are you noticing high readings, low readings, or symptoms…";
    const r = detectHealthConcern('my readings have been high all week', prior);
    expect(r.concern).toBe(true);
    expect(r.response).toMatch(/doctor or pharmacist/i);
    expect(r.response).not.toMatch(/high readings, low readings/i); // didn't repeat the ask
  });
});
