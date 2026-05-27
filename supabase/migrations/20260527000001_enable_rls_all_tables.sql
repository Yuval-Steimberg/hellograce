-- Enable Row Level Security on all public tables.
-- Grace's API connects via DATABASE_URL (postgres role), which bypasses RLS.
-- This blocks access via the Supabase anon key (client SDK / REST API).

-- Core tables
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.embeddings ENABLE ROW LEVEL SECURITY;

-- Data tables
ALTER TABLE public.food_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.weight_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.check_ins ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.injections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tool_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.feedback ENABLE ROW LEVEL SECURITY;

-- Profile / memory tables
ALTER TABLE public.user_profile_facts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_memories ENABLE ROW LEVEL SECURITY;

-- Admin tables
ALTER TABLE public.prompts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tool_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.content_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;

-- Allow the postgres role (used by the API server via DATABASE_URL) full access.
-- The anon and authenticated roles get NO policies = no access.
DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOR tbl IN
    SELECT unnest(ARRAY[
      'users', 'conversations', 'messages', 'embeddings',
      'food_logs', 'weight_logs', 'check_ins', 'injections',
      'tool_logs', 'feedback', 'user_profile_facts', 'user_memories',
      'prompts', 'tool_settings', 'content_rules', 'audit_logs'
    ])
  LOOP
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR ALL TO postgres USING (true) WITH CHECK (true)',
      'allow_postgres_' || tbl, tbl
    );
  END LOOP;
END
$$;
