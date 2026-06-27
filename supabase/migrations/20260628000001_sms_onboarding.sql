-- Conversational SMS/WhatsApp onboarding state (2026-06-28)
--
-- Adds the minimal state needed to onboard a user entirely over chat instead of
-- the web form. The flow is ADDITIVE and gated behind SMS_ONBOARDING_ENABLED on
-- the API — with the flag off, these columns stay null and behavior is unchanged.
--
--   onboarding_state      null = never started (web-onboarded / pre-feature),
--                         'in_progress' = mid SMS onboarding,
--                         'complete' = finished.
--   onboarding_last_slot  the field Grace last asked for, so the next inbound
--                         reply is parsed into the correct slot (resilient to
--                         restarts / cold isolates — no in-memory step state).
--   onboarding_started_at when the SMS flow began (analytics / abandonment).
--
-- All columns are nullable with no default change to existing rows, so this is a
-- safe online migration: already-onboarded users are unaffected (their
-- onboarding_state stays null and the webhook treats null + a started trial as
-- "registered", never re-onboarding them).

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS onboarding_state TEXT,
  ADD COLUMN IF NOT EXISTS onboarding_last_slot TEXT,
  ADD COLUMN IF NOT EXISTS onboarding_started_at TIMESTAMPTZ;

-- Partial index for the (rare) lookups of users actively mid-onboarding.
CREATE INDEX IF NOT EXISTS users_onboarding_in_progress_idx
  ON public.users (onboarding_state)
  WHERE onboarding_state = 'in_progress';
