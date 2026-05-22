-- Phase 5: Contextual bandit (per-user response strategy) + USDA food cache
-- Purely additive: new tables only. No existing rows are touched.

-- ─── Contextual bandit state ──────────────────────────────────────────────────
-- Per (user, arm) Beta-distribution parameters for Thompson Sampling.
-- pulls = successes + failures (denormalized for cheap reads).
CREATE TABLE IF NOT EXISTS user_bandit_state (
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  arm            TEXT NOT NULL,
  pulls          INT  NOT NULL DEFAULT 0,
  successes      INT  NOT NULL DEFAULT 0,
  failures       INT  NOT NULL DEFAULT 0,
  last_updated   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, arm)
);

CREATE INDEX IF NOT EXISTS user_bandit_state_user_idx ON user_bandit_state(user_id);

-- ─── USDA food cache ──────────────────────────────────────────────────────────
-- Per-100g protein/calorie values from USDA FoodData Central, keyed by
-- normalized food name. 30-day TTL via lookups checking last_refreshed_at.
-- Stays cheap: each row is < 200 bytes.
CREATE TABLE IF NOT EXISTS usda_food_cache (
  normalized_name      TEXT PRIMARY KEY,
  display_name         TEXT NOT NULL,
  fdc_id               BIGINT,
  protein_per_100g     REAL NOT NULL,
  calories_per_100g    REAL NOT NULL,
  data_type            TEXT,
  last_refreshed_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
