-- OTP verification codes used by /upgrade and /signin phone+email login flows.
-- Stores both phone numbers and email addresses in the `phone` column (legacy name).
CREATE TABLE IF NOT EXISTS public.verification_codes (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone        TEXT NOT NULL,
  code         TEXT NOT NULL,
  used         BOOLEAN NOT NULL DEFAULT FALSE,
  expires_at   TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '10 minutes'),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS verification_codes_phone_idx
  ON public.verification_codes (phone, used, expires_at DESC);

-- Edge functions use service role key — RLS not strictly needed, but enable for safety.
ALTER TABLE public.verification_codes ENABLE ROW LEVEL SECURITY;
