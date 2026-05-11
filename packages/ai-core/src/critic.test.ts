import { describe, expect, it } from 'vitest';
import type { LLMProvider, LLMRequest, LLMResponse } from '@grace/shared';
import { LLMCritic, parseCriticResponse } from './critic.js';

class MockLLM implements LLMProvider {
  readonly id = 'mock';
  public calls: LLMRequest[] = [];
  constructor(private replies: string[]) {}
  async generate(req: LLMRequest): Promise<LLMResponse> {
    this.calls.push(req);
    return { text: this.replies.shift() ?? '{}', finishReason: 'stop' };
  }
}

describe('parseCriticResponse', () => {
  it('parses a clean JSON response and marks it pass when scores are healthy', () => {
    const r = parseCriticResponse(
      JSON.stringify({ grounding: 5, safety: 5, on_task: 4, tone: 5, issues: [] }),
    );
    expect(r.pass).toBe(true);
    expect(r.overall).toBe(19);
    expect(r.issues).toEqual([]);
  });

  it('marks pass=false when any criterion is below threshold', () => {
    const r = parseCriticResponse(
      JSON.stringify({ grounding: 5, safety: 2, on_task: 5, tone: 5, issues: ['told user a specific dose'] }),
    );
    expect(r.pass).toBe(false);
    expect(r.issues).toContain('told user a specific dose');
  });

  it('marks pass=false when overall is below 14 even if no individual score is <3', () => {
    const r = parseCriticResponse(
      JSON.stringify({ grounding: 3, safety: 3, on_task: 3, tone: 3, issues: [] }),
    );
    expect(r.overall).toBe(12);
    expect(r.pass).toBe(false);
  });

  it('returns malformed=true when JSON is unparseable', () => {
    const r = parseCriticResponse('not json at all');
    expect(r.malformed).toBe(true);
    expect(r.pass).toBe(false);
    expect(r.issues).toContain('critic_malformed_response');
  });

  it('returns malformed=true when a required score is missing', () => {
    const r = parseCriticResponse(JSON.stringify({ grounding: 5, safety: 5, on_task: 5 }));
    expect(r.malformed).toBe(true);
    expect(r.pass).toBe(false);
  });

  it('strips markdown fences before parsing', () => {
    const r = parseCriticResponse(
      '```json\n{"grounding":5,"safety":5,"on_task":5,"tone":5,"issues":[]}\n```',
    );
    expect(r.pass).toBe(true);
  });

  it('clamps out-of-range scores into [1,5]', () => {
    const r = parseCriticResponse(
      JSON.stringify({ grounding: 9, safety: 0, on_task: 4, tone: 5, issues: [] }),
    );
    expect(r.scores.grounding).toBe(5);
    expect(r.scores.safety).toBe(1);
  });

  it('caps issues at 4 entries', () => {
    const r = parseCriticResponse(
      JSON.stringify({
        grounding: 5,
        safety: 5,
        on_task: 5,
        tone: 5,
        issues: ['a', 'b', 'c', 'd', 'e', 'f'],
      }),
    );
    expect(r.issues).toHaveLength(4);
  });
});

describe('LLMCritic', () => {
  it('treats an LLM error as a failed (malformed) critic report', async () => {
    const flakyLLM: LLMProvider = {
      id: 'flaky',
      generate: async () => {
        throw new Error('upstream timeout');
      },
    };
    const critic = new LLMCritic(flakyLLM);
    const r = await critic.evaluate({ userText: 'q', response: 'a', retrieved: [] });
    expect(r.malformed).toBe(true);
    expect(r.pass).toBe(false);
  });

  it('round-trips a healthy critic response', async () => {
    const llm = new MockLLM([
      JSON.stringify({ grounding: 5, safety: 5, on_task: 5, tone: 4, issues: [] }),
    ]);
    const critic = new LLMCritic(llm);
    const r = await critic.evaluate({
      userText: 'is fatigue normal?',
      response: 'Fatigue is a known GLP-1 side effect; if it worsens, message your clinician.',
      retrieved: [],
    });
    expect(r.pass).toBe(true);
    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0]?.responseFormat).toBe('json');
  });
});
