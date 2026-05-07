import { describe, it, expect } from 'vitest';
import { parsePlannerResponse } from './planner.js';

describe('parsePlannerResponse', () => {
  it('parses a clean JSON response', () => {
    const out = parsePlannerResponse(
      JSON.stringify({ intent: 'log_food', needsTools: true, toolCalls: [{ name: 'log_food', args: { food: 'eggs' } }], rationale: 'user reported eggs' }),
    );
    expect(out.intent).toBe('log_food');
    expect(out.needsTools).toBe(true);
    expect(out.toolCalls).toHaveLength(1);
  });

  it('strips markdown fences', () => {
    const wrapped = '```json\n' + JSON.stringify({ intent: 'chat', needsTools: false, toolCalls: [], rationale: '' }) + '\n```';
    const out = parsePlannerResponse(wrapped);
    expect(out.intent).toBe('chat');
  });

  it('falls back safely on garbage input', () => {
    const out = parsePlannerResponse('not json at all');
    expect(out.intent).toBe('chat');
    expect(out.needsTools).toBe(false);
  });
});
