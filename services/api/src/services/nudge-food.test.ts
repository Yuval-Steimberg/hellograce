import { describe, it, expect, vi } from 'vitest';
import { extractNudgeFoodLog } from './nudge-food.js';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any;

// A stub LLM that echoes a fixed extraction, so we can test the deterministic
// hedge guard + parsing without a real model.
function stubLlm(json: object) {
  return { generate: vi.fn().mockResolvedValue({ text: JSON.stringify(json) }) } as any;
}

describe('extractNudgeFoodLog', () => {
  it('logs a specific meal with an estimate (Nudge logs "chicken and rice")', async () => {
    const llm = stubLlm({ foods: '2 eggs and chicken and rice', protein_g: 45, calories: 600 });
    const r = await extractNudgeFoodLog(llm, logger, 'I ate 2 eggs for breakfast and chicken and rice for lunch');
    expect(r.foods).toBe('2 eggs and chicken and rice');
    expect(r.protein_g).toBe(45);
  });

  it('deterministic hedge guard strips a hedged amount even if the model logged it', async () => {
    const llm = stubLlm({ foods: 'yogurt', protein_g: 17, calories: 130 });
    const r = await extractNudgeFoodLog(llm, logger, 'I had some yogurt');
    expect(r.foods).toBeNull();
    expect(r.protein_g).toBeNull();
  });

  it('keeps a concrete portion (not hedged)', async () => {
    const llm = stubLlm({ foods: '3 eggs', protein_g: 18, calories: 210 });
    const r = await extractNudgeFoodLog(llm, logger, 'I had 3 eggs');
    expect(r.foods).toBe('3 eggs');
  });

  it('passes through nulls for a generic/plan/non-food (model returns nulls)', async () => {
    const llm = stubLlm({ foods: null, protein_g: null, calories: null });
    const r = await extractNudgeFoodLog(llm, logger, 'any snack idea?');
    expect(r.foods).toBeNull();
  });

  it('empty message → nulls, no LLM call', async () => {
    const llm = stubLlm({ foods: 'x' });
    const r = await extractNudgeFoodLog(llm, logger, '   ');
    expect(r.foods).toBeNull();
    expect(llm.generate).not.toHaveBeenCalled();
  });
});
