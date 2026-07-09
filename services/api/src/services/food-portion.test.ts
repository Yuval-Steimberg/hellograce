import { describe, it, expect } from 'vitest';
import { isPortionAffirmation, buildPortionConfirmQuestion, isPortionSensitiveFood, isCompositionAmbiguousFood, isProteinProductAmbiguous, hasPreciseAmount, isObviousSingleServing, servingReflectsUserAmount } from './food-portion.js';
import { hasExplicitQuantity } from '../safety/vague-food.js';

// A composition-ambiguous assembled food (a bare sandwich/wrap) must be ASKED
// about, never logged at an assumed value — even when an article is present.
// Prod (IMG_6699): Grace logged "a sandwich" at ~23g "assuming deli meat"; Nudge
// held it pending and asked. A named filling makes it loggable.
describe('isCompositionAmbiguousFood — ask what is IN it, never assume a filling', () => {
  it('is TRUE for a bare assembled food (even with an article)', () => {
    for (const f of ['sandwich', 'a sandwich', 'wrap', 'a wrap', 'burrito', 'taco', 'sub', 'hoagie', 'quesadilla', 'panini']) {
      expect(isCompositionAmbiguousFood(f), f).toBe(true);
    }
  });
  it('is FALSE once a filling/protein is named (loggable)', () => {
    for (const f of ['turkey sandwich', 'chicken wrap', 'egg sandwich', 'peanut butter sandwich', 'tuna sub', 'veggie burrito', 'ham and cheese sandwich']) {
      expect(isCompositionAmbiguousFood(f), f).toBe(false);
    }
  });
  it('a bare salad / poke bowl is composition-ambiguous (contents drive the protein) — prod "2 eggs with salad"', () => {
    for (const f of ['salad', 'a salad', 'caesar salad', 'greek salad', 'cobb salad', 'poke bowl', 'grain bowl', 'buddha bowl']) {
      expect(isCompositionAmbiguousFood(f), f).toBe(true);
    }
  });
  it('a described salad (named protein or greens) logs — no over-asking', () => {
    for (const f of ['chicken salad', 'tuna salad', 'egg salad', 'green salad', 'garden salad', 'side salad', 'spinach salad']) {
      expect(isCompositionAmbiguousFood(f), f).toBe(false);
    }
  });
  it('a SEPARATE food joined by with/and does NOT resolve the salad — prod "2 eggs with salad" (IMG_6708)', () => {
    // The eggs are a different food; the salad still has an unknown composition
    // → must be asked, not silently logged at an assumed greens value.
    for (const f of ['eggs with salad', '2 eggs with salad', 'eggs and salad', 'eggs, salad', 'chicken with a salad', 'a burger and a salad']) {
      expect(isCompositionAmbiguousFood(f), f).toBe(true);
    }
  });
  it('a filling attached to the salad itself (before, or after via with/of) still logs', () => {
    for (const f of ['salad with chicken', 'salad with tuna', 'chicken salad sandwich', 'grilled chicken salad']) {
      expect(isCompositionAmbiguousFood(f), f).toBe(false);
    }
  });
  it('is FALSE for non-assembled foods (a protein shake is not an assembled food)', () => {
    for (const f of ['protein shake', 'apple', 'banana', 'chicken', 'rice', 'yogurt', 'toast', 'burger']) {
      expect(isCompositionAmbiguousFood(f), f).toBe(false);
    }
  });
});

// A protein shake/drink/powder gives no protein number without the scoop count
// or brand — one scoop ~20g, two ~40g — so ASK, even with the article present.
describe('isProteinProductAmbiguous — ask for scoops/brand, never assume', () => {
  it('is TRUE for a bare protein product (even with an article)', () => {
    for (const f of ['protein shake', 'a protein shake', 'protein drink', 'whey', 'protein powder', 'protein smoothie']) {
      expect(isProteinProductAmbiguous(f), f).toBe(true);
    }
  });
  it('is FALSE once scoops / grams / a brand are given (in the item or the message)', () => {
    expect(isProteinProductAmbiguous('protein shake', 'I had a protein shake with 2 scoops')).toBe(false);
    expect(isProteinProductAmbiguous('protein shake', 'a fairlife protein shake')).toBe(false);
    expect(isProteinProductAmbiguous('protein shake', 'protein shake, 30g')).toBe(false);
    expect(isProteinProductAmbiguous('one scoop of whey')).toBe(false);
  });
  it('is FALSE for non-protein-products (a bar is standard; a milkshake / bare shake are not protein products)', () => {
    for (const f of ['protein bar', 'milkshake', 'shake', 'sandwich', 'chicken', 'apple']) {
      expect(isProteinProductAmbiguous(f), f).toBe(false);
    }
  });
});

describe('isPortionSensitiveFood — only ask when the portion swings the macros', () => {
  it('is TRUE for portion-variable foods', () => {
    for (const f of ['yogurt with berries', 'chicken', 'rice', 'pasta', 'oatmeal', 'a bowl of cereal', 'cheese', 'almonds', 'smoothie', 'beef and rice']) {
      expect(isPortionSensitiveFood(f), f).toBe(true);
    }
  });
  it('is FALSE for obvious / low-variance foods (just log)', () => {
    for (const f of ['apple', 'banana', 'toast', 'a boiled egg', 'orange', 'protein bar', 'a granola bar']) {
      expect(isPortionSensitiveFood(f), f).toBe(false);
    }
  });
});

describe('hasPreciseAmount — a real number/unit, NOT a bare size or vague quantifier', () => {
  it('is TRUE for a number or a measuring unit', () => {
    for (const t of ['2 eggs', 'a cup of rice', '6 oz chicken', 'three slices', '200 grams', 'one scoop protein', 'a bowl of oats', 'half a bagel', '1 bottle']) {
      expect(hasPreciseAmount(t), t).toBe(true);
    }
  });
  it('is FALSE for a bare size word or vague quantifier (still needs a confirm)', () => {
    for (const t of ['small yogurt', 'yogurt small', 'some crackers', 'crackers', 'a bit of chicken', 'a little rice', 'big salad', 'yogurt']) {
      expect(hasPreciseAmount(t), t).toBe(false);
    }
  });
});

describe('servingReflectsUserAmount — trust serving_size only when the USER stated it', () => {
  it('is TRUE when the amount token appears in the user message', () => {
    expect(servingReflectsUserAmount('1 cup', 'I had a cup of rice')).toBe(true);
    expect(servingReflectsUserAmount('a cup', 'a cup of rice')).toBe(true);
    expect(servingReflectsUserAmount('2 slices', 'I had 2 slices of toast')).toBe(true);
    expect(servingReflectsUserAmount('6 oz', 'grilled chicken, 6 oz')).toBe(true);
  });
  it('is FALSE when the extractor INVENTED an amount the user never gave', () => {
    // "small yogurt" → extractor guesses "1 cup"; the user never said cup/1.
    expect(servingReflectsUserAmount('1 cup', 'I only had a small yogurt')).toBe(false);
    expect(servingReflectsUserAmount('1 serving', 'some crackers')).toBe(false);
    expect(servingReflectsUserAmount('1 small yogurt', 'a small yogurt')).toBe(false); // no number/unit token in msg
  });
  it('is FALSE for an empty/absent serving_size', () => {
    expect(servingReflectsUserAmount(null, 'a small yogurt')).toBe(false);
    expect(servingReflectsUserAmount('', 'a small yogurt')).toBe(false);
  });
});

describe('isObviousSingleServing — a whole fruit / a wrapped bar logs without asking', () => {
  it('is TRUE for obvious single-serving foods', () => {
    for (const f of ['apple', 'a banana', 'orange', 'granola bar', 'protein bar', 'kind bar']) {
      expect(isObviousSingleServing(f), f).toBe(true);
    }
  });
  it('is FALSE for variable-portion foods', () => {
    for (const f of ['yogurt', 'crackers', 'chicken', 'rice', 'toast', 'cheese']) {
      expect(isObviousSingleServing(f), f).toBe(false);
    }
  });
});

describe('isPortionAffirmation', () => {
  it('accepts confirmations of the proposed standard portion', () => {
    for (const t of ['yes', 'yep', 'that\'s right', 'that\'s about right', 'about right', 'the usual', 'standard serving', 'log it', 'that works', 'perfect']) {
      expect(isPortionAffirmation(t), t).toBe(true);
    }
  });
  it('rejects a real portion answer or a new topic', () => {
    for (const t of ['a small cup', '6 oz', 'two cups of rice', 'actually a big bowl', 'what should I eat for dinner', 'no']) {
      expect(isPortionAffirmation(t), t).toBe(false);
    }
  });
});

describe('buildPortionConfirmQuestion', () => {
  it('asks the portion warmly and offers the standard-serving shortcut', () => {
    const q = buildPortionConfirmQuestion([{ item: 'yogurt with berries', protein_g: 18 }]);
    expect(q).toMatch(/yogurt with berries/i);
    expect(q).toMatch(/how much/i);
    expect(q).toMatch(/that'?s about right/i);
  });
  it('asks about EACH dish with a fitting reference, not one generic amount', () => {
    const q = buildPortionConfirmQuestion([{ item: 'chicken', protein_g: null }, { item: 'rice', protein_g: null }]);
    expect(q).toMatch(/chicken and rice/i);
    // per-dish references: a palm-sized piece for chicken, a cup for rice
    expect(q).toMatch(/for the chicken, a palm-sized piece/i);
    expect(q).toMatch(/for the rice, about a cup/i);
    expect(buildPortionConfirmQuestion([])).toBe('');
  });

  it('uses a food-appropriate reference for a single dish (not a blanket cup/container)', () => {
    expect(buildPortionConfirmQuestion([{ item: 'grilled chicken', protein_g: null }])).toMatch(/palm-sized piece/i);
    expect(buildPortionConfirmQuestion([{ item: 'white rice', protein_g: null }])).toMatch(/a cup/i);
    expect(buildPortionConfirmQuestion([{ item: 'greek yogurt', protein_g: null }])).toMatch(/small container/i);
  });

  it('asks what is IN a composition-ambiguous food (not how much), and never guesses the filling', () => {
    const q = buildPortionConfirmQuestion([{ item: 'sandwich', protein_g: null }]);
    expect(q).toMatch(/what was in the sandwich/i);
    expect(q).not.toMatch(/how much/i);
    expect(q.toLowerCase()).toContain('guess'); // "I'd rather log it right than guess"
  });

  it('mixes question types in a multi-item meal (what-was-in-it vs how-much)', () => {
    const q = buildPortionConfirmQuestion([{ item: 'sandwich', protein_g: null }, { item: 'rice', protein_g: null }]);
    expect(q).toMatch(/what was in the sandwich/i);
    expect(q).toMatch(/for the rice, about a cup/i);
  });

  it('asks a protein product for scoops/brand (not how much, not what is in it)', () => {
    const q = buildPortionConfirmQuestion([{ item: 'protein shake', protein_g: null }]);
    expect(q).toMatch(/how many scoops/i);
    expect(q).toMatch(/brand/i);
    expect(q).not.toMatch(/how much did you have/i);
  });

  it('asks scoops for the shake AND filling for the sandwich in one message', () => {
    const q = buildPortionConfirmQuestion([{ item: 'protein shake', protein_g: null }, { item: 'sandwich', protein_g: null }]);
    expect(q).toMatch(/how many scoops the protein shake/i);
    expect(q).toMatch(/what was in the sandwich/i);
  });

  // Prod IMG_6709: a raw consumption span reached the clarify builder as the
  // "item" → "how many scoops was the I ate pretty light, just a protein shake
  // and a sandwich…". Defense-in-depth: an over-long, sentence-like item is
  // reduced to its recognized food token so the whole message is never echoed.
  it('never echoes a raw sentence — reduces a span-as-item to the food token', () => {
    const raw = 'I ate pretty light, just a protein shake and a sandwich, and I still feel like I need more protein';
    const q = buildPortionConfirmQuestion([{ item: raw, protein_g: null }]);
    expect(q.toLowerCase()).not.toContain('i still feel');
    expect(q.toLowerCase()).not.toContain('pretty light');
    expect(q).toMatch(/protein shake/i); // asks about the actual food
    expect(q).toMatch(/how many scoops/i);
  });
});

describe('hasExplicitQuantity — the precision gate', () => {
  it('is FALSE for a portion-less meal (→ ask before logging)', () => {
    for (const t of ['yogurt with berries', 'i ate yogurt with berries', 'chicken and rice', 'had some pasta']) {
      expect(hasExplicitQuantity(t), t).toBe(false);
    }
  });
  it('is TRUE when an amount/unit/size/article is present (→ log)', () => {
    for (const t of ['2 eggs', 'a cup of rice', '6 oz chicken', 'a banana', 'a large yogurt', 'half a sandwich']) {
      expect(hasExplicitQuantity(t), t).toBe(true);
    }
  });
});
