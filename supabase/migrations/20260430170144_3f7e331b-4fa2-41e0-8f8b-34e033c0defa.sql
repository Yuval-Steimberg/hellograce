ALTER TABLE public.users
ADD COLUMN IF NOT EXISTS checkin_frequency text NOT NULL DEFAULT 'normal';

ALTER TABLE public.users
DROP CONSTRAINT IF EXISTS users_checkin_frequency_check;

ALTER TABLE public.users
ADD CONSTRAINT users_checkin_frequency_check
CHECK (checkin_frequency IN ('less', 'normal', 'more'));