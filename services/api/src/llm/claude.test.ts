import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Logger } from 'pino';
import { UpstreamError } from '../errors.js';
import { NUDGE_RULES } from '../services/nudge-prompt.js';

// Mock the Anthropic SDK so no network call is made — capture the args passed to
// messages.create and control its return value.
const createMock = vi.fn();
vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic {
    messages = { create: createMock };
    constructor(_opts: unknown) {}
  }
  return { default: MockAnthropic };
});

import { ClaudeProvider } from './claude.js';

const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn() } as unknown as Logger;

function makeProvider() {
  return new ClaudeProvider({ apiKey: 'sk-test', model: 'claude-haiku-4-5' }, logger);
}

describe('ClaudeProvider', () => {
  beforeEach(() => createMock.mockReset());

  it('extracts system, drops leading assistant + empty turns, returns text/finish/usage', async () => {
    createMock.mockResolvedValue({
      content: [{ type: 'text', text: '  warm reply ' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 42, output_tokens: 7 },
    });
    const res = await makeProvider().generate({
      messages: [
        { role: 'system', content: 'RULES' },
        { role: 'assistant', content: 'earlier' }, // leading assistant → dropped
        { role: 'user', content: 'hello' },
        { role: 'user', content: '   ' }, // empty → dropped
      ],
      temperature: 0.8,
      maxOutputTokens: 500,
    });

    expect(res.text).toBe('warm reply');
    expect(res.finishReason).toBe('stop');
    expect(res.usage).toEqual({ inputTokens: 42, outputTokens: 7 });

    const arg = createMock.mock.calls[0]![0];
    expect(arg.system).toBe('RULES');
    expect(arg.model).toBe('claude-haiku-4-5');
    expect(arg.temperature).toBe(0.8);
    expect(arg.max_tokens).toBe(500);
    expect(arg.messages).toEqual([{ role: 'user', content: 'hello' }]);
  });

  it('joins multiple system blocks and concatenates multiple text blocks; maps max_tokens→length', async () => {
    createMock.mockResolvedValue({
      content: [
        { type: 'text', text: 'part one ' },
        { type: 'thinking', thinking: 'ignored' },
        { type: 'text', text: 'part two' },
      ],
      stop_reason: 'max_tokens',
      usage: { input_tokens: 1, output_tokens: 2 },
    });
    const res = await makeProvider().generate({
      messages: [
        { role: 'system', content: 'A' },
        { role: 'system', content: 'B' },
        { role: 'user', content: 'hi' },
      ],
    });
    expect(res.text).toBe('part one part two');
    expect(res.finishReason).toBe('length');
    expect(createMock.mock.calls[0]![0].system).toBe('A\n\nB');
  });

  it('splits the static Nudge RULES into its own prompt-cache breakpoint', async () => {
    createMock.mockResolvedValue({
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const dynamic = '\n━━━\nPROFILE: Jane, Ozempic\n\nCURRENT TIME: ...';
    await makeProvider().generate({
      messages: [
        { role: 'system', content: NUDGE_RULES + dynamic },
        { role: 'user', content: 'hi' },
      ],
    });
    const system = createMock.mock.calls[0]![0].system;
    expect(Array.isArray(system)).toBe(true);
    expect(system[0]).toEqual({ type: 'text', text: NUDGE_RULES, cache_control: { type: 'ephemeral' } });
    expect(system[1]).toEqual({ type: 'text', text: dynamic });
  });

  it('keeps a non-RULES system prompt as a plain string (no mis-split)', async () => {
    createMock.mockResolvedValue({
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    await makeProvider().generate({
      messages: [
        { role: 'system', content: 'some other prompt' },
        { role: 'user', content: 'hi' },
      ],
    });
    expect(createMock.mock.calls[0]![0].system).toBe('some other prompt');
  });

  it('refuses JSON / schema requests (accuracy-critical extraction never routes here)', async () => {
    await expect(
      makeProvider().generate({ messages: [{ role: 'user', content: 'x' }], responseFormat: 'json' }),
    ).rejects.toThrow(/text reply path only/i);
    await expect(
      makeProvider().generate({
        messages: [{ role: 'user', content: 'x' }],
        responseSchema: { type: 'object' },
      }),
    ).rejects.toThrow(/text reply path only/i);
    expect(createMock).not.toHaveBeenCalled();
  });

  it('throws an UpstreamError when there is no user content (caller degrades to deterministic reply)', async () => {
    // These guard paths also prove generate() rejects with UpstreamError on
    // failure — the same shape the grounded caller's `.catch(() => null)` relies
    // on to degrade to the deterministic reply. (The SDK-error path is the same
    // catch; it isn't unit-covered here because vitest's unhandled-rejection
    // detector flags the mock's internally-awaited rejected promise.)
    let caught: unknown;
    try {
      await makeProvider().generate({
        messages: [
          { role: 'system', content: 'RULES' },
          { role: 'assistant', content: 'hi' },
        ],
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(UpstreamError);
    expect((caught as UpstreamError).message).toMatch(/no user content/i);
    expect(createMock).not.toHaveBeenCalled();
  });
});
