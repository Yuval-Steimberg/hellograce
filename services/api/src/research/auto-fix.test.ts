import { describe, it, expect, vi } from 'vitest';
import type { Pool } from 'pg';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import type { LLMProvider } from '@grace/shared';
import { ResearchAutoFix } from './auto-fix.js';

/**
 * Unit coverage for the auto-fix engine.
 *
 * We use bracket access to reach private methods rather than promoting them
 * to public — these are tested as pure functions of their inputs, the
 * orchestration is integration-tested via the admin endpoint smoke test.
 */

const stubLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

function makeFix(overrides: Partial<{ pool: Pool; redis: Redis; llm: LLMProvider }> = {}): ResearchAutoFix {
  const pool = overrides.pool ?? ({ query: vi.fn() } as unknown as Pool);
  const redis = overrides.redis ?? ({
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
  } as unknown as Redis);
  const llm = overrides.llm ?? ({ generate: vi.fn() } as unknown as LLMProvider);
  return new ResearchAutoFix({ pool, redis, llm, logger: stubLogger });
}

describe('ResearchAutoFix.quickFailCheck', () => {
  const fix = makeFix();
  const check = (text: string): string[] =>
    (fix as unknown as { quickFailCheck: (s: string) => string[] }).quickFailCheck(text);

  it('flags empty responses', () => {
    expect(check('')).toContain('empty_response');
    expect(check('   ')).toContain('empty_response');
  });

  it('detects unprompted apologies', () => {
    expect(check('I apologize for the confusion earlier.')).toContain('unprompted_apology');
    expect(check('I apologize for the mix-up')).toContain('unprompted_apology');
  });

  it('detects warning-label tone', () => {
    expect(check('These are absolutely critical considerations')).toContain('warning_label_tone');
    expect(check('You must discuss this with your doctor')).toContain('warning_label_tone');
  });

  it('detects privacy misfire', () => {
    expect(check('I only know about you and your journey')).toContain('privacy_misfire');
  });

  it('detects generic fallback openers', () => {
    expect(check("I'm here to help with whatever you need!")).toContain('generic_fallback');
    expect(check("What's on your mind today?")).toContain('generic_fallback');
  });

  it('detects sycophantic openers', () => {
    // Regex requires the praise word directly followed by ! or ,
    expect(check('Great! That makes sense.')).toContain('sycophantic_opener');
    expect(check('Wonderful, that is so brave of you')).toContain('sycophantic_opener');
    expect(check('Amazing! You are doing well.')).toContain('sycophantic_opener');
  });

  it('detects vague framing phrases', () => {
    expect(check('We need a holistic approach to this')).toContain('vague_framing');
    expect(check('There are layers of complexity here')).toContain('vague_framing');
  });

  it('detects banned filler phrases', () => {
    expect(check("That's incredibly common with GLP-1 users")).toContain('banned_phrase');
    expect(check('Completely understandable to feel that way')).toContain('banned_phrase');
  });

  it('flags responses longer than 700 chars', () => {
    const long = 'a'.repeat(701);
    expect(check(long)).toContain('too_long');
  });

  it('flags multiple questions in one response', () => {
    expect(check('How are you feeling? Did you eat today? What about water?')).toContain('multiple_questions');
  });

  it('does not flag normal short responses', () => {
    expect(check('Got it. Hydrate and rest tonight.')).toEqual([]);
    expect(check('Protein bar with peanut butter works well. About 20g per serving.')).toEqual([]);
  });

  it('stacks multiple failures on a single response', () => {
    const bad = "Wonderful! I'm here to help with anything. What's on your mind? Anything else?";
    const result = check(bad);
    expect(result).toContain('sycophantic_opener');
    expect(result).toContain('generic_fallback');
    expect(result).toContain('multiple_questions');
  });
});

describe('ResearchAutoFix.computeWeakestDims', () => {
  const fix = makeFix();
  const compute = (posts: Array<{ eval_scores: Record<string, number> | null }>): Array<{ dim: string; avgScore: number }> =>
    (fix as unknown as { computeWeakestDims: (p: unknown) => Array<{ dim: string; avgScore: number }> }).computeWeakestDims(posts);

  it('returns empty when no posts have eval scores', () => {
    expect(compute([{ eval_scores: null }, { eval_scores: null }])).toEqual([]);
  });

  it('averages scores per dimension and sorts ascending', () => {
    const result = compute([
      { eval_scores: { empathy: 2, tone_match: 4 } },
      { eval_scores: { empathy: 1, tone_match: 5 } },
      { eval_scores: { empathy: 3, tone_match: 3 } },
    ]);
    expect(result).toEqual([
      { dim: 'empathy', avgScore: 2 },
      { dim: 'tone_match', avgScore: 4 },
    ]);
  });

  it('rounds averages to 1 decimal', () => {
    const result = compute([
      { eval_scores: { foo: 3 } },
      { eval_scores: { foo: 4 } },
      { eval_scores: { foo: 4 } },
    ]);
    // (3+4+4)/3 = 3.666... → 3.7
    expect(result[0]).toEqual({ dim: 'foo', avgScore: 3.7 });
  });

  it('caps at 5 weakest dimensions', () => {
    const scores: Record<string, number> = {};
    for (let i = 0; i < 10; i++) scores[`dim_${i}`] = i;
    const result = compute([{ eval_scores: scores }]);
    expect(result).toHaveLength(5);
    expect(result[0]?.dim).toBe('dim_0');
  });

  it('ignores posts without eval_scores', () => {
    const result = compute([
      { eval_scores: { a: 1 } },
      { eval_scores: null },
      { eval_scores: { a: 3 } },
    ]);
    expect(result[0]).toEqual({ dim: 'a', avgScore: 2 });
  });
});

describe('ResearchAutoFix.buildSyntheticFeedback', () => {
  const fix = makeFix();
  type StillFailing = Parameters<
    (typeof fix)['buildSyntheticFeedback' extends keyof typeof fix ? never : 'run']
  >;
  const build = (input: unknown): unknown =>
    (fix as unknown as { buildSyntheticFeedback: (i: unknown) => unknown }).buildSyntheticFeedback(input);

  it('skips responses that are empty after trimming', () => {
    const out = build([
      {
        post: { id: 1, raw_text: 'q', classified_intent: 'food_log', grade_failures: [], eval_scores: null, eval_overall: null, is_covered: null },
        freshResponse: '   ',
        failTypes: ['empty_response'],
      },
    ]) as unknown[];
    expect(out).toHaveLength(0);
  });

  it('assigns rating 1 for empty_response failure', () => {
    const out = build([
      {
        post: { id: 1, raw_text: 'Hello', classified_intent: 'greeting', grade_failures: [], eval_scores: null, eval_overall: null, is_covered: null },
        freshResponse: 'something',
        failTypes: ['empty_response'],
      },
    ]) as Array<{ rating: number }>;
    expect(out[0]?.rating).toBe(1);
  });

  it('assigns rating 1 for 3+ failure types', () => {
    const out = build([
      {
        post: { id: 1, raw_text: 'Q', classified_intent: 'general', grade_failures: [], eval_scores: null, eval_overall: 4, is_covered: true },
        freshResponse: 'bad',
        failTypes: ['a', 'b', 'c'],
      },
    ]) as Array<{ rating: number }>;
    expect(out[0]?.rating).toBe(1);
  });

  it('assigns rating 2 for milder failures', () => {
    const out = build([
      {
        post: { id: 1, raw_text: 'Q', classified_intent: 'general', grade_failures: [], eval_scores: null, eval_overall: 4, is_covered: true },
        freshResponse: 'response',
        failTypes: ['generic_filler'],
      },
    ]) as Array<{ rating: number }>;
    expect(out[0]?.rating).toBe(2);
  });

  it('truncates long user messages and assistant responses to 500 chars', () => {
    const longText = 'x'.repeat(700);
    const out = build([
      {
        post: { id: 1, raw_text: longText, classified_intent: 'general', grade_failures: [], eval_scores: null, eval_overall: 3, is_covered: true },
        freshResponse: longText,
        failTypes: ['banned_phrase'],
      },
    ]) as Array<{ user_message: string; assistant_message: string }>;
    expect(out[0]?.user_message).toHaveLength(500);
    expect(out[0]?.assistant_message).toHaveLength(500);
  });

  it('includes failure types and intent in the comment', () => {
    const out = build([
      {
        post: { id: 1, raw_text: 'how much protein?', classified_intent: 'food_question', grade_failures: [], eval_scores: null, eval_overall: 2.5, is_covered: true },
        freshResponse: 'long generic answer',
        failTypes: ['vague_framing', 'too_long'],
      },
    ]) as Array<{ comment: string }>;
    expect(out[0]?.comment).toContain('vague_framing');
    expect(out[0]?.comment).toContain('food_question');
    expect(out[0]?.comment).toContain('Eval score: 2.5');
  });
});

describe('ResearchAutoFix.runIfMissedRecently', () => {
  it('skips when last run was less than 20 hours ago', async () => {
    const recentMs = (Date.now() - 4 * 3_600_000).toString(); // 4 hours ago
    const redis = {
      get: vi.fn().mockResolvedValue(recentMs),
      set: vi.fn().mockResolvedValue('OK'),
    } as unknown as Redis;
    const fix = makeFix({ redis });
    const runSpy = vi.spyOn(fix, 'run');
    await fix.runIfMissedRecently();
    expect(runSpy).not.toHaveBeenCalled();
    runSpy.mockRestore();
  });

  it('triggers run when last run was more than 20 hours ago', async () => {
    const recentMs = (Date.now() - 22 * 3_600_000).toString(); // 22 hours ago
    const redis = {
      get: vi.fn().mockResolvedValue(recentMs),
      set: vi.fn().mockResolvedValue('OK'),
    } as unknown as Redis;
    const fix = makeFix({ redis });
    const runSpy = vi.spyOn(fix, 'run').mockResolvedValue({
      postsAnalyzed: 0,
      stillFailing: 0,
      alreadyFixed: 0,
      contentRulesGenerated: 0,
      syntheticFeedbackInjected: 0,
      topPatterns: [],
      weakestDimensions: [],
      promptOptimizerKicked: false,
      runAt: new Date().toISOString(),
    });
    await fix.runIfMissedRecently();
    expect(runSpy).toHaveBeenCalledTimes(1);
    runSpy.mockRestore();
  });

  it('triggers run when never executed before', async () => {
    const redis = {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue('OK'),
    } as unknown as Redis;
    const fix = makeFix({ redis });
    const runSpy = vi.spyOn(fix, 'run').mockResolvedValue({
      postsAnalyzed: 0,
      stillFailing: 0,
      alreadyFixed: 0,
      contentRulesGenerated: 0,
      syntheticFeedbackInjected: 0,
      topPatterns: [],
      weakestDimensions: [],
      promptOptimizerKicked: false,
      runAt: new Date().toISOString(),
    });
    await fix.runIfMissedRecently();
    expect(runSpy).toHaveBeenCalledTimes(1);
    runSpy.mockRestore();
  });

  it('survives Redis errors gracefully without throwing', async () => {
    const redis = {
      get: vi.fn().mockRejectedValue(new Error('redis down')),
      set: vi.fn().mockResolvedValue('OK'),
    } as unknown as Redis;
    const fix = makeFix({ redis });
    await expect(fix.runIfMissedRecently()).resolves.not.toThrow();
  });
});

describe('ResearchAutoFix.run — empty corpus + empty feedback', () => {
  it('still produces samples from static GLP-1 FAQ + intent library (self-sufficient loop)', async () => {
    const pool = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
    } as unknown as Pool;
    const redis = {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue('OK'),
    } as unknown as Redis;
    const fix = makeFix({ pool, redis });
    const report = await fix.run({ sampleSize: 10 });
    // The autonomous loop now falls back to FAQ_SEEDS (60 clinically-verified
    // GLP-1 questions) + intents.json so it always has signal even with an
    // empty DB. postsAnalyzed should be > 0.
    expect(report.postsAnalyzed).toBeGreaterThan(0);
    // recordRun() should fire — set called for last_run key
    expect((redis as unknown as { set: ReturnType<typeof vi.fn> }).set).toHaveBeenCalled();
  });

  it('does not record the run in dry-run mode', async () => {
    const pool = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
    } as unknown as Pool;
    const redis = {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue('OK'),
    } as unknown as Redis;
    const fix = makeFix({ pool, redis });
    await fix.run({ sampleSize: 10, dryRun: true });
    expect((redis as unknown as { set: ReturnType<typeof vi.fn> }).set).not.toHaveBeenCalled();
  });
});

describe('ResearchAutoFix.fetchNegativeFeedback', () => {
  it('returns reshaped FailingPosts from feedback rows', async () => {
    const pool = {
      query: vi.fn().mockResolvedValue({
        rows: [
          { id: 'uuid-1', user_message: 'is my protein enough today?', comment: 'this was too generic' },
          { id: 'uuid-2', user_message: 'feeling nauseous', comment: null },
        ],
      }),
    } as unknown as Pool;
    const fix = makeFix({ pool });
    const result = await (fix as unknown as { fetchNegativeFeedback: (n: number) => Promise<unknown[]> }).fetchNegativeFeedback(10);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      raw_text: 'is my protein enough today?',
      eval_overall: 1.5,
      classified_intent: null,
    });
    const firstFailure = (result[0] as { grade_failures: Array<{ type: string }> }).grade_failures[0];
    expect(firstFailure?.type).toBe('user_thumbs_down');
  });

  it('returns empty array when limit is 0', async () => {
    const pool = { query: vi.fn() } as unknown as Pool;
    const fix = makeFix({ pool });
    const result = await (fix as unknown as { fetchNegativeFeedback: (n: number) => Promise<unknown[]> }).fetchNegativeFeedback(0);
    expect(result).toEqual([]);
    expect((pool as unknown as { query: ReturnType<typeof vi.fn> }).query).not.toHaveBeenCalled();
  });

  it('returns empty array on DB error instead of throwing', async () => {
    const pool = {
      query: vi.fn().mockRejectedValue(new Error('pool dead')),
    } as unknown as Pool;
    const fix = makeFix({ pool });
    const result = await (fix as unknown as { fetchNegativeFeedback: (n: number) => Promise<unknown[]> }).fetchNegativeFeedback(10);
    expect(result).toEqual([]);
  });
});
