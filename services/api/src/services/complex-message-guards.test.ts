import { describe, it, expect } from 'vitest';
import {
  ambiguousEatenFoods,
  ambiguousFoodNames,
  statesFalseConsumedTotal,
  stripReportShape,
  hasDisallowedProteinNumber,
  stripAssumedProteinSentences,
} from './ai.service.js';
import { analyzeMessage } from './message-understanding.js';

/**
 * OFFLINE EVAL HARNESS for complex multi-topic messages (2026-07-06).
 *
 * The live pipeline's food EXTRACTION and reply GENERATION are LLM calls we
 * can't run in CI. What CAN be proven deterministically — and what actually
 * guarantees correctness on any complex message — are the reply-layer guards:
 *
 *   1. ambiguousEatenFoods(text)  → derive the ambiguous EATEN foods straight
 *      from the message (independent of the extractor), so the reply can ask
 *      about EACH one instead of assuming it.
 *   2. statesFalseConsumedTotal   → a reply that claims an assumed consumed
 *      total (not the real logged total) is caught + regenerated.
 *   3. stripReportShape           → a "here's the plan: 1. 2." reply is stripped
 *      to warm prose.
 *
 * This battery runs the real, user-reported complex messages through those
 * guards and asserts the class is handled — no live Gemini needed. If a future
 * complex message slips, add it here and generalize the guard until it's green.
 */

// The user's real long multi-topic battery (each mixes eaten food + planning +
// emotion + questions). `ambiguous` = the eaten foods that CANNOT be logged
// without a clarification (a bare sandwich/wrap/burrito, or a protein shake with
// no scoop/brand). A clear/named/obvious food is loggable → not listed here.
const BATTERY: Array<{ msg: string; ambiguous: string[] }> = [
  {
    msg: "I'm going to my parents on Friday night and I know there will probably be a lot of food, maybe pasta, bread, desserts, and some kind of meat. I don't want to feel weird or restricted, but I also don't want to ruin my progress. Today I ate pretty light, just a protein shake and a sandwich, and I still feel like I need more protein. Can you help me plan what to eat before dinner, what to choose at the meal, and how to handle dessert without feeling guilty?",
    ambiguous: ['sandwich', 'protein shake'],
  },
  {
    msg: 'Today I took my injection this morning and I only had a protein shake and half a sandwich, but I don’t know if that’s enough. I also have a family dinner tomorrow and I want to feel prepared. Can you tell me what to focus on today, what to eat tonight, and how to plan for tomorrow’s dinner?',
    ambiguous: ['sandwich', 'protein shake'],
  },
  {
    msg: 'I forgot to log earlier, but today I had coffee, a banana, a turkey sandwich, some soup, and a few bites of chocolate. I feel mostly fine, just a little hungry now. Can you estimate my protein and suggest a smart dinner?',
    ambiguous: [], // "turkey sandwich" names its filling → loggable, not ambiguous
  },
  {
    msg: 'I had grilled salmon with potatoes and salad for lunch and I felt great. Can you estimate my lunch, tell me what to eat tonight, and give me a two-day meal prep idea?',
    ambiguous: ['salad'], // the bare side salad has an unknown composition → ask (salmon logs; salad asked)
  },
  {
    msg: "I'm vegetarian and today was hard. I had a veggie wrap and some fruit, and I still need protein. Can you help me find a gentle dinner idea and a plan for tomorrow?",
    ambiguous: [], // "veggie wrap" names its filling → loggable
  },
  {
    msg: 'I ate a burrito for lunch and a protein shake after the gym, feeling good but not sure if it was enough. What should I have for dinner and how do I hit my goal?',
    ambiguous: ['burrito', 'protein shake'],
  },
];

describe('offline harness — ambiguousEatenFoods derives what must be asked (not assumed)', () => {
  for (const [i, c] of BATTERY.entries()) {
    it(`#${i + 1} → asks about [${c.ambiguous.join(', ') || 'nothing ambiguous'}]`, () => {
      const res = ambiguousEatenFoods(c.msg);
      if (c.ambiguous.length === 0) {
        // Either null, or a set that doesn't include an unnamed sandwich/shake.
        if (res) expect(res.items).toEqual([]);
        else expect(res).toBeNull();
        return;
      }
      expect(res).not.toBeNull();
      // Every expected ambiguous food is surfaced (order-independent).
      for (const a of c.ambiguous) {
        expect(res!.items.some((it) => it.includes(a.split(' ').pop()!))).toBe(true);
      }
      // The clarify question names each ambiguous food so the reply can ask each.
      for (const a of c.ambiguous) {
        expect(res!.clarify.toLowerCase()).toContain(a.split(' ').pop()!);
      }
    });
  }

  it('every battery message is multi-topic (routes to the full grounded answer)', () => {
    for (const c of BATTERY) expect(analyzeMessage(c.msg).hasMultiple).toBe(true);
  });

  // Prod IMG_6708: "2 eggs with salad" logged the salad silently (→32g) because
  // the eggs' protein word masked the salad's composition-ambiguity. A separate
  // food joined by with/and must never resolve the salad — it stays asked.
  it('surfaces a salad reported ALONGSIDE eggs (eggs must not mask it)', () => {
    for (const msg of ['I had 2 eggs with salad', 'today I ate eggs and salad', 'this morning I had 2 eggs with a salad']) {
      const res = ambiguousEatenFoods(msg);
      expect(res, msg).not.toBeNull();
      expect(res!.items, msg).toContain('salad');
      expect(res!.clarify.toLowerCase(), msg).toContain('salad');
    }
  });

  // Prod IMG_6709: the log-path backstop echoed the WHOLE message as the food name
  // ("how many scoops was the I ate pretty light, just a protein shake and a
  // sandwich…"). ambiguousFoodNames must return only clean food words, never the
  // raw span — this is what the backstop now pends + asks about.
  it('ambiguousFoodNames returns clean food words for a raw consumption span', () => {
    const span = 'I ate pretty light, just a protein shake and a sandwich, and I still feel like I need more protein';
    const names = ambiguousFoodNames(span, span);
    expect(names).toContain('sandwich');
    expect(names).toContain('protein shake');
    // never the raw sentence
    for (const n of names) expect(n.length).toBeLessThan(20);
  });
});

describe('offline harness — statesFalseConsumedTotal catches an ASSUMED total', () => {
  it('flags "you\'ve likely consumed about 50g so far today" when the diary is empty (0g)', () => {
    const bad =
      "Based on your shake and sandwich, you've likely consumed about 50g of protein so far today. To hit your 140g goal, you still need 90g.";
    expect(statesFalseConsumedTotal(bad, 0)).toBe(true); // real logged total is 0
    expect(statesFalseConsumedTotal(bad, 50)).toBe(false); // matches → fine
  });
  it('leaves goal / to-go / need / advice numbers alone', () => {
    expect(statesFalseConsumedTotal('You still need 90g to hit your 140g goal today.', 0)).toBe(false);
    expect(statesFalseConsumedTotal('Aim for about 30g of protein at dinner tonight.', 0)).toBe(false);
    expect(statesFalseConsumedTotal("You're at 0g so far today — log a meal and I'll track it.", 0)).toBe(false);
  });
});

describe('offline harness — no ASSUMED protein number ships (ambiguous food)', () => {
  // The general rule that replaces phrase-by-phrase total detection: when food is
  // ambiguous, the ONLY allowed protein numbers are the real logged total and the
  // goal. Any other gram figure is an assumption, no matter how it's phrased.
  const ASSUMED =
    "Since your log is currently empty, let's estimate based on your description. A standard protein shake is usually ~25-30g and a sandwich (depending on the meat) is ~20-25g. That puts you around 50g of protein, meaning you likely need about 90g more to hit your 140g target.";
  it('flags every assumed estimate (25/30/20/50/90) with allowed = {realTotal 0, goal 140}', () => {
    expect(hasDisallowedProteinNumber(ASSUMED, [0, 140])).toBe(true);
  });
  it('a reply that mentions only the goal (140g) is allowed', () => {
    const clean = 'You are aiming for 140g today. Load your plate with the meat first at dinner. What was in the sandwich, and how many scoops was the shake?';
    expect(hasDisallowedProteinNumber(clean, [0, 140])).toBe(false);
  });
  it('strips the estimate/assumption sentences deterministically, leaving clean prose', () => {
    const out = stripAssumedProteinSentences(ASSUMED, [0, 140]);
    expect(out).not.toMatch(/\b(25|30|20|50|90)\s*g/i);
    expect(out.toLowerCase()).not.toContain('estimate'); // "let's estimate…" framing removed too
  });
});

describe('offline harness — stripReportShape guarantees warm prose', () => {
  it('strips "here is your strategy: 1." and "game plan: 1. 2." tails', () => {
    expect(stripReportShape('You have got this. Here is your strategy: 1.')).toBe('You have got this.');
    expect(stripReportShape('Family dinners can be tricky. Here is a game plan: 1. Yogurt. 2. Meat.')).toBe(
      'Family dinners can be tricky.',
    );
  });
  it('leaves clean warm prose untouched', () => {
    const good = 'Grab a Greek yogurt now, load up on the meat at dinner, and enjoy a few bites of dessert with zero guilt.';
    expect(stripReportShape(good)).toBe(good);
  });
});
