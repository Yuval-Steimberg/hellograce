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

  // 2026-06-04 production failure regressions
  it('detects unclosed parenthesis as mid-sentence (production: "Greek yogurt (approx.")', () => {
    expect(endsMidWord('Try Greek yogurt (approx.')).toBe(true);
    expect(endsMidWord('Try Greek yogurt (approx. 200g).')).toBe(false);
  });

  it('detects unclosed square brackets', () => {
    expect(endsMidWord('See the table [section')).toBe(true);
    expect(endsMidWord('See the table [section 4].')).toBe(false);
  });

  it('detects unclosed curly braces', () => {
    expect(endsMidWord('Try {tofu')).toBe(true);
  });

  it('detects unmatched double quotes', () => {
    expect(endsMidWord('She said "hello.')).toBe(true);
    expect(endsMidWord('She said "hello".')).toBe(false);
  });

  it('detects stranded hedge words like "approximately"', () => {
    expect(endsMidWord('Eat about 30 grams of protein, approximately.')).toBe(true);
    expect(endsMidWord('Try about 30g.')).toBe(false);
  });

  it('detects stranded "such as," / "including," / "for example,"', () => {
    expect(endsMidWord('Try plant proteins, such as.')).toBe(true);
    expect(endsMidWord('Many options exist.')).toBe(false);
  });

  // ── Comprehensive variations the rule must catch ──────────────────────
  it('detects stranded mathematical operators', () => {
    expect(endsMidWord('Your total is 60 +')).toBe(true);
    expect(endsMidWord('Your total is 60 + 20 =')).toBe(true);
    expect(endsMidWord('Your total is 80g.')).toBe(false);
  });

  it('detects stranded "due to," / "because of," / "in order to,"', () => {
    expect(endsMidWord('Hair loss happens due to.')).toBe(true);
    expect(endsMidWord('Eat protein in order to.')).toBe(true);
    expect(endsMidWord('Eat protein because of the goal.')).toBe(false);
  });

  it('detects empty list bullet at end', () => {
    expect(endsMidWord('Try:\n- Tofu\n- Lentils\n- ')).toBe(true);
    expect(endsMidWord('Try:\n1. Tofu\n2. ')).toBe(true);
  });

  it('detects empty markdown header at end', () => {
    expect(endsMidWord('Why this matters\n## ')).toBe(true);
  });

  it('detects unbalanced markdown bold', () => {
    expect(endsMidWord('This is **important')).toBe(true);
    expect(endsMidWord('This is **important**.')).toBe(false);
  });

  it('detects bare number with quantity hedge before it', () => {
    expect(endsMidWord('Eat about 60')).toBe(true);
    expect(endsMidWord('Eat approximately 30')).toBe(true);
    expect(endsMidWord('Eat about 60g.')).toBe(false);
  });

  it('detects stranded conditional connectors', () => {
    expect(endsMidWord('If you exercise, then.')).toBe(true);
    expect(endsMidWord('Eat more protein when.')).toBe(true);
    expect(endsMidWord('Eat protein when you can.')).toBe(false);
  });

  it('detects stranded sequence words', () => {
    expect(endsMidWord('First,')).toBe(true);
    expect(endsMidWord('Finally,')).toBe(true);
    expect(endsMidWord('Moreover,')).toBe(true);
    expect(endsMidWord('First, eat breakfast.')).toBe(false);
  });

  it('accepts emoji endings', () => {
    expect(endsMidWord('Got it 👍')).toBe(false);
    expect(endsMidWord('Sounds great! 🌿')).toBe(false);
  });

  it('accepts numeric values with units', () => {
    expect(endsMidWord("You're at 56g protein today.")).toBe(false);
    expect(endsMidWord('That target is 60g.')).toBe(false);
  });

  it('accepts compound responses with parens balanced', () => {
    expect(endsMidWord('Try Greek yogurt (about 200g).')).toBe(false);
  });

  it('accepts complete responses ending in question mark', () => {
    expect(endsMidWord('Want me to walk you through the math?')).toBe(false);
  });

  // 2026-06-04 production failure: response ended with stranded "2." after
  // an earlier "1." item that had content. The list was started but not
  // finished — must be detected as mid-sentence.
  it('detects stranded numbered list ending ("1. content. 2.")', () => {
    const text = 'Tell me about: 1. Your goals, what are you trying to achieve. 2.';
    expect(endsMidWord(text)).toBe(true);
  });

  it('detects stranded "2." after long parenthetical content', () => {
    const text = 'Tell me about: 1. Your Goals, what are you trying to achieve (e.g, energy, feeling full). 2.';
    expect(endsMidWord(text)).toBe(true);
  });

  it('does NOT false-positive on completed numbered list', () => {
    const text = '1. Eat tofu. 2. Drink water. 3. Sleep well.';
    expect(endsMidWord(text)).toBe(false);
  });

  it('does NOT false-positive on a number with units', () => {
    expect(endsMidWord("You're at 56g protein today, 4g to go.")).toBe(false);
  });
});
