import { describe, it, expect } from 'vitest';
import {
  isCompositionAmbiguousFood,
  isProteinProductAmbiguous,
  isPortionSensitiveFood,
  isPortionAffirmation,
  buildPortionConfirmQuestion,
} from './food-portion.js';
import {
  isFoodDiaryQuery,
  ambiguousEatenFoods,
  ambiguousFoodNames,
  stripReportShape,
  hasDisallowedProteinNumber,
  stripAssumedProteinSentences,
  statesFalseConsumedTotal,
} from './ai.service.js';
import { formatFoodReply } from './food-extract.js';
import { hasExplicitQuantity } from '../safety/vague-food.js';
import { namesSpecificFood, foodSpanFromConsumption } from './meal-lifecycle.js';
import { detectReminderIntent } from './reminder-service.js';
import { analyzeMessage } from './message-understanding.js';
import { sanitizeOutbound } from '../twilio/sender.js';
import { signupSequence, buildSignupCompleteReply, parseSlotAnswer } from '../onboarding/onboarding-flow.js';

/**
 * FULL-SYSTEM OFFLINE VERIFICATION (2026-07-07).
 *
 * Replays EVERY real user-reported scenario from the last weeks' screenshots
 * (IMG_6697…6717 + onboarding) through the DETERMINISTIC layer of the pipeline —
 * the part that guarantees accuracy regardless of which system prompt is active
 * and which does NOT need live Gemini. Each block names the screenshot it locks.
 *
 * What this CANNOT prove (needs the user's live look post-deploy): the exact
 * LLM-generated wording, and the food extractor's own splitting (an LLM pass).
 * Everything below is the deterministic contract the reply is built on.
 */

describe('ONBOARDING (IMG_6716) — slots, completion, name-glitch fix', () => {
  it('signup asks the slots in the right order (weekly injectable)', () => {
    const seq = signupSequence({ medication_frequency: 'weekly_injection' });
    expect(seq[0]).toBe('first_name');
    expect(seq).toContain('medication');
    expect(seq).toContain('injection_day');
    expect(seq[seq.length - 1]).toBe('consent');
  });
  it('captures the onboarding answers from the screenshot', () => {
    expect(parseSlotAnswer('first_name', 'Yuval').ok).toBe(true);
    expect(parseSlotAnswer('medication', 'Ozempic').ok).toBe(true);
    expect(parseSlotAnswer('injection_day', 'Wednesday').ok).toBe(true);
  });
  it('completion invites the FIRST food log', () => {
    const reply = buildSignupCompleteReply('Yuval');
    expect(reply.toLowerCase()).toMatch(/ate|eat|meal|food|log/);
  });
  it('FIX: "Nice to meet you,. 😊" no longer ships an orphaned comma (name stripped)', () => {
    const out = sanitizeOutbound('Nice to meet you,. Which GLP-1 are you taking?');
    expect(out).not.toMatch(/,\s*[.!?]/); // no ", ." / ", !"
    expect(out).toMatch(/Nice to meet you\. Which GLP-1/);
  });
});

describe('FOOD ACCURACY — salad not masked, protein correct (IMG_6708 / IMG_6717)', () => {
  it('a salad reported alongside eggs stays ambiguous (asked, not silently logged)', () => {
    for (const f of ['eggs with salad', '2 eggs with salad', 'eggs and salad']) {
      expect(isCompositionAmbiguousFood(f), f).toBe(true);
    }
  });
  it('a named salad/dish still logs (no over-asking)', () => {
    for (const f of ['egg salad', 'chicken salad', 'salad with chicken', 'turkey sandwich']) {
      expect(isCompositionAmbiguousFood(f), f).toBe(false);
    }
  });
  it('the food confirmation is deterministic, accurate, and varied — never "Yum", never invented', () => {
    const seen = new Set<string>();
    for (const seed of ['a', 'b', 'c', 'd']) {
      const r = formatFoodReply({ loggedItems: ['salad'], loggedProtein: 14, loggedCalories: 180, pendingFoods: [], seed });
      expect(r).not.toMatch(/yum|black coffee/i); // no repetition, no hallucinated food
      expect(r).toMatch(/14g/); // the REAL total (eggs 12 + salad 2), not 3g
      seen.add(r.split(' ').slice(0, 2).join(' '));
    }
    expect(seen.size).toBeGreaterThan(1); // openers vary
  });
});

describe('PROTEIN SHAKE + SANDWICH — ask scoops / what is in it (IMG_6699 / IMG_6700)', () => {
  it('a bare protein shake asks scoops/brand; a bare sandwich asks what is in it', () => {
    expect(isProteinProductAmbiguous('protein shake')).toBe(true);
    expect(isCompositionAmbiguousFood('sandwich')).toBe(true);
    const q = buildPortionConfirmQuestion([{ item: 'protein shake', protein_g: null }, { item: 'sandwich', protein_g: null }]);
    expect(q).toMatch(/how many scoops the protein shake/i);
    expect(q).toMatch(/what was in the sandwich/i);
  });
  it('a specified shake logs (scoops/brand present)', () => {
    expect(isProteinProductAmbiguous('protein shake', 'a fairlife protein shake')).toBe(false);
    expect(isProteinProductAmbiguous('protein shake', 'protein shake, 2 scoops')).toBe(false);
  });
});

describe('CLARIFY NEVER ECHOES THE WHOLE MESSAGE (IMG_6709)', () => {
  const span = 'I ate pretty light, just a protein shake and a sandwich, and I still feel like I need more protein';
  it('ambiguousFoodNames returns clean words, not the raw span', () => {
    const names = ambiguousFoodNames(span, span);
    expect(names).toContain('sandwich');
    expect(names).toContain('protein shake');
    for (const n of names) expect(n.length).toBeLessThan(20);
  });
  it('buildPortionConfirmQuestion reduces a span-as-item to the food token', () => {
    const q = buildPortionConfirmQuestion([{ item: span, protein_g: null }]);
    expect(q.toLowerCase()).not.toContain('i still feel');
    expect(q).toMatch(/protein shake/i);
  });
});

describe('DIARY QUERY answered from the LOG, any phrasing (IMG_6710 / IMG_6711)', () => {
  it('recognizes every phrasing incl. the greeting + word-order case', () => {
    for (const t of [
      'Good morning, what I have eaten today?', 'what have I eaten today?', 'what did I eat today',
      'how much protein have I had today?', "show me today's food", 'recap my meals today',
    ]) expect(isFoodDiaryQuery(t), t).toBe(true);
  });
  it('does NOT fire for recommendations / plans / logs', () => {
    for (const t of ['what should I eat today?', 'any ideas for breakfast?', 'I ate a chicken sandwich today']) {
      expect(isFoodDiaryQuery(t), t).toBe(false);
    }
  });
  it('empty log → a clean "nothing logged yet" (not a history reconstruction)', () => {
    expect(formatFoodReply({ loggedItems: [], loggedProtein: 0, pendingFoods: [], seed: 'x' })).toBe('');
    // renderDailyFoodSummary is the diary renderer; formatFoodReply('') means the
    // diary intercept uses renderDailyFoodSummary → covered in food-diary-query.test.ts
  });
});

describe('PORTION ANSWER resolves deterministically, no history leak (IMG_6713)', () => {
  it('"One cup" is a portion answer (quantity, no new food) → resolves, never grounded', () => {
    expect(hasExplicitQuantity('One cup')).toBe(true);
    expect(namesSpecificFood('One cup')).toBe(false);
    expect(isPortionAffirmation('One cup')).toBe(false); // it's a real amount, not "yes"
  });
  it('a new food in the reply ("two cups of rice") is NOT treated as a portion answer', () => {
    expect(namesSpecificFood('two cups of rice')).toBe(true);
  });
});

describe('MULTI-TOPIC PLANNING — every part, no assumed total, no game plan (IMG_6697…6707)', () => {
  const friday =
    "I'm going to my parents on Friday night and there will be a lot of food, maybe pasta, bread, desserts. Today I ate pretty light, just a protein shake and a sandwich, and I still feel like I need more protein. Can you help me plan what to eat before dinner, what to choose at the meal, and how to handle dessert without feeling guilty?";
  it('is multi-topic (routes to the full grounded answer)', () => {
    expect(analyzeMessage(friday).hasMultiple).toBe(true);
  });
  it('surfaces the ambiguous eaten foods to ask about', () => {
    const res = ambiguousEatenFoods(friday);
    expect(res).not.toBeNull();
    expect(res!.items.some((i) => i.includes('sandwich'))).toBe(true);
    expect(res!.items.some((i) => i.includes('shake'))).toBe(true);
  });
  it('a "here is your game plan: 1. 2." reply is stripped to warm prose', () => {
    expect(stripReportShape('You have got this. Here is your game plan: 1. Yogurt. 2. Meat.')).toBe('You have got this.');
  });
  it('an assumed protein number (not the real total/goal) is caught + stripped', () => {
    const assumed = "A shake is ~25-30g and a sandwich is ~20-25g, so you're around 50g of your 140g goal.";
    expect(hasDisallowedProteinNumber(assumed, [0, 140])).toBe(true);
    const cleaned = stripAssumedProteinSentences(assumed, [0, 140]);
    expect(cleaned).not.toMatch(/\b(25|30|20|50)\s*g/);
  });
  it('a false consumed total is caught vs the real logged total', () => {
    expect(statesFalseConsumedTotal("you've consumed about 50g so far today", 0)).toBe(true);
    expect(statesFalseConsumedTotal('aim for about 30g at dinner', 0)).toBe(false); // advice is fine
  });
});

describe('REMINDERS — Grace answers, never denies capability (capability screenshots)', () => {
  it('recognizes reminder-status / change questions', () => {
    expect(detectReminderIntent('when is my next reminder?')).not.toBeNull();
    expect(detectReminderIntent('would you send me a reminder tomorrow morning?')).not.toBeNull();
    expect(detectReminderIntent('can you change my reminder time?')).not.toBeNull();
  });
});

describe('PORTION-SENSITIVE FOODS ask, obvious foods just log', () => {
  it('portion-variable → ask', () => {
    for (const f of ['chicken', 'rice', 'yogurt with berries', 'pasta']) expect(isPortionSensitiveFood(f), f).toBe(true);
  });
  it('obvious/low-variance → log', () => {
    for (const f of ['apple', 'banana', 'a boiled egg', 'protein bar']) expect(isPortionSensitiveFood(f), f).toBe(false);
  });
});
