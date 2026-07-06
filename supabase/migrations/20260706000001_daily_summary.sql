-- Nightly daily-summary feature — per-user opt-out flag (2026-07-06)
--
-- The nightly end-of-day recap is a SEPARATE system from reminders: it runs in
-- its own scheduler pass, uses its own Redis dedup lock (daily_summary:{phone}:{date}),
-- and records into check_ins with type = 'daily_summary' (the check_ins.type CHECK
-- constraint was dropped in 20260413170506, so no constraint change is needed).
--
-- This migration adds ONLY the per-user opt-out toggle. The master rollout gate is
-- the DAILY_SUMMARY_ENABLED env flag (default off), so the feature stays dark until
-- deliberately enabled. This column defaults TRUE so that, once the env flag is on,
-- every eligible (active, not paused, not blocked, onboarded) user receives the
-- summary unless they are individually opted out.
--
-- Additive + idempotent. Existing rows get TRUE. No backfill needed. Pre-migration
-- the job reads the column as undefined and treats it as enabled, and the env gate
-- is off regardless, so applying this before or after the code deploy is safe.

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS daily_summary_enabled BOOLEAN NOT NULL DEFAULT TRUE;

COMMENT ON COLUMN public.users.daily_summary_enabled IS
  'Per-user opt-out for the nightly end-of-day summary. Default TRUE. Gated globally by the DAILY_SUMMARY_ENABLED env flag. Separate from the reminder system.';
