import { describe, it, expect } from 'vitest';
import { scrapedPostToIngestInput } from './corpus.service.js';
import type { ScrapedPost } from './reddit-scraper.js';

describe('scrapedPostToIngestInput', () => {
  it('maps a ScrapedPost to the corpus IngestPostInput shape', () => {
    const post: ScrapedPost = {
      post_id: 'abc123',
      raw_text: 'Anyone else feeling nauseous?\nI started Ozempic last week.',
      author_hashed: 'a'.repeat(64),
      score: 145,
      num_comments: 38,
      permalink: 'https://reddit.com/r/Ozempic/comments/abc123/',
      subreddit: 'ozempic',
      created_utc: 1717238400,
      content_hash: 'c'.repeat(64),
    };
    const input = scrapedPostToIngestInput(post);
    expect(input.source_type).toBe('reddit');
    expect(input.source_url).toBe('https://reddit.com/r/Ozempic/comments/abc123/');
    expect(input.source_subreddit).toBe('ozempic');
    expect(input.source_score).toBe(145);
    expect(input.source_comment_count).toBe(38);
    expect(input.author_hashed).toBe('a'.repeat(64));
    expect(input.content_hash).toBe('c'.repeat(64));
    expect(input.raw_text).toContain('nauseous');
  });
});

// The full pipeline (ingest / classify / replay / evaluate) is tested
// integration-style against the admin endpoint with the live orchestrator.
// The pure-function pieces above + the smoke endpoint test on the admin
// page are sufficient unit coverage.
