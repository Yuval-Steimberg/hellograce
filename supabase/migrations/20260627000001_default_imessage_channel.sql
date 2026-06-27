-- Make iMessage the system-wide primary delivery channel (2026-06-27).
--
-- Decision: Grace delivers iMessage-first, with WhatsApp/SMS as automatic
-- fallback (ChannelRouter falls back when iMessage is unconfigured OR a send
-- fails). This (a) flips the column default to 'imessage' for new users and
-- (b) migrates every existing user to 'imessage'.
--
-- Inbound replies still go back on the channel the message arrived on, and the
-- webhook auto-aligns users.channel to the transport they actually use — so a
-- WhatsApp/Android user who messages in is re-aligned to 'whatsapp' on their
-- next inbound. This migration sets the proactive default; the router + inbound
-- alignment keep non-iMessage users reachable.

ALTER TABLE public.users
  ALTER COLUMN channel SET DEFAULT 'imessage';

-- Migrate everyone now (per the rollout decision). Proactive sends to a user
-- who isn't actually reachable on iMessage fall back to WhatsApp via the router.
UPDATE public.users
  SET channel = 'imessage'
  WHERE channel IS DISTINCT FROM 'imessage';
