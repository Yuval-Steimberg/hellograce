import { describe, it, expect } from 'vitest';
import type { LLMProvider, LLMRequest, LLMResponse } from '@grace/shared';
import { AIOrchestrator } from './orchestrator.js';
import { ToolRegistry } from './tools/registry.js';

class MockLLM implements LLMProvider {
  readonly id = 'mock';
  public calls: LLMRequest[] = [];
  constructor(private replies: string[]) {}
  async generate(req: LLMRequest): Promise<LLMResponse> {
    this.calls.push(req);
    const text = this.replies.shift() ?? 'ok';
    return { text, finishReason: 'stop' };
  }
}

describe('AIOrchestrator', () => {
  it('runs the full pipeline and returns a validated response', async () => {
    // First reply = planner JSON, second reply = generation
    const llm = new MockLLM([
      JSON.stringify({ intent: 'chat', needsTools: false, toolCalls: [], rationale: 'casual' }),
      'Sounds good — tell me more.',
    ]);
    const tools = new ToolRegistry();
    const orch = new AIOrchestrator({ llm, tools });

    const out = await orch.run({
      userId: 'u1',
      text: 'hey grace',
      history: [],
      retrieved: [],
      toolsEnabled: true,
    });

    expect(out.text).toContain('Sounds good');
    expect(out.intent).toBe('chat');
    expect(out.confidence).toBe('high');
    expect(out.usedRetrieval).toBe(false);
  });

  it('skips planner when tools are disabled', async () => {
    const llm = new MockLLM(['Got it — drink some water.']);
    const tools = new ToolRegistry();
    const orch = new AIOrchestrator({ llm, tools });

    const out = await orch.run({
      userId: 'u1',
      text: 'i feel dehydrated',
      history: [],
      retrieved: [],
      toolsEnabled: false,
    });

    expect(llm.calls).toHaveLength(1);
    expect(out.intent).toBe('chat');
  });

  it('scores hedged responses as medium confidence', async () => {
    const llm = new MockLLM([
      JSON.stringify({ intent: 'chat', needsTools: false, toolCalls: [], rationale: '' }),
      "I'm not sure, probably 50g of protein.",
    ]);
    const tools = new ToolRegistry();
    const orch = new AIOrchestrator({ llm, tools });

    const out = await orch.run({
      userId: 'u1',
      text: 'how much protein?',
      history: [],
      retrieved: [],
      toolsEnabled: true,
    });

    expect(out.confidence).toBe('medium');
  });
});
