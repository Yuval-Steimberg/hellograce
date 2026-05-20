-- Admin-editable subscription messages. Centralises the four user-facing
-- subscription touch-points (paywall, trial reminder, welcome, upgrade
-- nudge) into a single table so ops can update copy without a deploy.
--
-- Variable substitution syntax: {first_name}, {upgrade_url}, {medication}.
-- The service does a literal string replace on each declared variable.

CREATE TABLE IF NOT EXISTS message_templates (
  id           BIGSERIAL PRIMARY KEY,
  key          TEXT NOT NULL UNIQUE,
  template     TEXT NOT NULL,
  description  TEXT,
  variables    TEXT[] NOT NULL DEFAULT '{}',
  is_active    BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION trg_message_templates_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS message_templates_updated_at ON message_templates;
CREATE TRIGGER message_templates_updated_at
BEFORE UPDATE ON message_templates
FOR EACH ROW
EXECUTE FUNCTION trg_message_templates_updated_at();

INSERT INTO message_templates (key, template, description, variables) VALUES
  (
    'paywall',
    'Your 3-day Grace trial has ended 🧡 To keep your daily check-ins going, head to {upgrade_url} to subscribe. Questions? Reply HELP.',
    'Sent when an unpaid user messages after the 3-day trial has expired.',
    ARRAY['upgrade_url']
  ),
  (
    'trial_reminder',
    'Your Grace trial ends tomorrow 🧡 Head to {upgrade_url} anytime to keep your check-ins going, no pressure, whenever you''re ready.',
    'Day 2 morning reminder — fires instead of the regular morning check-in.',
    ARRAY['upgrade_url']
  ),
  (
    'welcome',
    'Hey {first_name} 🧡 I''m Grace. I''ll check in a few times a week, light touch, here whenever you need me on this GLP-1 journey.',
    'First message after onboarding. Used as deterministic fallback when LLM personalisation fails.',
    ARRAY['first_name', 'medication', 'goal']
  ),
  (
    'upgrade_nudge',
    'You can upgrade or manage your subscription anytime at {upgrade_url} 🧡',
    'Sent when the user types "upgrade", "pro", or "subscribe" in chat.',
    ARRAY['upgrade_url']
  )
ON CONFLICT (key) DO NOTHING;
