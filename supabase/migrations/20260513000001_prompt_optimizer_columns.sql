-- Add notes and auto_generated columns to prompts table for PromptOptimizer
ALTER TABLE prompts
  ADD COLUMN IF NOT EXISTS notes TEXT,
  ADD COLUMN IF NOT EXISTS auto_generated BOOLEAN NOT NULL DEFAULT FALSE;
