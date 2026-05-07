-- Phase "Ready Bot": full user profile, check-ins, weight logs, injections.
-- In production (Supabase), these come from v1. This migration creates them
-- for the standalone Docker/local v2 deployment.

-- ─── Users ───────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone         TEXT UNIQUE NOT NULL,
  first_name    TEXT,
  last_name     TEXT,
  email         TEXT,

  -- GLP-1 context
  medication    TEXT,                          -- 'Ozempic', 'Wegovy', 'Mounjaro', etc.
  medication_frequency TEXT DEFAULT 'weekly', -- 'weekly' | 'biweekly'
  injection_day TEXT,                          -- 'Monday' … 'Sunday'
  dose_mg       NUMERIC,
  dose_change_started_at TIMESTAMPTZ,
  injection_count INT DEFAULT 0,

  -- Preferences
  goals         TEXT[] DEFAULT '{}',           -- ['Losing weight', 'Eating enough protein', …]
  food_dislikes TEXT[] DEFAULT '{}',
  timezone      TEXT DEFAULT 'America/New_York',
  wake_time     TEXT DEFAULT '07:00',          -- HH:MM local
  sleep_time    TEXT DEFAULT '22:00',          -- HH:MM local

  -- Body data
  current_weight  NUMERIC,
  goal_weight     NUMERIC,
  height_cm       NUMERIC,

  -- Behavioural flags (updated by personalization engine)
  protein_focus_boost  BOOLEAN DEFAULT FALSE,
  hydration_struggle   BOOLEAN DEFAULT FALSE,
  low_mood_mode        BOOLEAN DEFAULT FALSE,
  midday_skip          BOOLEAN DEFAULT FALSE,

  -- Injection flow state machine
  injection_flow_stage        TEXT,           -- 'morning_sent'|'done_confirmed'|'followup_sent'
  injection_flow_started_at   TIMESTAMPTZ,
  injection_done_at           TIMESTAMPTZ,
  injection_side_effect_free  BOOLEAN DEFAULT FALSE,
  injection_evening_followup_due BOOLEAN DEFAULT FALSE,

  -- Side-effect follow-up flow
  side_effect_flow            TEXT,           -- 'nausea'|'fatigue'|'constipation'
  side_effect_flow_started_at TIMESTAMPTZ,
  side_effect_followup_sent   BOOLEAN DEFAULT FALSE,

  -- Scheduling tracking (date columns avoid duplicate sends)
  last_morning_sent_at  TIMESTAMPTZ,
  last_midday_sent_at   TIMESTAMPTZ,
  last_evening_sent_at  TIMESTAMPTZ,
  last_reply_at         TIMESTAMPTZ,
  messages_sent_today   INT DEFAULT 0,
  messages_sent_today_date DATE,

  -- Check-in frequency controls
  checkin_frequency       TEXT DEFAULT 'normal',  -- 'less'|'normal'|'more'
  checkin_count_per_day   INT DEFAULT 1,
  checkin_days_interval   INT DEFAULT 1,

  -- Personalization notes (free-text, updated by AI)
  grace_notes   TEXT,

  -- Account status
  active        BOOLEAN DEFAULT TRUE,
  paused        BOOLEAN DEFAULT FALSE,
  blocked       BOOLEAN DEFAULT FALSE,
  is_paid       BOOLEAN DEFAULT FALSE,
  is_pro        BOOLEAN DEFAULT FALSE,
  trial_start   TIMESTAMPTZ,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS users_phone_idx     ON public.users (phone);
CREATE INDEX IF NOT EXISTS users_active_idx    ON public.users (active) WHERE active = TRUE;
CREATE INDEX IF NOT EXISTS users_inject_day_idx ON public.users (injection_day) WHERE injection_day IS NOT NULL;

DROP TRIGGER IF EXISTS users_touch ON public.users;
CREATE TRIGGER users_touch BEFORE UPDATE ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ─── Check-ins ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.check_ins (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      TEXT NOT NULL,
  phone        TEXT,
  type         TEXT NOT NULL DEFAULT 'morning',
  -- Types: morning | midday | evening | injection_morning | injection_followup |
  --        injection_dayafter | side_effect_followup | mood_log | welcome
  message_sent TEXT NOT NULL DEFAULT '',
  user_reply   TEXT,
  mood_score   SMALLINT,
  protein_logged BOOLEAN DEFAULT FALSE,
  water_logged   BOOLEAN DEFAULT FALSE,
  side_effect    TEXT,                        -- 'nausea'|'fatigue'|'constipation'
  -- Injection-specific reply tracking
  injection_followup_reply TEXT,
  injection_dayafter_reply TEXT,
  nausea_reply TEXT,
  fatigue_reply TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS check_ins_user_idx  ON public.check_ins (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS check_ins_type_idx  ON public.check_ins (user_id, type, created_at DESC);
CREATE INDEX IF NOT EXISTS check_ins_phone_idx ON public.check_ins (phone, created_at DESC);

-- ─── Weight logs ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.weight_logs (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    TEXT NOT NULL,
  weight     NUMERIC NOT NULL,               -- lbs
  notes      TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS weight_logs_user_idx ON public.weight_logs (user_id, created_at DESC);

-- ─── Injections ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.injections (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          TEXT NOT NULL,
  phone            TEXT,
  injection_number INT,
  injected_at      TIMESTAMPTZ,
  side_effects     TEXT[] DEFAULT '{}',      -- ['nausea','fatigue'] or ['none']
  followup_reply   TEXT,
  dayafter_reply   TEXT,
  nausea_reply     TEXT,
  fatigue_reply    TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS injections_user_idx ON public.injections (user_id, created_at DESC);
