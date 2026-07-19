#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOCAL_DIR="$ROOT_DIR/.local"
PG_DIR="$LOCAL_DIR/postgres"
PG_LOG="$LOCAL_DIR/postgres.log"
PG_BIN="/opt/homebrew/opt/postgresql@17/bin"
REDIS_BIN="/opt/homebrew/opt/redis/bin"

for required in "$PG_BIN/initdb" "$PG_BIN/pg_ctl" "$PG_BIN/createdb" "$PG_BIN/psql" "$REDIS_BIN/redis-server" /opt/homebrew/opt/node@20/bin/node; do
  if [[ ! -x "$required" ]]; then
    echo "Missing dependency: $required"
    echo "Install with: brew install node@20 postgresql@17 pgvector redis"
    exit 1
  fi
done

mkdir -p "$LOCAL_DIR"
if [[ ! -f "$PG_DIR/PG_VERSION" ]]; then
  "$PG_BIN/initdb" -D "$PG_DIR" --auth=trust --encoding=UTF8 --locale=C
  {
    echo "port = 5433"
    echo "listen_addresses = '127.0.0.1'"
  } >> "$PG_DIR/postgresql.conf"
fi

if ! "$PG_BIN/pg_ctl" -D "$PG_DIR" status >/dev/null 2>&1; then
  "$PG_BIN/pg_ctl" -D "$PG_DIR" -l "$PG_LOG" start
fi

if ! "$PG_BIN/psql" -h 127.0.0.1 -p 5433 -d postgres -Atqc "SELECT 1 FROM pg_database WHERE datname='grace'" | grep -q 1; then
  "$PG_BIN/createdb" -h 127.0.0.1 -p 5433 grace
fi

"$PG_BIN/psql" -v ON_ERROR_STOP=1 -h 127.0.0.1 -p 5433 -d grace -c "CREATE EXTENSION IF NOT EXISTS vector"
"$PG_BIN/psql" -v ON_ERROR_STOP=1 -h 127.0.0.1 -p 5433 -d grace <<'SQL'
CREATE SCHEMA IF NOT EXISTS auth;
CREATE TABLE IF NOT EXISTS auth.users (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
LANGUAGE sql STABLE AS $$ SELECT NULL::uuid $$;
CREATE TABLE IF NOT EXISTS public._local_migrations (
  filename text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);
SQL

for migration in "$ROOT_DIR"/supabase/migrations/*.sql; do
  filename="$(basename "$migration")"
  # The standalone Node service starts at the canonical Grace v2 schema.
  # Earlier files are the legacy Supabase application schema and conflict
  # with v2's text user IDs and progressive phone-first onboarding.
  if [[ "$filename" < "20260507000001_grace_v2_core.sql" ]]; then
    continue
  fi
  # Supabase-only scheduler/network extensions are not needed by the local
  # request-path harness and are unavailable in stock Homebrew PostgreSQL.
  if [[ "$(basename "$migration")" == "20260411191126_45758a4f-c29b-4dca-90f8-78380e9e8df7.sql" ]]; then
    continue
  fi
  if "$PG_BIN/psql" -h 127.0.0.1 -p 5433 -d grace -Atqc "SELECT 1 FROM public._local_migrations WHERE filename = '$filename'" | grep -q 1; then
    continue
  fi
  # These are canonical v2 migrations. Fail immediately on the first SQL error:
  # marking a partially-applied migration as complete creates a local database
  # that looks ready but is missing tables/columns used by the API.
  "$PG_BIN/psql" -v ON_ERROR_STOP=1 -h 127.0.0.1 -p 5433 -d grace -f "$migration" >>"$LOCAL_DIR/migrations.log" 2>&1
  "$PG_BIN/psql" -v ON_ERROR_STOP=1 -h 127.0.0.1 -p 5433 -d grace -c "INSERT INTO public._local_migrations(filename) VALUES ('$filename')" >/dev/null
done

# The v1 Supabase table predates the standalone v2 API. v2 creates a user from
# the phone number first and fills profile fields during onboarding.
"$PG_BIN/psql" -v ON_ERROR_STOP=1 -h 127.0.0.1 -p 5433 -d grace <<'SQL'
ALTER TABLE public.users ALTER COLUMN first_name DROP NOT NULL;
ALTER TABLE public.users ALTER COLUMN medication DROP NOT NULL;
ALTER TABLE public.users ALTER COLUMN injection_day DROP NOT NULL;
ALTER TABLE public.users ALTER COLUMN wake_time DROP NOT NULL;
ALTER TABLE public.users ALTER COLUMN sleep_time DROP NOT NULL;
SQL

if ! "$REDIS_BIN/redis-cli" -p 6390 ping >/dev/null 2>&1; then
  "$REDIS_BIN/redis-server" --port 6390 --bind 127.0.0.1 --daemonize yes --dir "$LOCAL_DIR" --pidfile "$LOCAL_DIR/redis.pid" --logfile "$LOCAL_DIR/redis.log"
fi

echo "Local test services are ready."
echo "Postgres: postgresql://127.0.0.1:5433/grace"
echo "Redis:    redis://127.0.0.1:6390"
