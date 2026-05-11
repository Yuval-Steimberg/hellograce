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

const healthyCriticJson = JSON.stringify({
  grounding: 5,
  safety: 5,
  on_task: 5,
  tone: 4,
  issues: [],
});
const failingCriticJson = JSON.stringify({
  grounding: 2,
  safety: 1,
  on_task: 3,
  tone: 3,
  issues: ['told user a specific dose without deferring to clinician'],
});

describe('AIOrchestrator', () => {
  it('runs the full pipeline and returns a validated response', async () => {
    // chat intent + clean response → planner JSON, generation. No critic.
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
    expect(out.critic).toBeUndefined();
    expect(out.regenerated).toBeUndefined();
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

    expect(llm.calls).toHaveLength(1); // generation only, no planner, no critic
    expect(out.intent).toBe('chat');
    expect(out.critic).toBeUndefined();
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
    expect(out.critic).toBeUndefined(); // medium isn't a risk trigger
  });

  it('invokes the critic on knowledge_lookup intent and accepts a healthy critique', async () => {
    const llm = new MockLLM([
      JSON.stringify({
        intent: 'knowledge_lookup',
        needsTools: false,
        toolCalls: [],
        rationale: 'kb question',
      }),
      'Nausea is a known GLP-1 side effect; bring it up with your clinician if it worsens.',
      healthyCriticJson,
    ]);
    const tools = new ToolRegistry();
    const orch = new AIOrchestrator({ llm, tools });

    const out = await orch.run({
      userId: 'u1',
      text: 'is nausea normal on Wegovy?',
      history: [],
      retrieved: [],
      toolsEnabled: true,
    });

    expect(llm.calls).toHaveLength(3); // planner + generation + critic
    expect(out.intent).toBe('knowledge_lookup');
    expect(out.critic?.pass).toBe(true);
    expect(out.regenerated).toBeUndefined();
    expect(out.usedSafeFallback).toBeUndefined();
  });

  it('regenerates once when the critic flags the draft, accepts the retry if it passes', async () => {
    const llm = new MockLLM([
      JSON.stringify({
        intent: 'knowledge_lookup',
        needsTools: false,
        toolCalls: [],
        rationale: '',
      }),
      'Take 2mg twice a week, that should help.',
      failingCriticJson,
      'I can\'t give dose advice — that\'s a question for your prescribing clinician. Want to talk through what you\'re noticing?',
      healthyCriticJson,
    ]);
    const tools = new ToolRegistry();
    const orch = new AIOrchestrator({ llm, tools });

    const out = await orch.run({
      userId: 'u1',
      text: 'what dose should I be on?',
      history: [],
      retrieved: [],
      toolsEnabled: true,
    });

    expect(llm.calls).toHaveLength(5); // planner + gen + critic + regen + critic
    expect(out.regenerated).toBe(true);
    expect(out.usedSafeFallback).toBeUndefined();
    expect(out.text).toContain('clinician');
    expect(out.critic?.pass).toBe(true);
  });

  it('falls back to a safe canned response when both attempts fail the critic', async () => {
    const llm = new MockLLM([
      JSON.stringify({
        intent: 'knowledge_lookup',
        needsTools: false,
        toolCalls: [],
        rationale: '',
      }),
      'Yeah, just take an extra shot if you missed yesterday.',
      failingCriticJson,
      'Take double the dose tomorrow, easy fix.',
      failingCriticJson,
    ]);
    const tools = new ToolRegistry();
    const orch = new AIOrchestrator({ llm, tools });

    const out = await orch.run({
      userId: 'u1',
      text: 'I missed my injection — should I double up?',
      history: [],
      retrieved: [],
      toolsEnabled: true,
    });

    expect(out.usedSafeFallback).toBe(true);
    expect(out.regenerated).toBe(true);
    expect(out.confidence).toBe('low');
    expect(out.text).toContain('clinician');
    expect(out.text).not.toContain('double');
  });
});
