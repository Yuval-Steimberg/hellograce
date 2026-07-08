-- Food-tracker ideas (2026-07-08): store the portion phrase per logged item so
-- edits / re-asks and awareness reads have the amount, not just the food name.
-- `confidence` already exists (added in the v2 core schema); this adds the
-- serving_size companion. Additive + nullable — old rows and every existing
-- read path are unaffected.
ALTER TABLE public.food_logs
  ADD COLUMN IF NOT EXISTS serving_size TEXT;
