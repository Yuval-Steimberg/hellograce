-- Enable pgvector extension if not already enabled
CREATE EXTENSION IF NOT EXISTS vector;

-- Add pill_time column to users table if it doesn't exist
ALTER TABLE users ADD COLUMN IF NOT EXISTS pill_time text;

-- Add week_number column to users table with default value of 1
ALTER TABLE users ADD COLUMN IF NOT EXISTS week_number int default 1;

-- Create grace_knowledge table for storing user interactions with embeddings
CREATE TABLE IF NOT EXISTS grace_knowledge (
  id              uuid primary key default gen_random_uuid(),
  user_message    text not null,
  grace_response  text not null,
  topic           text,
  style_tag       text,
  embedding       vector(1536)
);

-- Create index on embedding column for similarity search
CREATE INDEX IF NOT EXISTS grace_knowledge_embedding_idx
ON grace_knowledge
USING ivfflat (embedding vector_cosine_ops)
WITH (lists = 100);