-- Drop field-level encryption: NULL unrecoverable ciphertext blobs (2026-06-18)
--
-- FIELD_ENCRYPTION_KEY is no longer present on the API process, so fields that
-- were encrypted under that (now-missing) key are unreadable ciphertext blobs
-- of the form `enc:<iv>:<data>:<tag>` (see services/api/src/crypto/field-encrypt.ts).
-- The application already fails safe at read time (decryptUser nullifies these),
-- but this cleans the data AT REST so no path — admin raw selects, analytics,
-- CSV exports — ever sees ciphertext either.
--
-- Only rows whose value is an unrecoverable blob are touched; plaintext values
-- (including any written after the key was dropped) are left untouched. The
-- match is anchored and requires the exact enc:hex:hex:hex shape, so a real
-- medication name like "Wegovy" or a user named "Enzo" can never match.
--
-- Recovery: affected users re-enter their medication via the Settings page or
-- the admin dashboard. With the key absent, UserService.update stores those
-- values as plaintext, so they read back correctly going forward.
--
-- NOTE: this is irreversible for the affected rows — the ciphertext is the only
-- copy of that data and it cannot be decrypted without the original key. Run
-- only after confirming the key is genuinely unavailable.

UPDATE public.users
   SET medication = NULL, updated_at = now()
 WHERE medication ~* '^enc:[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$';

UPDATE public.users
   SET first_name = NULL, updated_at = now()
 WHERE first_name ~* '^enc:[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$';
