import { describe, it, expect } from 'vitest';
import { isTapbackReaction } from './reaction-filter.js';

describe('isTapbackReaction', () => {
  it('detects the six iMessage tapbacks (curly + straight quotes)', () => {
    expect(isTapbackReaction('Liked “I logged your eggs”')).toBe(true);
    expect(isTapbackReaction('Loved "That\'s 22g protein so far"')).toBe(true);
    expect(isTapbackReaction('Disliked “Try a protein-first breakfast”')).toBe(true);
    expect(isTapbackReaction('Laughed at "haha good one"')).toBe(true);
    expect(isTapbackReaction('Emphasized “Great work today”')).toBe(true);
    expect(isTapbackReaction('Questioned "your next shot is Wednesday"')).toBe(true);
  });

  it('detects removal and "Reacted … to" forms', () => {
    expect(isTapbackReaction('Removed a heart from “nice job”')).toBe(true);
    expect(isTapbackReaction('Removed an exclamation from "logged"')).toBe(true);
    expect(isTapbackReaction('Reacted 👍 to “I logged your eggs”')).toBe(true);
    expect(isTapbackReaction('Reacted ❤️ to "you got this"')).toBe(true);
  });

  it('does NOT filter a normal sentence that merely starts with a reaction verb', () => {
    // No quoted-original wrapper → real conversational content.
    expect(isTapbackReaction('Loved the eggs, what should I have for dinner?')).toBe(false);
    expect(isTapbackReaction('I liked that idea')).toBe(false);
    expect(isTapbackReaction('Liked it a lot!')).toBe(false);
    expect(isTapbackReaction('questioned whether I should eat before my shot')).toBe(false);
  });

  it('does NOT filter ordinary food / chat messages or empties', () => {
    expect(isTapbackReaction('I had 2 eggs and lox')).toBe(false);
    expect(isTapbackReaction('how much protein today?')).toBe(false);
    expect(isTapbackReaction('')).toBe(false);
    expect(isTapbackReaction(null)).toBe(false);
    expect(isTapbackReaction(undefined)).toBe(false);
  });

  it('does NOT filter a multi-line message even if the first line looks like a tapback', () => {
    expect(isTapbackReaction('Liked “the plan”\nbut what about dinner?')).toBe(false);
  });
});
