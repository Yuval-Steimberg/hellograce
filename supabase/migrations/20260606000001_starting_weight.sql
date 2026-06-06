-- Starting weight column (2026-06-06)
--
-- Added per the coverage audit (Area 8): users.starting_weight was MISSING.
-- Grace must never invent a baseline; with this column she can compute
-- accurate "how much have I lost" responses when set, and gracefully say
-- "I don't have your starting weight on file" when not.
--
-- Nullable, no default, no backfill — every existing row gets NULL. The
-- prompts.ts rule "NEVER invent a starting weight or baseline" handles the
-- null case in chat responses.

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS starting_weight NUMERIC NULL;

COMMENT ON COLUMN public.users.starting_weight IS
  'User-provided baseline weight in lbs at start of GLP-1 journey. Nullable. Grace must NEVER fabricate or infer this value when absent.';
