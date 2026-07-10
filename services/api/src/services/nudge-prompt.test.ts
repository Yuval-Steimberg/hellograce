import { describe, it, expect } from 'vitest';
import { buildNudgeSystemPrompt } from './nudge-prompt.js';

describe('buildNudgeSystemPrompt', () => {
  const base = {
    profileBlock: 'WHAT YOU KNOW ABOUT THIS USER:\n- Name: Uri\n- Medication: Ozempic',
    todaySnapshot: '',
    temporalBlock: 'CURRENT DATE & TIME: it is Saturday, July 4, 2026.',
    memoryBlock: '',
  };

  it('carries Nudge\'s core behavioral rules', () => {
    const p = buildNudgeSystemPrompt(base);
    // Identity + food handling + tone + latest-message + safety are all present.
    expect(p).toContain('You are Grace');
    expect(p).toContain('ABSOLUTE BAN'); // generic food logging language
    expect(p).toContain('LATEST MESSAGE RULE');
    expect(p).toContain('DO NOT END WITH A QUESTION BY DEFAULT');
    expect(p).toContain('is REPORTING what she ate, NOT a plan'); // the meal-report rule
    expect(p).toContain('VAGUE PORTION');
    expect(p).toContain('graceglp.com/settings'); // settings redirect
    expect(p).toContain('988'); // crisis resource
    expect(p).toContain('English'); // english-only
  });

  it('includes the profile + temporal blocks and omits empty sections', () => {
    const p = buildNudgeSystemPrompt(base);
    expect(p).toContain('Name: Uri');
    expect(p).toContain('July 4, 2026');
    // No snapshot / memory provided → those separators are not injected twice.
    expect(p).not.toContain('TRUE FOR THEM TODAY');
    expect(p).not.toContain('WHAT YOU REMEMBER');
  });

  it('includes the gated snapshot only when provided', () => {
    const p = buildNudgeSystemPrompt({ ...base, todaySnapshot: 'TRUE FOR THEM TODAY:\n- Nothing logged yet today.' });
    expect(p).toContain('TRUE FOR THEM TODAY');
    expect(p).toContain('Nothing logged yet today');
  });
});

describe('nudge-prompt — live-path safety guardrails (2026-07-10 audit)', () => {
  const PROMPT = buildNudgeSystemPrompt({ profileBlock: '', todaySnapshot: '', temporalBlock: '', memoryBlock: '' });

  it('Med 1: never affirm a shot timing/delay change; defer to prescriber', () => {
    expect(PROMPT).toMatch(/DELAY, MOVE, RETIME, OR SKIP A SHOT/);
    expect(PROMPT).toMatch(/prescriber's call/i);
  });
  it('Med 2: symptom replies must include a when-to-seek-help safety-net line', () => {
    expect(PROMPT).toContain('SYMPTOM SAFETY-NET');
  });
  it('Med 3: medication storage/stability must be hedged, not stated as certain', () => {
    expect(PROMPT).toContain('STORAGE / STABILITY');
    expect(PROMPT).toMatch(/never present a stability number as certain/i);
  });
  it('Med 4: surgery/anesthesia → redirect to the team, no stop-days number', () => {
    expect(PROMPT).toContain('PROCEDURE OR SURGERY');
    expect(PROMPT).toMatch(/anesthesia team/i);
  });
  it('Med 5: compounded medications get a differentiated caution', () => {
    expect(PROMPT).toContain('COMPOUNDED semaglutide');
  });
  it('Bug 4: a food/brand/product is never read as a name change', () => {
    expect(PROMPT).toContain('NOT A NAME CHANGE');
  });
});
