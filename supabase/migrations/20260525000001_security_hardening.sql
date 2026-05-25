-- Phase 3: field-level encryption support
-- phone_hash: SHA-256 hash for lookups (replaces plaintext phone in WHERE clauses)
-- encrypted_* columns: AES-256-GCM ciphertext for sensitive fields
-- Plaintext columns kept temporarily for backward compatibility during migration

ALTER TABLE public.users ADD COLUMN IF NOT EXISTS phone_hash TEXT;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS encrypted_phone TEXT;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS encrypted_first_name TEXT;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS encrypted_medication TEXT;

-- Index on phone_hash for fast lookups
CREATE INDEX IF NOT EXISTS idx_users_phone_hash ON public.users (phone_hash);

-- Audit log table for admin actions
CREATE TABLE IF NOT EXISTS public.audit_logs (
  id BIGSERIAL PRIMARY KEY,
  action TEXT NOT NULL,
  admin_ip TEXT,
  details JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);
