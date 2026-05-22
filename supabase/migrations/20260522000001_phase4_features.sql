-- Phase 4 features (Critical phase 3 + Mid-tier gaps)
-- Purely additive: new table + new nullable columns. No existing data touched.

-- ─── Behavioral anomaly detection ─────────────────────────────────────────────
-- Nightly job inserts a row per detected anomaly. Surfaced in admin.
CREATE TABLE IF NOT EXISTS user_anomalies (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('mood_drop','logging_silence','weight_spike','side_effect_escalation')),
  severity TEXT NOT NULL DEFAULT 'medium' CHECK (severity IN ('low','medium','high')),
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  resolved BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS user_anomalies_user_id_idx ON user_anomalies(user_id);
CREATE INDEX IF NOT EXISTS user_anomalies_unresolved_idx ON user_anomalies(resolved, created_at DESC) WHERE resolved = FALSE;

-- One unresolved anomaly per (user, kind) at a time — re-firing the same anomaly
-- doesn't multiply rows.
CREATE UNIQUE INDEX IF NOT EXISTS user_anomalies_open_unique
  ON user_anomalies(user_id, kind) WHERE resolved = FALSE;

-- ─── Conversation summary memory ──────────────────────────────────────────────
-- Compact summary regenerated every N turns. Injected into orchestrator context
-- so Grace recalls early-conversation context without re-reading 100 messages.
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS summary TEXT,
  ADD COLUMN IF NOT EXISTS summary_updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS summary_turn_count INT NOT NULL DEFAULT 0;

-- ─── Active topic tracker ─────────────────────────────────────────────────────
-- Per-conversation current topic (food, mood, knowledge, etc.) + when last touched.
-- Auto-decays after silence (computed at read time, never stored as null).
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS active_topic TEXT,
  ADD COLUMN IF NOT EXISTS active_topic_at TIMESTAMPTZ;
