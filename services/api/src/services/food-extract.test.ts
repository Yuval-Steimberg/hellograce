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

  it('instructs ALWAYS asking for a missing portion (no silent assumption)', () => {
    const p = buildFoodExtractPrompt([]);
    expect(p).toContain('ALWAYS ask for the portion when the amount is missing');
    expect(p).toContain('CONFIRMED requires a concrete portion');
  });
});
