-- Enable RLS on grace_knowledge table
ALTER TABLE grace_knowledge ENABLE ROW LEVEL SECURITY;

-- Allow service role full access
CREATE POLICY "Service role can manage grace_knowledge"
ON grace_knowledge
FOR ALL
TO public
USING (
  ((current_setting('request.jwt.claims'::text, true))::json ->> 'role'::text) = 'service_role'::text
)
WITH CHECK (
  ((current_setting('request.jwt.claims'::text, true))::json ->> 'role'::text) = 'service_role'::text
);