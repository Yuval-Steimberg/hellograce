-- Symptom episode memory (2026-07-01)
-- Powers Grace's signature differentiator: she learns how THIS person's body
-- handles GLP-1 side effects over time. Each reported symptom is recorded with
-- how many days it was since their injection and the dose at the time, plus what
-- (if anything) settled it. That history lets Grace recall a personal pattern
-- ("this tends to hit you the day after your shot, and ginger tea helped last
-- time") reactively, and warn proactively on injection day — something no
-- generic tracker or 15-minute clinic visit can do.

CREATE TABLE IF NOT EXISTS public.symptom_episodes (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              TEXT NOT NULL,
  symptom              TEXT NOT NULL,            -- canonical: nausea, fatigue, constipation, …
  days_since_injection INT,                      -- 0 = injection day, 1 = day after, … (null if unknown)
  dose_mg              REAL,                      -- dose at the time of the episode
  remedy_helped        TEXT,                      -- what settled it, when the user later says it worked
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS symptom_episodes_user_symptom_idx
  ON public.symptom_episodes (user_id, symptom, created_at DESC);

CREATE INDEX IF NOT EXISTS symptom_episodes_user_created_idx
  ON public.symptom_episodes (user_id, created_at DESC);

-- Row Level Security: default-deny (blocks the Supabase anon key). The API uses
-- a direct Postgres connection / service role, which bypasses RLS — consistent
-- with every other table (see 20260527000001_enable_rls_all_tables).
ALTER TABLE public.symptom_episodes ENABLE ROW LEVEL SECURITY;
