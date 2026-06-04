-- Production issue capture table — every time a guard fires regen, a safe
-- fallback ships, content gets sanitized at the sender, or a user reacts
-- 👎, we capture the full turn here. The table is the raw feed for the
-- "promote to regression test" workflow.
--
-- Created 2026-06-04 in response to user feedback: "too many fixes and
-- falls — users always reporting problems." Building Layer 4 of the
-- defense-in-depth model.

CREATE TABLE IF NOT EXISTS production_issues (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT NOT NULL,
  conversation_id UUID,
  -- The actual turn
  user_message TEXT NOT NULL,
  grace_response TEXT,
  -- What triggered the capture
  -- 'behavioral_violation' | 'safe_fallback' | 'content_violation_at_sender'
  -- | 'user_thumbs_down' | 'truncation_cascade' | 'topic_drift'
  trigger TEXT NOT NULL,
  -- The specific violation codes / signals
  violation_codes TEXT[],
  -- Free-form snapshot of relevant context (intent, model used, etc.)
  context JSONB,
  -- Workflow state for human review
  -- 'pending' | 'promoted' | 'dismissed' | 'duplicate'
  status TEXT NOT NULL DEFAULT 'pending',
  -- When promoted, which regression scenario it became
  promoted_scenario_id TEXT,
  -- Soft-dedupe key: hash(user_message + trigger). Lets us dedupe
  -- identical issues from the same user in the same window without
  -- blocking distinct issues.
  dedupe_hash TEXT,
  reviewed_by TEXT,
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS production_issues_status_idx ON production_issues (status, created_at DESC);
CREATE INDEX IF NOT EXISTS production_issues_trigger_idx ON production_issues (trigger, created_at DESC);
CREATE INDEX IF NOT EXISTS production_issues_user_idx ON production_issues (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS production_issues_dedupe_idx ON production_issues (dedupe_hash) WHERE dedupe_hash IS NOT NULL;
