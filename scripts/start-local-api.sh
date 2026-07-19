#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$ROOT_DIR/services/api/.env"
export PATH="/opt/homebrew/opt/node@20/bin:$PATH"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing $ENV_FILE"
  exit 1
fi

if grep -q '^GEMINI_API_KEY=REPLACE_WITH_GEMINI_API_KEY$' "$ENV_FILE"; then
  echo "Add a Gemini API key to services/api/.env before live chat testing."
  echo "The deterministic readiness suite is already available via: pnpm test:ready"
  exit 2
fi

set -a
source "$ENV_FILE"
set +a
export LOCAL_TEST_MODE=true
export NODE_ENV=development

cd "$ROOT_DIR"
exec corepack pnpm --filter @grace/api dev
