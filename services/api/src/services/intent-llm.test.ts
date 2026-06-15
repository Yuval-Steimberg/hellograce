import { describe, it, expect, vi } from 'vitest';
import { classifyIntentLLM, mapLLMIntent } from './intent-llm.js';
import type { LLMProvider } from '@grace/shared';

const logger = { info: () => {}, warn: () => {}, error: () => {} } as any;
function stubLlm(json: string): LLMProvider {
  return { generate: vi.fn(async () => ({ text: json })) } as unknown as LLMProvider;
}

describe('mapLLMIntent', () => {
  it('maps food_recommendation → food_question', () => {
    expect(mapLLMIntent('food_recommendation', {})).toBe('food_question');
  });
  it('maps food_logging → food_log; symptom → knowledge; medication → medication_question', () => {
    expect(mapLLMIntent('food_logging', {})).toBe('food_log');
    expect(mapLLMIntent('symptom', {})).toBe('knowledge');
    expect(mapLLMIntent('medication', {})).toBe('medication_question');
  });
  it('falls back to boolean flags when intent is "other"', () => {
    expect(mapLLMIntent('other', { food_rec: true })).toBe('food_question');
    expect(mapLLMIntent('other', {})).toBeNull();
  });
});

describe('classifyIntentLLM', () => {
  it('parses Gemini JSON and maps the intent', async () => {
    const llm = stubLlm('{"primary_intent":"food_recommendation","requires_food_recommendation":true,"requires_food_logging":false,"requires_medical_triage":false,"confidence":0.95,"clarification_needed":false}');
    const r = await classifyIntentLLM(llm, logger, 'what should I do for dinner');
    expect(r).not.toBeNull();
    expect(r!.mappedType).toBe('food_question');
    expect(r!.confidence).toBe(0.95);
  });
  it('tolerates surrounding prose / code fences', async () => {
    const llm = stubLlm('Here you go:\n```json\n{"primary_intent":"food_logging","requires_food_recommendation":false,"requires_food_logging":true,"requires_medical_triage":false,"confidence":0.9,"clarification_needed":false}\n```');
    const r = await classifyIntentLLM(llm, logger, 'I had eggs');
    expect(r!.mappedType).toBe('food_log');
  });
  it('returns null on unparseable output (fails safe)', async () => {
    const r = await classifyIntentLLM(stubLlm('no json here'), logger, 'hi');
    expect(r).toBeNull();
  });
});
