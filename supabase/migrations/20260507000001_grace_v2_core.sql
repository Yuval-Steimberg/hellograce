-- Grace v2 — core schema for the new orchestration service.
-- Adds: conversations, messages, embeddings, tool_logs, feedback, user_profiles.
-- Existing Grace v1 tables (users, check_ins, injections, weight_logs, grace_knowledge)
-- remain intact and untouched by this migration.

-- The extension is named "vector" (pgvector is the project name).
-- `CREATE EXTENSION IF NOT EXISTS pgvector` errors on every Postgres,
-- aborting this whole file when run with ON_ERROR_STOP (2026-06-11 fix).
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ─── conversations ───────────────────────────────────────────────────
-- One active conversation per user. New row when an old conversation
-- is archived (e.g. via admin reset).
CREATE TABLE IF NOT EXISTS public.conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS conversations_active_user_idx
  ON public.conversations (user_id) WHERE active = true;

-- ─── messages ────────────────────────────────────────────────────────
-- Canonical chat history. Used for short-term memory recall (last N turns).
CREATE TABLE IF NOT EXISTS public.messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content TEXT NOT NULL,
  provider_message_id TEXT,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS messages_user_created_idx
  ON public.messages (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS messages_conversation_idx
  ON public.messages (conversation_id, created_at DESC);

-- ─── embeddings (pgvector) ───────────────────────────────────────────
-- Long-term semantic memory + general knowledge. The `feedback_score`
-- column biases retrieval toward responses that received positive RLHF
-- signals (see `feedback` table).
CREATE TABLE IF NOT EXISTS public.embeddings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT,                          -- NULL = global knowledge
  source TEXT NOT NULL CHECK (source IN ('history', 'knowledge', 'web')),
  content TEXT NOT NULL,
  embedding vector(768) NOT NULL,        -- text-embedding-004 dim
  metadata JSONB,
  feedback_score REAL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS embeddings_user_idx ON public.embeddings (user_id);
-- Approximate nearest-neighbor index. Use ivfflat for cosine distance.
CREATE INDEX IF NOT EXISTS embeddings_vec_idx
  ON public.embeddings USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- ─── tool_logs ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.tool_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  conversation_id UUID REFERENCES public.conversations(id) ON DELETE CASCADE,
  tool_name TEXT NOT NULL,
  args JSONB NOT NULL,
  ok BOOLEAN NOT NULL,
  output JSONB,
  error TEXT,
  latency_ms INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tool_logs_tool_idx ON public.tool_logs (tool_name, created_at DESC);
CREATE INDEX IF NOT EXISTS tool_logs_user_idx ON public.tool_logs (user_id, created_at DESC);

-- ─── feedback (RLHF signals) ─────────────────────────────────────────
-- Both explicit (rating) and implicit (re-query, drop-off) signals.
CREATE TABLE IF NOT EXISTS public.feedback (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id UUID REFERENCES public.messages(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  signal_type TEXT NOT NULL CHECK (signal_type IN ('rating', 'comment', 'requery', 'dropoff', 'correction')),
  rating SMALLINT,                       -- -1, 0, +1
  comment TEXT,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS feedback_message_idx ON public.feedback (message_id);
CREATE INDEX IF NOT EXISTS feedback_user_idx ON public.feedback (user_id, created_at DESC);

-- ─── food_logs ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.food_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  food TEXT NOT NULL,
  protein_g REAL,
  calories REAL,
  confidence TEXT,
  raw_text TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS food_logs_user_idx ON public.food_logs (user_id, created_at DESC);

-- ─── user_profiles ───────────────────────────────────────────────────
-- Free-form learned preferences/habits. Distinct from the v1 `users`
-- table, which holds onboarding settings. This grows over time from
-- AI-derived observations.
CREATE TABLE IF NOT EXISTS public.user_profiles (
  user_id TEXT PRIMARY KEY,
  preferences JSONB NOT NULL DEFAULT '{}'::jsonb,
  habits JSONB NOT NULL DEFAULT '{}'::jsonb,
  derived_goals JSONB NOT NULL DEFAULT '{}'::jsonb,
  notes TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── updated_at triggers ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

DROP TRIGGER IF EXISTS conversations_touch ON public.conversations;
CREATE TRIGGER conversations_touch BEFORE UPDATE ON public.conversations
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

DROP TRIGGER IF EXISTS user_profiles_touch ON public.user_profiles;
CREATE TRIGGER user_profiles_touch BEFORE UPDATE ON public.user_profiles
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
