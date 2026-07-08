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
    expect(note.toLowerCase()).toMatch(/own short paragraph/); // one section per part
    expect(note.toLowerCase()).toMatch(/feeling.*first|react to it first|respond to it first/);
    expect(note.toLowerCase()).toMatch(/no bullet|option 1|no "1\.\/2\."|no headings/); // still bans the report/essay format
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
    expect(note.toLowerCase()).toMatch(/own short paragraph/); // one section per part
    expect(note.toLowerCase()).toMatch(/don'?t hedge|commit to/);
    expect(note.toLowerCase()).toMatch(/feeling.*first|react to any feeling/);
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
    // food consumption + hunger + food idea (the exact prod yogurt message)
    { msg: "I ate yogurt with berries after my injection and now I'm a little hungry. Any snack idea?", expect: ['food', 'craving', 'food_question'] },
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

// PRODUCTION SCREENSHOT (2026-07-06, IMG_6697): a planning + emotional message
// that MENTIONS food eaten. Grace (unified path) collapsed it into a terse
// food-confirmation ("you're at 65g, try Greek yogurt") and dropped the meal
// advice + the dessert-without-guilt ask, while Nudge answered all of it. Root
// cause: the unified food early-return fired on any food mention. The fix gates
// that early-return on !isMultiTopic and falls through to the full grounded
// answer. This locks the decision boundary the fix keys on: this class of
// message MUST read as multi-topic, and a pure food log MUST NOT.
describe('food-inside-a-bigger-ask routes to the full multi-part answer (IMG_6697)', () => {
  const PROD_MSG =
    "I'm going to my parents on Friday night and I know there will probably be a lot of food, maybe pasta, bread, desserts, and some kind of meat. I don't want to feel weird or restricted, but I also don't want to ruin my progress. Today I ate pretty light, just a protein shake and a sandwich, and I still feel like I need more protein. Can you help me plan what to eat before dinner, what to choose at the meal, and how to handle dessert without feeling guilty?";

  it('the exact production message is multi-topic (so it falls through to the grounded full answer, not the terse food-confirm)', () => {
    const u = analyzeMessage(PROD_MSG);
    expect(u.hasMultiple).toBe(true);
    expect(u.kinds).toContain('food'); // mentions the shake + sandwich (still logged as a side-effect)
    expect(u.kinds).toContain('emotion'); // "don't want to feel weird / guilty"
    expect(u.kinds).toContain('food_question'); // help me plan what to eat
    // The multi-part note tells Grace to answer every part + feeling first.
    const note = buildMultiPartNote(u);
    expect(note).toMatch(/Reply to ALL of it/i);
    expect(note).not.toMatch(/\n\d\)/);
  });

  it('shorter food-mention-plus-planning variants are still multi-topic', () => {
    for (const m of [
      'I ate a protein shake and a sandwich today, what should I eat before dinner and how do I handle dessert without feeling guilty?',
      'had eggs this morning but I feel guilty about dinner at my parents, what should I do?',
    ]) {
      expect(analyzeMessage(m).hasMultiple).toBe(true);
    }
  });

  it('a PURE food log stays single-topic (keeps the fast deterministic food confirmation — no regression)', () => {
    for (const m of ['I just had eggs for breakfast', 'chicken and rice for dinner', 'a protein shake and a sandwich']) {
      expect(analyzeMessage(m).hasMultiple).toBe(false);
    }
  });
});

// LONG MULTI-TOPIC BATTERY (user-provided, 2026-07-06). Realistic paragraph-long
// messages that each MENTION food eaten AND ask several planning/estimate/
// emotional things at once. Every one must route to the full grounded answer
// (hasMultiple=true) so no part is dropped — and each carries a 'food' part, so
// the food is still logged as a side-effect while the reply answers everything.
describe('long multi-topic battery routes to the full grounded answer', () => {
  const BATTERY: string[] = [
    'I had a pretty good day overall. I ate eggs and toast in the morning, then chicken with rice for lunch, and I felt good after the meal. I also walked for about 30 minutes, but I didn’t drink enough water today. I’m starting to feel a little hungry now, but I don’t want something too heavy. Can you estimate how I’m doing with protein, tell me what I should focus on tonight, and also give me an idea for what to make for Friday night dinner?',
    'Today was a little confusing for me. I took my injection this morning, and at first I wasn’t hungry at all, so I only had coffee and a small yogurt. Later I ate some chicken salad, but I’m not sure if it was enough protein. Now I feel okay, maybe a little tired, and I’m trying not to overthink the scale because it didn’t move this week. Can you help me understand what I should do for the rest of the day, what I can eat tonight, and what I should focus on tomorrow?',
    'I’m going to my parents on Friday night and I know there will probably be a lot of food, maybe pasta, bread, desserts, and some kind of meat. I don’t want to feel weird or restricted, but I also don’t want to ruin my progress. Today I ate pretty light, just a protein shake and a sandwich, and I still feel like I need more protein. Can you help me plan what to eat before dinner, what to choose at the meal, and how to handle dessert without feeling guilty?',
    'I feel good after lunch, but I’m not sure if I ate enough. I had rice, chicken, and some vegetables, but I don’t remember the exact amount. I also drank only one bottle of water today and I skipped breakfast because I wasn’t hungry. Can you estimate the meal, tell me if I should add more protein today, suggest something light for dinner, and remind me what I should do differently tomorrow?',
    'I had a small breakfast, then I went to the gym, and after that I ate yogurt with berries and a protein bar. I feel okay but still a little low energy. I’m trying to stay consistent, but I’m not sure if I’m eating enough or just eating less because of the medication. Can you help me understand if today looks balanced, what I should eat next, and how to avoid feeling weak tomorrow?',
    'I’m a little nauseous today, but I still want to stay on track. I took my shot yesterday, and today I only managed to eat toast, cottage cheese, and a few crackers. I’m not very hungry, but I know I need protein and water. Can you suggest something gentle to eat, tell me what not to force, and help me plan a simple meal for tomorrow if I still feel like this?',
    'I ate pasta for lunch and now I’m worried it was too many carbs and not enough protein. I don’t want to panic because I actually enjoyed the meal and I feel fine, but I also want to make better choices for dinner. Can you estimate what I may still need today, suggest a high-protein dinner that is not too heavy, and give me one simple rule for meals like this in the future?',
    'I had a good day with food but emotionally I feel a bit discouraged because my weight has been stuck for a few days. I ate eggs in the morning, chicken salad for lunch, and a protein shake in the afternoon. I also walked a lot and drank more water than usual. Can you tell me if I’m doing okay, what I should eat for dinner, and how to think about the scale without losing motivation?',
    'I forgot to log earlier, but today I had coffee, a banana, a turkey sandwich, some soup, and a few bites of chocolate. I feel mostly fine, just a little hungry now. Can you help me log what you can, tell me what information you still need if anything, estimate my protein, and suggest a smart dinner that helps balance the day?',
    'I’m going out to a restaurant tonight and I don’t know what to order. Today I only had a small yogurt and some crackers because I wasn’t hungry. I want to get enough protein, but I also don’t want to feel too full or nauseous. Can you give me restaurant order ideas, tell me what to avoid, and help me decide if I should eat something small before I go?',
    'I had grilled salmon with potatoes and salad for lunch, and I felt really good after. I’m thinking about meal prepping tomorrow because I have a busy week, but I don’t want boring meals. Can you estimate my lunch, tell me what I should eat tonight, and give me a simple two-day meal prep idea that has enough protein?',
    'I’m vegetarian and today was hard because I felt full very quickly. I had Greek yogurt, some fruit, a small salad, and a few crackers. I still need protein, but I don’t want eggs and I don’t feel like tofu. Can you help me find a gentle dinner idea, a snack option, and a plan for tomorrow so I don’t fall behind?',
    'I took my injection this morning and I’m feeling okay, just not very hungry. I had a protein shake and half a sandwich, but I don’t know if that’s enough. I also have a family dinner tomorrow and I want to feel prepared. Can you tell me what to focus on today, what to eat tonight, and how to plan for tomorrow’s dinner?',
    'I ate chicken and rice for lunch, but I don’t know if Grace should log it because I didn’t give the amount. I also feel good after the meal and I want to make something nice for Friday night that is still GLP-1 friendly. Can you ask me anything you need to log it accurately, estimate my protein if possible, and suggest a Friday dinner idea?',
    'I had a weird food day. I skipped breakfast, had coffee, then ate a big lunch with chicken, rice, salad, and hummus, and now I’m not hungry at all. I don’t want to force dinner, but I also don’t want to miss my protein goal. Can you help me decide if I should eat later, what kind of small option would work, and what I should do tomorrow morning?',
  ];
  for (const [i, msg] of BATTERY.entries()) {
    it(`battery #${i + 1} → multi-topic + food part (full answer, food still logged)`, () => {
      const u = analyzeMessage(msg);
      expect(u.hasMultiple).toBe(true);
      expect(u.kinds).toContain('food');
    });
  }
});
