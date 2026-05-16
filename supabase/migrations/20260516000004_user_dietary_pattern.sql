-- Add a durable dietary-restriction column so the orchestrator's guard layer
-- doesn't rely on the conversation-history race (the BullMQ turn-persist
-- worker runs async, so a user who sends "I'm vegetarian" then immediately
-- "what should I eat for lunch?" can have an empty history on the second
-- request).
--
-- Values: 'vegan' | 'vegetarian' | 'pescatarian' | NULL
-- Written synchronously by ai.service.ts whenever detectDietaryRestriction
-- finds a match in the user's CURRENT message. Once set, every future
-- request reads it from the user record — no history dependence.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS dietary_pattern TEXT;

-- No index needed — this is read per-request alongside the rest of the row.
