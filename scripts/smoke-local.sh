#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PG_BIN="/opt/homebrew/opt/postgresql@17/bin"
REDIS_BIN="/opt/homebrew/opt/redis/bin"

"$PG_BIN/psql" -v ON_ERROR_STOP=1 -h 127.0.0.1 -p 5433 -d grace -Atqc \
  "SELECT extversion FROM pg_extension WHERE extname='vector'" | grep -Eq '^[0-9]'
"$PG_BIN/psql" -v ON_ERROR_STOP=1 -h 127.0.0.1 -p 5433 -d grace -Atqc \
  "SELECT to_regclass('public.users'), to_regclass('public.messages'), to_regclass('public.food_logs')" | grep -q 'users'
"$REDIS_BIN/redis-cli" -p 6390 ping | grep -q PONG

cd "$ROOT_DIR"
export PATH="/opt/homebrew/opt/node@20/bin:$PATH"
corepack pnpm --filter @grace/api exec vitest run \
  src/config/env.test.ts \
  src/services/full-system-verification.test.ts \
  src/services/nudge-prompt.test.ts \
  src/services/latency-tracker.test.ts

echo "Local unified-system smoke test passed."
