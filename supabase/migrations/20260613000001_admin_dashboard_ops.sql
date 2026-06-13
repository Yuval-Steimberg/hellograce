-- Admin dashboard operational control: deep audit logging, Stripe two-way
-- sync state, webhook-event log, internal admin notes, flagged responses.
--
-- Safe to run multiple times (IF NOT EXISTS / ADD COLUMN IF NOT EXISTS).
-- All tables/columns degrade gracefully: code that reads them tolerates
-- their absence (the audit helper already swallows a missing table), so a
-- delayed migration never takes the API down.

-- ─── Stripe sync state cached on the user row ──────────────────────────────
-- The v2 API reads subscription state live from Stripe for the billing
-- snapshot, but we ALSO mirror the canonical IDs + last-known status here so
-- the dashboard can (a) link straight to Stripe without a search round-trip,
-- (b) detect drift (internal is_paid vs Stripe status), and (c) show when the
-- last sync ran and whether it errored.
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS subscription_status TEXT;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS subscription_plan TEXT;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS stripe_synced_at TIMESTAMPTZ;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS stripe_sync_error TEXT;

CREATE INDEX IF NOT EXISTS idx_users_stripe_customer ON public.users (stripe_customer_id);

-- ─── Deep audit log ─────────────────────────────────────────────────────────
-- The base table (id, action, admin_ip, details, created_at) was created in
-- 20260525000001_security_hardening.sql. Add the columns needed for a full
-- before/after audit trail with admin attribution.
ALTER TABLE public.audit_logs ADD COLUMN IF NOT EXISTS actor TEXT;
ALTER TABLE public.audit_logs ADD COLUMN IF NOT EXISTS target_user TEXT;
ALTER TABLE public.audit_logs ADD COLUMN IF NOT EXISTS before JSONB;
ALTER TABLE public.audit_logs ADD COLUMN IF NOT EXISTS after JSONB;
ALTER TABLE public.audit_logs ADD COLUMN IF NOT EXISTS reason TEXT;

CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON public.audit_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_target_user ON public.audit_logs (target_user);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON public.audit_logs (action);

-- ─── Stripe webhook event log ────────────────────────────────────────────────
-- Every webhook delivery is recorded so failures are visible + retryable.
-- stripe_event_id is unique → idempotent processing (a redelivered event is a
-- no-op on insert and can be detected/skipped).
CREATE TABLE IF NOT EXISTS public.stripe_events (
  id BIGSERIAL PRIMARY KEY,
  stripe_event_id TEXT UNIQUE NOT NULL,
  type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',   -- pending | processed | failed | skipped
  target_user TEXT,                          -- phone, when resolvable
  payload JSONB DEFAULT '{}',
  error TEXT,
  attempts INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  processed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_stripe_events_created_at ON public.stripe_events (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_stripe_events_status ON public.stripe_events (status);
CREATE INDEX IF NOT EXISTS idx_stripe_events_type ON public.stripe_events (type);

-- ─── Internal admin notes (per user) ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.admin_notes (
  id BIGSERIAL PRIMARY KEY,
  target_user TEXT NOT NULL,                 -- phone
  author TEXT NOT NULL DEFAULT 'admin',
  note TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_admin_notes_target_user ON public.admin_notes (target_user, created_at DESC);

-- ─── Flagged responses / conversations marked for review ─────────────────────
CREATE TABLE IF NOT EXISTS public.flagged_responses (
  id BIGSERIAL PRIMARY KEY,
  message_id UUID,                           -- messages.id (nullable: can flag a whole convo)
  user_id TEXT NOT NULL,                     -- phone
  reason TEXT NOT NULL,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'open',       -- open | reviewed
  created_by TEXT NOT NULL DEFAULT 'admin',
  resolved_by TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  resolved_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_flagged_responses_status ON public.flagged_responses (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_flagged_responses_user ON public.flagged_responses (user_id);

-- RLS: these tables hold operational/admin data only. The API uses a direct
-- Postgres connection (service role), which bypasses RLS. Enable RLS with a
-- default-deny posture so the Supabase anon key can never read them, matching
-- 20260527000001_enable_rls_all_tables.sql.
ALTER TABLE public.stripe_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.flagged_responses ENABLE ROW LEVEL SECURITY;
