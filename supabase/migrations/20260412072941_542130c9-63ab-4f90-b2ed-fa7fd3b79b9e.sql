ALTER TABLE public.users
ADD COLUMN safety_flag text DEFAULT NULL,
ADD COLUMN safety_flagged_at timestamp with time zone DEFAULT NULL,
ADD COLUMN safety_pause_until timestamp with time zone DEFAULT NULL;