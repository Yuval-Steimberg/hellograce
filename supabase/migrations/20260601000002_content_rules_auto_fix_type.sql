-- Allow the research auto-fix engine to insert rules with rule_type = 'auto_fix'.
-- The existing CHECK constraint must be dropped and recreated with the new value.

ALTER TABLE public.content_rules
  DROP CONSTRAINT IF EXISTS content_rules_rule_type_check;

ALTER TABLE public.content_rules
  ADD CONSTRAINT content_rules_rule_type_check
    CHECK (rule_type IN (
      'banned_phrase',
      'medication_safety',
      'medical_authority',
      'emotional_safety',
      'privacy',
      'auto_fix'
    ));
