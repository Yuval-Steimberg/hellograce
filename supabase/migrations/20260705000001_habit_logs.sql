-- Quick-checkmark daily habit tracking (Feature gap 2).
--
-- A low-friction checklist the user taps on the dashboard OR checks off in chat
-- ("I hit protein and water today"), separate from detailed logging — for users
-- who don't want to log every bite.
--
-- One row per (user, habit, day). A checklist is a per-day TOGGLE, not an append
-- log, so the UNIQUE constraint makes a check idempotent (INSERT … ON CONFLICT
-- DO NOTHING), an uncheck a DELETE, and "today's checklist" a WHERE day = today.
--
-- `day` is the user's LOCAL logging day, computed app-side from their timezone at
-- check time (nutrition/logging-window.computeUserLoggingDay) so it matches the
-- rest of the app. Unlike food/water totals (which derive the day from
-- created_at at read time and must re-bucket on a timezone change), a habit check
-- is a point-in-time "I did this today" that never needs retroactive re-bucketing
-- — so storing the concrete day is both correct and lets us key the toggle.
--
-- Additive, isolated, RLS default-deny (the API uses a direct Postgres connection
-- and bypasses RLS). Every code path reads/writes best-effort, so the feature
-- degrades to empty until this migration is applied — nothing else is affected.

CREATE TABLE IF NOT EXISTS public.habit_logs (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    TEXT NOT NULL,
  habit_key  TEXT NOT NULL,
  day        DATE NOT NULL,
  source     TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, habit_key, day)
);

CREATE INDEX IF NOT EXISTS idx_habit_logs_user_day ON public.habit_logs (user_id, day);

ALTER TABLE public.habit_logs ENABLE ROW LEVEL SECURITY;
