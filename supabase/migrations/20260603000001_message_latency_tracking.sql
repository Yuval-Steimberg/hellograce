-- Per-message latency + intent tracking so we can produce P50/P95/P99
-- breakdowns by message category and identify slow stages.
--
-- All columns default-null so the migration is non-blocking; the API will
-- begin writing them on the next deploy. Historical rows show as `null`
-- in the admin /admin/latency endpoint and are excluded from percentiles.

ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS latency_ms INTEGER;
ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS intent TEXT;
-- Stage-level timing breakdown for slow-request diagnosis:
--   { "parallel_io": 312, "rag": 145, "planner": 0, "generate": 1820,
--     "guards": 240, "regen": 0, "persist": 0 }
ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS stage_timings JSONB;

-- Index supporting the /admin/latency endpoint (per-intent percentile query
-- over the last 24h / 7d / 30d). Partial index on assistant rows only since
-- user rows have no latency.
CREATE INDEX IF NOT EXISTS messages_intent_latency_idx
  ON public.messages (intent, created_at DESC)
  WHERE role = 'assistant' AND latency_ms IS NOT NULL;

CREATE INDEX IF NOT EXISTS messages_latency_recent_idx
  ON public.messages (created_at DESC)
  WHERE role = 'assistant' AND latency_ms IS NOT NULL;
