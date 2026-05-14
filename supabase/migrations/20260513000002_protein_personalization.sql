-- Personalized protein calculation: add age, primary fitness goal, and computed daily protein target.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS age                  INT,
  ADD COLUMN IF NOT EXISTS primary_goal         TEXT,   -- 'fat_loss' | 'muscle_gain' | 'maintenance' | 'recomposition'
  ADD COLUMN IF NOT EXISTS protein_goal_grams   INT;
