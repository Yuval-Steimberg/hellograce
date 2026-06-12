import { describe, it, expect, vi } from 'vitest';
import { MessageGenerator, isNearDuplicate, __testing } from './message-generator.js';
import type { GraceUser } from '../user/user.service.js';
import type { LLMProvider } from '@grace/shared';

const { sanitizeProactiveOutput } = __testing;

function makeUser(overrides: Partial<GraceUser> = {}): GraceUser {
  return {
    phone: '+15551234567',
    first_name: 'Yuval',
    medication: 'Ozempic',
    goals: ['Losing weight'],
    food_dislikes: [],
    current_weight: 180,
    goal_weight: 160,
    protein_goal_grams: 90,
    rlhf_enabled: false,
  } as unknown as GraceUser;
}

/** Stub LLM that returns a fixed text and records every request. */
function makeStubLlm(reply: string) {
  const calls: Array<{ system: string; prompt: string }> = [];
  const llm = {
    generate: vi.fn(async (req: { messages: Array<{ role: string; content: string }> }) => {
      calls.push({
        system: req.messages.find((m) => m.role === 'system')?.content ?? '',
        prompt: req.messages.find((m) => m.role === 'user')?.content ?? '',
      });
      return { text: reply };
    }),
  } as unknown as LLMProvider;
  return { llm, calls };
}

describe('sanitizeProactiveOutput — mail-merge salutation openers (2026-06-11 production bug)', () => {
  it('strips the exact production failure "For Yuval, Hope you\'re having a good day…"', () => {
    const out = sanitizeProactiveOutput(
      'For Yuval, Hope you\'re having a good day. Prioritizing protein can help maintain steady energy through the afternoon.',
      'Yuval',
    );
    expect(out).not.toBeNull();
    expect(out!.startsWith('Hope')).toBe(true);
    expect(out).not.toMatch(/for yuval/i);
  });

  it('strips "For <Nickname>," even when it does not match users.first_name', () => {
    const out = sanitizeProactiveOutput('For Yuvi, water before coffee sets the day up well.', 'Yuval');
    expect(out).not.toBeNull();
    expect(out).not.toMatch(/yuvi/i);
    expect(out!.toLowerCase().startsWith('water')).toBe(true);
  });

  it('strips "Dear user," and "As your assistant," role openers', () => {
    expect(sanitizeProactiveOutput('Dear user, a short walk after lunch helps digestion today.', null))
      .toMatch(/^A short walk/);
    expect(sanitizeProactiveOutput('As your assistant, I recommend a glass of water before your coffee this morning.', null))
      .toMatch(/^I recommend/);
  });

  it('does NOT strip legitimate "For breakfast," (lowercase noun is not a salutation)', () => {
    const out = sanitizeProactiveOutput('For breakfast, Greek yogurt with berries is an easy protein win.', 'Yuval');
    expect(out).toMatch(/^For breakfast/);
  });

  it('still strips label prefixes and the first name elsewhere in the text', () => {
    const out = sanitizeProactiveOutput('Morning reminder: protein first today.', 'Yuval');
    expect(out).toMatch(/^Protein first today/);
  });
});

describe('isNearDuplicate', () => {
  it('exact and emoji-variant texts are duplicates', () => {
    expect(isNearDuplicate('Protein first today 🌿', 'Protein first today 🤍')).toBe(true);
    expect(isNearDuplicate('Rest well tonight.', 'rest well tonight')).toBe(true);
  });

  it('genuinely different reminders are not duplicates', () => {
    expect(isNearDuplicate(
      'Protein first today — front-load it before appetite fades.',
      'A glass of water before coffee sets the whole day up differently.',
    )).toBe(false);
  });
});

describe('MessageGenerator — context grounding + anti-repetition', () => {
  it('morning prompt embeds REAL yesterday data and the no-invention rule', async () => {
    const { llm, calls } = makeStubLlm('Yesterday you landed a little short on protein, so a solid breakfast helps today.');
    const gen = new MessageGenerator(llm);
    await gen.generate('morning', makeUser(), {
      yesterdayFood: { protein_g: 42, calories: 900, itemCount: 3, proteinGoal: 90 },
    });
    const prompt = calls[0]!.prompt;
    expect(prompt).toContain('REAL DATA — yesterday');
    expect(prompt).toContain('42g');
    expect(prompt).toContain('90g');
    expect(prompt).toContain('NEVER invent');
  });

  it('morning with NOTHING logged yesterday → shame-free framing, no invented numbers', async () => {
    const { llm, calls } = makeStubLlm('Fresh start today — one solid protein meal early sets the tone.');
    const gen = new MessageGenerator(llm);
    await gen.generate('morning', makeUser(), {
      yesterdayFood: { protein_g: 0, calories: 0, itemCount: 0, proteinGoal: 90 },
    });
    const prompt = calls[0]!.prompt;
    expect(prompt).toContain('no food was logged');
    expect(prompt).toContain('shame-free');
  });

  it('evening prompt embeds REAL today data; no data → no REAL DATA block', async () => {
    const { llm, calls } = makeStubLlm('You\'re at 82g protein today — something simple tonight could close the gap.');
    const gen = new MessageGenerator(llm);
    await gen.generate('evening', makeUser(), {
      todayFood: { protein_g: 82, calories: 1400, itemCount: 4, proteinGoal: 100 },
    });
    expect(calls[0]!.prompt).toContain('REAL DATA — today');
    expect(calls[0]!.prompt).toContain('82g');

    await gen.generate('evening', makeUser(), {});
    expect(calls[1]!.prompt).not.toContain('REAL DATA — today');
  });

  it('prompt no longer baits the model with "SMS for <name>" addressing', async () => {
    const { llm, calls } = makeStubLlm('Water before coffee sets the day up well.');
    const gen = new MessageGenerator(llm);
    await gen.generate('morning', makeUser());
    expect(calls[0]!.prompt).not.toMatch(/SMS for Yuval/i);
    expect(calls[0]!.prompt).toMatch(/NEVER address the user by name/);
  });

  it('lists recently sent reminders in the prompt and falls back on a near-duplicate', async () => {
    const previous = 'Protein first today — front-load it before appetite fades 🌿';
    const { llm, calls } = makeStubLlm('Protein first today — front-load it before appetite fades 🤍');
    const gen = new MessageGenerator(llm);
    const out = await gen.generate('morning', makeUser(), { recentMessages: [previous] });
    expect(calls[0]!.prompt).toContain('RECENTLY SENT');
    expect(calls[0]!.prompt).toContain('front-load it before appetite fades');
    // The LLM returned a trivial emoji-variant of the previous reminder →
    // deterministic backstop ships the (daily-rotating) fallback instead.
    expect(isNearDuplicate(out, previous)).toBe(false);
  });
});
