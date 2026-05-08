-- Allow specific users to contribute to RLHF by rating Grace's responses.
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS rlhf_enabled BOOLEAN NOT NULL DEFAULT FALSE;
