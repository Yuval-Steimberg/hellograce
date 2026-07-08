import { describe, it, expect, vi } from 'vitest';
import { MessageGenerator, isNearDuplicate, deriveMorningBridge, anticipationDirective, injectionNumberFromStart, pickTodaysFocus, buildFocusBlock, isNutritionFocus, __testing } from './message-generator.js';
import type { GraceUser } from '../user/user.service.js';
import type { LLMProvider } from '@grace/shared';

const { sanitizeProactiveOutput } = __testing;

describe('injectionNumberFromStart — grounded injection number, never invented', () => {
  const now = new Date('2026-07-05T12:00:00Z');
  it('weekly: weeks since start + 1', () => {
    expect(injectionNumberFromStart('2026-07-01', 'weekly', now)).toBe(1); // <1 week → #1
    expect(injectionNumberFromStart('2026-06-14', 'weekly', now)).toBe(4); // 3 weeks → #4
  });
  it('biweekly: halved', () => {
    expect(injectionNumberFromStart('2026-05-10', 'biweekly', now)).toBe(5); // ~8 weeks / 2 + 1
  });
  it('returns null without a usable start date', () => {
    expect(injectionNumberFromStart(null, 'weekly', now)).toBeNull();
    expect(injectionNumberFromStart('not-a-date', 'weekly', now)).toBeNull();
    expect(injectionNumberFromStart('2026-08-01', 'weekly', now)).toBeNull(); // future start
  });
  it('returns null for an implausible number (mis-entered start date)', () => {
    expect(injectionNumberFromStart('2010-01-01', 'weekly', now)).toBeNull(); // >5 years
  });
});

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

describe('welcome message — deterministic, compliance-correct (2026-06-14)', () => {
  it('ships the fixed welcome verbatim WITHOUT calling the LLM', async () => {
    const { llm, calls } = makeStubLlm('SOME LLM PARAPHRASE THAT MUST NOT SHIP');
    const gen = new MessageGenerator(llm);
    const out = await gen.generate('welcome', makeUser({ first_name: 'Yuval' }));
    // The LLM is never consulted for the welcome.
    expect(calls).toHaveLength(0);
    expect(out).not.toContain('PARAPHRASE');
    // Name + the key beats + the A2P compliance footer (verbatim, at the end).
    expect(out).toContain('Hi Yuval, it\'s Grace, your new GLP-1 sidekick.');
    expect(out).toContain('snap a pic');
    // Tells the user how to get their dashboard link (text "dashboard").
    expect(out).toContain('"dashboard"');
    expect(out).toContain('Save this number');
    expect(out.trimEnd().endsWith('Reply STOP to cancel, HELP for help. Msg & data rates may apply.')).toBe(true);
  });

  it('falls back to "there" when no first name is set', async () => {
    const { llm } = makeStubLlm('x');
    const gen = new MessageGenerator(llm);
    const noName = { ...makeUser(), first_name: undefined } as unknown as GraceUser;
    const out = await gen.generate('welcome', noName);
    expect(out).toContain('Hi there, it\'s Grace');
  });
});

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

  it('embeds the user\'s recent messages so the reminder can reference a real topic', async () => {
    const { llm, calls } = makeStubLlm('Hope the nausea has eased — a little ginger tea can help settle things.');
    const gen = new MessageGenerator(llm);
    await gen.generate('morning', makeUser(), {
      conversationContext: ['felt really nauseous after my shot yesterday', 'trying to hit my protein goal'],
    });
    const prompt = calls[0]!.prompt;
    expect(prompt).toContain('RECENT CONVERSATION');
    expect(prompt).toContain('nauseous after my shot');
    expect(prompt).toContain('only if it genuinely fits');
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

describe('deriveMorningBridge — connect the morning reminder to yesterday', () => {
  const base = { side_effect_flow: null } as Pick<GraceUser, 'side_effect_flow'>;

  it('1. symptom yesterday → gentle check-in + simple food + safety, allows a question', () => {
    const b = deriveMorningBridge(base, { conversationContext: ['ugh so nauseous after my shot today'] });
    expect(b.block).toMatch(/YESTERDAY BRIDGE/);
    expect(b.block.toLowerCase()).toContain('nause');
    expect(b.block.toLowerCase()).toMatch(/simple|easy/);
    expect(b.block.toLowerCase()).toMatch(/doctor/); // safety
    expect(b.allowQuestion).toBe(true);
  });

  it('symptom can also come from an active side_effect_flow', () => {
    const b = deriveMorningBridge({ side_effect_flow: 'constipation' }, {});
    expect(b.block.toLowerCase()).toContain('constipation');
    expect(b.allowQuestion).toBe(true);
  });

  it('2. missed protein yesterday → nudge one protein-first meal, no numbers, no question', () => {
    const b = deriveMorningBridge(base, { yesterdayFood: { protein_g: 42, calories: 900, itemCount: 3, proteinGoal: 90 } });
    expect(b.block.toLowerCase()).toMatch(/protein-first|protein/);
    expect(b.block.toLowerCase()).toMatch(/don't quote the numbers|never scolding/);
    expect(b.allowQuestion).toBe(false);
  });

  it('3. hit protein yesterday → acknowledge + build on it', () => {
    const b = deriveMorningBridge(base, { yesterdayFood: { protein_g: 95, calories: 1500, itemCount: 4, proteinGoal: 90 } });
    expect(b.block.toLowerCase()).toMatch(/solid|build on it|acknowledge/);
  });

  it('5. emotional / frustrated yesterday → clean-slate reset, no scolding', () => {
    const b = deriveMorningBridge(base, { conversationContext: ['honestly this is so frustrating, nothing is working'] });
    expect(b.block.toLowerCase()).toMatch(/fresh start|clean-slate|no pressure|no need to be perfect/);
    expect(b.allowQuestion).toBe(false);
  });

  it('symptom takes priority over a missed-protein angle', () => {
    const b = deriveMorningBridge(base, {
      conversationContext: ['felt really nauseous all evening'],
      yesterdayFood: { protein_g: 20, calories: 400, itemCount: 1, proteinGoal: 90 },
    });
    expect(b.block.toLowerCase()).toContain('nause');
  });

  it('7. no activity / quiet yesterday → warm fresh-start hello', () => {
    const b = deriveMorningBridge(base, { yesterdayFood: { protein_g: 0, calories: 0, itemCount: 0, proteinGoal: 90 } });
    expect(b.block.toLowerCase()).toMatch(/fresh-start|fresh start|quiet|zero pressure/);
  });

  it('no context at all → empty block, falls back to the generic warm morning', () => {
    const b = deriveMorningBridge(base, {});
    expect(b.block).toBe('');
    expect(b.allowQuestion).toBe(false);
  });

  it('never tells the model to recite yesterday verbatim', () => {
    const b = deriveMorningBridge(base, { yesterdayFood: { protein_g: 42, calories: 900, itemCount: 3, proteinGoal: 90 } });
    expect(b.block).toMatch(/NEVER say "based on our conversation yesterday"/);
  });
});

describe('anticipationDirective — occasional forward teaser', () => {
  it('fires on ~1 in 3 days (seed % 3 === 0), empty otherwise', () => {
    expect(anticipationDirective(0)).toMatch(/ANTICIPATION/);
    expect(anticipationDirective(3)).toMatch(/look forward to/i);
    expect(anticipationDirective(1)).toBe('');
    expect(anticipationDirective(2)).toBe('');
  });
  it('never promises anything medical', () => {
    expect(anticipationDirective(0)).toMatch(/never promise anything medical/i);
  });
});

describe("TODAY'S FOCUS — rotating check-in topic (Nudge model)", () => {
  const NUTRITION = new Set(['protein', 'nutrition']);

  it('is deterministic per (seed, slot) and varies across slots', () => {
    // Same inputs → same focus (stable on retry within a day).
    expect(pickTodaysFocus(['Losing weight'], 12345, 'morning'))
      .toBe(pickTodaysFocus(['Losing weight'], 12345, 'morning'));
    // At least one seed produces different morning vs evening foci.
    const differs = [0, 1, 2, 3, 4, 5, 6, 7].some(
      (s) => pickTodaysFocus(['Losing weight'], s, 'morning') !== pickTodaysFocus(['Losing weight'], s, 'evening'),
    );
    expect(differs).toBe(true);
  });

  it('a hydration-goal user NEVER lands on a protein/nutrition focus', () => {
    // 'Staying hydrated' weights + universal contain no protein/nutrition topic,
    // so every seed must yield a non-nutrition focus — the over-indexing fix.
    for (let s = 0; s < 60; s++) {
      for (const slot of ['morning', 'midday', 'evening']) {
        expect(NUTRITION.has(pickTodaysFocus(['Staying hydrated'], s, slot))).toBe(false);
      }
    }
  });

  it('a protein-goal user CAN land on protein (weighted, not forced)', () => {
    const foci = new Set(Array.from({ length: 60 }, (_, s) => pickTodaysFocus(['Eating enough protein'], s, 'morning')));
    expect(foci.has('protein')).toBe(true);
    expect(foci.size).toBeGreaterThan(1); // still varied, not protein every time
  });

  it('buildFocusBlock enforces TOPIC DISCIPLINE and bans protein on a non-nutrition day', () => {
    const hydration = buildFocusBlock('hydration');
    expect(hydration).toContain("TODAY'S FOCUS");
    expect(hydration).toContain('TOPIC DISCIPLINE');
    expect(hydration).toContain('Hydration');
    expect(hydration).toMatch(/Do NOT default to protein/i);
    expect(hydration).toMatch(/do NOT recite protein\/calorie numbers/i);
    // A nutrition focus DOES allow the protein nudge.
    const protein = buildFocusBlock('protein');
    expect(protein).toMatch(/protein\/nutrition nudge fits/i);
    expect(protein).not.toMatch(/Do NOT default to protein/i);
    expect(isNutritionFocus('protein')).toBe(true);
    expect(isNutritionFocus('hydration')).toBe(false);
  });

  it('a non-nutrition morning keeps yesterday data as AWARENESS only — no protein pivot', async () => {
    const { llm, calls } = makeStubLlm('A glass of water now sets the whole day up 🌿');
    const gen = new MessageGenerator(llm);
    // 'Staying hydrated' → focus is always non-nutrition regardless of the daily seed.
    await gen.generate('morning', makeUser({ goals: ['Staying hydrated'] }), {
      yesterdayFood: { protein_g: 42, calories: 900, itemCount: 3, proteinGoal: 90 },
    });
    const prompt = calls[0]!.prompt;
    expect(prompt).toContain('TOPIC DISCIPLINE');
    expect(prompt).toMatch(/Do NOT default to protein/i);
    // Numbers stay for awareness, but the protein DIRECTIVE is gone.
    expect(prompt).toContain('REAL DATA — yesterday');
    expect(prompt).toContain('AWARENESS only');
    expect(prompt).not.toMatch(/plan one solid protein meal early/i);
  });

  it('a non-nutrition evening does not recite the protein total as a suggestion', async () => {
    const { llm, calls } = makeStubLlm('Rest is part of the work tonight 🌙');
    const gen = new MessageGenerator(llm);
    await gen.generate('evening', makeUser({ goals: ['Staying hydrated'] }), {
      todayFood: { protein_g: 82, calories: 1400, itemCount: 4, proteinGoal: 100 },
    });
    const prompt = calls[0]!.prompt;
    expect(prompt).toContain('TOPIC DISCIPLINE');
    expect(prompt).toContain('82g'); // still present for awareness
    expect(prompt).toMatch(/AWARENESS only|do NOT recite these numbers/i);
    expect(prompt).not.toMatch(/could close the gap/i);
  });
});

describe('stickiness message types', () => {
  it('journey: generates a day-specific first-week message', async () => {
    const { llm, calls } = makeStubLlm("Day one! Just text me your next meal and I'll log it 🧡");
    const gen = new MessageGenerator(llm);
    const out = await gen.generate('journey', makeUser(), { journeyDay: 1 });
    expect(out.length).toBeGreaterThan(0);
    expect(calls[0]!.prompt).toMatch(/first-week journey/i);
    expect(calls[0]!.prompt).toMatch(/FIRST full day|log their first meal/i);
  });

  it('winback: references the stage and may use recent conversation', async () => {
    const { llm, calls } = makeStubLlm("Thinking of you — door's always open whenever you're ready 🧡");
    const gen = new MessageGenerator(llm);
    const out = await gen.generate('winback', makeUser(), { winbackStage: 3, conversationContext: ['I was trying to hit my protein goal'] });
    expect(out.length).toBeGreaterThan(0);
    expect(calls[0]!.prompt).toMatch(/win-back/i);
    expect(calls[0]!.prompt).toMatch(/NEVER guilt|we miss you/i);
    expect(calls[0]!.prompt).toContain('protein goal'); // recent convo woven in
  });

  it('journey/winback fall back to a warm canned message when the LLM is empty', async () => {
    const { llm } = makeStubLlm(''); // empty → fallback
    const gen = new MessageGenerator(llm);
    const j = await gen.generate('journey', makeUser(), { journeyDay: 2 });
    const w = await gen.generate('winback', makeUser(), { winbackStage: 1 });
    expect(j.length).toBeGreaterThan(10);
    expect(w.length).toBeGreaterThan(10);
  });
});
