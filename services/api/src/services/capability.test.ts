import { describe, it, expect } from 'vitest';
import {
  detectCapabilityQuestion,
  buildCapabilityReply,
  detectOnboardingSideQuestion,
  buildSideAnswer,
} from './capability.js';

describe('detectCapabilityQuestion', () => {
  it('matches identity / capability questions', () => {
    for (const t of ['what can you do', 'What can you do?', 'who are you', 'what are you', 'what do you do', 'how can you help']) {
      expect(detectCapabilityQuestion(t)).toBe(true);
    }
  });
  it('does NOT match a real topic question that happens to start similarly', () => {
    expect(detectCapabilityQuestion('how can you help me with nausea')).toBe(false);
    expect(detectCapabilityQuestion('what should I eat today')).toBe(false);
    expect(detectCapabilityQuestion('can you help me figure out my protein for the whole week and beyond')).toBe(false);
  });
});

describe('buildCapabilityReply — always Grace, never generic, SMS-short', () => {
  const r = buildCapabilityReply('Yuval');
  it('is in Grace persona with concrete GLP-1 capabilities + an invitation', () => {
    expect(r).toMatch(/Grace/);
    expect(r.toLowerCase()).toMatch(/glp-1|protein|side effects/);
    expect(r).toMatch(/Yuval/);
    expect(r.length).toBeLessThan(360); // SMS-friendly, not an essay
  });
  it('never offers generic-assistant capabilities', () => {
    expect(r.toLowerCase()).not.toMatch(/quantum|poems?|code|capital of france|songs/);
  });
});

describe('detectOnboardingSideQuestion', () => {
  it('classifies capability / why / how / skip interruptions', () => {
    expect(detectOnboardingSideQuestion('what can you do?')).toBe('capability');
    expect(detectOnboardingSideQuestion('why do you need this')).toBe('why');
    expect(detectOnboardingSideQuestion('how does this work')).toBe('how');
    expect(detectOnboardingSideQuestion('can I skip')).toBe('skip');
    expect(detectOnboardingSideQuestion('is this required')).toBe('skip');
  });
  it('returns null for a normal onboarding answer', () => {
    expect(detectOnboardingSideQuestion('ozempic')).toBeNull();
    expect(detectOnboardingSideQuestion('Monday')).toBeNull();
    expect(detectOnboardingSideQuestion('150kg')).toBeNull();
  });
  it('side answers stay in Grace persona and short', () => {
    expect(buildSideAnswer('capability')).toMatch(/Grace/);
    expect(buildSideAnswer('capability').toLowerCase()).not.toMatch(/quantum|code|poems?/);
    expect(buildSideAnswer('why').length).toBeLessThan(120);
  });
});
