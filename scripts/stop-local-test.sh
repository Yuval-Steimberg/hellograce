#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PG_BIN="/opt/homebrew/opt/postgresql@17/bin"
PG_DIR="$ROOT_DIR/.local/postgres"

if [[ -f "$PG_DIR/PG_VERSION" ]] && "$PG_BIN/pg_ctl" -D "$PG_DIR" status >/dev/null 2>&1; then
  "$PG_BIN/pg_ctl" -D "$PG_DIR" stop -m fast
fi

/opt/homebrew/opt/redis/bin/redis-cli -p 6390 shutdown nosave >/dev/null 2>&1 || true
echo "Local test services stopped."
