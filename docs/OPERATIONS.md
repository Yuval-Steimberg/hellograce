# Grace — Operations Guide

Everything you need to go from zero to live users today.

---

## 1. What Grace does (30-second version)

Users text your WhatsApp number. Grace responds with personalized GLP-1 coaching:
meal ideas, hydration reminders, injection-day walkthroughs, mood tracking, and side-effect support.
Grace also texts *them* first — morning check-in every day, midday nudge 3x/week, and
evening wind-down 2x/week. No app required. Pure WhatsApp.

---

## 2. Subscription tiers

| Tier | What users get | Price |
|---|---|---|
| **Free trial** | Full access for 3 days | $0 |
| **Standard** | Daily check-ins, all 8 AI tools, injection flow, side-effect support | Your Stripe price |
| **Pro** | Everything + priority response (configure in Stripe) | Your Stripe price |

Stripe manages billing. Grace reads `is_paid`/`is_pro` from Postgres. Users who let their
trial expire get a soft paywall message instead of AI responses.

---

## 3. Infrastructure required

| Service | Purpose | Notes |
|---|---|---|
| PostgreSQL + pgvector | All data | Supabase works, or self-host |
| Redis | BullMQ workers + LLM cache | Docker or Upstash |
| Twilio | WhatsApp + SMS delivery | Need approved WhatsApp sender or sandbox |
| Gemini API | AI brain | `gemini-2.5-flash` |
| Stripe | Payments | Keys from v1 Supabase functions, reuse them |
| Node.js host | Run the API | Fly.io, Railway, Render, EC2 — anything |
| Web host | Onboarding + admin | Netlify, Vercel, Cloudflare Pages |

---

## 4. Deploy the API today

### 4a. Environment variables

Copy `services/api/.env.example` and fill in:

```env
NODE_ENV=production
PORT=3001
LOG_LEVEL=info

# The public URL your API will be reachable at (used for Twilio signature verification)
PUBLIC_BASE_URL=https://api.yourdomain.com

# Supabase Postgres (or your own PG URL)
DATABASE_URL=postgres://postgres:[password]@db.[project].supabase.co:5432/postgres
DATABASE_SSL=true

# Twilio
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_WHATSAPP_FROM=whatsapp:+14155238886   # your approved number or sandbox

# Gemini
GEMINI_API_KEY=AIzaSy...
GEMINI_MODEL=gemini-2.5-flash

# Redis
REDIS_URL=redis://localhost:6379   # or Upstash URL

# Admin dashboard password (any string you choose)
ADMIN_TOKEN=choose-a-long-random-string

# Feature flags
RAG_ENABLED=true
TOOLS_ENABLED=true
```

### 4b. Apply database migrations

If using Supabase, run in the Supabase SQL editor or via `psql`:

```bash
psql "$DATABASE_URL" -f supabase/migrations/20260507000001_grace_v2_core.sql
psql "$DATABASE_URL" -f supabase/migrations/20260507000002_grace_v2_phase4.sql
psql "$DATABASE_URL" -f supabase/migrations/20260507000003_grace_v2_users.sql
```

These are idempotent (`CREATE TABLE IF NOT EXISTS`) — safe to run multiple times.

### 4c. Deploy (example: Fly.io)

```bash
fly launch --name grace-api --region iad
fly secrets set DATABASE_URL="..." GEMINI_API_KEY="..." TWILIO_ACCOUNT_SID="..." \
  TWILIO_AUTH_TOKEN="..." TWILIO_WHATSAPP_FROM="whatsapp:+14155238886" \
  ADMIN_TOKEN="your-secret" REDIS_URL="rediss://..."
fly deploy
```

Or Railway / Render — just set the env vars in their dashboard and point at `services/api`.

### 4d. Seed the knowledge base (optional but recommended)

```bash
pnpm --filter @grace/api exec tsx scripts/seed-knowledge.ts
```

This embeds GLP-1 knowledge articles into pgvector so the RAG tool has content to retrieve.

---

## 5. Deploy the web app

### 5a. Environment variable

```env
VITE_API_URL=https://api.yourdomain.com
```

When `VITE_API_URL` is set, the onboarding form posts to your v2 API.
If it's missing, it falls back to the v1 Supabase edge function (backwards-compatible).

### 5b. Build + deploy

```bash
pnpm --filter @grace/web build
# dist/ → Netlify / Vercel / Cloudflare Pages / S3
```

Set `VITE_API_URL` as a build-time env var in your hosting dashboard.

---

## 6. Twilio webhook cutover (Phase 5)

This is the one remaining step to put v2 live for real users.

1. Log in to [console.twilio.com](https://console.twilio.com).
2. Go to **Messaging → Senders → WhatsApp Senders** (or Sandbox settings).
3. Change **"When a message comes in"** from:
   ```
   https://[project].supabase.co/functions/v1/handle-inbound-sms
   ```
   to:
   ```
   https://api.yourdomain.com/webhook/twilio
   ```
4. Set the method to `POST`.
5. Save.

That's it. All inbound WhatsApp messages now go to v2.

**Rollback**: change the URL back. The v1 Supabase function is still deployed and works.

**Smoke test before cutover**: use `POST /chat/send` to verify the AI is responding,
then send a test WhatsApp from a non-production number to confirm end-to-end.

---

## 7. Admin dashboard

Navigate to `https://yourapp.com/admin` (or `http://localhost:5173/admin` locally).

Login with the `ADMIN_TOKEN` value you set.

### Pages and what to do with them

**Metrics** — daily message volume, tool usage, cache hit rate, RLHF feedback signals.
Check this every morning. Red flags: p95 latency > 3s, ok_rate < 0.85 on any tool.

**Conversations** — view any user's message thread. Click a conversation → messages appear.
Toggle "Live" to stream new messages in real time via SSE.
Use this to spot bad AI responses or confused users.

**Users** — paginated list of all users. Search by phone, name, or medication.
- **Reset** button: wipes message history and embeddings. User profile stays intact.
  Use when a user wants a "fresh start" or you're debugging context issues.
- **Delete** button: GDPR hard delete. Removes user + all their data. Requires confirmation.

**RLHF Feedback** — rate responses 👍/👎. High volume of thumbs-down on a specific
intent = the prompt needs work. Use the Prompt Manager to fix it.

**Prompt Manager** — edit the system prompt that drives Grace's personality.
- Click "New version", write your improved prompt, save.
- Preview it in the right pane.
- Click "Set active" → immediately applies to all new conversations (no restart).
- Old versions are preserved for rollback.

**Tool Settings** — enable/disable individual tools, set priority order.
Turn off `log_food` if you're getting false positives. Turn off `knowledge_search`
if RAG retrieval is hurting latency. Changes apply immediately.

---

## 8. Managing subscriptions

The Stripe flow is handled by v1 Supabase edge functions — they're already live and working.
Grace v2 reads `is_paid` and `is_pro` from Postgres, which Stripe keeps up to date.

**To manually upgrade a user to paid** (e.g., comped accounts, testers):
```sql
UPDATE users SET is_paid = TRUE WHERE phone = '+15551234567';
```

**To extend a trial**:
```sql
UPDATE users SET trial_start = now() WHERE phone = '+15551234567';
```

**To pause a user** (stops proactive messages, allows replies):
```sql
UPDATE users SET paused = TRUE WHERE phone = '+15551234567';
```

**To block a user** (no messages in either direction):
```sql
UPDATE users SET blocked = TRUE WHERE phone = '+15551234567';
```

---

## 9. How a new user's journey works

```
1. User visits grace.com/onboarding
2. Fills in: name, medication, injection day, goals, wake/sleep times, food preferences, weight
3. Enters phone number → hits "Submit"
4. Grace API:
   a. Normalizes phone to E.164
   b. Creates user in DB with full profile
   c. Sets trial_start = now()
   d. Sends welcome WhatsApp immediately
5. User sees the PaymentStep
6. Enters card → Stripe creates subscription with 3-day free trial
7. Stripe confirm-checkout fires → is_paid = true (happens even in trial)
8. From now on, Grace texts them proactively and responds to their messages
9. After 3 days, Stripe charges the card automatically
10. If payment fails → Stripe webhook fires → is_paid = false → user gets paywall message
```

---

## 10. Testing before going live

```bash
# 1. Start the API locally
cd services/api && cp .env.example .env
# Fill in GEMINI_API_KEY + test Twilio credentials
pnpm dev

# 2. Test the onboarding API
curl -X POST http://localhost:3001/users/onboard \
  -H "Content-Type: application/json" \
  -d '{
    "firstName": "Yuval",
    "phone": "+15551234567",
    "medication": "Ozempic",
    "injectionDay": "Monday",
    "goals": ["Losing weight", "Eating enough protein"],
    "wakeTime": "07:00",
    "sleepTime": "22:00"
  }'

# 3. Test the AI
curl -X POST http://localhost:3001/chat/send \
  -H "Content-Type: application/json" \
  -d '{"userId":"+15551234567","text":"I just had chicken and rice for lunch"}'

# 4. Check admin
open http://localhost:3001/health
# Then open http://localhost:5173/admin with your ADMIN_TOKEN

# 5. Simulate a Twilio inbound (no actual Twilio needed)
curl -X POST http://localhost:3001/webhook/twilio \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "From=whatsapp%3A%2B15551234567&To=whatsapp%3A%2B14155238886&Body=How+am+I+doing+this+week%3F&MessageSid=SM123"
```

---

## 11. Monitoring in production

**Logs**: structured JSON via pino. In Docker: `docker logs grace-api-1 --follow`.
Key log lines to watch:
- `scheduler.sent` — proactive message fired
- `ai.handle.ok` — successful AI response (check `latencyMs`, `confidence`)
- `scheduler.send.failed` — a proactive message couldn't be sent
- `webhook.ai.failed` — AI failed to respond to an inbound message

**Health check**: `GET /health` returns `{"status":"ok","db":"ok"}`.
Set up an uptime monitor (Better Uptime, UptimeRobot) to ping this every minute.

**Admin metrics**: check `GET /admin/metrics` daily (or watch the dashboard).
Focus on `ok_rate` for tools and `p95_ms` latency.

---

## 12. Updating the AI prompt

In the admin dashboard → Prompt Manager:
1. Click **+ New version**
2. Edit the prompt in the textarea
3. Click **Save**
4. Preview the new version
5. Click **Set active**

Grace uses the new prompt immediately for all conversations. No restart needed.
The old prompt is saved for rollback.

---

## 13. Key files for ongoing development

| Task | File |
|---|---|
| Change AI behavior / personality | Admin → Prompt Manager |
| Add a new tool | `services/api/src/tools/` + register in `ai.service.ts` |
| Change scheduling logic | `services/api/src/scheduler/scheduler.ts` |
| Change proactive message templates | `services/api/src/scheduler/message-generator.ts` |
| Add an admin API endpoint | `services/api/src/routes/admin.ts` |
| Add an admin dashboard page | `apps/web/src/pages/admin/` + route in `App.tsx` + nav in `AdminLayout.tsx` |
| Update onboarding flow | `apps/web/src/pages/Onboarding.tsx` + step components in `src/components/onboarding/` |
