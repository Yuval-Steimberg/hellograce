-- Track when user started their GLP-1 therapy so Grace can calculate the correct week number.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS glp1_start_date DATE;
