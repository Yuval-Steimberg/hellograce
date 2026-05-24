-- New lifestyle/personalization fields for richer AI context
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS glp1_start_date DATE;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS dose_mg NUMERIC;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS dietary_restriction TEXT;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS biggest_challenge TEXT;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS why_started TEXT;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS support_style TEXT CHECK (support_style IN ('gentle', 'straight_facts', 'tough_love', 'mix'));
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS exercise_habits TEXT;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS cooking_comfort TEXT CHECK (cooking_comfort IN ('dont_cook', 'basic', 'comfortable', 'love_cooking'));
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS daily_water_intake TEXT CHECK (daily_water_intake IN ('less_than_4', '4_to_6', '6_to_8', 'more_than_8'));
