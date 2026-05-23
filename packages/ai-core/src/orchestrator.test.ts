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
    // 'hey grace' is classified as a greeting → planner is skipped.
    // Only one LLM call: the generation.
    const llm = new MockLLM(['Sounds good — tell me more.']);
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

  it('invokes the critic on safety intent and accepts a healthy critique', async () => {
    // knowledge_lookup is intentionally NOT in RISKY_INTENT_PREFIXES (too broad).
    // Use a safety_ intent to exercise the critic path.
    const llm = new MockLLM([
      JSON.stringify({
        intent: 'safety_dosing',
        needsTools: false,
        toolCalls: [],
        rationale: 'dosing question',
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
    expect(out.intent).toBe('safety_dosing');
    expect(out.critic?.pass).toBe(true);
    expect(out.regenerated).toBeUndefined();
    expect(out.usedSafeFallback).toBeUndefined();
  });

  it('regenerates once when the LLM-critic flags the draft, accepts the retry if it passes', async () => {
    // Bad response is qualitatively wrong but has no quantitative claims that
    // the precheck would catch — so the LLM-critic is the gate.
    // Uses safety_ intent because knowledge_lookup no longer triggers the critic.
    const llm = new MockLLM([
      JSON.stringify({
        intent: 'safety_dosing',
        needsTools: false,
        toolCalls: [],
        rationale: '',
      }),
      'Yeah totally, you can drink as much alcohol as you want on this medication.',
      failingCriticJson,
      "Alcohol can interact with how you tolerate the medication. Check with your prescriber about what's right for you.",
      healthyCriticJson,
    ]);
    const tools = new ToolRegistry();
    const orch = new AIOrchestrator({ llm, tools });

    const out = await orch.run({
      userId: 'u1',
      text: 'can I drink on Wegovy?',
      history: [],
      retrieved: [],
      toolsEnabled: true,
    });

    expect(llm.calls).toHaveLength(5); // planner + gen + critic + regen + critic
    expect(out.regenerated).toBe(true);
    expect(out.usedSafeFallback).toBeUndefined();
    expect(out.text).toContain('prescriber');
    expect(out.intent).toBe('safety_dosing');
    expect(out.critic?.pass).toBe(true);
  });

  it('forces regen via grounding precheck even on a chat intent, without an LLM critic call', async () => {
    // Chat intent would normally skip the critic. But the response contains
    // an unsupported dose claim — precheck must fail-close and trigger regen.
    const llm = new MockLLM([
      JSON.stringify({ intent: 'chat', needsTools: false, toolCalls: [], rationale: '' }),
      'Just take 2mg next time — that should help.',
      // No critic call expected for attempt 1 (precheck handles it).
      // Retry response, clean:
      "I can't suggest doses — your prescriber is the right person to ask. Want to talk through what you're noticing?",
      // Critic call for retry (precheck clean now):
      healthyCriticJson,
    ]);
    const tools = new ToolRegistry();
    const orch = new AIOrchestrator({ llm, tools });

    const out = await orch.run({
      userId: 'u1',
      text: 'I missed yesterday, what should I do?',
      history: [],
      retrieved: [{ id: 'doc-1', source: 'knowledge', content: 'GLP-1 medications are injected weekly.', score: 0.8 }],
      toolsEnabled: true,
    });

    expect(llm.calls).toHaveLength(4); // planner + gen + regen + critic (precheck skipped LLM critic on attempt 1)
    expect(out.regenerated).toBe(true);
    expect(out.critic?.pass).toBe(true);
    expect(out.text).toContain('prescriber');
  });

  it('attaches unsupportedClaims and source=precheck when grounding fails', async () => {
    const llm = new MockLLM([
      JSON.stringify({
        intent: 'knowledge_lookup',
        needsTools: false,
        toolCalls: [],
        rationale: '',
      }),
      'Most patients lose 25% of their weight in 12 weeks.',
      // Retry stays bad — precheck still fails:
      'Studies show 25% loss within 12 weeks consistently.',
      // Web-search fallback returns empty → tryWebSearchFallback returns null
      // and we fall through to safe fallback.
      '',
    ]);
    const tools = new ToolRegistry();
    const orch = new AIOrchestrator({ llm, tools });

    const out = await orch.run({
      userId: 'u1',
      text: 'how much weight will I lose?',
      history: [],
      retrieved: [{ id: 'doc-1', source: 'knowledge', content: 'GLP-1 medications suppress appetite.', score: 0.8 }],
      toolsEnabled: true,
    });

    expect(out.usedSafeFallback).toBe(true);
    expect(out.critic?.source).toBe('precheck');
    expect(out.critic?.unsupportedClaims?.length).toBeGreaterThan(0);
    // Safe fallback is returned when both grounding attempts fail
    expect(out.text.length).toBeGreaterThan(0);
  });

  it('discards a web-search result that contains a block-severity content violation', async () => {
    // Scenario: primary + retry both fail the LLM critic (safety_ intent gates
    // the critic). The web-search fallback returns a response with a block-severity
    // phrase. Only block violations disqualify web results (regen violations are
    // tolerated since we can't regen a grounded result).
    const llm = new MockLLM([
      JSON.stringify({ intent: 'safety_dosing', needsTools: false, toolCalls: [], rationale: '' }),
      'Yeah just take it whenever you want — no real timing requirement.',
      failingCriticJson,
      'Take it whenever you feel like it, timing is not a concern.',
      failingCriticJson,
      // Web-search fallback — contains a phrase that triggers a block rule
      'You should take an extra dose to make up for the missed one.',
    ]);
    const tools = new ToolRegistry();
    const orch = new AIOrchestrator({ llm, tools });

    const out = await orch.run({
      userId: 'u1',
      text: 'when can I take my injection?',
      history: [],
      retrieved: [{ id: 'doc-1', source: 'knowledge', content: 'Semaglutide is injected weekly.', score: 0.8 }],
      toolsEnabled: true,
      dbRules: [{ id: 1, rule_type: 'content', pattern: 'extra dose', is_regex: false, flags: '', reason: 'Advising extra dose is dangerous', severity: 'block', applies_to: 'all' }],
    });

    expect(out.usedSafeFallback).toBe(true);
    expect(out.text.toLowerCase()).not.toContain('extra dose');
  });

  it('falls back to a safe canned response when both attempts fail the critic', async () => {
    // Uses safety_ intent because knowledge_lookup no longer triggers the LLM-critic
    // (only the grounding precheck can gate it). These responses lack quantitative
    // claims so the precheck is clean — the LLM-critic must be the gate.
    const llm = new MockLLM([
      JSON.stringify({
        intent: 'safety_dosing',
        needsTools: false,
        toolCalls: [],
        rationale: '',
      }),
      'Yeah, just take an extra shot if you missed yesterday.',
      failingCriticJson,
      'Take double the dose tomorrow, easy fix.',
      failingCriticJson,
      // Web-search fallback returns empty so we fall through to safe fallback.
      '',
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
    expect(out.text.length).toBeGreaterThan(0);
    expect(out.text).not.toContain('double');
  });
});
