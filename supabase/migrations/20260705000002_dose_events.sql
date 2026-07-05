-- Medication / dose timeline (Feature gap 8).
--
-- Today `users.dose_mg` is a single scalar that gets overwritten on a dose
-- change, so no history is kept. This table records one row each time a dose
-- STARTS, which lets us render the "Week 1–4: 2.5mg → Week 5–8: 5mg" timeline and
-- derive weight-change-per-dose and top-symptom-per-dose at read time (from the
-- existing weight_logs + symptom_episodes.dose_mg — no extra columns needed).
--
-- effective_date = the user's local date the dose began. `medication` is a
-- snapshot so a med switch is captured too. UNIQUE(user_id, dose_mg,
-- effective_date) makes recording idempotent.
--
-- Additive, RLS default-deny (API uses direct PG, bypasses RLS). Every read/write
-- is best-effort, so the timeline degrades to "just your current dose" until this
-- migration is applied — nothing else is affected.

CREATE TABLE IF NOT EXISTS public.dose_events (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        TEXT NOT NULL,
  medication     TEXT,
  dose_mg        NUMERIC NOT NULL,
  effective_date DATE NOT NULL,
  source         TEXT,
  note           TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_dose_events_user_date ON public.dose_events (user_id, effective_date);
CREATE UNIQUE INDEX IF NOT EXISTS uq_dose_events_user_dose_date ON public.dose_events (user_id, dose_mg, effective_date);

ALTER TABLE public.dose_events ENABLE ROW LEVEL SECURITY;
