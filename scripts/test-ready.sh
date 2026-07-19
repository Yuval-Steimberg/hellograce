#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="/opt/homebrew/opt/node@20/bin:$PATH"
export HARNESS_DATABASE_URL="postgresql://127.0.0.1:5433/grace"
export HARNESS_REDIS_URL="redis://127.0.0.1:6390"

cd "$ROOT_DIR"
bash scripts/setup-local-test.sh
corepack pnpm install --frozen-lockfile
corepack pnpm build
corepack pnpm test
bash scripts/smoke-local.sh
