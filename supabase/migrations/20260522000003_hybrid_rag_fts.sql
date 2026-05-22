-- Phase 12 (additive): Hybrid retrieval — add Postgres FTS index over `embeddings.content`
-- so the new HybridRagService can run sparse keyword search alongside the existing
-- pgvector dense search. Pure addition — no existing column, index, or query changes.
--
-- Safe to apply on a live DB: STORED generated column backfills inline, GIN index
-- builds with CONCURRENTLY off (small table at GLP-1 KB scale). If your KB is large,
-- run the CREATE INDEX manually with CONCURRENTLY.

ALTER TABLE public.embeddings
  ADD COLUMN IF NOT EXISTS content_tsv tsvector
    GENERATED ALWAYS AS (to_tsvector('english', coalesce(content, ''))) STORED;

CREATE INDEX IF NOT EXISTS embeddings_content_tsv_idx
  ON public.embeddings USING GIN (content_tsv);
