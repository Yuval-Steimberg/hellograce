
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS injection_flow_stage text DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS injection_flow_started_at timestamptz DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS injection_done_at timestamptz DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS injection_count integer NOT NULL DEFAULT 0;
