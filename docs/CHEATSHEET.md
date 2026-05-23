# Grace — Maintenance Cheatsheet

Set `ADMIN_TOKEN` once in your terminal session before running admin commands:
```bash
export ADMIN_TOKEN=your_token_here
```

---

## DEPLOY TO PRODUCTION

```bash
# Pull latest code then deploy the main API
cd ~/Desktop/Grace/Grace
git pull origin claude/icloud-access-clarification-5hsRr
fly deploy --app grace-api

# Watch deployment logs in real time
fly logs --app grace-api

# Check deployment status
fly status --app grace-api

# Restart the API (useful if it hung or you changed secrets)
fly machine restart --app grace-api
```

---

## GIT / CODE WORKFLOW

```bash
# See what's changed
git status
git log --oneline -10
git diff

# Stage, commit, and push a fix
git add -p                          # review changes interactively
git commit -m "fix: short description"
git push -u origin claude/icloud-access-clarification-5hsRr

# Pull latest from the remote (sync with Claude Code changes)
git pull origin claude/icloud-access-clarification-5hsRr
```

---

## TESTING

```bash
# Run ALL tests (220 tests across api + ai-core)
cd ~/Desktop/Grace/Grace
pnpm test

# Run only API tests
pnpm --filter @grace/api test

# Run only AI-core tests
pnpm --filter @grace/ai-core test

# Run a single test file by name
pnpm --filter @grace/api test -- guard.test
pnpm --filter @grace/ai-core test -- -t "planner"

# Type-check everything (catches TS errors without building)
pnpm -r typecheck

# Build everything
pnpm -r build
```

---

## EVAL HARNESS (AI accuracy check)

```bash
# Run all 50+ GLP-1 accuracy/safety test cases
cd ~/Desktop/Grace/Grace
GEMINI_API_KEY=your_key pnpm --filter @grace/api eval

# Run only food-related cases, 5 at a time
EVAL_FILTER=food EVAL_CONCURRENCY=5 pnpm --filter @grace/api eval

# Results saved to: services/api/eval/results/<timestamp>.json
```

---

## VERIFY PRODUCTION IS ALIVE

```bash
# Health check
curl https://grace-api.fly.dev/health

# Send a test WhatsApp message through the API (no real Twilio needed)
curl -X POST https://grace-api.fly.dev/chat/send \
  -H "Content-Type: application/json" \
  -d '{"userId":"+15551234567","text":"Tell me about muscle loss on GLP-1"}'

# Check admin metrics (messages, tools, users today)
curl -s https://grace-api.fly.dev/admin/metrics \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq .
```

---

## MANAGE USERS

```bash
# List all users
curl -s "https://grace-api.fly.dev/admin/users?limit=20" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq .

# Get a specific user by phone
curl -s https://grace-api.fly.dev/admin/users/+972547722420 \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq .

# Update a user field (e.g. fix timezone)
curl -X PUT https://grace-api.fly.dev/admin/users/+972547722420 \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"timezone": "Asia/Jerusalem"}'

# Mark user as paid
curl -X PUT https://grace-api.fly.dev/admin/users/+972547722420 \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"is_paid": true}'

# Reset a user's memory (wipes messages + embeddings)
curl -X POST https://grace-api.fly.dev/admin/users/+972547722420/reset-memory \
  -H "Authorization: Bearer $ADMIN_TOKEN"

# Hard-delete a user and all their data (GDPR)
curl -X DELETE https://grace-api.fly.dev/admin/users/+972547722420 \
  -H "Authorization: Bearer $ADMIN_TOKEN"

# Toggle RLHF ratings on/off for a user
curl -X PUT https://grace-api.fly.dev/admin/users/+972547722420/rlhf \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"enabled": true}'
```

---

## CONTENT RULES (AI guardrails)

```bash
# List all active content rules
curl -s "https://grace-api.fly.dev/admin/content-rules" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq .

# Test a phrase against all active rules
curl -s -X POST https://grace-api.fly.dev/admin/content-rules/test \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"text":"You could take an extra dose to make up for it"}' | jq .

# Add a new rule
curl -X POST https://grace-api.fly.dev/admin/content-rules \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"rule_type":"content","pattern":"dangerous phrase","is_regex":false,"reason":"Why it is bad","severity":"block","applies_to":"all"}'

# Disable a rule by ID
curl -X DELETE https://grace-api.fly.dev/admin/content-rules/5 \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

---

## SYSTEM PROMPT MANAGEMENT

```bash
# List all prompt versions
curl -s https://grace-api.fly.dev/admin/prompts \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq .

# Activate a specific prompt version (hot-swap without restart)
curl -X PUT https://grace-api.fly.dev/admin/prompts/3/activate \
  -H "Authorization: Bearer $ADMIN_TOKEN"

# Hot-reload prompt from disk without redeploying (local Docker only)
docker kill --signal HUP grace-api-1
```

---

## TOOL SETTINGS

```bash
# See all tools and their enabled/disabled status
curl -s https://grace-api.fly.dev/admin/tool-settings \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq .

# Disable a specific tool (e.g. search_food_ideas)
curl -X PUT https://grace-api.fly.dev/admin/tool-settings/search_food_ideas \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"enabled": false}'
```

---

## CONVERSATIONS & FEEDBACK

```bash
# See recent conversations
curl -s https://grace-api.fly.dev/admin/conversations \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq .

# See messages for a specific user
curl -s https://grace-api.fly.dev/admin/conversations/+972547722420/messages \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq .

# See RLHF feedback (thumbs up/down ratings)
curl -s https://grace-api.fly.dev/admin/feedback \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq .
```

---

## FLY SECRETS (environment variables in production)

```bash
# See all secrets (names only, not values)
fly secrets list --app grace-api

# Set a single secret
fly secrets set --app grace-api SOME_KEY="some_value"

# Set multiple secrets from a file
fly secrets import --app grace-api < /tmp/secrets.env

# Update DATABASE_URL after rotating DB password
fly secrets set --app grace-api DATABASE_URL="postgresql://postgres.PROJECT_ID:NEW_PASSWORD@aws-1-ap-northeast-1.pooler.supabase.com:6543/postgres"
```

---

## LOCAL DEV (Docker)

```bash
cd ~/Desktop/Grace/Grace

# Start everything (Postgres + Redis + API on :3001)
docker compose up -d

# Stop everything
docker compose down

# See API logs
docker compose logs -f api

# Re-seed the GLP-1 knowledge base
GEMINI_API_KEY=your_key pnpm --filter @grace/api exec tsx scripts/seed-knowledge.ts

# Local test chat (no Twilio)
curl -X POST http://localhost:3001/chat/send \
  -H "Content-Type: application/json" \
  -d '{"userId":"+15551234567","text":"I just had chicken and rice"}'

# Local health check
curl http://localhost:3001/health
```

---

## DATABASE MIGRATIONS (Supabase)

Run in Supabase SQL Editor at supabase.com → project → SQL Editor:
```sql
-- Run each in order if setting up a new DB
-- Paste content of each file and execute
supabase/migrations/20260507000001_grace_v2_core.sql
supabase/migrations/20260507000002_grace_v2_phase4.sql
supabase/migrations/20260507000003_grace_v2_users.sql
supabase/migrations/20260508000001_rlhf_user_flags.sql
supabase/migrations/20260513000001_prompt_optimizer_columns.sql
supabase/migrations/20260513000002_protein_personalization.sql
supabase/migrations/20260513000003_glp1_start_date.sql
supabase/migrations/20260516000005_content_rules.sql   -- run with "No limit" toggle OFF
```

Verify content rules were seeded:
```sql
SELECT severity, COUNT(*) FROM content_rules GROUP BY severity;
-- Expected: block: 4, regen: 44
```

---

## URLS

| What | URL |
|---|---|
| Production API | https://grace-api.fly.dev |
| Admin dashboard | https://grace-admin-silk.vercel.app/admin |
| Onboarding flow | https://grace-admin-silk.vercel.app |
| Health check | https://grace-api.fly.dev/health |
| Twilio webhook | https://grace-api.fly.dev/webhook/twilio |
| Fly dashboard | https://fly.io/apps/grace-api |
| Supabase DB | https://supabase.com/dashboard/project/uifadtlktpddtfohwxfi |
