import { describe, it, expect } from 'vitest';
import { detectPeptideSafety, PEPTIDE_SAFETY_RESPONSE } from './peptide-safety.js';

describe('detectPeptideSafety — fires on unsafe DIY / research-peptide guidance', () => {
  const shouldFlag = [
    'how do I reconstitute my peptide?',
    'how much bacteriostatic water do I add to the vial?',
    'how much bac water for 10mg?',
    'where can I buy retatrutide research peptide',
    'is it safe to stack tirzepatide with retatrutide?',
    'can I mix the powder myself',
    'how many units should I draw up',
    "I'm running reta alongside my semaglutide",
    'the vial came as dry powder, how do I mix it',
    'this cagrilintide is for research use only, how do I dose it',
    'thinking of stacking my compounded tirz with another peptide',
  ];
  for (const msg of shouldFlag) {
    it(`flags: "${msg}"`, () => {
      const r = detectPeptideSafety(msg);
      expect(r.flagged).toBe(true);
      expect(r.response).toBe(PEPTIDE_SAFETY_RESPONSE);
    });
  }
});

describe('detectPeptideSafety — does NOT fire on legitimate / in-scope messages', () => {
  const shouldPass = [
    // balanced-plate food talk (Feature gap 5) — "combine" must not trip it
    'should I combine protein with carbs?',
    'what protein can I eat with carbs',
    'I like to combine chicken and rice',
    'can I mix greek yogurt into my oatmeal',
    // legitimate medication tracking
    'I take tirzepatide once a week',
    'log my dose',
    'my doctor moved me to 5mg',
    'what dose am I on',
    'I inject on saturdays',
    'I had my shot today',
    // generic chat
    'how much protein should I eat',
    'I stacked a bunch of veggies on my plate',
    "what's my calorie goal",
    '',
  ];
  for (const msg of shouldPass) {
    it(`passes: "${msg}"`, () => {
      expect(detectPeptideSafety(msg).flagged).toBe(false);
    });
  }
});

describe('PEPTIDE_SAFETY_RESPONSE', () => {
  it('refuses the unsafe help but offers the safe alternative + clinician', () => {
    expect(PEPTIDE_SAFETY_RESPONSE.toLowerCase()).toMatch(/track/);
    expect(PEPTIDE_SAFETY_RESPONSE.toLowerCase()).toMatch(/clinician/);
    expect(PEPTIDE_SAFETY_RESPONSE.length).toBeLessThan(420);
  });
});
