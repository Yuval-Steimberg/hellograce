import { describe, it, expect } from 'vitest';
import {
  detectMealConsumption,
  detectConsumptionFeedback,
  extractFoodMention,
  foodSpanFromConsumption,
  namesSpecificFood,
  isConsumptionConfirmed,
  isPreferenceLanguage,
  isBareConsumptionBackReference,
  mentionsFood,
} from './meal-lifecycle.js';
import { isCompositionAmbiguousFood } from './food-portion.js';
import { hasExplicitQuantity } from '../safety/vague-food.js';

// The exact deterministic gate foodStepUnified uses to resolve a bare filling
// answer ("Cheese") against a pending composition-ambiguous item ("salad") —
// logging "<filling> <food>" instead of falling to the grounded path (prod fix).
function compositionResolves(text: string, pendingItem: string): boolean {
  return (
    isCompositionAmbiguousFood(pendingItem) &&
    !hasExplicitQuantity(text) &&
    namesSpecificFood(text) &&
    !foodSpanFromConsumption(text) &&
    text.split(/\s+/).length <= 3
  );
}

describe('composition-answer resolution gate (prod: "Cheese" → the pending salad)', () => {
  it('fires for a bare filling word answering "what was in the salad?"', () => {
    expect(isCompositionAmbiguousFood('salad')).toBe(true);
    expect(compositionResolves('Cheese', 'salad')).toBe(true);
    expect(compositionResolves('turkey', 'salad')).toBe(true);
    expect(compositionResolves('chicken', 'sandwich')).toBe(true);
  });
  it('does NOT fire for a new consumption log, an amount, or a long reply', () => {
    expect(compositionResolves('I ate a burrito', 'salad')).toBe(false); // consumption → new log
    expect(compositionResolves('one cup', 'salad')).toBe(false); // amount → portion branch
    expect(compositionResolves('cheese and crackers and some grapes', 'salad')).toBe(false); // too long
  });
  it('does NOT fire when nothing composition-ambiguous is pending', () => {
    expect(compositionResolves('Cheese', 'rice')).toBe(false); // rice is portion-ambiguous, not composition
  });
});

// The pending DETAIL-resolution branch: a reply that names the pending food(s)
// WITH details ("Cheese sandwich and one scoop protein shake") — has both a
// filling and an amount, for several items. Prod IMG_6733/6735: it fell to the
// grounded path, which hallucinated a total and logged nothing.
function detailResolve(text: string, pending: string[]): { logged: string[]; unresolved: string[]; fellThrough: boolean } {
  // Mirrors foodStepUnified's DETAIL-resolution branch: a question or a
  // fresh-food mention disqualifies it (fall through), pending items match
  // DISTINCT segments, and any unmatched food-bearing segment forces fall-through
  // so a new food is never dropped.
  const looksLikeQuestion =
    /\?/.test(text) ||
    /^\s*(is|are|was|were|do|does|did|can|could|should|would|will|why|what|how|when|where|which|who|whose)\b/i.test(text);
  const gate = pending.length > 0 && !looksLikeQuestion && namesSpecificFood(text) && !foodSpanFromConsumption(text) && text.split(/\s+/).length <= 12;
  if (!gate) return { logged: [], unresolved: pending, fellThrough: true };
  const segments = text.split(/\s+and\s+|,|;/i).map((s) => s.trim().replace(/[.!?]+$/, '')).filter(Boolean);
  const usedSeg = new Set<number>();
  const matched: string[] = [];
  const unresolved: string[] = [];
  for (const p of pending) {
    const key = (p.toLowerCase().split(/\s+/).pop() || p.toLowerCase());
    const idx = segments.findIndex((s, i) => !usedSeg.has(i) && new RegExp(`\\b${key}\\b`, 'i').test(s));
    if (idx >= 0) { usedSeg.add(idx); matched.push(segments[idx]!); } else unresolved.push(p);
  }
  const hasFreshFood = segments.some((s, i) => !usedSeg.has(i) && namesSpecificFood(s));
  if (matched.length > 0 && !hasFreshFood) return { logged: matched, unresolved, fellThrough: false };
  return { logged: [], unresolved: pending, fellThrough: true };
}

describe('pending DETAIL resolution gate (prod IMG_6733: shake + sandwich never logged)', () => {
  it('resolves both pending items to the right segments', () => {
    const r = detailResolve('Cheese sandwich and one scoop protein shake', ['sandwich', 'protein shake']);
    expect(r.logged).toEqual(['Cheese sandwich', 'one scoop protein shake']);
    expect(r.unresolved).toEqual([]);
  });
  it('resolves a single detailed answer', () => {
    expect(detailResolve('one scoop protein shake', ['protein shake']).logged).toEqual(['one scoop protein shake']);
    expect(detailResolve('turkey sandwich', ['sandwich']).logged).toEqual(['turkey sandwich']);
  });
  it('leaves an unmentioned pending item pending, and never hijacks an unrelated food', () => {
    // A new/unrelated food does not match the pending keyword → nothing logged, falls through.
    const r = detailResolve('some chicken', ['sandwich']);
    expect(r.logged).toEqual([]);
    expect(r.unresolved).toEqual(['sandwich']);
    expect(r.fellThrough).toBe(true);
  });
  it('does not fire on a fresh consumption log ("I ate a sandwich")', () => {
    // foodSpanFromConsumption matches → the gate is false → handled as a new log.
    expect(detailResolve('I ate a turkey sandwich', ['sandwich']).logged).toEqual([]);
  });
  // A QUESTION about the pending food must NEVER be logged as food (was: logged
  // the raw question string as a sandwich + wiped the pending clarify).
  it('never logs a QUESTION about the pending food', () => {
    for (const q of ['Is the sandwich healthy?', 'why did you ask about the sandwich', 'how many calories is the sandwich']) {
      const r = detailResolve(q, ['sandwich']);
      expect(r.logged, q).toEqual([]);
      expect(r.fellThrough, q).toBe(true);
    }
  });
  // A fresh food alongside a pending one must NOT be dropped (was: logged only
  // rice, silently dropped chicken). Falls through so the extractor logs both.
  it('falls through when the message also names a FRESH food (never drops it)', () => {
    const r = detailResolve('chicken and rice', ['rice']);
    expect(r.logged).toEqual([]); // deterministic branch declines → extractor handles both
    expect(r.fellThrough).toBe(true);
  });
  // Two pending items sharing a trailing word must map to DISTINCT segments
  // (was: both collapsed onto the first → one double-logged, the other dropped).
  it('maps two same-suffix pending items to distinct segments', () => {
    const r = detailResolve('cheese sandwich and ham sandwich', ['chicken sandwich', 'turkey sandwich']);
    expect(r.logged).toEqual(['cheese sandwich', 'ham sandwich']);
    expect(r.unresolved).toEqual([]);
  });
});

describe('foodSpanFromConsumption — never-drop backstop for "I ate X … <question>"', () => {
  it('extracts the eaten meal, slicing off the trailing question (prod: salmon)', () => {
    expect(
      foodSpanFromConsumption('I had salmon with potatoes and salad. How much protein is that roughly, and what should I eat later?'),
    ).toBe('I had salmon with potatoes and salad');
  });
  it('handles a mid-sentence question clause with no period', () => {
    expect(foodSpanFromConsumption('I ate chicken and rice how much protein was that')).toBe('I ate chicken and rice');
    expect(foodSpanFromConsumption('just had a greek yogurt, any idea what to eat next?')).toBe('just had a greek yogurt');
  });
  it('slices off trailing state/context clauses (prod 2026-07-04: yogurt + injection + hunger)', () => {
    expect(foodSpanFromConsumption('I ate yogurt with berries after my injection and now I’m a little hungry. Any snack idea?'))
      .toBe('I ate yogurt with berries');
    expect(foodSpanFromConsumption('I ate chicken and now I’m full')).toBe('I ate chicken');
    expect(foodSpanFromConsumption('I had a protein shake after my workout')).toBe('I had a protein shake');
    // Must NOT over-cut a real food phrase:
    expect(foodSpanFromConsumption('I ate chicken with rice')).toBe('I ate chicken with rice');
  });
  it('anchors on the ACTUAL eaten clause, not a leading future/other-food clause (prod 2026-07-06 Friday msg)', () => {
    const span = foodSpanFromConsumption(
      "I'm going to my parents on Friday night and there will probably be a lot of food, maybe pasta, bread, desserts, and some kind of meat. Today I ate pretty light, just a protein shake and a sandwich, and I still feel like I need more protein. Can you help me plan what to eat?",
    );
    expect(span).toMatch(/protein shake/i);
    expect(span).toMatch(/sandwich/i);
    expect(span).not.toMatch(/pasta|bread/i); // the future dinner food is NOT what they ate
  });
  it('returns null for a PURE question (nothing eaten)', () => {
    expect(foodSpanFromConsumption('what should I eat later?')).toBeNull();
    expect(foodSpanFromConsumption('what did I eat today?')).toBeNull();
    expect(foodSpanFromConsumption('how much protein is in salmon?')).toBeNull();
  });
  it('returns null for preference / planning language (never log interest)', () => {
    expect(foodSpanFromConsumption('salmon sounds good, maybe later')).toBeNull();
    expect(foodSpanFromConsumption("I think I'll have the salmon")).toBeNull();
  });
  it('returns null when a consumption verb names no real food', () => {
    expect(foodSpanFromConsumption('I had a really rough day, any advice?')).toBeNull();
    expect(foodSpanFromConsumption('I had a great time at the gym')).toBeNull();
  });
  it('is voided by negation IN the eating clause ("I did not eat")', () => {
    expect(foodSpanFromConsumption("I haven't had lunch yet, what should I make?")).toBeNull();
    expect(isConsumptionConfirmed("I haven't had lunch yet")).toBe(false);
    expect(isConsumptionConfirmed('I skipped lunch')).toBe(false);
  });
  it('a negation about something ELSE does NOT drop the eaten food ("ate eggs but didn\'t drink water")', () => {
    expect(isConsumptionConfirmed("I ate eggs and toast but I didn't drink enough water today")).toBe(true);
    const span = foodSpanFromConsumption("I ate eggs and toast but I didn't drink enough water today. what should I eat next?");
    expect(span).toContain('eggs');
    expect(span).toContain('toast');
    // "I didn't eat X but I had Y" — the eaten Y (a real food) is confirmed.
    expect(isConsumptionConfirmed('I didn\'t eat breakfast but I had chicken and rice')).toBe(true);
  });
  it('keeps a plain consumption statement intact when there is no question', () => {
    expect(foodSpanFromConsumption('I ate 3 eggs and a banana')).toBe('I ate 3 eggs and a banana');
  });
  it('returns null when only a meal-TIME word is named (prod: breakfast late)', () => {
    // "I had breakfast late, skipped lunch, big dinner?" names no real dish → nothing to log.
    expect(foodSpanFromConsumption('I had breakfast late, skipped lunch, should I eat a big dinner or something small')).toBeNull();
    expect(foodSpanFromConsumption('I had a big lunch today')).toBeNull();
    expect(foodSpanFromConsumption('grabbed dinner earlier')).toBeNull();
  });
});

describe('namesSpecificFood — a real dish vs a bare meal-time word', () => {
  it('true for an actual food / dish', () => {
    for (const t of ['salmon', 'I had salmon with potatoes', 'chicken for lunch', 'breakfast burrito', 'a bowl of oatmeal', '3 eggs'])
      expect(namesSpecificFood(t)).toBe(true);
  });
  it('false for a bare meal-time / container word (no dish named)', () => {
    for (const t of ['breakfast', 'a big lunch', 'dinner', 'I had breakfast late', 'grabbed a snack', 'skipped lunch', 'a big meal'])
      expect(namesSpecificFood(t)).toBe(false);
  });
});

describe('detectConsumptionFeedback — follow-up after trying a suggestion', () => {
  // The exact production failure + the spec's example set. General across
  // phrasing, not hardcoded to "smoothie".
  const YES = [
    'Thanks I feel good after drinking smoothie',
    'Thanks, I tried it',
    'I feel better after eating that',
    'The smoothie was good',
    'That worked',
    'I drank the one you suggested',
    'I feel good after that',
    'It helped',
    'the oatmeal was great',
    'I tried the omelet you recommended',
    'feeling full after the wrap, that worked well',
  ];
  for (const m of YES) {
    it(`"${m}" → consumption feedback`, () => expect(detectConsumptionFeedback(m)).toBe(true));
  }

  const NO = [
    'What should I have for breakfast?', // new request
    'Can you give me dinner ideas', // new request
    "I don't feel good after eating that", // negated → symptom, not positive feedback
    "I haven't tried it yet", // negated
    'I ate two eggs and toast', // plain food log, no feedback phrasing
    'what kind of smoothie is best', // question / new request
  ];
  for (const m of NO) {
    it(`"${m}" → NOT consumption feedback`, () => expect(detectConsumptionFeedback(m)).toBe(false));
  }
});

describe('extractFoodMention', () => {
  it('pulls the named dish for echo-back', () => {
    expect(extractFoodMention('I feel good after drinking smoothie')).toBe('smoothie');
    expect(extractFoodMention('the omelet was great')).toBe('omelet');
  });
  it('returns null for generic meal words (no concrete dish)', () => {
    expect(extractFoodMention('that breakfast was great')).toBeNull();
    expect(extractFoodMention('it worked')).toBeNull();
  });
});

describe('mentionsFood — food-context gate', () => {
  it('detects named foods / dishes', () => {
    expect(mentionsFood('halloumi and roasted vegetable plate')).toBe(true);
    expect(mentionsFood('the omelet')).toBe(true);
    expect(mentionsFood('lentil dal')).toBe(true);
    expect(mentionsFood('chicken bowl')).toBe(true);
  });
  it('returns false for bare affirmations with no food', () => {
    expect(mentionsFood('that sounds good')).toBe(false);
    expect(mentionsFood('that works')).toBe(false);
    expect(mentionsFood('might make')).toBe(false);
  });
});

describe('detectMealConsumption — preference (never log)', () => {
  const PREFERENCE = [
    'That sounds good.',
    'Halloumi and roasted vegetable plate sounds good',
    'Maybe the lentil dal.',
    'I like the omelet option.',
    'I might make that.',
    'Sounds good',
    'Looks good',
    'I like that',
    'Maybe',
    "I'll try that",
    "I think I'll have that",
    'Considering it',
    'Planning to eat that',
    'I might make it',
    'That works',
    "I'll go with the omelet",
    "I'm gonna have the salmon",
    'Going with the chicken bowl',
    // Picking a suggested option (production: user replied to breakfast ideas).
    'Overnight oats will work',
    'The oats work for me',
    'Greek yogurt works for now',
    "That'll do",
  ];
  for (const m of PREFERENCE) {
    it(`"${m}" → preference`, () => {
      expect(detectMealConsumption(m)).toBe('preference');
      expect(isPreferenceLanguage(m)).toBe(true);
      expect(isConsumptionConfirmed(m)).toBe(false);
    });
  }
});

describe('detectMealConsumption — consumption (log)', () => {
  const CONSUMED = [
    'I ate the lentil dal.',
    'Just finished dinner.',
    'Log the halloumi plate.',
    'Had the omelet.',
    'I ended up eating it.',
    'I had two eggs',
    'For dinner I had chicken and rice',
    'Finished eating my lunch',
    'Ended up having the salmon',
    'Track my lunch — a chicken wrap',
    'Add that to my log',
    "I'm eating a protein shake",
  ];
  for (const m of CONSUMED) {
    it(`"${m}" → consumed`, () => {
      expect(detectMealConsumption(m)).toBe('consumed');
      expect(isConsumptionConfirmed(m)).toBe(true);
    });
  }
});

describe('detectMealConsumption — consumption wins over preference', () => {
  it('eating phrasing dominates an embedded "sounds good"', () => {
    expect(detectMealConsumption('I ended up eating the dal that sounded good')).toBe('consumed');
  });
  it('"I had it, it was good" is consumption not preference', () => {
    expect(detectMealConsumption('I had the omelet, it was good')).toBe('consumed');
  });
});

describe('detectMealConsumption — negation voids consumption', () => {
  it('"I didn\'t eat it" is not consumption', () => {
    expect(isConsumptionConfirmed("I didn't eat the dal")).toBe(false);
  });
  it('"haven\'t had it yet" is not consumption', () => {
    expect(isConsumptionConfirmed("I haven't had it yet")).toBe(false);
  });
});

describe('detectMealConsumption — neither (plain logs / unrelated)', () => {
  // A plain food log has no preference words — the dedicated food-log paths
  // handle it, so the lifecycle classifier returns 'neither'.
  it('a bare food list is neither preference nor (lifecycle) consumption-phrase', () => {
    // "2 eggs and toast" has no eat verb and no preference word.
    expect(detectMealConsumption('2 eggs and toast')).toBe('neither');
  });
  it('unrelated chatter is neither', () => {
    expect(detectMealConsumption('how are you today')).toBe('neither');
    expect(detectMealConsumption('')).toBe('neither');
  });
});

describe('isBareConsumptionBackReference', () => {
  const YES = [
    'I ended up making it',
    'had it',
    'ate it',
    'I finished it',
    'made it',
    'I ended up having it.',
    'finished the dish',
  ];
  for (const m of YES) {
    it(`"${m}" → bare back-reference`, () => expect(isBareConsumptionBackReference(m)).toBe(true));
  }
  const NO = [
    'I ate two eggs and toast', // names a food
    "I'll make it", // future preference, not consumption
    "I didn't make it", // negated
    'I ended up making a big pot of chili with beans and rice for the week', // too long / names food
  ];
  for (const m of NO) {
    it(`"${m}" → NOT a bare back-reference`, () => expect(isBareConsumptionBackReference(m)).toBe(false));
  }
});
