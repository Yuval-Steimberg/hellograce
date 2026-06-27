import { describe, it, expect } from 'vitest';
import { analyzeMessage, buildMultiPartNote } from './message-understanding.js';

describe('analyzeMessage — multi-intent detection', () => {
  it('the canonical food + symptom + question message → all three parts', () => {
    const u = analyzeMessage(
      'I had chicken and rice for lunch, I feel a little nauseous, also how much protein do I still need today?',
    );
    expect(u.kinds).toContain('food');
    expect(u.kinds).toContain('symptom');
    expect(u.kinds).toContain('progress_question');
    expect(u.hasMultiple).toBe(true);
  });

  it('food + emotion (no question) → both parts', () => {
    const u = analyzeMessage('I had chicken and rice and I feel tired and a bit down');
    // "tired" is a symptom; "feel ... down" is emotion — both meaningful, plus food.
    expect(u.kinds).toContain('food');
    expect(u.hasMultiple).toBe(true);
  });

  it('symptom + question → multi-part', () => {
    const u = analyzeMessage('I feel really nauseous after my shot, is that normal?');
    expect(u.kinds).toContain('symptom');
    expect(u.kinds).toContain('injection');
    expect(u.hasMultiple).toBe(true);
  });

  it('weight update + advice question → multi-part', () => {
    const u = analyzeMessage("I'm down 3 lbs this week, what should I focus on now?");
    expect(u.kinds).toContain('weight');
    expect(u.kinds).toContain('question');
    expect(u.hasMultiple).toBe(true);
  });

  // Single-intent messages must NOT trigger multi-part handling (the fast paths
  // own them) — guards against over-firing.
  const SINGLE = [
    'I had 2 eggs',
    'thanks',
    'good morning',
    'how much protein do I still need today?', // one question only
    'I feel nauseous', // one symptom only
    'chicken and rice for dinner', // one food log
  ];
  for (const m of SINGLE) {
    it(`"${m}" → single intent (hasMultiple=false)`, () => {
      expect(analyzeMessage(m).hasMultiple).toBe(false);
    });
  }

  it('empty message → no parts', () => {
    expect(analyzeMessage('').hasMultiple).toBe(false);
    expect(analyzeMessage('   ').parts).toEqual([]);
  });
});

describe('buildMultiPartNote', () => {
  it('enumerates every part and forbids dropping/checklist', () => {
    const u = analyzeMessage(
      'I had chicken and rice, I feel nauseous, how much protein do I still need today?',
    );
    const note = buildMultiPartNote(u);
    expect(note).toMatch(/Address EVERY part/i);
    expect(note).toMatch(/ONE short, warm/i);
    expect(note).toMatch(/not a checklist/i);
    // One numbered line per detected part.
    expect((note.match(/\n\d\)/g) ?? []).length).toBe(u.parts.length);
  });

  it('returns empty string for a single-intent message', () => {
    expect(buildMultiPartNote(analyzeMessage('I had 2 eggs'))).toBe('');
  });
});
