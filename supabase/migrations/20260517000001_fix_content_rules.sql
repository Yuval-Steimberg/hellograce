-- Fix overly-broad content rules that were blocking legitimate GLP-1 education.
--
-- Run in Supabase SQL Editor (No limit OFF):
--   SELECT id, pattern, reason FROM content_rules WHERE is_active = true ORDER BY id;
-- then paste this file.

-- 1. The "(most|many) people ... on this medication|taking this" rule was
--    catching factual statements like "many people taking GLP-1 lose some muscle."
--    Strip "on this medication|taking this" from the alternatives — the real
--    toxic-positivity pattern is "many people also/too [feel this way]", not
--    factual descriptions of medication effects.
UPDATE public.content_rules
SET
  pattern = '\b(most|many) (people|women|men|patients|users) (also|too)\b',
  reason  = '"Many people also/too" — comparative normalising instead of personal validation'
WHERE
  pattern = '\b(most|many) (people|women|men|patients|users) (also|too|on this medication|taking this)\b'
  AND is_active = true;

-- 2. "consult your healthcare provider" fires on valid suggestions to check with
--    a prescriber. Narrow it: only fire on "consult a doctor/physician" (cold
--    third-person referral), not "check with your prescriber/doctor".
--    The word "consult" alone (without "a" referral) is kept so Grace still
--    avoids "consult a specialist" cold-referral phrasing.
UPDATE public.content_rules
SET
  pattern = '\bconsult (with )?(a) (doctor|physician|medical professional|GP|specialist)\b',
  reason  = '"Consult a doctor/physician" — cold third-person referral; say "check with your prescriber" instead'
WHERE
  pattern = '\bconsult (with )?(a|your) (doctor|physician|healthcare (provider|professional)|medical professional|GP|specialist)\b'
  AND is_active = true;
