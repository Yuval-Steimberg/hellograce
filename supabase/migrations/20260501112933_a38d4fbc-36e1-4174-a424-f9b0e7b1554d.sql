ALTER TABLE public.users ADD COLUMN IF NOT EXISTS medication_frequency text DEFAULT 'weekly';
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS medication_time text DEFAULT NULL;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS checkin_count_per_day integer DEFAULT 2;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS checkin_days_interval integer DEFAULT 1;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS injection_day_2 text DEFAULT NULL;