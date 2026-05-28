-- Persistent daily calorie target per user (kcal). Calculated from
-- Mifflin-St Jeor BMR + activity + GLP-1 deficit at onboarding; nightly
-- personalization engine can refresh it as weight/activity change.
-- Nullable: if any input is missing we leave the column null and Grace
-- asks the user for the missing field naturally.
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS calorie_goal_kcal INT;
