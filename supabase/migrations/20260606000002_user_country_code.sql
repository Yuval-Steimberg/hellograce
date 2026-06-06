-- Country code column (2026-06-06)
--
-- Added per the coverage audit (Area 6 — crisis resource localization).
-- Today's SAFETY_RESPONSE hard-codes US-only 988/911. With this column we
-- can look up the right crisis line + emergency number per country.
--
-- ISO-3166-1 alpha-2 (e.g. 'US', 'IL', 'GB', 'CA', 'AU'). Nullable; when
-- null, the safety response falls back to the US default verbatim
-- (existing behavior). Country can be inferred from timezone when present.
--
-- PRE-LAUNCH GATE: clinical + legal review of every entry in
-- services/api/src/safety/crisis-resources.ts is required before the
-- CRISIS_RESOURCES_REVIEWED env flag is flipped to true. Until that flip,
-- this column has no user-facing effect — the default US response ships
-- to everyone.

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS country_code CHAR(2) NULL;

COMMENT ON COLUMN public.users.country_code IS
  'ISO-3166-1 alpha-2 country code. Nullable. Used by the crisis-resources lookup to ship localized hotline numbers in SAFETY responses. Effective only when CRISIS_RESOURCES_REVIEWED env flag is true.';
