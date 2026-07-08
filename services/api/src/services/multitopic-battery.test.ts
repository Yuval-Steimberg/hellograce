import { describe, it, expect } from 'vitest';
import { analyzeMessage } from './message-understanding.js';
import { ambiguousEatenFoods, isFoodDiaryQuery } from './ai.service.js';
import { askKeywordGroups, uncoveredAskCount } from './multi-ask-coverage.js';
import { detectReminderIntent } from './reminder-service.js';
import { classifyMessage } from '../safety/guard.js';
import { detectHypoglycemiaWarning } from '../safety/hypoglycemia-warning.js';

/**
 * REAL long multi-topic messages (user battery, 2026-07-08). Locks the
 * DETERMINISTIC contract for each: they all route to the full grounded answer,
 * ambiguous eaten foods are ASKED (never assumed), safety never false-fires, and
 * the diary/reminder intercepts don't misfire on a planning message. The LLM
 * wording + food extraction are a live pass — everything below is the accuracy
 * backbone that holds regardless of the model.
 */
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

describe('multi-topic battery — every message routes to the full grounded answer', () => {
  it('all are detected as multi-topic (never collapse to a terse food confirmation)', () => {
    for (const m of BATTERY) {
      expect(analyzeMessage(m).hasMultiple, m.slice(0, 40)).toBe(true);
    }
  });
  it('each is understood as touching food AND a question/plan', () => {
    for (const m of BATTERY) {
      const kinds = analyzeMessage(m).kinds;
      expect(kinds).toContain('food');
      expect(kinds.some((k) => k === 'question' || k === 'food_question' || k === 'progress_question')).toBe(true);
    }
  });
});

describe('multi-topic battery — safety never false-fires on a wellness message', () => {
  it('no message is classified as crisis/emergency', () => {
    for (const m of BATTERY) expect(classifyMessage(m).class, m.slice(0, 40)).toBe('safe');
  });
  it('the hypoglycemia handler does NOT fire (none is a 2-symptom cluster)', () => {
    // #5 mentions "low energy / weak" but that is a single symptom → no warning.
    for (const m of BATTERY) expect(detectHypoglycemiaWarning(m).warning, m.slice(0, 40)).toBe(false);
  });
});

describe('multi-topic battery — intercepts do not misfire on a planning message', () => {
  it('the food-diary intercept does not steal these (they are asks, not "what did I eat")', () => {
    for (const m of BATTERY) expect(isFoodDiaryQuery(m), m.slice(0, 40)).toBe(false);
  });
  it('the reminder intercept does not steal these ("remind me what to do tomorrow" is a plan, not a reminder config)', () => {
    for (const m of BATTERY) expect(detectReminderIntent(m), m.slice(0, 40)).toBeNull();
  });
});

describe('multi-topic battery — ambiguous eaten foods are ASKED, never assumed a number', () => {
  it('a bare sandwich + protein shake are flagged to clarify', () => {
    const friday = ambiguousEatenFoods(BATTERY[2]!); // shake + sandwich
    expect(friday).not.toBeNull();
    expect(friday!.items).toEqual(expect.arrayContaining(['sandwich', 'protein shake']));
    const shakeSandwich = ambiguousEatenFoods(BATTERY[12]!); // "protein shake and half a sandwich"
    expect(shakeSandwich!.items).toEqual(expect.arrayContaining(['sandwich', 'protein shake']));
  });
  it('a bare salad alongside a logged protein is flagged (not masked)', () => {
    expect(ambiguousEatenFoods(BATTERY[10]!)!.items).toContain('salad'); // salmon + potatoes + salad
    expect(ambiguousEatenFoods(BATTERY[11]!)!.items).toContain('salad'); // vegetarian: small salad
  });
  it('a clearly-portioned/named meal is NOT flagged as ambiguous', () => {
    expect(ambiguousEatenFoods(BATTERY[6]!)).toBeNull(); // "I ate pasta for lunch" (portion-sensitive, not composition-ambiguous)
    expect(ambiguousEatenFoods(BATTERY[0]!)).toBeNull(); // eggs/toast/chicken+rice
  });
});

describe('multi-topic battery — enumerated multi-ask completeness tracking', () => {
  it('the Friday message tracks its three sub-asks (before dinner / at the meal / dessert)', () => {
    const groups = askKeywordGroups(BATTERY[2]!);
    expect(groups.length).toBe(3);
    const flat = groups.map((g) => g[0]);
    expect(flat).toEqual(expect.arrayContaining(['dinner', 'meal', 'dessert']));
    // A reply that only covers before-dinner leaves two asks uncovered.
    expect(uncoveredAskCount(BATTERY[2]!, 'Have a Greek yogurt before you go so you are not hungry.')).toBe(2);
  });
});

// ─── Positive controls — the intercepts DO fire when they genuinely should ────

describe('safety + intercept positive controls (comprehensiveness)', () => {
  it('a real self-harm message IS flagged (crisis), not "safe"', () => {
    expect(classifyMessage('I want to hurt myself and end it all').class).not.toBe('safe');
  });
  it('a real 2-symptom hypo cluster DOES fire the warning', () => {
    const h = detectHypoglycemiaWarning("I'm shaky, sweaty, and lightheaded right now");
    expect(h.warning).toBe(true);
    expect(h.response!.toLowerCase()).toMatch(/sugar|juice|doctor/);
  });
  it('a genuine diary query IS recognized', () => {
    expect(isFoodDiaryQuery('what have I eaten today?')).toBe(true);
    expect(isFoodDiaryQuery('how much protein have I had today')).toBe(true);
  });
  it('a genuine reminder question IS recognized', () => {
    expect(detectReminderIntent('when is my next reminder?')).not.toBeNull();
  });
});
