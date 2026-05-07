DELETE FROM public.check_ins WHERE user_id IN (SELECT id FROM public.users);
DELETE FROM public.injections WHERE user_id IN (SELECT id FROM public.users);
DELETE FROM public.weight_logs WHERE user_id IN (SELECT id FROM public.users);
DELETE FROM public.verification_codes;
DELETE FROM public.users;