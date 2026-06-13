import { describe, it, expect } from 'vitest';
import { lookupCommonFoodMacros, estimateMultiItemFood, __testing } from './log-food.js';

const { parseItemizedEstimate, sumItemized } = __testing;

describe('lookupCommonFoodMacros — fast-path macro table (2026-06-01)', () => {
  it('matches "2 eggs" exactly', () => {
    const r = lookupCommonFoodMacros('2 eggs');
    expect(r).not.toBeNull();
    expect(r?.protein_g).toBe(12);
    expect(r?.calories).toBe(140);
    expect(r?.confidence).toBe('high');
  });

  it('matches "I just had 2 eggs for breakfast" (article + verb + suffix stripped)', () => {
    const r = lookupCommonFoodMacros('I just had 2 eggs for breakfast');
    expect(r).not.toBeNull();
    expect(r?.protein_g).toBe(12);
  });

  it('matches "Hey, just had 2 eggs" (greeting stripped)', () => {
    const r = lookupCommonFoodMacros('Hey, just had 2 eggs');
    expect(r).not.toBeNull();
    expect(r?.protein_g).toBe(12);
  });

  it('matches "chicken and rice" (compound entry)', () => {
    const r = lookupCommonFoodMacros('chicken and rice');
    expect(r).not.toBeNull();
    expect(r?.protein_g).toBe(34);
  });

  it('prefers the longest matching key ("chicken and rice" wins over "chicken")', () => {
    const r = lookupCommonFoodMacros('had chicken and rice');
    expect(r?.protein_g).toBe(34);
  });

  it('matches "1 chicken breast"', () => {
    expect(lookupCommonFoodMacros('1 chicken breast')?.protein_g).toBe(30);
  });

  it('matches a protein shake by various phrasings', () => {
    expect(lookupCommonFoodMacros('protein shake')?.protein_g).toBe(25);
    expect(lookupCommonFoodMacros('just had a protein shake')?.protein_g).toBe(25);
    expect(lookupCommonFoodMacros('1 scoop protein')?.protein_g).toBe(25);
  });

  it('matches "Greek yogurt" / "cup of Greek yogurt"', () => {
    expect(lookupCommonFoodMacros('Greek yogurt')?.protein_g).toBe(17);
    expect(lookupCommonFoodMacros('cup of Greek yogurt')?.protein_g).toBe(17);
  });

  it('matches "Big Mac"', () => {
    expect(lookupCommonFoodMacros('Big Mac')?.protein_g).toBe(25);
    expect(lookupCommonFoodMacros('I had a Big Mac')?.protein_g).toBe(25);
  });

  it('matches "2 slices of pizza"', () => {
    expect(lookupCommonFoodMacros('2 slices of pizza')?.protein_g).toBe(22);
    expect(lookupCommonFoodMacros('1 slice of pizza')?.protein_g).toBe(11);
  });

  it('returns null for unknown / compound items (falls through to LLM)', () => {
    expect(lookupCommonFoodMacros('vegetarian shepherd pie with lentils')).toBeNull();
    expect(lookupCommonFoodMacros('cheddar chickpea bake')).toBeNull();
    expect(lookupCommonFoodMacros('miso soup with tofu')).toBeNull();
  });

  it('returns null for too-short input', () => {
    expect(lookupCommonFoodMacros('a')).toBeNull();
    expect(lookupCommonFoodMacros('')).toBeNull();
  });

  it('matches "For lunch chicken breast with cup of rice"', () => {
    // The exact multi-meal segment from the 2026-06-01 production failure.
    const r = lookupCommonFoodMacros('For lunch chicken breast with cup of rice');
    expect(r).not.toBeNull();
    // "chicken breast with rice" → 34g (compound entry)
    expect(r?.protein_g).toBe(34);
  });

  it('matches "For breakfast i ate 2 eggs" (production multi-meal segment)', () => {
    const r = lookupCommonFoodMacros('For breakfast i ate 2 eggs');
    expect(r).not.toBeNull();
    expect(r?.protein_g).toBe(12);
  });
});

describe('lookupCommonFoodMacros — Phase 16 expansion (2026-06-03)', () => {
  it('hits Greek yogurt brands', () => {
    expect(lookupCommonFoodMacros('Fage')?.protein_g).toBe(18);
    expect(lookupCommonFoodMacros('I had chobani')?.protein_g).toBe(14);
    expect(lookupCommonFoodMacros('oikos')?.protein_g).toBe(15);
  });

  it('hits cottage cheese full-cup portion', () => {
    expect(lookupCommonFoodMacros('1 cup cottage cheese')?.protein_g).toBe(28);
  });

  it('hits branded protein bars', () => {
    expect(lookupCommonFoodMacros('quest bar')?.protein_g).toBe(20);
    expect(lookupCommonFoodMacros('I had a rxbar')?.protein_g).toBe(12);
    expect(lookupCommonFoodMacros('built bar')?.protein_g).toBe(18);
    expect(lookupCommonFoodMacros('clif bar')?.protein_g).toBe(9);
  });

  it('hits branded shakes', () => {
    expect(lookupCommonFoodMacros('fairlife')?.protein_g).toBe(26);
    expect(lookupCommonFoodMacros('premier protein')?.protein_g).toBe(30);
  });

  it('hits common breakfasts', () => {
    expect(lookupCommonFoodMacros('overnight oats')?.protein_g).toBe(10);
    expect(lookupCommonFoodMacros('avocado toast')?.protein_g).toBe(5);
    expect(lookupCommonFoodMacros('yogurt with berries')?.protein_g).toBe(18);
  });

  it('hits common lunch / dinner items', () => {
    expect(lookupCommonFoodMacros('burrito bowl')?.protein_g).toBe(30);
    expect(lookupCommonFoodMacros('turkey sandwich')?.protein_g).toBe(22);
    expect(lookupCommonFoodMacros('caesar salad with chicken')?.protein_g).toBe(35);
  });

  it('hits asian takeout staples', () => {
    expect(lookupCommonFoodMacros('chicken stir fry')?.protein_g).toBe(30);
    expect(lookupCommonFoodMacros('pad thai')?.protein_g).toBe(16);
    expect(lookupCommonFoodMacros('pho')?.protein_g).toBe(25);
  });

  it('hits packaged tuna / jerky', () => {
    expect(lookupCommonFoodMacros('tuna packet')?.protein_g).toBe(17);
    expect(lookupCommonFoodMacros('I had a turkey jerky')?.protein_g).toBe(12);
  });

  // 2026-06-05 cuisine expansion — verify broad coverage of newly added
  // Mediterranean / Indian / Mexican / Italian / Asian variants.
  it('hits mediterranean / middle eastern entries', () => {
    expect(lookupCommonFoodMacros('falafel')?.protein_g).toBe(10);
    expect(lookupCommonFoodMacros('chicken shawarma')?.protein_g).toBe(35);
    expect(lookupCommonFoodMacros('gyro')?.protein_g).toBe(25);
    expect(lookupCommonFoodMacros('hummus bowl')?.protein_g).toBe(12);
    expect(lookupCommonFoodMacros('greek salad')?.protein_g).toBe(7);
  });

  it('hits indian entries', () => {
    expect(lookupCommonFoodMacros('chicken tikka masala')?.protein_g).toBe(22);
    expect(lookupCommonFoodMacros('butter chicken')?.protein_g).toBe(24);
    expect(lookupCommonFoodMacros('biryani')?.protein_g).toBe(12);
    expect(lookupCommonFoodMacros('dal')?.protein_g).toBe(9);
    expect(lookupCommonFoodMacros('naan')?.protein_g).toBe(5);
  });

  it('hits mexican entries', () => {
    expect(lookupCommonFoodMacros('chicken tacos')?.protein_g).toBe(22);
    expect(lookupCommonFoodMacros('quesadilla')?.protein_g).toBe(16);
    expect(lookupCommonFoodMacros('chicken quesadilla')?.protein_g).toBe(25);
    expect(lookupCommonFoodMacros('fajitas')?.protein_g).toBe(28);
  });

  it('hits italian entries', () => {
    expect(lookupCommonFoodMacros('lasagna')?.protein_g).toBe(22);
    expect(lookupCommonFoodMacros('chicken parmesan')?.protein_g).toBe(40);
    expect(lookupCommonFoodMacros('spaghetti bolognese')?.protein_g).toBe(25);
    expect(lookupCommonFoodMacros('mac and cheese')?.protein_g).toBe(14);
  });

  it('hits more asian / poke entries', () => {
    expect(lookupCommonFoodMacros('dumplings')?.protein_g).toBe(10);
    expect(lookupCommonFoodMacros('ramen')?.protein_g).toBe(14);
    expect(lookupCommonFoodMacros('salmon poke bowl')?.protein_g).toBe(28);
    expect(lookupCommonFoodMacros('bibimbap')?.protein_g).toBe(22);
  });

  it('hits expanded fish list', () => {
    expect(lookupCommonFoodMacros('cod')?.protein_g).toBe(28);
    expect(lookupCommonFoodMacros('tilapia')?.protein_g).toBe(30);
    expect(lookupCommonFoodMacros('halibut')?.protein_g).toBe(30);
    expect(lookupCommonFoodMacros('scallops')?.protein_g).toBe(23);
  });

  it('hits plant-based burgers', () => {
    expect(lookupCommonFoodMacros('beyond burger')?.protein_g).toBe(20);
    expect(lookupCommonFoodMacros('impossible burger')?.protein_g).toBe(19);
    expect(lookupCommonFoodMacros('veggie burger')?.protein_g).toBe(17);
  });

  it('hits common breakfast variants', () => {
    expect(lookupCommonFoodMacros('egg whites')?.protein_g).toBe(11);
    expect(lookupCommonFoodMacros('french toast')?.protein_g).toBe(10);
    expect(lookupCommonFoodMacros('breakfast burrito')?.protein_g).toBe(20);
    expect(lookupCommonFoodMacros('acai bowl')?.protein_g).toBe(6);
  });

  it('hits common snack pairings', () => {
    expect(lookupCommonFoodMacros('apple with peanut butter')?.protein_g).toBe(8);
    expect(lookupCommonFoodMacros('mixed nuts')?.protein_g).toBe(6);
    expect(lookupCommonFoodMacros('trail mix')?.protein_g).toBe(5);
  });

  it('multi-food bail still fires on new cuisines', () => {
    // "chicken tacos and rice" → tacos already include rice/tortilla; the
    // matcher should bail because "rice" is a distinct food token.
    const r = lookupCommonFoodMacros('chicken tacos and rice');
    expect(r).toBeNull();
  });
});

// ── Deterministic multi-item estimator (no-LLM fallback) ──────────────────
// estimateMultiItemFood keeps multi-item logging working (and complete) when
// Gemini is down. Production failure 2026-06-11: "2 eggs / chicken breast +
// rice" logged only the 12g eggs because the compound lunch fell through to a
// dead LLM. These cover the full-sentence decomposition.

describe('estimateMultiItemFood — full multi-clause comprehension', () => {
  it('captures EVERY food across two meals (the 2026-06-11 production failure)', () => {
    const r = estimateMultiItemFood('For breakfast I ate 2 eggs. For lunch I had chicken breast with bowl of rice');
    expect(r).not.toBeNull();
    expect(r!.items.map((i) => i.food)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/egg/i),
        expect.stringMatching(/chicken/i),
        expect.stringMatching(/rice/i),
      ]),
    );
    // 2 eggs (12) + chicken breast (30) + rice (4) = 46g — NOT just the 12g eggs.
    expect(r!.protein_g).toBe(46);
    expect(r!.calories).toBeGreaterThan(400);
  });

  it('separates meals even WITHOUT punctuation between them', () => {
    const r = estimateMultiItemFood('2 eggs for breakfast then chicken and rice for lunch');
    expect(r).not.toBeNull();
    expect(r!.items.length).toBeGreaterThanOrEqual(2);
    expect(r!.protein_g).toBeGreaterThanOrEqual(40);
  });

  // 2026-06-13 user examples — sentence-per-meal + newline list.
  it('parses "for breakfast i ate eggs. for lunch chicken breast, rice and salad"', () => {
    const r = estimateMultiItemFood('for breakfast i ate eggs. for lunch chicken breast, rice and salad');
    expect(r).not.toBeNull();
    const names = r!.items.map((i) => i.food).join(' | ');
    expect(names).toMatch(/egg/i);
    expect(names).toMatch(/chicken/i);
    expect(names).toMatch(/rice/i);
    expect(names).toMatch(/salad/i);
    // eggs(12) + chicken breast(30) + rice(4) + salad(3) = 49g
    expect(r!.protein_g).toBe(49);
  });

  it('parses a newline-separated list ("rice\\nchicken")', () => {
    const r = estimateMultiItemFood('rice\nchicken');
    expect(r).not.toBeNull();
    const names = r!.items.map((i) => i.food).join(' | ');
    expect(names).toMatch(/rice/i);
    expect(names).toMatch(/chicken/i);
    expect(r!.items.length).toBe(2);
  });

  it('resolves a punctuation-free run of multiple foods in one clause', () => {
    // "2 eggs chicken breast rice" — no joiners; the greedy token resolver
    // must still pull out all three foods rather than dropping the run.
    const r = estimateMultiItemFood('2 eggs chicken breast rice');
    expect(r).not.toBeNull();
    expect(r!.protein_g).toBe(46);
  });

  it('handles comma + "and" separated lists', () => {
    const r = estimateMultiItemFood('I had Greek yogurt, a banana, and a protein shake');
    expect(r).not.toBeNull();
    // yogurt 17 + banana 1 + protein shake 25 = 43
    expect(r!.protein_g).toBe(43);
    expect(r!.items.length).toBe(3);
  });

  it('does not double-count the same anchor', () => {
    const r = estimateMultiItemFood('eggs and eggs');
    expect(r!.items.length).toBe(1);
  });

  it('returns null when nothing is a recognizable food', () => {
    expect(estimateMultiItemFood('went for a long walk today')).toBeNull();
  });
});

// ── Structured-output path (2026-06-04 Option B fix) ──────────────────────
// estimateFoodMacros now demands per-item arrays via Gemini's responseSchema
// then sums on the server. These tests cover the parse + sum helpers without
// hitting a real LLM.

describe('parseItemizedEstimate — strict JSON parser', () => {
  it('parses a clean per-item response', () => {
    const raw = JSON.stringify({
      items: [
        { name: '3 eggs', protein_g: 18, calories: 210 },
        { name: '1 can tuna', protein_g: 20, calories: 110 },
        { name: 'salad', protein_g: 3, calories: 100 },
        { name: '1 cup rice', protein_g: 4, calories: 200 },
      ],
      confidence: 'high',
    });
    const out = parseItemizedEstimate(raw);
    expect(out).not.toBeNull();
    expect(out!.items).toHaveLength(4);
    expect(out!.confidence).toBe('high');
  });

  it('strips markdown code fences', () => {
    const raw = '```json\n{"items":[{"name":"eggs","protein_g":12,"calories":140}],"confidence":"medium"}\n```';
    expect(parseItemizedEstimate(raw)).not.toBeNull();
  });

  it('rejects empty items array', () => {
    expect(parseItemizedEstimate(JSON.stringify({ items: [], confidence: 'low' }))).toBeNull();
  });

  it('drops invalid items but keeps valid ones', () => {
    const raw = JSON.stringify({
      items: [
        { name: 'eggs', protein_g: 12, calories: 140 },
        { name: '', protein_g: 5, calories: 50 },          // empty name → drop
        { name: 'toast', protein_g: 'invalid', calories: 80 }, // bad type → drop
        { name: 'rice', protein_g: 4, calories: 200 },
      ],
      confidence: 'medium',
    });
    const out = parseItemizedEstimate(raw);
    expect(out!.items.map((i) => i.name)).toEqual(['eggs', 'rice']);
  });

  it('rounds floats and clamps negatives to zero', () => {
    const raw = JSON.stringify({
      items: [{ name: 'eggs', protein_g: 12.7, calories: 140.4 }, { name: 'X', protein_g: -3, calories: 50 }],
      confidence: 'medium',
    });
    const out = parseItemizedEstimate(raw);
    expect(out!.items[0]!.protein_g).toBe(13);
    expect(out!.items[0]!.calories).toBe(140);
    expect(out!.items[1]!.protein_g).toBe(0);
  });

  it('returns null on malformed JSON', () => {
    expect(parseItemizedEstimate('not json')).toBeNull();
    expect(parseItemizedEstimate('')).toBeNull();
  });

  it('defaults confidence to medium when invalid', () => {
    const raw = JSON.stringify({
      items: [{ name: 'eggs', protein_g: 12, calories: 140 }],
      confidence: 'totally_made_up',
    });
    expect(parseItemizedEstimate(raw)!.confidence).toBe('medium');
  });
});

describe('sumItemized — server-side total', () => {
  it('sums "3 eggs with salad, Tuna, Rice" correctly (the production bug)', () => {
    // This is the EXACT failure case from 2026-06-04:
    //   Old flow returned a flat 45g (under-count).
    //   New flow: schema forces per-item, server sums.
    const itemized = {
      items: [
        { name: '3 eggs', protein_g: 18, calories: 210 },
        { name: 'salad', protein_g: 3, calories: 100 },
        { name: '1 can tuna', protein_g: 20, calories: 110 },
        { name: '1 cup rice', protein_g: 4, calories: 200 },
      ],
      confidence: 'high' as const,
    };
    const total = sumItemized(itemized, '3 eggs with salad, Tuna, Rice');
    expect(total!.protein_g).toBe(45);        // 18+3+20+4 = 45  ← correct math
    expect(total!.calories).toBe(620);        // 210+100+110+200 = 620
    expect(total!.food).toBe('3 eggs + salad + 1 can tuna + 1 cup rice');
    expect(total!.confidence).toBe('high');
  });

  it('uses original food string for single-item logs (no name collapse)', () => {
    const itemized = {
      items: [{ name: 'yogurt', protein_g: 17, calories: 100 }],
      confidence: 'high' as const,
    };
    const total = sumItemized(itemized, 'Greek yogurt with hemp seeds');
    // For 1 item, keep the item's own name (this is what the LLM returned).
    expect(total!.food).toBe('yogurt');
  });

  it('returns null when both protein and calories sum to zero', () => {
    const itemized = {
      items: [{ name: 'water', protein_g: 0, calories: 0 }],
      confidence: 'high' as const,
    };
    expect(sumItemized(itemized, 'water')).toBeNull();
  });

  it('rounds the summed totals', () => {
    const itemized = {
      items: [
        { name: 'a', protein_g: 12, calories: 140 },
        { name: 'b', protein_g: 8, calories: 90 },
      ],
      confidence: 'medium' as const,
    };
    const total = sumItemized(itemized, 'a and b');
    expect(total!.protein_g).toBe(20);
    expect(total!.calories).toBe(230);
  });
});
