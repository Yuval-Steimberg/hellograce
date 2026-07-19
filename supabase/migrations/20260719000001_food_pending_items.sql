-- Durable fallback for portion clarifications. Redis remains the latency layer;
-- this row preserves context across Redis outages/restarts for up to six hours.
CREATE TABLE IF NOT EXISTS public.food_pending_items (
  user_id TEXT PRIMARY KEY,
  items JSONB NOT NULL DEFAULT '[]'::jsonb,
  expires_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS food_pending_items_expiry_idx
  ON public.food_pending_items (expires_at);
