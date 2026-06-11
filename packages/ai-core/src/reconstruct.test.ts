import { describe, it, expect } from 'vitest';
import { reconstructFollowUp } from './reconstruct.js';

describe('reconstructFollowUp — continuation', () => {
  it('"on glp?" after "is hair loss common?" → standalone hair-loss-on-GLP question', () => {
    const r = reconstructFollowUp('on glp?', { previousUserMessage: 'is hair loss common?' });
    expect(r.kind).toBe('continuation');
    expect(r.isFollowUp).toBe(true);
    expect(r.reconstructed.toLowerCase()).toBe('is hair loss common on glp?');
  });

  it('"for women?" splices onto the prior question', () => {
    const r = reconstructFollowUp('for women?', { previousUserMessage: 'is the protein target different?' });
    expect(r.kind).toBe('continuation');
    expect(r.reconstructed.toLowerCase()).toBe('is the protein target different for women?');
  });

  it('"with food" splices onto a prior question', () => {
    const r = reconstructFollowUp('with food', { previousUserMessage: 'should I take it in the morning?' });
    expect(r.kind).toBe('continuation');
    expect(r.reconstructed.toLowerCase()).toBe('should i take it in the morning with food?');
  });

  it('leading connector "and on weekends?" is handled', () => {
    const r = reconstructFollowUp('and on weekends?', { previousUserMessage: 'do I inject the same day?' });
    expect(r.kind).toBe('continuation');
    expect(r.reconstructed.toLowerCase()).toContain('on weekends');
  });

  it('does NOT splice when the previous message is not a question', () => {
    const r = reconstructFollowUp('on glp?', { previousUserMessage: 'I had eggs for breakfast' });
    expect(r.kind).toBe('none');
  });

  it('does NOT duplicate a qualifier already present in the base', () => {
    const r = reconstructFollowUp('on glp?', { previousUserMessage: 'is hair loss common on glp?' });
    expect(r.kind).toBe('none');
  });
});

describe('reconstructFollowUp — reasoning', () => {
  it('"why 12?" → reasoning hint referencing the prior reply', () => {
    const r = reconstructFollowUp('why 12?', { lastAssistantMessage: "Got it, about 12g protein for that, you're at 45g today." });
    expect(r.kind).toBe('reasoning');
    expect(r.isFollowUp).toBe(true);
    expect(r.reconstructed).toContain('12g protein');
    expect(r.reconstructed.toLowerCase()).toContain('why');
  });

  it('"why?" → reasoning when there is a prior assistant reply', () => {
    const r = reconstructFollowUp('why?', { lastAssistantMessage: 'Your daily protein target is 60g.' });
    expect(r.kind).toBe('reasoning');
    expect(r.reconstructed).toContain('60g');
  });

  it('"why?" with no prior assistant reply → none', () => {
    const r = reconstructFollowUp('why?', {});
    expect(r.kind).toBe('none');
  });
});

describe('reconstructFollowUp — negatives (must pass through)', () => {
  it('a full self-contained question returns none', () => {
    const r = reconstructFollowUp('how does GLP-1 affect my muscles?', { previousUserMessage: 'is hair loss common?' });
    expect(r.kind).toBe('none');
    expect(r.reconstructed).toBe('how does GLP-1 affect my muscles?');
  });

  it('a normal statement returns none', () => {
    const r = reconstructFollowUp('I feel nauseous today', { previousUserMessage: 'is hair loss common?' });
    expect(r.kind).toBe('none');
  });

  it('empty / whitespace returns none', () => {
    expect(reconstructFollowUp('   ', { previousUserMessage: 'is hair loss common?' }).kind).toBe('none');
  });

  it('long fragment over the word gate returns none', () => {
    const r = reconstructFollowUp('on glp and also when I travel a lot', { previousUserMessage: 'is hair loss common?' });
    expect(r.kind).toBe('none');
  });
});
