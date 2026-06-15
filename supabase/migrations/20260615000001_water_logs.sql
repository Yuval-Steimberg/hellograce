-- Water tracking (2026-06-15)
-- Hydration is its own isolated metric — a dedicated table so water totals can
-- never mix with food/protein/calorie data. Mirrors the food_logs shape
-- (text user_id == phone, dedupe_key for idempotent inserts, timestamptz).
-- Totals are computed over the user's personal wake-time logging day, the same
-- window as food (see services/api/src/nutrition/logging-window.ts).

CREATE TABLE IF NOT EXISTS public.water_logs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     TEXT NOT NULL,
  oz          REAL NOT NULL,
  raw_text    TEXT,
  source      TEXT DEFAULT 'text',
  dedupe_key  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS water_logs_user_created_idx
  ON public.water_logs (user_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS water_logs_user_dedupe_idx
  ON public.water_logs (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL;

-- Row Level Security: default-deny (blocks the Supabase anon key). The API
-- uses a direct Postgres connection / service role, which bypasses RLS —
-- consistent with every other table (see 20260527000001_enable_rls_all_tables).
ALTER TABLE public.water_logs ENABLE ROW LEVEL SECURITY;
