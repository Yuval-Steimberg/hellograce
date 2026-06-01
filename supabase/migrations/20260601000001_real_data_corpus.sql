-- Real-data research corpus (2026-06-01)
-- Stores public-community posts (Reddit, user-uploaded CSVs, etc.) for
-- intent-coverage research. Pipeline: scrape → classify → check coverage
-- → sandbox replay → deterministic grade → LLM-eval failures only.
--
-- Privacy: never store raw usernames — author_hashed = sha256(username).
-- Source: always carries source_url for attribution per Reddit content policy.

CREATE TABLE IF NOT EXISTS real_data_corpus (
  id BIGSERIAL PRIMARY KEY,
  content_hash TEXT UNIQUE NOT NULL,                 -- SHA-256 of normalized text — dedup
  source_type TEXT NOT NULL,                          -- 'reddit' | 'csv_upload' | 'manual'
  source_url TEXT,                                    -- e.g. https://reddit.com/r/Ozempic/comments/...
  source_subreddit TEXT,                              -- 'Ozempic', 'Mounjaro', 'GLP1', ...
  source_score INT,                                   -- Reddit upvote count (signal strength)
  source_comment_count INT,                           -- engagement signal
  author_hashed TEXT,                                 -- sha256(username) — never plaintext
  scraped_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  raw_text TEXT NOT NULL,                             -- title + selftext combined
  -- Deterministic classification (no LLM)
  classified_intent TEXT,                             -- MessageType from classify.ts
  intent_id_match TEXT,                               -- nearest intent.id, or NULL when uncovered
  is_covered BOOLEAN,                                 -- TRUE when intent_id_match is non-null
  -- Replay + grading (populated by background job)
  grace_response TEXT,
  grace_response_intent TEXT,                         -- what the orchestrator returned
  grade_passed BOOLEAN,
  grade_failures JSONB,                               -- [{type, detail}]
  replay_latency_ms INT,
  replay_at TIMESTAMPTZ,
  -- LLM evaluation — only when grade_passed = FALSE OR is_covered = FALSE
  eval_scores JSONB,                                  -- {empathy: 4.0, tone_match: 3.5, ...}
  eval_overall NUMERIC(3,1),
  eval_weaknesses TEXT[],
  eval_at TIMESTAMPTZ,
  -- Admin review
  admin_status TEXT DEFAULT 'pending'                 -- 'pending' | 'reviewed' | 'promoted_to_intent' | 'rejected'
    CHECK (admin_status IN ('pending', 'reviewed', 'promoted_to_intent', 'rejected')),
  reviewed_by TEXT,
  reviewed_at TIMESTAMPTZ,
  notes TEXT
);

CREATE INDEX IF NOT EXISTS real_data_intent
  ON real_data_corpus (classified_intent, is_covered);
CREATE INDEX IF NOT EXISTS real_data_status
  ON real_data_corpus (admin_status);
CREATE INDEX IF NOT EXISTS real_data_subreddit
  ON real_data_corpus (source_subreddit);
CREATE INDEX IF NOT EXISTS real_data_scraped_at
  ON real_data_corpus (scraped_at DESC);
CREATE INDEX IF NOT EXISTS real_data_uncovered
  ON real_data_corpus (is_covered, classified_intent)
  WHERE is_covered = FALSE;

COMMENT ON TABLE real_data_corpus IS
  'Public-community posts scraped for intent-coverage research. See /admin/research.';
