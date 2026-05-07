-- Drop overly permissive insert policies
DROP POLICY "System can insert check-ins" ON public.check_ins;
DROP POLICY "System can insert injections" ON public.injections;

-- Replace with service-role-only policies (edge functions use service role key)
CREATE POLICY "Service role can insert check-ins" ON public.check_ins
  FOR INSERT WITH CHECK (
    (current_setting('request.jwt.claims', true)::json->>'role') = 'service_role'
    OR user_id IN (SELECT id FROM public.users WHERE auth_user_id = auth.uid())
  );

CREATE POLICY "Service role can insert injections" ON public.injections
  FOR INSERT WITH CHECK (
    (current_setting('request.jwt.claims', true)::json->>'role') = 'service_role'
    OR user_id IN (SELECT id FROM public.users WHERE auth_user_id = auth.uid())
  );