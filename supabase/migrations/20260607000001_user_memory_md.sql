-- Phase D — memory.md per-user narrative memory layer
-- Added 2026-06-07 per /root/.claude/plans/transient-riding-ritchie.md
--
-- This is an ADDITIVE layer alongside the existing Postgres memory:
--   - users table:           hard fields (medication, weight, etc.)
--   - user_profile_facts:    LLM-extracted facts (keep during pilot)
--   - embeddings (pgvector): semantic memory for RAG
--   - **user_memory_md:      NEW — narrative markdown per user**
--
-- One row per user. Content is a single markdown document with sections
-- for profile, recent context, and open threads. The LLM reads it
-- verbatim from the system prompt and rewrites the whole file via the
-- memory-md-updater worker after each response.
--
-- Pilot gate: presence of a row enables memory.md for that user. Absence
-- preserves existing behavior unchanged. To enroll a user, insert a row.
-- To unenroll, delete the row.

-- user_id is the user's PHONE (every reader/writer — MemoryMdService,
-- ai.service, admin routes — keys this table by phone, not users.id).
-- No FK: the original `REFERENCES public.users(id)` was a TEXT→UUID type
-- mismatch, which made this migration fail on every database it ran on.
CREATE TABLE IF NOT EXISTS public.user_memory_md (
  user_id    TEXT PRIMARY KEY,
  content_md TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Track size for the compact-on-overflow worker; populated on every write.
  content_chars INT NOT NULL DEFAULT 0,
  -- Diagnostic: count how many times the worker has rewritten this file.
  rewrite_count INT NOT NULL DEFAULT 0
);

COMMENT ON TABLE public.user_memory_md IS
  'Per-user narrative memory in markdown form. Read verbatim into the LLM prompt. Rewritten by the memory-md-updater BullMQ worker after every assistant turn. Presence of a row enables the memory.md layer for that user (pilot gate).';

COMMENT ON COLUMN public.user_memory_md.content_md IS
  'Full markdown document. Schema: # Header / ## Profile / ## Recent context / ## Open threads. The LLM is responsible for keeping facts consistent with the users table (hard fields stay source of truth).';
