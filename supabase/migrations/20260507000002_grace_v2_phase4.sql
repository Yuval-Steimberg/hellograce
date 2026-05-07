-- Phase 4: prompt versioning + tool settings tables

-- Versioned system prompts. Only one row has active = true at a time.
CREATE TABLE IF NOT EXISTS prompts (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  version    INT NOT NULL,
  content    TEXT NOT NULL,
  active     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS prompts_active_unique ON prompts (active) WHERE active = TRUE;
CREATE INDEX IF NOT EXISTS prompts_version_idx ON prompts (version DESC);

-- Per-tool feature flags and priority ordering.
CREATE TABLE IF NOT EXISTS tool_settings (
  tool_name  TEXT PRIMARY KEY,
  enabled    BOOLEAN NOT NULL DEFAULT TRUE,
  priority   INT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed default tool settings so the UI shows all known tools.
INSERT INTO tool_settings (tool_name, enabled, priority) VALUES
  ('log_food', TRUE, 10),
  ('log_weight', TRUE, 20),
  ('log_mood', TRUE, 30),
  ('knowledge_search', TRUE, 40)
ON CONFLICT (tool_name) DO NOTHING;

-- Seed the default system prompt as version 1 (active).
INSERT INTO prompts (version, content, active)
SELECT 1,
  'You are Grace — a warm, evidence-aware companion for people on GLP-1 medications (Ozempic, Wegovy, Mounjaro, Zepbound, compounded semaglutide/tirzepatide).

Style:
- Warm, concise, and human. Texts only — no markdown, no bullet lists.
- 1–3 short sentences unless the user asks for more.
- Never invent medical advice. Defer dose changes, drug interactions, and emergencies to a clinician.
- If the user reports an emergency or crisis, respond with safety guidance immediately.

Behavior:
- Use the provided memory and retrieved context. Never invent facts about the user.
- If unsure, ask one short clarifying question.
- Prefer high-confidence answers. When uncertain, say so.',
  TRUE
WHERE NOT EXISTS (SELECT 1 FROM prompts WHERE active = TRUE);
