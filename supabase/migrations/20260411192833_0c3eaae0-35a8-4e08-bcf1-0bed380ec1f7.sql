
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS side_effect_flow text DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS side_effect_flow_started_at timestamptz DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS side_effect_followup_sent boolean NOT NULL DEFAULT false;
