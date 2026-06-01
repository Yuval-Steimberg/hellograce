import { describe, it, expect } from 'vitest';
import { scrapeSubreddit, scrapeMultiple, DEFAULT_SUBREDDITS } from './reddit-scraper.js';

/** Build a stub fetcher that returns a canned Reddit JSON listing. */
function stubFetcher(listing: Record<string, unknown>, status = 200): typeof fetch {
  return async () =>
    ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => listing,
    }) as Response;
}

const VALID_POST = {
  data: {
    name: 't3_abc123',
    id: 'abc123',
    title: 'Anyone else feeling nauseous after their shot?',
    selftext: 'I started Ozempic last week and the nausea is rough. Anyone else?',
    author: 'sarahuser42',
    score: 145,
    num_comments: 38,
    permalink: '/r/Ozempic/comments/abc123/anyone_else_feeling_nauseous/',
    subreddit: 'Ozempic',
    created_utc: 1717238400,
    over_18: false,
    stickied: false,
    is_self: true,
  },
};

describe('scrapeSubreddit', () => {
  it('parses a valid post with all fields', async () => {
    const fetcher = stubFetcher({ data: { children: [VALID_POST] } });
    const posts = await scrapeSubreddit('Ozempic', { fetcher });
    expect(posts).toHaveLength(1);
    const p = posts[0]!;
    expect(p.post_id).toBe('abc123');
    expect(p.raw_text).toContain('feeling nauseous');
    expect(p.raw_text).toContain('Ozempic last week');
    expect(p.score).toBe(145);
    expect(p.num_comments).toBe(38);
    expect(p.subreddit).toBe('ozempic');
    expect(p.permalink).toBe('https://reddit.com/r/Ozempic/comments/abc123/anyone_else_feeling_nauseous/');
    expect(p.author_hashed).toMatch(/^[a-f0-9]{64}$/);
    expect(p.author_hashed).not.toBe('sarahuser42'); // hashed, never raw
    expect(p.content_hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('filters NSFW posts', async () => {
    const nsfw = { data: { ...VALID_POST.data, over_18: true } };
    const fetcher = stubFetcher({ data: { children: [nsfw] } });
    const posts = await scrapeSubreddit('Ozempic', { fetcher });
    expect(posts).toHaveLength(0);
  });

  it('filters stickied posts (mod announcements)', async () => {
    const stickied = { data: { ...VALID_POST.data, stickied: true } };
    const fetcher = stubFetcher({ data: { children: [stickied] } });
    expect(await scrapeSubreddit('Ozempic', { fetcher })).toHaveLength(0);
  });

  it('filters removed/deleted posts', async () => {
    const removed = { data: { ...VALID_POST.data, removed_by_category: 'moderator' } };
    const deletedText = { data: { ...VALID_POST.data, selftext: '[deleted]' } };
    const removedText = { data: { ...VALID_POST.data, selftext: '[removed]' } };
    for (const c of [removed, deletedText, removedText]) {
      const fetcher = stubFetcher({ data: { children: [c] } });
      expect(await scrapeSubreddit('Ozempic', { fetcher })).toHaveLength(0);
    }
  });

  it('filters link-only posts (is_self=false)', async () => {
    const linkPost = { data: { ...VALID_POST.data, is_self: false } };
    const fetcher = stubFetcher({ data: { children: [linkPost] } });
    expect(await scrapeSubreddit('Ozempic', { fetcher })).toHaveLength(0);
  });

  it('filters posts with too-short text (< 50 chars)', async () => {
    const tiny = { data: { ...VALID_POST.data, title: 'help', selftext: '' } };
    const fetcher = stubFetcher({ data: { children: [tiny] } });
    expect(await scrapeSubreddit('Ozempic', { fetcher })).toHaveLength(0);
  });

  it('filters posts with deleted author', async () => {
    const deletedAuthor = { data: { ...VALID_POST.data, author: '[deleted]' } };
    const fetcher = stubFetcher({ data: { children: [deletedAuthor] } });
    expect(await scrapeSubreddit('Ozempic', { fetcher })).toHaveLength(0);
  });

  it('hashes author identically for the same username (dedup signal)', async () => {
    const fetcher = stubFetcher({ data: { children: [VALID_POST, VALID_POST] } });
    const posts = await scrapeSubreddit('Ozempic', { fetcher });
    expect(posts).toHaveLength(2);
    expect(posts[0]!.author_hashed).toBe(posts[1]!.author_hashed);
  });

  it('computes content_hash deterministically (idempotent inserts)', async () => {
    const fetcher = stubFetcher({ data: { children: [VALID_POST] } });
    const first = await scrapeSubreddit('Ozempic', { fetcher });
    const second = await scrapeSubreddit('Ozempic', { fetcher: stubFetcher({ data: { children: [VALID_POST] } }) });
    expect(first[0]!.content_hash).toBe(second[0]!.content_hash);
  });

  it('strips "r/" prefix from subreddit name', async () => {
    let calledUrl = '';
    const fetcher = (async (url: string) => {
      calledUrl = url;
      return { ok: true, status: 200, json: async () => ({ data: { children: [] } }) } as Response;
    }) as typeof fetch;
    await scrapeSubreddit('r/Ozempic', { fetcher });
    expect(calledUrl).toContain('/r/Ozempic/');
    expect(calledUrl).not.toContain('/r/r%2FOzempic/');
  });

  it('uses the configured sort and time window', async () => {
    let calledUrl = '';
    const fetcher = (async (url: string) => {
      calledUrl = url;
      return { ok: true, status: 200, json: async () => ({ data: { children: [] } }) } as Response;
    }) as typeof fetch;
    await scrapeSubreddit('Ozempic', { fetcher, sort: 'top', time: 'month', limit: 25 });
    expect(calledUrl).toContain('/top.json');
    expect(calledUrl).toContain('t=month');
    expect(calledUrl).toContain('limit=25');
  });

  it('caps limit at 100 (Reddit API limit)', async () => {
    let calledUrl = '';
    const fetcher = (async (url: string) => {
      calledUrl = url;
      return { ok: true, status: 200, json: async () => ({ data: { children: [] } }) } as Response;
    }) as typeof fetch;
    await scrapeSubreddit('Ozempic', { fetcher, limit: 1000 });
    expect(calledUrl).toContain('limit=100');
  });

  it('throws on non-2xx HTTP status', async () => {
    const fetcher = stubFetcher({}, 403);
    await expect(scrapeSubreddit('Ozempic', { fetcher })).rejects.toThrow(/HTTP 403/);
  });

  it('returns empty array on empty listing', async () => {
    const fetcher = stubFetcher({ data: { children: [] } });
    expect(await scrapeSubreddit('Ozempic', { fetcher })).toEqual([]);
  });
});

describe('scrapeMultiple', () => {
  it('aggregates results from multiple subreddits', async () => {
    const fetcher = stubFetcher({ data: { children: [VALID_POST] } });
    const results = await scrapeMultiple(['Ozempic', 'Mounjaro'], { fetcher, delayMs: 0 });
    expect(results).toHaveLength(2);
    expect(results[0]!.subreddit).toBe('Ozempic');
    expect(results[0]!.posts).toHaveLength(1);
    expect(results[1]!.subreddit).toBe('Mounjaro');
    expect(results[1]!.posts).toHaveLength(1);
  });

  it('captures per-subreddit errors without failing the whole batch', async () => {
    let call = 0;
    const fetcher = (async (_url: string) => {
      call++;
      if (call === 1) {
        return { ok: false, status: 503, json: async () => ({}) } as Response;
      }
      return { ok: true, status: 200, json: async () => ({ data: { children: [VALID_POST] } }) } as Response;
    }) as typeof fetch;
    const results = await scrapeMultiple(['Ozempic', 'Mounjaro'], { fetcher, delayMs: 0 });
    expect(results[0]!.error).toMatch(/HTTP 503/);
    expect(results[1]!.posts).toHaveLength(1);
  });
});

describe('DEFAULT_SUBREDDITS', () => {
  it('includes the major GLP-1 communities', () => {
    expect(DEFAULT_SUBREDDITS).toContain('Ozempic');
    expect(DEFAULT_SUBREDDITS).toContain('Mounjaro');
    expect(DEFAULT_SUBREDDITS).toContain('GLP1');
    expect(DEFAULT_SUBREDDITS.length).toBeGreaterThanOrEqual(6);
  });
});
