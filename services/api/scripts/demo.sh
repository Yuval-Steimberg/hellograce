#!/usr/bin/env bash
# Investor demo — hits /chat/send with realistic GLP-1 user messages.
# Requires the api running on localhost:3001 (or set BASE_URL).
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3001}"
USER_ID="${USER_ID:-demo-investor-1}"

send() {
  local text="$1"
  echo
  echo "  USER: $text"
  curl -s -X POST "$BASE_URL/chat/send" \
    -H 'content-type: application/json' \
    -d "{\"userId\":\"$USER_ID\",\"text\":$(jq -Rs <<<"$text")}" \
    | jq -r '"GRACE [\(.intent), \(.confidence), \(.latencyMs)ms]: \(.reply)"'
  sleep 1
}

send "hey grace, just woke up. feeling a 7 today"
send "had eggs and yogurt for breakfast"
send "what's a good protein goal for me?"
send "weighed in at 192 today"
send "i think i forgot my shot yesterday — what do i do?"
send "i feel a little nauseous after my injection"
