-- Add nutrition profile fields for Mifflin-St Jeor calorie estimation.
-- sex and height_cm already exist from earlier migrations (20260516000002,
-- 20260513000002). Only activity_level is new.
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS activity_level TEXT
    CHECK (activity_level IN ('sedentary', 'lightly_active', 'moderate', 'very_active'));
