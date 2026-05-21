-- Long-term semantic memory: extracted facts about each user from past
-- conversations. Top-k by similarity injected into every system prompt.
--
-- Run in Supabase SQL editor. Requires the pgvector extension (already
-- enabled for the embeddings table).

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS public.user_memories (
  id            BIGSERIAL PRIMARY KEY,
  user_id       TEXT NOT NULL,
  content       TEXT NOT NULL,
  embedding     vector(768),
  kind          TEXT NOT NULL CHECK (kind IN ('preference','history','struggle','win','medical','context')),
  confidence    REAL NOT NULL DEFAULT 0.7 CHECK (confidence >= 0 AND confidence <= 1),
  use_count     INT  NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS user_memories_user_idx ON public.user_memories (user_id);
CREATE INDEX IF NOT EXISTS user_memories_kind_idx ON public.user_memories (user_id, kind);

-- ivfflat needs the table to have rows before tuning lists; start with
-- a small list count, ANALYZE-driven re-build can happen later.
CREATE INDEX IF NOT EXISTS user_memories_embedding_idx
  ON public.user_memories
  USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 50);

ALTER TABLE public.user_memories ENABLE ROW LEVEL SECURITY;
