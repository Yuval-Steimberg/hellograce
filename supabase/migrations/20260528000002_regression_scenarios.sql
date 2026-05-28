-- Dynamic regression scenarios (in addition to the static ones in code).
-- Populated via admin UI when bugs are reported — converts a real WhatsApp
-- failure into a permanent test case.
--
-- Static scenarios live in services/api/auto-eval/regression-scenarios.ts.
-- DB scenarios are merged in at runtime and shown alongside static ones.

CREATE TABLE IF NOT EXISTS public.regression_scenarios (
  id              TEXT PRIMARY KEY,
  bug_description TEXT NOT NULL,
  trigger_message TEXT NOT NULL,
  banned_phrases  TEXT[] NOT NULL DEFAULT '{}',
  required_behavior TEXT[] NOT NULL DEFAULT '{}',
  setup           TEXT,
  persona_id      TEXT,
  category        TEXT,
  source          TEXT NOT NULL DEFAULT 'manual',  -- 'manual', 'replay', 'feedback'
  source_meta     JSONB,                             -- e.g. feedback_id, grace_response captured
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  active          BOOLEAN NOT NULL DEFAULT TRUE
);

ALTER TABLE public.regression_scenarios ENABLE ROW LEVEL SECURITY;
CREATE POLICY allow_postgres_regression_scenarios ON public.regression_scenarios
  FOR ALL TO postgres USING (true) WITH CHECK (true);
