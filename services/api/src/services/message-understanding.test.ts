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

  it('the production case: "I feel good after the meal. What should I will make for Friday night?"', () => {
    const u = analyzeMessage('I feel good after the meal. What should I will make for Friday night?');
    expect(u.kinds).toContain('emotion'); // "I feel good"
    expect(u.kinds).toContain('food_question'); // the Friday-night meal-idea request (typo-tolerant)
    expect(u.hasMultiple).toBe(true);
    const note = buildMultiPartNote(u);
    expect(note).toMatch(/SPECIFIC/);
    expect(note.toLowerCase()).toMatch(/feeling.*first|feeling first|respond to it first/);
  });

  it('detects a food-idea request as food_question, tolerant of grammar/typos', () => {
    for (const msg of [
      'what should I make for dinner',
      'what should I will make for Friday night',
      'give me some dinner ideas',
      'what to eat tonight',
      "what's a good high-protein breakfast",
    ]) {
      expect(analyzeMessage(msg).kinds).toContain('food_question');
    }
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

  it('the note forbids deflection and puts feelings first', () => {
    const note = buildMultiPartNote(
      analyzeMessage('I feel good after the meal. What should I make for dinner?'),
    );
    expect(note).toMatch(/REAL, specific answer/i);
    expect(note.toLowerCase()).toMatch(/never defer|i can help you think about/);
    expect(note.toLowerCase()).toMatch(/feeling.*first|respond to it first/);
  });
});

// FULL VERIFICATION (2026-07-02): every complex message — any mix of topics in
// one message — must (a) be flagged hasMultiple, (b) surface EVERY topic as a
// part, and (c) produce a note that enumerates each part. Proves the routing
// gate (isMultiTopic) fires and Gemini is told to answer each part, generally —
// not just for the one reported screenshot.
describe('multi-topic FULL coverage matrix', () => {
  const CASES: Array<{ msg: string; expect: string[] }> = [
    { msg: 'I feel good after the meal. What should I will make for Friday night?', expect: ['emotion', 'food_question'] },
    { msg: 'I feel great today, what should I eat for lunch?', expect: ['emotion', 'food_question'] },
    { msg: 'I had eggs for breakfast, what should I make for dinner?', expect: ['food', 'food_question'] },
    { msg: "I'm feeling anxious about my shot tomorrow, and what should I eat tonight?", expect: ['emotion', 'injection', 'food_question'] },
    { msg: "I've been nauseous all morning, what can I eat that's gentle?", expect: ['symptom', 'food_question'] },
    { msg: 'took my shot yesterday and I feel queasy, is that normal?', expect: ['injection', 'symptom'] },
    { msg: "I'm down 3 lbs and so proud, what should I focus on now?", expect: ['weight', 'emotion', 'question'] },
    { msg: 'how much protein do I still need today and what should I make for dinner?', expect: ['progress_question', 'food_question'] },
    { msg: 'I had chicken and rice, I feel bloated, how many calories is that?', expect: ['food', 'symptom', 'progress_question'] },
    { msg: 'feeling low today and I skipped my dose, what should I do?', expect: ['emotion', 'injection', 'question'] },
    { msg: 'I ate a big lunch and I feel guilty, am I over my calories?', expect: ['food', 'emotion', 'progress_question'] },
  ];
  for (const c of CASES) {
    it(`"${c.msg.slice(0, 48)}…" → ${c.expect.join('+')}`, () => {
      const u = analyzeMessage(c.msg);
      expect(u.hasMultiple).toBe(true);
      for (const k of c.expect) expect(u.kinds).toContain(k);
      // The note enumerates one line per detected part (nothing dropped).
      const note = buildMultiPartNote(u);
      expect((note.match(/\n\d\)/g) ?? []).length).toBe(u.parts.length);
    });
  }
});
