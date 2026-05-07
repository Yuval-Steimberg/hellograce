
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS messages_sent_today integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS messages_sent_today_date date DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS last_midday_sent_at timestamptz DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS last_evening_sent_at timestamptz DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS last_milestone_sent_at timestamptz DEFAULT NULL;
