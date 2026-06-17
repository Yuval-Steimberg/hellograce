-- Per-user delivery channel for proactive/outbound messages (multi-channel,
-- 2026-06-17). 'whatsapp' (default, unchanged behavior) | 'sms' | 'imessage'.
-- Inbound replies always go back on the channel the message arrived on; this
-- column only drives PROACTIVE sends (scheduler, admin manual send).
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'whatsapp';

-- Guardrail: only the three supported channels.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_channel_check'
  ) THEN
    ALTER TABLE public.users
      ADD CONSTRAINT users_channel_check
      CHECK (channel IN ('whatsapp', 'sms', 'imessage'));
  END IF;
END $$;
