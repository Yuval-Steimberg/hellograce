-- Post-trial win-back sequence state (spec: Post_Trial_Winback.mmd).
-- Additive + dark-launchable: the scheduler pass no-ops until POST_TRIAL_WINBACK_ENABLED=true,
-- and the code treats a NULL/absent winback_stage as 0, so this migration is safe
-- to apply before or after the deploy.
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS winback_stage SMALLINT NOT NULL DEFAULT 0;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS winback_last_sent_at TIMESTAMPTZ;

-- Cheap lookup for the win-back tick: expired-trial, unpaid, not-yet-complete users.
CREATE INDEX IF NOT EXISTS idx_users_winback
  ON public.users (winback_stage)
  WHERE winback_stage < 5;
