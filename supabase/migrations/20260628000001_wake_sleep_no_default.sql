-- New users must be ASKED their wake/sleep times — the reminder schedule is
-- per-user and meaningless on a shared default. A non-null default ('07:00' /
-- '22:00') made every new user look like they had already answered, so
-- onboarding skipped the question and reminders fired at a generic time for
-- everyone. Drop the defaults so a fresh row has NULL until the user answers
-- (the scheduler/reminder code already treats NULL as "use a sensible default").
ALTER TABLE public.users ALTER COLUMN wake_time DROP DEFAULT;
ALTER TABLE public.users ALTER COLUMN sleep_time DROP DEFAULT;
