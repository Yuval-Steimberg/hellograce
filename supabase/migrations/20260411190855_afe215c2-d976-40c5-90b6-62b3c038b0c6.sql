
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS last_checkin_mode text DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS last_reply_at timestamptz DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS consecutive_no_reply_days integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS paused boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS paused_at timestamptz DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS protein_focus_boost boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS hydration_struggle boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS low_mood_mode boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS midday_skip boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS injection_side_effect_free boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS last_morning_sent_at timestamptz DEFAULT NULL;
