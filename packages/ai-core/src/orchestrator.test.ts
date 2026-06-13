import { describe, it, expect } from 'vitest';
import type { LLMProvider, LLMRequest, LLMResponse } from '@grace/shared';
import { AIOrchestrator } from './orchestrator.js';
import { ToolRegistry } from './tools/registry.js';

const RELEVANCE_OK = JSON.stringify({ relevant: true, reason: 'addresses the user\'s message' });
const BEHAVIORAL_OK = JSON.stringify({ violations: [] });

class MockLLM implements LLMProvider {
  readonly id = 'mock';
  public calls: LLMRequest[] = [];
  constructor(private replies: string[]) {}
  async generate(req: LLMRequest): Promise<LLMResponse> {
    // Auto-handle post-generation guard calls (relevance + behavioral). Both
    // are separate semantic checks, not part of the orchestrator's main pipeline.
    // Detected by their specific system prompts; auto-pass so tests don't need
    // to enumerate them in their reply queues.
    const sys = req.messages.find((m) => m.role === 'system')?.content ?? '';
    if (sys.includes('quality checker for a chatbot called Grace')) {
      return { text: RELEVANCE_OK, finishReason: 'stop' };
    }
    if (sys.includes('behavioral quality checker for Grace')) {
      return { text: BEHAVIORAL_OK, finishReason: 'stop' };
    }
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
    // After 2026-06-03 latency cut: the retry critic is also skipped when
    // the retry's precheck is clean AND the intent is non-risky (chat).
    // Total LLM calls: planner + gen + regen (no critic on either attempt).
    const llm = new MockLLM([
      JSON.stringify({ intent: 'chat', needsTools: false, toolCalls: [], rationale: '' }),
      'Just take 2mg next time — that should help.',
      // No critic call expected for attempt 1 (precheck handles it).
      // Retry response, clean — no dose claim, precheck passes:
      "I can't suggest doses — your prescriber is the right person to ask. Want to talk through what you're noticing?",
      // No critic call expected for attempt 2 either (precheck clean +
      // non-risky 'chat' intent + no truncation/drift).
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

    expect(llm.calls).toHaveLength(3); // planner + gen + regen (critic skipped on both attempts)
    expect(out.regenerated).toBe(true);
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
    // The safe fallback may now ship the curated, SAFE missed-dose guidance
    // ("don't double up, skip if it's been >5 days, check your label") — that's
    // accurate and helpful. It must NEVER echo the dangerous advice the critic
    // rejected ("take an extra shot", "take double the dose tomorrow").
    expect(out.text).not.toMatch(/take (an )?extra|double the dose|take double/i);
  });
});

describe('detectTopicSwitch', () => {
  it('returns true when the user shifts from one body system to another', async () => {
    const { detectTopicSwitch } = await import('./orchestrator.js');
    const prior =
      "It's really common to worry about muscle loss while losing weight on GLP-1s. Research shows that around 25-35% of the weight lost can be lean mass, so your concern is valid. The best ways to protect your muscle are protein and resistance training.";
    const next = 'My hair is falling out, is this from Ozempic';
    expect(detectTopicSwitch(next, prior)).toBe(true);
  });

  it('returns true on the lab-result follow-up after a hair answer', async () => {
    const { detectTopicSwitch } = await import('./orchestrator.js');
    const prior =
      "What you're likely seeing is telogen effluvium, which is temporary hair shedding caused by the metabolic stress of rapid weight loss, not damage to your hair follicles directly. It usually starts 2-3 months in and resolves within 6-9 months.";
    const next = 'My labs came back and my A1C is 5.8, is that okay';
    expect(detectTopicSwitch(next, prior)).toBe(true);
  });

  it('returns false when the follow-up shares 2+ topic words (continuation)', async () => {
    const { detectTopicSwitch } = await import('./orchestrator.js');
    const prior =
      'Protein is the most impactful thing you can do for muscle preservation. Aim for 1.2 to 1.6 grams per kilogram of your current body weight, daily.';
    const next = 'How much protein should I aim for at lunch';
    expect(detectTopicSwitch(next, prior)).toBe(false);
  });

  it('returns false when the previous message is short (no real anchor)', async () => {
    const { detectTopicSwitch } = await import('./orchestrator.js');
    const prior = 'Got it, around 25g.';
    const next = 'How is my hair affected';
    expect(detectTopicSwitch(next, prior)).toBe(false);
  });

  it('returns false when the user message is too brief to call a shift confidently', async () => {
    const { detectTopicSwitch } = await import('./orchestrator.js');
    const prior =
      'Plateaus are super common in months 3-6, especially after the first rapid loss. The medication is still doing its job — the scale is just catching up.';
    const next = 'Hair?';
    expect(detectTopicSwitch(next, prior)).toBe(false);
  });

  it('returns false on missing inputs', async () => {
    const { detectTopicSwitch } = await import('./orchestrator.js');
    expect(detectTopicSwitch(undefined, 'whatever')).toBe(false);
    expect(detectTopicSwitch('hello', undefined)).toBe(false);
    expect(detectTopicSwitch('', '')).toBe(false);
  });
});

describe('stripAssistantTurns (production path — strips all)', () => {
  it('removes every assistant turn, keeping all user turns intact', async () => {
    const { stripAssistantTurns } = await import('./orchestrator.js');
    const history = [
      { role: 'user' as const, content: 'muscle Q', createdAt: new Date() },
      { role: 'assistant' as const, content: 'muscle A', createdAt: new Date() },
      { role: 'user' as const, content: 'hair Q', createdAt: new Date() },
      { role: 'assistant' as const, content: 'hair A (wrong, was muscle)', createdAt: new Date() },
    ];
    const result = stripAssistantTurns(history);
    expect(result).toHaveLength(2);
    expect(result.every((t) => t.role === 'user')).toBe(true);
    expect(result.map((t) => t.content)).toEqual(['muscle Q', 'hair Q']);
  });

  it('returns the empty array when given empty history', async () => {
    const { stripAssistantTurns } = await import('./orchestrator.js');
    expect(stripAssistantTurns([])).toEqual([]);
  });

  it('returns the same user turns when no assistant turns exist', async () => {
    const { stripAssistantTurns } = await import('./orchestrator.js');
    const onlyUsers = [
      { role: 'user' as const, content: 'a', createdAt: new Date() },
      { role: 'user' as const, content: 'b', createdAt: new Date() },
    ];
    expect(stripAssistantTurns(onlyUsers)).toEqual(onlyUsers);
  });
});

describe('detectMultiPartMessage', () => {
  it('returns true when the message has two question marks', async () => {
    const { detectMultiPartMessage } = await import('./orchestrator.js');
    expect(
      detectMultiPartMessage(
        'I have no appetite, is that the medication? I forgot my injection yesterday, what should I do?',
      ),
    ).toBe(true);
  });

  it('returns true on continuation cues like "Also"/"And"/"By the way"', async () => {
    const { detectMultiPartMessage } = await import('./orchestrator.js');
    expect(
      detectMultiPartMessage('I felt rough yesterday. Also, what foods are best to eat tonight?'),
    ).toBe(true);
    expect(
      detectMultiPartMessage(
        'Took my shot this morning. By the way, my hair is shedding more lately.',
      ),
    ).toBe(true);
    expect(
      detectMultiPartMessage(
        "I'm at 60g today. Another question — should I worry about the plateau?",
      ),
    ).toBe(true);
  });

  it('returns false on a single short question', async () => {
    const { detectMultiPartMessage } = await import('./orchestrator.js');
    expect(detectMultiPartMessage('How much protein should I have today?')).toBe(false);
  });

  it('returns false on short messages even with one question mark', async () => {
    const { detectMultiPartMessage } = await import('./orchestrator.js');
    expect(detectMultiPartMessage('hi?')).toBe(false);
    expect(detectMultiPartMessage('really?')).toBe(false);
  });

  it('returns false on missing input', async () => {
    const { detectMultiPartMessage } = await import('./orchestrator.js');
    expect(detectMultiPartMessage(undefined)).toBe(false);
    expect(detectMultiPartMessage('')).toBe(false);
  });
});

describe('stripLastAssistantTurn', () => {
  it('removes the most recent assistant turn but keeps prior user turn', async () => {
    const { stripLastAssistantTurn } = await import('./orchestrator.js');
    const history = [
      { role: 'user' as const, content: 'muscle?', createdAt: new Date() },
      { role: 'assistant' as const, content: 'muscle answer', createdAt: new Date() },
    ];
    const result = stripLastAssistantTurn(history);
    expect(result).toHaveLength(1);
    expect(result[0]?.role).toBe('user');
    expect(result[0]?.content).toBe('muscle?');
  });

  it('removes only the LAST assistant turn, leaving earlier ones intact', async () => {
    const { stripLastAssistantTurn } = await import('./orchestrator.js');
    const history = [
      { role: 'user' as const, content: 'q1', createdAt: new Date() },
      { role: 'assistant' as const, content: 'a1', createdAt: new Date() },
      { role: 'user' as const, content: 'q2', createdAt: new Date() },
      { role: 'assistant' as const, content: 'a2 (most recent)', createdAt: new Date() },
    ];
    const result = stripLastAssistantTurn(history);
    expect(result).toHaveLength(3);
    expect(result.map((t) => t.content)).toEqual(['q1', 'a1', 'q2']);
  });

  it('returns a copy of empty history when no assistant turns exist', async () => {
    const { stripLastAssistantTurn } = await import('./orchestrator.js');
    expect(stripLastAssistantTurn([])).toEqual([]);
    const onlyUsers = [
      { role: 'user' as const, content: 'a', createdAt: new Date() },
      { role: 'user' as const, content: 'b', createdAt: new Date() },
    ];
    const result = stripLastAssistantTurn(onlyUsers);
    expect(result).toEqual(onlyUsers);
  });
});

describe('endsMidWord — completeness gate (2026-06-03 hard rule)', () => {
  it('flags trailing comma as mid-clause', async () => {
    const { endsMidWord } = await import('./orchestrator.js');
    expect(endsMidWord('Good. Aim for protein, water,')).toBe(true);
  });

  it('flags trailing colon as mid-introduction', async () => {
    const { endsMidWord } = await import('./orchestrator.js');
    expect(endsMidWord("Here's why it matters:")).toBe(true);
  });

  it('flags stranded conjunctions / linkers', async () => {
    const { endsMidWord } = await import('./orchestrator.js');
    expect(endsMidWord('That works, and')).toBe(true);
    expect(endsMidWord('Protein helps because')).toBe(true);
    expect(endsMidWord("This is common when")).toBe(true);
    expect(endsMidWord('You can try things like')).toBe(true);
  });

  it('passes a clean complete sentence', async () => {
    const { endsMidWord } = await import('./orchestrator.js');
    expect(endsMidWord('Got it, about 25g protein. Solid lunch.')).toBe(false);
    expect(endsMidWord('You should aim for 1.2 g/kg.')).toBe(false);
    expect(endsMidWord('That sounds rough — want to talk about it?')).toBe(false);
  });

  it('accepts emoji endings', async () => {
    const { endsMidWord } = await import('./orchestrator.js');
    expect(endsMidWord("Anytime 🤍")).toBe(false);
    expect(endsMidWord("Solid lunch 💪")).toBe(false);
  });
});

describe('detectReasoningRequest — explain-vs-repeat gate (2026-06-03)', () => {
  const calculatedPrior =
    "Your protein target lands at about 111 g per day, based on your 175 lb weight.";
  const recommendationPrior =
    "I'd recommend hitting at least 100 g of protein today and getting a short walk in after dinner.";
  const noAnchorPrior = "That sounds rough, want to share more?";

  it('fires on bare why? after a numeric prior turn', async () => {
    const { detectReasoningRequest } = await import('./orchestrator.js');
    expect(detectReasoningRequest('Why?', calculatedPrior)).toBe(true);
    expect(detectReasoningRequest('Why', calculatedPrior)).toBe(true);
  });

  it('fires on "how did you calculate that?"', async () => {
    const { detectReasoningRequest } = await import('./orchestrator.js');
    expect(detectReasoningRequest('How did you calculate that?', calculatedPrior)).toBe(true);
    expect(detectReasoningRequest('How did you get to 111?', calculatedPrior)).toBe(true);
    expect(detectReasoningRequest('Where did that number come from?', calculatedPrior)).toBe(true);
  });

  it('fires on "can you explain?" after a recommendation', async () => {
    const { detectReasoningRequest } = await import('./orchestrator.js');
    expect(detectReasoningRequest('Can you explain?', recommendationPrior)).toBe(true);
    expect(detectReasoningRequest('Can you walk me through that?', recommendationPrior)).toBe(true);
  });

  it('does NOT fire when the prior message has no concrete anchor', async () => {
    const { detectReasoningRequest } = await import('./orchestrator.js');
    expect(detectReasoningRequest('Why?', noAnchorPrior)).toBe(false);
    expect(detectReasoningRequest('How?', noAnchorPrior)).toBe(false);
  });

  it('does NOT fire on long messages that just contain "why"', async () => {
    const { detectReasoningRequest } = await import('./orchestrator.js');
    expect(
      detectReasoningRequest(
        'Why am I so tired today even though I slept well and ate enough protein and water?',
        calculatedPrior,
      ),
    ).toBe(false);
  });

  it('does NOT fire on missing inputs', async () => {
    const { detectReasoningRequest } = await import('./orchestrator.js');
    expect(detectReasoningRequest(undefined, calculatedPrior)).toBe(false);
    expect(detectReasoningRequest('Why?', undefined)).toBe(false);
  });
});

describe('detectMustAcknowledge — latest-message priority (2026-06-03)', () => {
  it('flags reported symptoms', async () => {
    const { detectMustAcknowledge } = await import('./orchestrator.js');
    expect(detectMustAcknowledge('I have a terrible headache')?.type).toBe('symptom');
    expect(detectMustAcknowledge("I'm so dizzy right now")?.type).toBe('symptom');
    expect(detectMustAcknowledge('my hair is falling out')?.type).toBe('symptom');
    expect(detectMustAcknowledge('Chest pain since this morning')?.type).toBe('symptom');
    expect(detectMustAcknowledge('losing my hair lately')?.type).toBe('symptom');
    expect(detectMustAcknowledge('my hair fell out in clumps')?.type).toBe('symptom');
    expect(detectMustAcknowledge('really bad heartburn after dinner')?.type).toBe('symptom');
  });

  it('flags corrections', async () => {
    const { detectMustAcknowledge } = await import('./orchestrator.js');
    expect(detectMustAcknowledge('Actually I meant 2 mg')?.type).toBe('correction');
    expect(detectMustAcknowledge('Wait, scratch that')?.type).toBe('correction');
    expect(detectMustAcknowledge('Sorry, I meant Wegovy not Ozempic')?.type).toBe('correction');
  });

  it('flags new medication info', async () => {
    const { detectMustAcknowledge } = await import('./orchestrator.js');
    expect(detectMustAcknowledge('I just started 1 mg today')?.type).toBe('new_info');
    expect(detectMustAcknowledge('I switched my dose this week')?.type).toBe('new_info');
  });

  it('returns null on neutral messages', async () => {
    const { detectMustAcknowledge } = await import('./orchestrator.js');
    expect(detectMustAcknowledge('Hello')).toBeNull();
    expect(detectMustAcknowledge('Thanks for that')).toBeNull();
    expect(detectMustAcknowledge("What's for dinner?")).toBeNull();
  });

  it('handles missing input', async () => {
    const { detectMustAcknowledge } = await import('./orchestrator.js');
    expect(detectMustAcknowledge(undefined)).toBeNull();
    expect(detectMustAcknowledge('')).toBeNull();
  });
});

describe('trimToLastCompleteSentence — final safety net', () => {
  it('trims a truncated trailing clause back to the prior sentence end', async () => {
    const { trimToLastCompleteSentence } = await import('./orchestrator.js');
    const r = trimToLastCompleteSentence("Got it, about 25g. You're at 60g today. Aim for more protein and");
    expect(r.wasTrimmed).toBe(true);
    expect(r.trimmed).toBe("Got it, about 25g. You're at 60g today.");
  });

  it('returns the original when it already ends cleanly', async () => {
    const { trimToLastCompleteSentence } = await import('./orchestrator.js');
    const r = trimToLastCompleteSentence("That sounds rough. Want to share more?");
    expect(r.wasTrimmed).toBe(false);
    expect(r.trimmed).toBe("That sounds rough. Want to share more?");
  });

  it('returns the original when no terminal punctuation exists anywhere', async () => {
    const { trimToLastCompleteSentence } = await import('./orchestrator.js');
    const r = trimToLastCompleteSentence("just a fragment with no end");
    expect(r.wasTrimmed).toBe(false);
    expect(r.trimmed).toBe("just a fragment with no end");
  });

  it('handles question-mark endings', async () => {
    const { trimToLastCompleteSentence } = await import('./orchestrator.js');
    const r = trimToLastCompleteSentence("How are you feeling? Anything specific bothering");
    expect(r.wasTrimmed).toBe(true);
    expect(r.trimmed).toBe("How are you feeling?");
  });

  it('handles ellipsis endings', async () => {
    const { trimToLastCompleteSentence } = await import('./orchestrator.js');
    const r = trimToLastCompleteSentence("Take your time… and");
    expect(r.wasTrimmed).toBe(true);
    expect(r.trimmed).toBe("Take your time…");
  });
});

describe('buildDietAwareSuggestion — diet + allergy filter (2026-06-06)', () => {
  it('returns omnivore options when no restriction given', async () => {
    const { buildDietAwareSuggestion } = await import('./orchestrator.js');
    const out = buildDietAwareSuggestion('snack', null, []);
    expect(out).not.toBeNull();
    expect(out).toContain('A few options:');
    // Omnivore snacks include animal-based options.
    expect(out!.toLowerCase()).toMatch(/yogurt|tuna|egg|cheese/);
  });

  it('vegan user: never suggests chicken / yogurt / eggs / fish', async () => {
    const { buildDietAwareSuggestion } = await import('./orchestrator.js');
    const vegan = { label: 'VEGAN' as const, forbidden: ['chicken', 'beef', 'pork', 'fish', 'salmon', 'tuna', 'dairy', 'milk', 'cheese', 'yogurt', 'eggs'], allowed: ['tofu', 'lentils'] };
    const out = buildDietAwareSuggestion('snack', vegan, []);
    expect(out).not.toBeNull();
    const lower = out!.toLowerCase();
    expect(lower).not.toMatch(/\b(chicken|yogurt|egg|cheese|tuna|salmon|beef|pork)\b/);
    // Should suggest plant options instead.
    expect(lower).toMatch(/edamame|hummus|chickpea|tofu|hemp/);
  });

  it('vegetarian user: suggests eggs/cheese but NEVER fish or chicken', async () => {
    const { buildDietAwareSuggestion } = await import('./orchestrator.js');
    const vegetarian = { label: 'VEGETARIAN' as const, forbidden: ['chicken', 'beef', 'pork', 'fish', 'salmon', 'tuna', 'turkey'], allowed: ['eggs', 'yogurt', 'lentils'] };
    const out = buildDietAwareSuggestion('lunch', vegetarian, []);
    expect(out).not.toBeNull();
    const lower = out!.toLowerCase();
    expect(lower).not.toMatch(/\b(chicken|turkey|fish|salmon|tuna|beef)\b/);
  });

  it('pescatarian user: fish OK, chicken/beef NOT', async () => {
    const { buildDietAwareSuggestion } = await import('./orchestrator.js');
    const pescatarian = { label: 'PESCATARIAN' as const, forbidden: ['chicken', 'beef', 'pork', 'turkey'], allowed: ['fish', 'salmon', 'tuna'] };
    const out = buildDietAwareSuggestion('dinner', pescatarian, []);
    expect(out).not.toBeNull();
    const lower = out!.toLowerCase();
    expect(lower).not.toMatch(/\b(chicken|turkey|beef|pork)\b/);
  });

  it('user with fish allergy: omnivore options but no salmon/tuna', async () => {
    const { buildDietAwareSuggestion } = await import('./orchestrator.js');
    const out = buildDietAwareSuggestion('snack', null, ['fish', 'salmon', 'tuna']);
    expect(out).not.toBeNull();
    const lower = out!.toLowerCase();
    expect(lower).not.toMatch(/\b(salmon|tuna|fish)\b/);
  });

  it('user with allergy phrased as "allergic to nuts": strips qualifier + filters', async () => {
    const { buildDietAwareSuggestion } = await import('./orchestrator.js');
    // "almonds" should be filtered because "nuts" stem matches the food list
    // implicitly via tokenization. (Stem match is tokenized — won't catch
    // "almonds" unless the dislike list contains "almonds". Test the literal.)
    const out = buildDietAwareSuggestion('snack', null, ['allergic to almonds', 'allergic to peanuts']);
    expect(out).not.toBeNull();
    const lower = out!.toLowerCase();
    expect(lower).not.toMatch(/\b(almond|peanut)s?\b/);
  });

  it('user dislikes "no eggs": filters out anything with eggs', async () => {
    const { buildDietAwareSuggestion } = await import('./orchestrator.js');
    const out = buildDietAwareSuggestion('breakfast', null, ['no eggs']);
    expect(out).not.toBeNull();
    const lower = out!.toLowerCase();
    expect(lower).not.toMatch(/\beggs?\b/);
  });

  it('returns null when too few options survive (vegan + heavy allergy load)', async () => {
    const { buildDietAwareSuggestion } = await import('./orchestrator.js');
    const vegan = { label: 'VEGAN' as const, forbidden: ['chicken', 'beef', 'pork', 'fish', 'salmon', 'tuna', 'dairy', 'milk', 'cheese', 'yogurt', 'eggs'], allowed: [] };
    const out = buildDietAwareSuggestion('snack', vegan, ['edamame', 'hummus', 'chickpeas', 'hemp', 'apples', 'peanuts', 'almonds']);
    // Most or all options stripped → returns null so caller can pick a
    // user-guidance line instead of risking a forbidden food.
    expect(out).toBeNull();
  });

  it('builds the line with comma list + final "or" + meal-specific follow-up', async () => {
    const { buildDietAwareSuggestion } = await import('./orchestrator.js');
    const out = buildDietAwareSuggestion('lunch', null, []);
    expect(out).not.toBeNull();
    expect(out).toMatch(/^A few options: /);
    expect(out).toMatch(/, or /);
    expect(out).toMatch(/Aim for 25-35g of protein at lunch\.$/);
  });

  it('breakfast meal type adds the breakfast-specific follow-up', async () => {
    const { buildDietAwareSuggestion } = await import('./orchestrator.js');
    const out = buildDietAwareSuggestion('breakfast', null, []);
    expect(out).toMatch(/Front-load 25-30g of protein to set the day up well\.$/);
  });
});

describe('getToolAwareFallback — food log formatting (2026-06-06)', () => {
  it('produces "Got it — about Xg protein for that." (lowercase after em-dash)', async () => {
    // Production failure: shipped "Got it, About 45g protein for that."
    // (stray capital A) after format-enforcer flattened em-dash to comma.
    // Now uses lowercase "about" so the post-conversion output reads as
    // grammatical "Got it, about 45g protein for that."
    const { getToolAwareFallback } = await import('./orchestrator.js') as any;
    const reply = getToolAwareFallback('food_log', [
      { name: 'log_food', ok: true, output: { ok: true, protein_g: 45 }, latencyMs: 100 },
    ]);
    expect(reply).toBe('Got it — about 45g protein for that.');
    expect(reply).not.toMatch(/, About\b/);
  });

  it('still uppercases the symptom-acknowledgement branch', async () => {
    const { getToolAwareFallback } = await import('./orchestrator.js') as any;
    const reply = getToolAwareFallback('food_log', [
      { name: 'log_food', ok: true, output: { ok: true, protein_g: 45 }, latencyMs: 100 },
    ], { userMessage: 'I had eggs but my stomach hurts' });
    expect(reply).toMatch(/^That sounds rough/);
  });
});

describe('getToolAwareFallback — health questions answered, not clarified (2026-06-13)', () => {
  it('answers the muscle "get smaller" question (the production failure)', async () => {
    const { getToolAwareFallback } = await import('./orchestrator.js') as any;
    const msg = 'is it possible that i feel that my muscles get smaller ?';
    // Real muscle answer regardless of whether it classified knowledge OR general.
    for (const type of ['knowledge', 'general']) {
      const reply = getToolAwareFallback(type, [], { userMessage: msg });
      expect(reply).toMatch(/muscle|lean mass/i);
      expect(reply).not.toMatch(/rest of that|tell me a bit more|say more/i);
    }
  });

  it('answers a health topic that landed in general (water / alcohol)', async () => {
    const { getToolAwareFallback } = await import('./orchestrator.js') as any;
    expect(getToolAwareFallback('general', [], { userMessage: 'how much water should i drink' })).toMatch(/water|oz/i);
    expect(getToolAwareFallback('general', [], { userMessage: 'can i have alcohol' })).toMatch(/alcohol|moderation/i);
  });

  it('general fallbacks never imply the message was cut off', async () => {
    const { getToolAwareFallback } = await import('./orchestrator.js') as any;
    // A truly non-health general message → invites elaboration, but never
    // "what's the rest of that?" (which reads as "you didn't finish").
    const reply = getToolAwareFallback('general', [], { userMessage: 'mmhm sure thing then' });
    expect(reply).not.toMatch(/rest of that/i);
  });

  it('a question with no topic match still gets a real answer, never a generic clarification', async () => {
    const { getToolAwareFallback } = await import('./orchestrator.js') as any;
    // No knowledge topic matches "why do i feel weird", but it's a question —
    // must not return "I'm with you" / "tell me more".
    const reply = getToolAwareFallback('general', [], { userMessage: 'why do i feel weird lately?' });
    expect(reply).not.toMatch(/i'?m with you|tell me a bit more|what would you like|rest of that/i);
    expect(reply.length).toBeGreaterThan(60);
  });
});

describe('classifyMessage — substantive questions route to knowledge (2026-06-13)', () => {
  it('routes fell-through questions to knowledge, not general', async () => {
    const { classifyMessage } = await import('./classify.js') as any;
    expect(classifyMessage('is it possible that i feel that my hair is shorter?').type).toBe('knowledge');
    expect(classifyMessage('why do i feel so weird on this').type).toBe('knowledge');
    // Bare one-word follow-ups stay general (handled by reasoning/continuation).
    expect(classifyMessage('Why').type).not.toBe('knowledge');
  });
});

describe('getToolAwareFallback — Level 2 mood-ladder (2026-06-06)', () => {
  it('"want to give up on everything" → validate + suggest professional help', async () => {
    // Production screenshot 2026-06-06: this exact phrase shipped "I hear
    // you." which validates but skips the Level 2 ladder's professional-
    // help line. The audit's Area 6 requires both pieces.
    const { getToolAwareFallback } = await import('./orchestrator.js') as any;
    const reply = getToolAwareFallback('emotional', [], {
      userMessage: 'want to give up on everything',
    });
    expect(reply).toMatch(/heavy|hear you/i);
    expect(reply.toLowerCase()).toMatch(/doctor|therapist|professional|talk/);
    expect(reply).not.toMatch(/988|911/);
  });

  it('"I feel hopeless" → Level 2 ladder fallback', async () => {
    const { getToolAwareFallback } = await import('./orchestrator.js') as any;
    const reply = getToolAwareFallback('emotional', [], { userMessage: "I'm hopeless" });
    expect(reply.toLowerCase()).toMatch(/doctor|therapist|professional/);
  });

  it('Mild "I had a rough day" does NOT get Level 2 fallback (stays generic, but engaging)', async () => {
    const { getToolAwareFallback } = await import('./orchestrator.js') as any;
    const reply = getToolAwareFallback('emotional', [], { userMessage: 'I had a rough day' });
    // 2026-06-06 v2 — emotional typed fallbacks now include a gentle open
    // door (per the 4-step framework) — should NOT be a bare one-liner.
    expect(reply).not.toMatch(/^(I hear you\.|That's a lot\. I'm here\.|With you on that\.)$/);
    // Should invite the user to share more — either a soft question or
    // language that opens the conversation.
    expect(reply).toMatch(/\?$|piece|underneath|put words/i);
    // Must not push 988/911 — no self-harm signaled.
    expect(reply).not.toMatch(/988|911/);
  });
});

describe('Emotional engagement — 4-step framework (2026-06-06 v2)', () => {
  it('emotional typed fallbacks always invite further conversation', async () => {
    // Pull each of the 3 emotional fallbacks in sequence and confirm none
    // dead-end on a bare ack.
    const { getToolAwareFallback } = await import('./orchestrator.js') as any;
    const seen = new Set<string>();
    for (let i = 0; i < 6; i++) {
      const r = getToolAwareFallback('emotional', [], { userMessage: 'hard day' });
      seen.add(r);
    }
    for (const r of seen) {
      // Every reply must include either a question OR a "share / put words /
      // underneath" invitation.
      expect(r).toMatch(/\?$|piece|underneath|put words|specifically/i);
    }
  });

  it('mood_log typed fallback also includes a soft invitation', async () => {
    const { getToolAwareFallback } = await import('./orchestrator.js') as any;
    const r = getToolAwareFallback('mood_log', [], { userMessage: 'feeling okay' });
    // Every mood_log fallback now ends with a soft conversation door.
    expect(r).toMatch(/\?$/);
  });

  it('Level 2 fallback follows the 4-step framework (recognize + context + question + no 988)', async () => {
    const { getToolAwareFallback } = await import('./orchestrator.js') as any;
    const reply = getToolAwareFallback('emotional', [], {
      userMessage: 'want to give up on everything',
    });
    // Step 1: recognize the feeling
    expect(reply).toMatch(/heavy|hear/i);
    // Step 2/3: invites the user to share more
    expect(reply).toMatch(/\?$/);
    // Step 3: doctor/therapist nudge (Level 2 — NOT 988 push)
    expect(reply.toLowerCase()).toMatch(/doctor|therapist/);
    // No 988/911 — that's safety-guard territory
    expect(reply).not.toMatch(/988|911/);
  });
});
