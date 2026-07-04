-- Admin group-messaging (campaigns) — purely additive, admin-only.
--
-- Why this migration exists: the admin dashboard can send a message to a whole
-- cohort of users (onboarding-stuck, trial-ending, inactive, …). The messaging
-- safety requirements are: a durable history of who sent what to which group,
-- per-recipient delivery status, duplicate-send prevention within a campaign,
-- and an audit trail. None of that can live in the existing `messages` table
-- (which is the conversation log). These two tables add it without touching any
-- existing table or the user-facing pipeline.
--
-- Nothing in the reply/scheduler/webhook path reads these tables. The admin API
-- degrades gracefully if this migration hasn't been applied (every read/write is
-- best-effort, matching admin_notes / flagged_responses).

-- ─── Campaigns ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.admin_campaigns (
  id BIGSERIAL PRIMARY KEY,
  actor TEXT NOT NULL DEFAULT 'admin',        -- who created/sent it (X-Admin-Actor)
  cohort_key TEXT,                             -- cohort filter used, null for ad-hoc phone lists
  cohort_label TEXT,                           -- human label snapshot at send time
  message TEXT NOT NULL,
  channel TEXT,                                -- explicit channel override, else per-user channel
  status TEXT NOT NULL DEFAULT 'draft',        -- draft | sending | sent | failed
  audience_size INT NOT NULL DEFAULT 0,        -- recipients resolved at send time
  sent_count INT NOT NULL DEFAULT 0,
  failed_count INT NOT NULL DEFAULT 0,
  skipped_count INT NOT NULL DEFAULT 0,        -- opted-out / blocked / duplicate excluded
  note TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  sent_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_admin_campaigns_created_at ON public.admin_campaigns (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_campaigns_status ON public.admin_campaigns (status);

-- ─── Per-recipient delivery rows ─────────────────────────────────────────────
-- UNIQUE (campaign_id, phone) enforces "no duplicate sends to the same user in
-- one campaign" at the database level.
CREATE TABLE IF NOT EXISTS public.admin_campaign_recipients (
  id BIGSERIAL PRIMARY KEY,
  campaign_id BIGINT NOT NULL REFERENCES public.admin_campaigns(id) ON DELETE CASCADE,
  phone TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',      -- pending | sent | failed | skipped
  error TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  sent_at TIMESTAMPTZ,
  UNIQUE (campaign_id, phone)
);

CREATE INDEX IF NOT EXISTS idx_campaign_recipients_campaign ON public.admin_campaign_recipients (campaign_id);
CREATE INDEX IF NOT EXISTS idx_campaign_recipients_status ON public.admin_campaign_recipients (status);

-- RLS: operational/admin data only. The API uses a direct Postgres (service-role)
-- connection which bypasses RLS. Default-deny so the Supabase anon key can never
-- read these, matching 20260527000001_enable_rls_all_tables.sql and the
-- 20260613000001 ops tables.
ALTER TABLE public.admin_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_campaign_recipients ENABLE ROW LEVEL SECURITY;
