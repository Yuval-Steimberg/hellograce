-- Progress photo gallery (2026-07-02)
-- Backs the dashboard's before/after progress gallery. Images are stored inline
-- as downscaled data URLs (the browser caps them to ~1024px / a small thumb
-- before upload), so no object-storage bucket is required — consistent with the
-- rest of the dashboard's zero-new-infra approach. A personal gallery is small
-- (dozens of photos), well within what Postgres TEXT handles comfortably.
--
--   image_data  — full (≈1024px) JPEG as a data: URL, shown in the lightbox
--   thumb_data  — small (≈400px) JPEG as a data: URL, shown in the grid
--   weight_lbs  — optional weight at the time, for before/after context
--   note        — optional caption, or Grace's warm read of the photo

CREATE TABLE IF NOT EXISTS public.progress_photos (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      TEXT NOT NULL,
  kind         TEXT NOT NULL DEFAULT 'progress',   -- 'progress' | 'body' | 'other'
  image_data   TEXT NOT NULL,
  thumb_data   TEXT,
  content_type TEXT NOT NULL DEFAULT 'image/jpeg',
  note         TEXT,
  weight_lbs   REAL,
  taken_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS progress_photos_user_taken_idx
  ON public.progress_photos (user_id, taken_at DESC);

-- Row Level Security: default-deny (blocks the Supabase anon key). The API uses
-- a direct Postgres connection / service role, which bypasses RLS — consistent
-- with every other table (see 20260527000001_enable_rls_all_tables).
ALTER TABLE public.progress_photos ENABLE ROW LEVEL SECURITY;
