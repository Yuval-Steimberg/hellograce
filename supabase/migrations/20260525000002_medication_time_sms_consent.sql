-- Add medication_time (for daily pill users) and sms_consent columns
ALTER TABLE users ADD COLUMN IF NOT EXISTS medication_time TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS sms_consent BOOLEAN DEFAULT FALSE;
