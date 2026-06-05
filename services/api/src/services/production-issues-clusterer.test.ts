import { describe, it, expect, vi } from 'vitest';
import { ProductionIssuesClusterer, __testing } from './production-issues-clusterer.js';

const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as never;

describe('ProductionIssuesClusterer — token + similarity helpers', () => {
  const { tokenize, jaccard } = __testing;

  it('tokenize drops stop words and short tokens', () => {
    const t = tokenize("What's my injection day today?");
    expect(t.has('injection')).toBe(true);
    expect(t.has('day')).toBe(true);
    // stopwords + short
    expect(t.has('my')).toBe(false);
    expect(t.has('the')).toBe(false);
    expect(t.has('to')).toBe(false);
  });

  it('jaccard returns 1 for identical sets', () => {
    const a = tokenize('What is my injection day');
    const b = tokenize('What is my injection day');
    expect(jaccard(a, b)).toBe(1);
  });

  it('jaccard returns 0 for disjoint sets', () => {
    const a = tokenize('chicken rice beans');
    const b = tokenize('vacation flight hotel');
    expect(jaccard(a, b)).toBe(0);
  });

  it('jaccard catches near-duplicate user messages', () => {
    const a = tokenize('What is my injection day');
    const b = tokenize('What was my injection day today');
    expect(jaccard(a, b)).toBeGreaterThan(0.35);
  });

  it('jaccard separates semantically different messages', () => {
    const a = tokenize('What is my injection day');
    const b = tokenize('I had pizza for lunch');
    expect(jaccard(a, b)).toBeLessThan(0.35);
  });
});

describe('ProductionIssuesClusterer — clustering behavior', () => {
  function mockPool(rows: Array<{
    id: number;
    user_message: string;
    grace_response: string | null;
    trigger: string;
    violation_codes: string[] | null;
    context: Record<string, unknown> | null;
    created_at: Date;
    user_id?: string;
  }>): { query: ReturnType<typeof vi.fn> } {
    return {
      query: vi.fn().mockResolvedValue({ rows: rows.map((r) => ({ user_id: 'u1', ...r })), rowCount: rows.length }),
    };
  }

  it('groups three similar messages into one cluster', async () => {
    const now = new Date();
    const pool = mockPool([
      { id: 1, user_message: 'What is my injection day', grace_response: 'muscle loss facts', trigger: 'safe_fallback', violation_codes: ['banned_phrase'], context: {}, created_at: now },
      { id: 2, user_message: 'When is my injection day', grace_response: 'muscle loss facts', trigger: 'safe_fallback', violation_codes: ['banned_phrase'], context: {}, created_at: now },
      { id: 3, user_message: 'Whats my injection day again', grace_response: 'random GLP-1 fact', trigger: 'safe_fallback', violation_codes: ['banned_phrase'], context: {}, created_at: now },
      // A distinct cluster
      { id: 4, user_message: 'I had pizza for lunch', grace_response: 'Logged', trigger: 'topic_drift', violation_codes: ['topic_drift'], context: {}, created_at: now },
    ]);
    const c = new ProductionIssuesClusterer(pool as never, noopLogger);
    const result = await c.cluster({ minClusterSize: 1, similarityThreshold: 0.3 });
    expect(result.length).toBeGreaterThanOrEqual(2);
    // Largest cluster should have the 3 injection-day messages.
    expect(result[0]!.count).toBe(3);
    expect(result[0]!.sample_messages.some((m) => m.includes('injection day'))).toBe(true);
  });

  it('produces a suggested_pattern when ≥2 common keywords exist', async () => {
    const now = new Date();
    const pool = mockPool([
      { id: 10, user_message: 'What is my injection day', grace_response: 'x', trigger: 'safe_fallback', violation_codes: [], context: {}, created_at: now },
      { id: 11, user_message: 'When is my injection day', grace_response: 'x', trigger: 'safe_fallback', violation_codes: [], context: {}, created_at: now },
      { id: 12, user_message: 'Tell me my injection day', grace_response: 'x', trigger: 'safe_fallback', violation_codes: [], context: {}, created_at: now },
    ]);
    const c = new ProductionIssuesClusterer(pool as never, noopLogger);
    const result = await c.cluster({ minClusterSize: 1, similarityThreshold: 0.3 });
    expect(result[0]!.suggested_pattern).not.toBeNull();
    expect(result[0]!.suggested_pattern).toContain('injection');
    expect(result[0]!.common_keywords).toContain('injection');
    expect(result[0]!.common_keywords).toContain('day');
  });

  it('returns empty array when there are no pending issues', async () => {
    const pool = mockPool([]);
    const c = new ProductionIssuesClusterer(pool as never, noopLogger);
    const result = await c.cluster();
    expect(result).toEqual([]);
  });

  it('filters out singleton clusters by default (minClusterSize=2)', async () => {
    const now = new Date();
    const pool = mockPool([
      { id: 1, user_message: 'completely unique message about asparagus', grace_response: null, trigger: 'safe_fallback', violation_codes: [], context: {}, created_at: now },
      { id: 2, user_message: 'totally different about tax filings', grace_response: null, trigger: 'safe_fallback', violation_codes: [], context: {}, created_at: now },
    ]);
    const c = new ProductionIssuesClusterer(pool as never, noopLogger);
    const result = await c.cluster();
    expect(result).toEqual([]);
  });
});
