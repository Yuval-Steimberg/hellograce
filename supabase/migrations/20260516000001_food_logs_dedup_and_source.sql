-- Phase 10: protein-tracking integrity
-- 1) Add `source` so we can track whether a log came from text/image/voice.
-- 2) Add `dedupe_key` so retries and re-analysis can't double-count meals.
-- 3) Index supporting fast user-local-day queries.

ALTER TABLE public.food_logs
  ADD COLUMN IF NOT EXISTS source TEXT,
  ADD COLUMN IF NOT EXISTS dedupe_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS food_logs_user_dedupe_idx
  ON public.food_logs (user_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL;
