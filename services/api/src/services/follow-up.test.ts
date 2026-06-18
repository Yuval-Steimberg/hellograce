import { describe, it, expect } from 'vitest';
import { detectFollowUp, wantsMoreDetail } from './follow-up.js';

describe('detectFollowUp — confirmations', () => {
  it('labels bare affirmations as confirm', () => {
    for (const t of ['yes', 'yep', 'sure', 'ok', 'do it', 'go ahead', 'sounds good', 'please do', 'continue']) {
      expect(detectFollowUp(t)).toEqual({ kind: 'confirm' });
    }
  });

  it('labels "yes do it specific" as confirm + more_specific (the production case)', () => {
    expect(detectFollowUp('Yes do it specific')).toEqual({ kind: 'confirm', modifier: 'more_specific' });
  });

  it('labels "yes, make it more detailed" as confirm + more_detail', () => {
    expect(detectFollowUp('yes, make it more detailed')).toEqual({ kind: 'confirm', modifier: 'more_detail' });
  });
});

describe('detectFollowUp — refinements', () => {
  it('labels bare refinements', () => {
    expect(detectFollowUp('make it specific')).toEqual({ kind: 'refine', modifier: 'more_specific' });
    expect(detectFollowUp('shorter')).toEqual({ kind: 'refine', modifier: 'shorter' });
    expect(detectFollowUp('more detail')).toEqual({ kind: 'refine', modifier: 'more_detail' });
    expect(detectFollowUp('simplify it')).toEqual({ kind: 'refine', modifier: 'simpler' });
    expect(detectFollowUp('add examples')).toEqual({ kind: 'refine', modifier: 'examples' });
  });

  it('handles add / remove / rewrite', () => {
    expect(detectFollowUp('rewrite it')).toEqual({ kind: 'refine', modifier: 'rewrite' });
    expect(detectFollowUp('remove that')).toEqual({ kind: 'refine', modifier: 'remove' });
  });
});

describe('detectFollowUp — rejections / references / clarifications', () => {
  it('labels rejections', () => {
    expect(detectFollowUp('no')).toEqual({ kind: 'reject' });
    expect(detectFollowUp('not that')).toEqual({ kind: 'reject' });
    expect(detectFollowUp('never mind')).toEqual({ kind: 'reject' });
  });
  it('labels references', () => {
    expect(detectFollowUp('the second one')).toEqual({ kind: 'reference' });
    expect(detectFollowUp('this plan')).toEqual({ kind: 'reference' });
    expect(detectFollowUp('both')).toEqual({ kind: 'reference' });
  });
  it('labels clarifications', () => {
    expect(detectFollowUp('why?')).toEqual({ kind: 'clarify' });
    expect(detectFollowUp('how')).toEqual({ kind: 'clarify' });
    expect(detectFollowUp('what do you mean')).toEqual({ kind: 'clarify' });
  });
});

describe('detectFollowUp — standalone messages return null', () => {
  it('does not flag real new-topic messages', () => {
    expect(detectFollowUp('I had eggs and toast for breakfast')).toBeNull();
    expect(detectFollowUp('what should I eat for dinner tonight')).toBeNull();
    expect(detectFollowUp('I feel really nauseous after my shot')).toBeNull();
    expect(detectFollowUp('')).toBeNull();
  });
  it('ignores long messages even if they start with a follow-up word', () => {
    const long = 'yes but actually I wanted to ask a completely different question about my weight loss plateau and what to do';
    expect(detectFollowUp(long)).toBeNull();
  });
});

describe('wantsMoreDetail', () => {
  it('is true for specificity/detail/longer/examples requests', () => {
    expect(wantsMoreDetail({ kind: 'refine', modifier: 'more_specific' })).toBe(true);
    expect(wantsMoreDetail({ kind: 'confirm', modifier: 'more_detail' })).toBe(true);
    expect(wantsMoreDetail({ kind: 'refine', modifier: 'longer' })).toBe(true);
  });
  it('is false for shorter/simpler/bare confirm', () => {
    expect(wantsMoreDetail({ kind: 'refine', modifier: 'shorter' })).toBe(false);
    expect(wantsMoreDetail({ kind: 'confirm' })).toBe(false);
    expect(wantsMoreDetail(null)).toBe(false);
  });
});
