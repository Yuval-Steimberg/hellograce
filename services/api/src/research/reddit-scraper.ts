/**
 * Reddit JSON scraper — pulls public top-level posts from a subreddit for
 * intent-coverage research. Uses the unauthenticated old.reddit.com JSON
 * endpoint which works without API credentials but is rate-limited to
 * ~60 req/min per IP. Daily scrape of ~10 subs is well under that ceiling.
 *
 * Privacy: usernames are SHA-256 hashed before persistence. Source URLs
 * are kept for attribution per Reddit's content policy.
 *
 * Scope (v1): top-level posts only. Comment threads multiply data 10-50x
 * and are deferred.
 */

import { createHash } from 'node:crypto';

export interface ScrapedPost {
  /** Reddit's stable post ID (e.g. 't3_abc123' → we strip the prefix). */
  post_id: string;
  /** Title combined with selftext for analysis (newline-separated). */
  raw_text: string;
  /** SHA-256(username) — we never store raw usernames. */
  author_hashed: string;
  /** Upvote count — signal strength for prioritizing review. */
  score: number;
  /** Comment count — engagement signal. */
  num_comments: number;
  /** Permalink URL like https://reddit.com/r/Ozempic/comments/abc123/... */
  permalink: string;
  /** Lowercase subreddit name (no leading `r/`). */
  subreddit: string;
  /** Epoch seconds (Reddit's `created_utc`). */
  created_utc: number;
  /** SHA-256(raw_text) used by the corpus service for idempotent inserts. */
  content_hash: string;
}

export type SortMode = 'top' | 'new' | 'hot';
export type TimeWindow = 'hour' | 'day' | 'week' | 'month' | 'year' | 'all';

export interface ScrapeOpts {
  /** Max posts to fetch (Reddit caps at 100). Default 50. */
  limit?: number;
  /** Sort order (default 'top' for highest-signal posts). */
  sort?: SortMode;
  /** Time window when sort='top' (default 'week'). Ignored for 'new'/'hot'. */
  time?: TimeWindow;
  /** Override the fetch implementation — used by tests to stub HTTP. */
  fetcher?: typeof fetch;
}

// Try both bases — old.reddit.com is sometimes blocked when www.reddit.com
// (which now serves the JSON behind a CDN) still works. We attempt www first.
const REDDIT_BASES = ['https://www.reddit.com', 'https://old.reddit.com'] as const;
// Reddit started returning 403 to anything that LOOKS like a bot in mid-2023,
// especially from datacenter IPs (Fly.io, AWS, GCP). A plain Chrome UA gets
// through far more reliably than a custom bot identifier.
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const FETCH_TIMEOUT_MS = 12_000;
// Drop posts with raw_text shorter than this — usually link-only posts that
// don't carry analytical signal.
const MIN_TEXT_LENGTH = 50;

interface RedditApiPost {
  data?: {
    name?: string;
    id?: string;
    title?: string;
    selftext?: string;
    author?: string;
    score?: number;
    num_comments?: number;
    permalink?: string;
    subreddit?: string;
    created_utc?: number;
    over_18?: boolean;
    stickied?: boolean;
    removed_by_category?: string | null;
    is_self?: boolean;
  };
}

interface RedditApiListing {
  data?: {
    children?: RedditApiPost[];
  };
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function normalizeForHash(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Fetch with timeout. Native fetch + AbortController.
 * Throws on network error or non-2xx status. Reads a small body snippet on
 * non-2xx so the caller can see WHAT Reddit returned (HTML block page, JSON
 * error, etc.) — silent 0-row results were impossible to diagnose otherwise.
 */
async function fetchWithTimeout(
  url: string,
  opts: { fetcher?: typeof fetch } = {},
): Promise<unknown> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  const fn = opts.fetcher ?? fetch;
  try {
    const res = await fn(url, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/json,text/html;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: ac.signal,
      redirect: 'follow',
    });
    if (!res.ok) {
      let snippet = '';
      if (typeof res.text === 'function') {
        snippet = await res.text().then((t) => t.slice(0, 160)).catch(() => '');
      }
      throw new Error(`HTTP ${res.status} ${res.statusText ?? ''} — ${snippet}`.trim());
    }
    // Prefer text() so we can detect HTML "blocked" pages (200 + non-JSON body),
    // but tests stub only json() so fall back when text() isn't on the response.
    if (typeof res.text === 'function') {
      const text = await res.text();
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new Error(`non-JSON response (${text.length} bytes): ${text.slice(0, 120)}`);
      }
    }
    return (await res.json()) as unknown;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Pull top-level posts from a public subreddit.
 * @throws on network/HTTP failure — caller decides whether to retry.
 */
export async function scrapeSubreddit(
  subreddit: string,
  opts: ScrapeOpts = {},
): Promise<ScrapedPost[]> {
  const limit = Math.max(1, Math.min(100, opts.limit ?? 50));
  const sort = opts.sort ?? 'top';
  const time = opts.time ?? 'week';
  const cleanSub = subreddit.replace(/^r\//i, '').trim();
  if (!cleanSub) throw new Error('subreddit name required');

  const params = new URLSearchParams({ limit: String(limit) });
  if (sort === 'top') params.set('t', time);
  const path = `/r/${encodeURIComponent(cleanSub)}/${sort}.json?${params.toString()}`;

  // Try www.reddit.com first, fall back to old.reddit.com. Some IPs are
  // blocked on one but not the other.
  let raw: unknown = null;
  const errors: string[] = [];
  for (const base of REDDIT_BASES) {
    try {
      raw = await fetchWithTimeout(base + path, { fetcher: opts.fetcher });
      break;
    } catch (err) {
      errors.push(`${base}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (raw === null) {
    throw new Error(`all Reddit endpoints failed: ${errors.join(' | ')}`);
  }
  const listing = raw as RedditApiListing;
  const children = listing.data?.children ?? [];

  return children
    .map((c) => parsePost(c, cleanSub))
    .filter((p): p is ScrapedPost => p !== null);
}

function parsePost(item: RedditApiPost, subredditFallback: string): ScrapedPost | null {
  const d = item.data;
  if (!d) return null;
  // Skip deleted/removed/stickied content
  if (d.removed_by_category) return null;
  if (d.over_18) return null;
  if (d.stickied) return null;
  // Skip link-only posts (they carry no analytical text)
  if (d.is_self === false) return null;

  const title = (d.title ?? '').trim();
  const selftext = (d.selftext ?? '').trim();
  const raw = `${title}\n${selftext}`.trim();
  if (raw.length < MIN_TEXT_LENGTH) return null;
  if (selftext === '[deleted]' || selftext === '[removed]') return null;

  const author = (d.author ?? '').trim();
  if (!author || author === '[deleted]') return null;

  const permalink = d.permalink
    ? `https://reddit.com${d.permalink}`
    : '';

  return {
    post_id: d.id ?? d.name ?? '',
    raw_text: raw,
    author_hashed: sha256(author),
    score: typeof d.score === 'number' ? d.score : 0,
    num_comments: typeof d.num_comments === 'number' ? d.num_comments : 0,
    permalink,
    subreddit: (d.subreddit ?? subredditFallback).toLowerCase(),
    created_utc: typeof d.created_utc === 'number' ? d.created_utc : 0,
    content_hash: sha256(normalizeForHash(raw)),
  };
}

/**
 * Convenience: scrape multiple subreddits sequentially with a brief delay
 * between calls (to stay well under Reddit's rate limit).
 */
export async function scrapeMultiple(
  subreddits: string[],
  opts: ScrapeOpts & { delayMs?: number } = {},
): Promise<{ subreddit: string; posts: ScrapedPost[]; error?: string }[]> {
  const delay = opts.delayMs ?? 1_500;
  const out: { subreddit: string; posts: ScrapedPost[]; error?: string }[] = [];
  for (let i = 0; i < subreddits.length; i++) {
    const sub = subreddits[i]!;
    try {
      const posts = await scrapeSubreddit(sub, opts);
      out.push({ subreddit: sub, posts });
    } catch (err) {
      out.push({
        subreddit: sub,
        posts: [],
        error: err instanceof Error ? err.message : String(err),
      });
    }
    if (i < subreddits.length - 1 && delay > 0) {
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  return out;
}

/** Default subreddit list — overridable via the corpus.service config. */
export const DEFAULT_SUBREDDITS: readonly string[] = [
  'Ozempic',
  'Mounjaro',
  'Zepbound',
  'WegovyWeightLoss',
  'Semaglutide',
  'GLP1',
  'loseit',
  'WeightLossAdvice',
];
