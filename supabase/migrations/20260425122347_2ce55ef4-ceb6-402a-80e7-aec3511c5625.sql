alter table public.users
  add column if not exists injection_evening_followup_due boolean not null default false;