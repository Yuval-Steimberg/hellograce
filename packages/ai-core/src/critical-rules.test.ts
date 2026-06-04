// Regression tests for the 4 launch-critical rules listed in
// 2026-06-04 user directive. These tests pin the wiring of each rule
// so future refactors can't silently break them.

import { describe, it, expect } from 'vitest';
import { detectMustAcknowledge, detectReasoningRequest, endsMidWord, trimToLastCompleteSentence } from './orchestrator.js';
import { checkContent } from './content-checker.js';

describe('CRITICAL RULE: Prioritize the user\'s latest message (must-acknowledge)', () => {
  it('detects newly-reported symptoms', () => {
    const r = detectMustAcknowledge('My hair is falling out');
    expect(r).not.toBeNull();
    expect(r?.type).toBe('symptom');
    expect(r?.label.toLowerCase()).toContain('hair');
  });

  it('detects nausea symptom', () => {
    const r = detectMustAcknowledge('I feel really nauseous after my shot');
    expect(r?.type).toBe('symptom');
  });

  it('detects corrections', () => {
    const r = detectMustAcknowledge('Actually I lost 8 lbs not 18');
    expect(r?.type).toBe('correction');
  });

  it('detects new info (dose changes)', () => {
    const r = detectMustAcknowledge('I just started 1 mg today');
    expect(r?.type).toBe('new_info');
  });

  it('does NOT fire on neutral chat', () => {
    expect(detectMustAcknowledge('Hi how are you')).toBeNull();
  });
});

describe('CRITICAL RULE: Intent detection — reasoning request vs. recommendation', () => {
  const priorRec = 'Aim for 60g of protein today to preserve muscle mass.';

  it('detects "Why?" after a recommendation', () => {
    expect(detectReasoningRequest('Why?', priorRec)).toBe(true);
  });

  it('detects "How did you calculate that?"', () => {
    expect(detectReasoningRequest('How did you calculate that?', priorRec)).toBe(true);
  });

  it('detects "Where did that number come from?"', () => {
    expect(detectReasoningRequest('Where did that number come from?', priorRec)).toBe(true);
  });

  it('detects "Can you explain?"', () => {
    expect(detectReasoningRequest('Can you explain?', priorRec)).toBe(true);
  });

  it('does NOT fire on follow-up topics', () => {
    expect(detectReasoningRequest('What should I eat?', priorRec)).toBe(false);
  });

  it('does NOT fire on long messages (need ≤12 words)', () => {
    const long = 'This is a really long message that goes on and on and asks many things';
    expect(detectReasoningRequest(long, priorRec)).toBe(false);
  });
});

describe('CRITICAL RULE: Never expose internal system limitations', () => {
  const memoryViolations = [
    "I don't have access to previous messages.",
    'I lost the conversation context.',
    "My memory doesn't carry over.",
    "I can't see earlier parts of the conversation.",
    "I don't remember what you told me before.",
  ];

  for (const v of memoryViolations) {
    it(`bans: "${v.slice(0, 40)}..."`, () => {
      const violations = checkContent(v, { userMessage: 'Some user message' });
      const memViolations = violations.filter((x) =>
        x.message?.toLowerCase().includes('memory') ||
        x.code === 'banned_phrase',
      );
      expect(memViolations.length).toBeGreaterThan(0);
    });
  }
});

describe('CRITICAL RULE: Never end a response mid-sentence', () => {
  it('endsMidWord detects stranded mid-word ending', () => {
    expect(endsMidWord('You could try a lentil sou')).toBe(true);
  });

  it('endsMidWord detects trailing comma/colon/dash', () => {
    expect(endsMidWord('Here are some options,')).toBe(true);
    expect(endsMidWord('You could:')).toBe(true);
  });

  it('endsMidWord ALLOWS proper sentence terminators', () => {
    expect(endsMidWord('You could try a lentil soup.')).toBe(false);
    expect(endsMidWord('What sounds good?')).toBe(false);
    expect(endsMidWord('Sounds great!')).toBe(false);
  });

  it('trimToLastCompleteSentence trims to the last completed sentence', () => {
    const r = trimToLastCompleteSentence('Try lentil soup. Mushroom risotto is also gre');
    expect(r.wasTrimmed).toBe(true);
    expect(r.trimmed).toBe('Try lentil soup.');
  });

  it('trimToLastCompleteSentence returns unchanged when already complete', () => {
    const r = trimToLastCompleteSentence('Try a tofu stir-fry.');
    expect(r.wasTrimmed).toBe(false);
    expect(r.trimmed).toBe('Try a tofu stir-fry.');
  });
});
