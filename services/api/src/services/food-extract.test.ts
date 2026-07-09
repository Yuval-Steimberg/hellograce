import { describe, it, expect } from 'vitest';
import { parseFoodExtraction, buildFoodExtractPrompt, formatFoodReply } from './food-extract.js';

describe('parseFoodExtraction', () => {
  it('parses a confirmed multi-item log with numbers', () => {
    const out = parseFoodExtraction(JSON.stringify({
      intent: 'log',
      items: [
        { item: '3 eggs', protein_g: 18, calories: 210, status: 'confirmed', clarify_question: null },
        { item: '1 cup rice', protein_g: 4, calories: 200, status: 'confirmed', clarify_question: null },
      ],
      edit_ref: null,
    }));
    expect(out.intent).toBe('log');
    expect(out.items).toHaveLength(2);
    expect(out.items[0]).toMatchObject({ item: '3 eggs', protein_g: 18, status: 'confirmed' });
  });

  it('nulls numbers on a pending_portion item and keeps the clarify question', () => {
    const out = parseFoodExtraction(JSON.stringify({
      intent: 'log',
      items: [{ item: 'pizza', protein_g: 22, calories: 600, status: 'pending_portion', clarify_question: 'How many slices?' }],
      edit_ref: null,
    }));
    expect(out.items[0]).toMatchObject({ item: 'pizza', protein_g: null, calories: null, status: 'pending_portion', clarify_question: 'How many slices?' });
    // Pending items carry no confidence / serving_size yet.
    expect(out.items[0]?.confidence).toBeNull();
    expect(out.items[0]?.serving_size).toBeNull();
  });

  it('parses confidence + serving_size (food_tracker fields) and defaults confidence to medium', () => {
    const out = parseFoodExtraction(JSON.stringify({
      intent: 'log',
      items: [
        { item: '3 eggs', protein_g: 18, calories: 210, status: 'confirmed', clarify_question: null, confidence: 'high', serving_size: '3 eggs' },
        { item: 'toast', protein_g: 3, calories: 80, status: 'confirmed', clarify_question: null }, // no confidence → medium
      ],
      edit_ref: null,
    }));
    expect(out.items[0]).toMatchObject({ confidence: 'high', serving_size: '3 eggs' });
    expect(out.items[1]?.confidence).toBe('medium');
    expect(out.items[1]?.serving_size).toBeNull();
  });

  it('downgrades an internally-impossible estimate to low confidence (macro-sanity)', () => {
    const out = parseFoodExtraction(JSON.stringify({
      intent: 'log',
      // 40g protein = 160 kcal, but only 60 kcal stated → impossible → 'low'.
      items: [{ item: 'salad', protein_g: 40, calories: 60, status: 'confirmed', clarify_question: null, confidence: 'high' }],
      edit_ref: null,
    }));
    expect(out.items[0]?.confidence).toBe('low');
  });

  it('clamps out-of-range macros to null', () => {
    const out = parseFoodExtraction(JSON.stringify({
      intent: 'log',
      items: [{ item: 'mystery', protein_g: 9999, calories: 99999, status: 'confirmed', clarify_question: null }],
    }));
    expect(out.items[0]?.protein_g).toBeNull();
    expect(out.items[0]?.calories).toBeNull();
  });

  it('resolves a pending item via edit + edit_ref', () => {
    const out = parseFoodExtraction(JSON.stringify({
      intent: 'edit',
      edit_ref: 'spaghetti',
      items: [{ item: '1 cup plain spaghetti', protein_g: 8, calories: 220, status: 'confirmed', clarify_question: null }],
    }));
    expect(out.intent).toBe('edit');
    expect(out.edit_ref).toBe('spaghetti');
    expect(out.items[0]?.status).toBe('confirmed');
  });

  it('tolerates code-fence / prose wrapping around the JSON', () => {
    const out = parseFoodExtraction('Sure!\n```json\n{"intent":"query","items":[],"edit_ref":null}\n```');
    expect(out.intent).toBe('query');
    expect(out.items).toHaveLength(0);
  });

  it('falls back to none on invalid JSON or unknown intent', () => {
    expect(parseFoodExtraction('not json').intent).toBe('none');
    expect(parseFoodExtraction(JSON.stringify({ intent: 'banana', items: [] })).intent).toBe('none');
  });

  it('drops items with no item string', () => {
    const out = parseFoodExtraction(JSON.stringify({ intent: 'log', items: [{ protein_g: 5 }, { item: '  ' }, { item: 'eggs' }] }));
    expect(out.items).toHaveLength(1);
    expect(out.items[0]?.item).toBe('eggs');
  });
});

describe('formatFoodReply', () => {
  const seed = 'u|msg';
  it('asks ONE combined portion question for vague foods (no logging yet)', () => {
    const r = formatFoodReply({ loggedItems: [], pendingFoods: ['eggs', 'cottage cheese'], seed });
    expect(r.toLowerCase()).toContain('eggs and cottage cheese');
    expect(r).toMatch(/\?/);
    expect(r.length).toBeLessThan(180);
    expect(r).not.toMatch(/\n/); // single line, no lists
  });

  it('confirms logged items with the running total, short', () => {
    const r = formatFoodReply({ loggedItems: ['2 eggs', 'half cup cottage cheese'], loggedProtein: 22, loggedCalories: 240, pendingFoods: [], seed });
    expect(r).toMatch(/2 eggs/);
    expect(r).toMatch(/22g protein/);
    expect(r.length).toBeLessThan(180);
  });

  it('handles logged + still-pending (confirm + ask)', () => {
    const r = formatFoodReply({ loggedItems: ['a cup of rice'], pendingFoods: ['chicken'], seed });
    expect(r.toLowerCase()).toContain('rice');
    expect(r.toLowerCase()).toContain('chicken');
    expect(r).toMatch(/\?/);
  });

  it('returns empty when there is nothing to say', () => {
    expect(formatFoodReply({ loggedItems: [], pendingFoods: [], seed })).toBe('');
  });

  it('never includes nutrition-education phrasing', () => {
    const r = formatFoodReply({ loggedItems: ['2 eggs'], loggedProtein: 12, pendingFoods: [], seed });
    expect(r.toLowerCase()).not.toMatch(/high in protein|supports muscle|sustained energy|excellent source/);
  });

  it('strips a leading consumption phrase from the food name (no "Logged I ate …")', () => {
    // prod 2026-07-08: reply echoed the raw "I ate 2 eggs".
    const r = formatFoodReply({ loggedItems: ['I ate 2 eggs'], loggedProtein: 12, pendingFoods: [], seed });
    expect(r).toMatch(/2 eggs/);
    expect(r.toLowerCase()).not.toContain('i ate');
    expect(r).toMatch(/12g protein/);
  });

  it('strips a consumption prefix carrying an adverb ("I also ate" → "2 eggs")', () => {
    // prod ("dont need to say also logged 2 eggs"): the recovery fallback logged
    // the raw span "I also ate 2 eggs" and the confirmation echoed it. The adverb
    // (also/just/already/only) between "I" and the verb must be stripped too.
    for (const raw of ['I also ate 2 eggs', 'I just had 2 eggs', 'I already ate 2 eggs', 'I only had 2 eggs']) {
      const r = formatFoodReply({ loggedItems: [raw], loggedProtein: 12, pendingFoods: [], seed });
      expect(r).toMatch(/2 eggs/);
      expect(r.toLowerCase()).not.toMatch(/i (?:also|just|already|only) /);
    }
  });

  it('warms up: some seeds add a friendly "how was it?" closer, none invent food/numbers', () => {
    // Across seeds the confirmation is warm and occasionally asks how it was; it
    // must never introduce a food or a number that was not passed in.
    const replies = Array.from({ length: 12 }, (_, i) =>
      formatFoodReply({ loggedItems: ['2 eggs'], loggedProtein: 12, loggedCalories: 140, pendingFoods: [], seed: `u|${i}` }),
    );
    expect(replies.some((r) => /how was it|hope it was good|how'd it hit/i.test(r))).toBe(true);
    for (const r of replies) {
      expect(r).toMatch(/2 eggs/);
      // The only numbers present are the ones passed in (2 from "2 eggs", 12g, 140cal).
      const nums = r.match(/\d+/g) ?? [];
      expect(nums.every((n) => n === '2' || n === '12' || n === '140')).toBe(true);
      expect(r.length).toBeLessThan(180);
    }
  });

  it('hedges the total when the estimate is rough (food_tracker confidence)', () => {
    const rough = formatFoodReply({ loggedItems: ['a bowl of soup'], loggedProtein: 15, pendingFoods: [], seed, rough: true });
    expect(rough).toMatch(/rough estimate/i);
    expect(rough).toMatch(/portion/i); // offers the path to exact
    // A confident log does NOT hedge.
    const exact = formatFoodReply({ loggedItems: ['3 eggs'], loggedProtein: 18, pendingFoods: [], seed, rough: false });
    expect(exact).not.toMatch(/rough estimate/i);
  });
});

describe('buildFoodExtractPrompt', () => {
  it('includes the pending-item resolution hint when pending items exist', () => {
    const p = buildFoodExtractPrompt([{ item: 'pizza' }]);
    expect(p).toContain('PENDING ITEMS FROM EARLIER');
    expect(p).toContain('"pizza"');
    expect(p).toContain('intent="edit"');
  });

  it('omits the pending hint when there are none', () => {
    const p = buildFoodExtractPrompt([]);
    expect(p).not.toContain('PENDING ITEMS FROM EARLIER');
    expect(p).toContain('Advice/planning about food NOT yet eaten is NOT logging');
    // A consumption statement must still log even when the same message asks a question.
    expect(p).toContain('report eaten food AND ask a question');
  });

  it('treats "X for breakfast / for lunch" (no eat-verb) as a LOG, not a plan', () => {
    const p = buildFoodExtractPrompt([]);
    expect(p).toContain('ASSIGNS foods to meals');
    expect(p).toContain('2 eggs for breakfast. For lunch chicken and rice');
    expect(p).toContain('ONLY planning');
  });

  it('instructs ALWAYS asking for a missing portion (no silent assumption)', () => {
    const p = buildFoodExtractPrompt([]);
    expect(p).toContain('ALWAYS ask for the portion when the amount is missing');
    expect(p).toContain('CONFIRMED requires a concrete portion');
  });
});
