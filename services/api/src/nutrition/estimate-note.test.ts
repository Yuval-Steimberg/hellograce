import { describe, it, expect } from 'vitest';
import { shouldDiscloseEstimate, estimateNote } from './estimate-note.js';

describe('shouldDiscloseEstimate', () => {
  it('true for a recognizable food with NO explicit portion (estimate)', () => {
    expect(shouldDiscloseEstimate('greek yogurt')).toBe(true);
    expect(shouldDiscloseEstimate('turkey sandwich')).toBe(true);
    expect(shouldDiscloseEstimate('yogurt and berries')).toBe(true);
  });
  it('false when an explicit amount / unit / count is given (high confidence)', () => {
    expect(shouldDiscloseEstimate('2 eggs')).toBe(false);
    expect(shouldDiscloseEstimate('6 oz chicken')).toBe(false);
    expect(shouldDiscloseEstimate('1 cup greek yogurt')).toBe(false);
    expect(shouldDiscloseEstimate('a banana')).toBe(false);
  });
});

describe('estimateNote', () => {
  it('returns a short estimate-disclosure sentence inviting a portion', () => {
    const n = estimateNote('+15551234567');
    expect(n.toLowerCase()).toMatch(/estimate|portion|amount/);
    // Stable for the same seed.
    expect(estimateNote('+15551234567')).toBe(n);
  });
});
