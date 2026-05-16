-- Phase 10: minimal onboarding — add `sex` to users for protein-target accuracy.
-- Optional column (NULL = "not specified"). Used by the personalization engine
-- and by Grace when discussing nutrition. Free-text rather than enum so we
-- support male / female / non-binary / prefer-not-to-say without future migrations.
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS sex TEXT;
