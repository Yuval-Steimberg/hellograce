import { describe, it, expect } from 'vitest';
import { analyzeMessage, buildMultiPartNote, type MessagePartKind } from './message-understanding.js';

type MessagePartKindLite = MessagePartKind;

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
    expect(note.toLowerCase()).toMatch(/specific/);
    expect(note.toLowerCase()).toMatch(/feeling.*first|react to it first|respond to it first/);
    expect(note.toLowerCase()).toMatch(/no lists|no bullet|option 1/); // bans the essay format
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
  it('is one plain instruction, NOT an enumerated data block (anti-analysis regression)', () => {
    const u = analyzeMessage(
      'I had chicken and rice, I feel nauseous, how much protein do I still need today?',
    );
    const note = buildMultiPartNote(u);
    expect(note).toMatch(/Reply to ALL of it/i);
    expect(note.toLowerCase()).toMatch(/lead with the answer/);
    expect(note.toLowerCase()).toMatch(/no lists|narrating/);
    // CRITICAL: no "1) … 2) …" enumeration — that structure made Gemini reply
    // "Here's an analysis of your entries, categorizing them…" (production bug).
    expect(note).not.toMatch(/\n\d\)/);
  });

  it('returns empty string for a single-intent message', () => {
    expect(buildMultiPartNote(analyzeMessage('I had 2 eggs'))).toBe('');
  });

  it('the note forbids deflection and puts feelings first', () => {
    const note = buildMultiPartNote(
      analyzeMessage('I feel good after the meal. What should I make for dinner?'),
    );
    expect(note.toLowerCase()).toMatch(/specific answer/);
    expect(note.toLowerCase()).toMatch(/don'?t hedge|commit to/);
    expect(note.toLowerCase()).toMatch(/feeling first|react to any feeling first/);
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
    { msg: 'feeling low today and I skipped my dose, what should I do?', expect: ['emotion', 'medication', 'question'] },
    { msg: 'I ate a big lunch and I feel guilty, am I over my calories?', expect: ['food', 'emotion', 'progress_question'] },
  ];
  for (const c of CASES) {
    it(`"${c.msg.slice(0, 48)}…" → ${c.expect.join('+')}`, () => {
      const u = analyzeMessage(c.msg);
      expect(u.hasMultiple).toBe(true);
      for (const k of c.expect) expect(u.kinds).toContain(k);
      // The note enumerates one line per detected part (nothing dropped).
      const note = buildMultiPartNote(u);
      expect(note).not.toMatch(/\n\d\)/); // plain instruction, never an enumerated data block
    });
  }
});

// VERY BROAD coverage — EVERY topic a GLP-1 user might combine, across slang,
// typos, lowercase, no punctuation, emoji, and run-on styles. Each must be
// flagged multi-part and surface the named topics. This is the "accurate
// machine" net: no complex message slips through as single-intent.
describe('multi-topic breadth: all subjects, slang, typos, styles', () => {
  const BROAD: Array<{ msg: string; expect: MessagePartKindLite[] }> = [
    // sleep + emotion (no question, lowercase, no punctuation)
    { msg: 'couldnt sleep at all last night and im feeling so anxious', expect: ['sleep', 'emotion'] },
    // exercise + food idea (slang)
    { msg: 'just crushed a 5k run 💪 what should i eat after', expect: ['exercise', 'food_question'] },
    // hydration + progress question
    { msg: 'been drinking tons of water today, how much protein have i had', expect: ['hydration', 'progress_question'] },
    // craving + emotion
    { msg: 'the food noise is back and im feeling super frustrated', expect: ['craving', 'emotion'] },
    // medication + symptom (typo "nauseus")
    { msg: 'upped my dose to 1mg and now im nauseus', expect: ['medication', 'symptom'] },
    // appointment + emotion
    { msg: 'got a doctor appointment friday and im nervous about it', expect: ['appointment', 'emotion'] },
    // social + food idea
    { msg: 'eating out at a restaurant tonight, what should i order', expect: ['social', 'food_question'] },
    // reminder + emotion
    { msg: 'can you text me less, its stressing me out', expect: ['reminder', 'emotion'] },
    // gratitude + food idea
    { msg: 'thanks so much!! what should i make for dinner', expect: ['gratitude', 'food_question'] },
    // symptom typo variants + question
    { msg: 'got bad diarhea and a headache, is that normal on wegovy', expect: ['symptom', 'question'] },
    // weight update + emotion + food idea (run-on)
    { msg: 'scale said 178 im down 4lbs so happy what should i eat to keep it going', expect: ['weight', 'emotion', 'food_question'] },
    // injection + hydration + sleep (three non-question topics)
    { msg: 'took my shot, drank all my water, but slept terribly', expect: ['injection', 'hydration', 'sleep'] },
    // exercise + craving
    { msg: 'went to the gym but now im craving something sweet', expect: ['exercise', 'craving'] },
    // emotion + appointment + question (formal)
    { msg: 'I am quite worried. I have blood work on Monday. Should I fast beforehand?', expect: ['emotion', 'appointment', 'question'] },
    // food log + medication + symptom (slang "n")
    { msg: 'had chicken n rice, took my 2mg dose, feeling kinda queasy', expect: ['food', 'medication', 'symptom'] },
    // hydration + exercise + food idea
    { msg: 'walked 10k steps and drank plenty of water, any snack ideas', expect: ['hydration', 'exercise', 'food_question'] },
  ];
  for (const c of BROAD) {
    it(`"${c.msg.slice(0, 44)}…" → ${c.expect.join('+')}`, () => {
      const u = analyzeMessage(c.msg);
      expect(u.hasMultiple).toBe(true);
      for (const k of c.expect) expect(u.kinds).toContain(k);
      expect(buildMultiPartNote(u)).not.toMatch(/\n\d\)/); // plain instruction, never an enumerated data block
    });
  }

  // Single-topic messages (any subject) must NOT over-fire → fast paths keep them.
  const SINGLE_BROAD = [
    'went for a run', 'couldnt sleep', 'drank a lot of water', 'i have a doctor appointment tomorrow',
    'took my shot', 'im craving chocolate', 'eating out tonight', 'thanks', 'what should i eat for dinner',
    'how much protein have i had today', 'i feel nauseous', 'i had 2 eggs',
  ];
  for (const m of SINGLE_BROAD) {
    it(`single: "${m}" → hasMultiple=false`, () => {
      expect(analyzeMessage(m).hasMultiple).toBe(false);
    });
  }
});
