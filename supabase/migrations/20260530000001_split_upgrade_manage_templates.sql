-- Split the single "upgrade_nudge" template into two messages with
-- distinct destinations (2026-05-30 — fixes production bug where paid
-- users were sent to /upgrade Stripe checkout instead of /settings
-- Customer Portal when they typed "manage my subscription").
--
-- After this migration:
--   - upgrade_nudge  → for trial / unpaid users → /upgrade URL
--   - manage_subscription → for paid / pro users → /settings URL
--
-- The webhook handler chooses which template to render based on
-- user.is_paid / user.is_pro.

-- Refine the existing upgrade_nudge wording so admins know it's only
-- used for users who do NOT have an active paid subscription.
UPDATE message_templates
   SET template    = 'You can upgrade your plan anytime at {upgrade_url} 🧡',
       description = 'Sent when an UNPAID user types "upgrade", "subscribe", "pricing", etc. in chat. Destination URL is the Stripe checkout flow at /upgrade.'
 WHERE key = 'upgrade_nudge';

-- Insert the new manage_subscription template — for paid / pro users
-- who type "manage my subscription", "cancel", "billing", etc. URL is
-- the /settings page which hosts the Stripe Customer Portal button.
INSERT INTO message_templates (key, template, description, variables)
VALUES (
  'manage_subscription',
  'You can manage your subscription anytime at {upgrade_url} 🧡',
  'Sent when a PAID/PRO user types "manage my subscription", "cancel", "billing", etc. in chat. Destination URL is /settings (Stripe Customer Portal — manage payment / cancel / change plan).',
  ARRAY['upgrade_url', 'first_name']
)
ON CONFLICT (key) DO NOTHING;
