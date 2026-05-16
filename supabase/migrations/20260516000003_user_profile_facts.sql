-- Phase 10: progressive profiling — durable facts learned through conversation.
--
-- The master prompt instructs Grace to remember things users mention naturally
-- ("I'm vegetarian", "I work night shifts", "protein shakes make me nauseous").
-- Recent 12-message history alone isn't enough — facts must persist across
-- sessions. A background worker extracts them from each user message and
-- writes here; buildPersonalisedPrompt reads them into the system prompt.

CREATE TABLE IF NOT EXISTS public.user_profile_facts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  fact TEXT NOT NULL,
  -- Loose category — used for grouping when surfaced to Grace.
  -- 'diet' | 'schedule' | 'aversion' | 'preference' | 'exercise' |
  -- 'symptom' | 'social' | 'other'
  category TEXT NOT NULL DEFAULT 'other',
  confidence TEXT NOT NULL DEFAULT 'medium',
  source_message_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS user_profile_facts_user_idx
  ON public.user_profile_facts (user_id, created_at DESC);

-- Dedupe: same user + same fact text (case-insensitive) → one row.
-- Lets ON CONFLICT DO NOTHING work for re-extracted facts.
CREATE UNIQUE INDEX IF NOT EXISTS user_profile_facts_dedupe_idx
  ON public.user_profile_facts (user_id, lower(fact));
