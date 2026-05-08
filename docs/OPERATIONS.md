# Grace — Complete Operations Guide

---

## Table of contents

1. [How Grace works (architecture in plain English)](#1-how-grace-works)
2. [RAG and RLHF — does it always learn?](#2-rag-and-rlhf--does-it-always-learn)
3. [Every environment variable — where to find it](#3-every-environment-variable)
4. [Step-by-step: deploy the API](#4-step-by-step-deploy-the-api)
5. [Step-by-step: deploy the web app](#5-step-by-step-deploy-the-web-app)
6. [Step-by-step: Twilio webhook cutover](#6-step-by-step-twilio-webhook-cutover)
7. [Step-by-step: test everything locally first](#7-step-by-step-test-locally)
8. [Subscriptions — how they work end to end](#8-subscriptions)
9. [Admin dashboard — what every page does](#9-admin-dashboard)
10. [Managing users day-to-day](#10-managing-users)
11. [Updating the AI personality](#11-updating-the-ai-personality)
12. [Monitoring and alerts](#12-monitoring)
13. [Key files reference](#13-key-files)

---

## 1. How Grace works

```
User texts WhatsApp
        ↓
Twilio receives the message and calls your webhook URL (POST /webhook/twilio)
        ↓
Grace checks: is this user's trial or subscription still valid?
  → No  → Send paywall message. Stop.
  → Yes → Continue
        ↓
Grace loads the user's profile (name, medication, goals, behavioral flags)
        ↓
Safety check: is this a crisis/emergency message?
  → Yes → Send crisis resources. Stop.
  → No  → Continue
        ↓
RAG retrieval: embed the user's message, find the 5 most relevant past
conversations and knowledge articles from pgvector
        ↓
AI Orchestrator (Gemini 2.5 Flash):
  Planner decides which tools to use, in what order
  Tools run: food logging, weight tracking, side-effect detection, etc.
  Validator checks confidence and safety of the response
        ↓
Response sent via WhatsApp
        ↓
Background: message + embedding stored in Postgres (BullMQ worker)
```

**Proactive messages** (separate flow, runs every minute in the same process):

```
Scheduler ticks every 60 seconds
  → For each active user, checks their local time:
    - Is it their wake hour? → Send morning check-in
    - Mon/Wed/Fri 11am–2pm? → Send midday nudge
    - Tue/Thu/Sun 90min before sleep? → Send evening wind-down
    - Injection day? → Run injection flow (4 stages)
    - Reported a side effect 4h ago? → Send follow-up
  → Every day at 3am UTC → Run personalization engine
    (updates low_mood_mode, midday_skip flags based on reply patterns)
```

---

## 2. RAG and RLHF — does it always learn?

**Short answer: yes, continuously — but without retraining the base model.**

### RAG (Retrieval-Augmented Generation)

Every time a user sends a message, Grace:

1. Converts the message into a 768-dimension vector (using Gemini `text-embedding-004`)
2. Searches pgvector for the 5 most semantically similar entries in the `embeddings` table
3. Injects those entries as context into the prompt before calling Gemini

The `embeddings` table contains:
- **Every past conversation turn** for each user (automatically added via BullMQ worker after each response)
- **GLP-1 knowledge articles** (seeded via `scripts/seed-knowledge.ts`)

So the more a user chats, the richer the context pool becomes. Grace literally remembers
prior conversations and uses them to give more relevant, personal answers.

The retrieval query:
```sql
SELECT content,
       (1 - (embedding <=> query_vector)) + COALESCE(feedback_score, 0) * 0.05 AS score
FROM embeddings
WHERE user_id = $user OR user_id IS NULL   -- user's history + global knowledge
ORDER BY embedding <=> query_vector
LIMIT 5
```

### RLHF (Reinforcement Learning from Human Feedback)

Grace does not fine-tune or retrain Gemini. Instead, human feedback **shifts which
past responses surface in future retrievals**. Here's the exact mechanism:

```
Step 1: User chats → AI responds → response embedding stored with feedback_score = 0

Step 2: You (admin) review the response in the dashboard → 👍 or 👎

Step 3: 
  👍 → feedback_score += 1 on that embedding
  👎 → feedback_score -= 1 on that embedding

Step 4: Next time any user asks something semantically similar:
  Good response (score = +1) → ranks 5% higher in retrieval → surfaces as context
  Bad response (score = -1) → ranks 5% lower → fades from context
```

Over time, the context pool Grace retrieves from is shaped by which past responses
you've judged as good. The model sees better examples, produces better outputs,
those get rated up, and the cycle reinforces itself.

This happens automatically in the background every time you rate a response in the
admin dashboard. No deployment needed, no model training, no delay.

### What "always learning" looks like in practice

| Event | What updates |
|---|---|
| User sends a message | Their message embedding stored (future RAG context) |
| Grace responds | Response embedding stored (future RAG context) |
| Admin clicks 👍/👎 | `feedback_score` on that embedding shifts ±1 |
| User replies (implicit) | High reply rate → personalization engine raises their engagement score |
| User stops replying to midday | Personalization engine sets `midday_skip = true` → no more midday messages |
| Low average mood scores | `low_mood_mode = true` → Grace becomes extra gentle |

The Gemini model itself never changes. What changes is:
1. The **retrieval pool** (grows with every conversation)
2. The **retrieval ranking** (shaped by your ratings)
3. The **system prompt** (you update it via the Prompt Manager)
4. The **user profile flags** (updated nightly by the personalization engine)

---

## 3. Every environment variable

Full file: `services/api/.env.example`. Here's where to find each one.

---

### `NODE_ENV`
**Value**: `production` (for deployed), `development` (local)
**Where**: you set this. Controls log format (pretty vs JSON) and Twilio signature enforcement.

---

### `PORT`
**Value**: `3001` (default)
**Where**: you set this. Most hosting platforms set `PORT` automatically and override this.

---

### `LOG_LEVEL`
**Value**: `info` (recommended), `debug` (verbose), `warn` (quiet)
**Where**: you set this.

---

### `PUBLIC_BASE_URL`
**Value**: `https://api.yourdomain.com` — the public URL of your deployed API
**Where**: you decide this based on where you host. Examples:
- Fly.io: `https://grace-api.fly.dev`
- Railway: `https://grace-api.up.railway.app`
- Custom domain: `https://api.gracehealth.com`

**Why it matters**: Twilio sends this URL in the `X-Twilio-Signature` header for security.
Grace verifies the signature matches. If the URL is wrong, all webhooks will be rejected in production.

---

### `DATABASE_URL`
**Where to find it** (Supabase):
1. Go to [supabase.com/dashboard](https://supabase.com/dashboard)
2. Select your project
3. Click **Settings** (gear icon, left sidebar)
4. Click **Database**
5. Scroll to **Connection string** → select **URI** tab
6. Copy the URI — it looks like:
   `postgresql://postgres.[project-ref]:[password]@aws-0-us-east-1.pooler.supabase.com:6543/postgres`
7. Replace `[YOUR-PASSWORD]` with your actual DB password (set when you created the project)

**Important**: Use the **pooler** connection string (port 6543), not the direct one (port 5432),
for deployed environments. The pooler handles connection limits.

---

### `DATABASE_SSL`
**Value**: `true` for Supabase and most hosted Postgres. `false` only for local Docker Postgres.

---

### `TWILIO_ACCOUNT_SID`
**Where to find it**:
1. Go to [console.twilio.com](https://console.twilio.com)
2. Log in
3. On the **Console Dashboard** (home page), look at the top section labeled **Account Info**
4. Your Account SID starts with `AC` followed by 32 hex characters — copy it
   Example format: `AC` + 32 alphanumeric characters

---

### `TWILIO_AUTH_TOKEN`
**Where to find it**:
1. Same page as above (Console Dashboard)
2. Next to Account SID, there's **Auth Token** — click the eye icon to reveal it
3. Copy it
   It's 32 alphanumeric characters — treat it like a password

**Security**: treat this like a password. Never commit it to git.

---

### `TWILIO_WHATSAPP_FROM`
**Value format**: `whatsapp:+14155238886` (the `whatsapp:` prefix is required)

**Where to find it** (two scenarios):

**Scenario A — Twilio Sandbox (for testing, free)**:
1. Console → **Messaging** → **Try it out** → **Send a WhatsApp message**
2. The sandbox number is always `+14155238886`
3. Set: `TWILIO_WHATSAPP_FROM=whatsapp:+14155238886`
4. Users must first send "join [your-word]" to activate the sandbox

**Scenario B — Approved WhatsApp Business number (for production)**:
1. Console → **Messaging** → **Senders** → **WhatsApp Senders**
2. Your approved number appears here
3. Set it with the `whatsapp:` prefix: `TWILIO_WHATSAPP_FROM=whatsapp:+1XXXXXXXXXX`

---

### `TWILIO_FROM_NUMBER`
**Value**: Your Twilio SMS phone number (for SMS-only users, no WhatsApp prefix)
**Where**: Console → **Phone Numbers** → **Manage** → **Active Numbers** → copy the number

Leave blank if you're WhatsApp-only.

---

### `GEMINI_API_KEY`
**Where to find it**:
1. Go to [aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey)
2. Click **Create API key**
3. Select your Google Cloud project (or create a new one)
4. Copy the key — it starts with `AIzaSy`

**Cost**: Gemini 2.5 Flash is very cheap (~$0.075 per 1M input tokens). A typical Grace
conversation costs fractions of a cent.

---

### `GEMINI_MODEL`
**Value**: `gemini-2.5-flash` (default, recommended)
**Other options**: `gemini-2.0-flash` (faster, slightly less capable)
**Where**: you set this. Check [ai.google.dev/models](https://ai.google.dev/models) for current options.

---

### `REDIS_URL`
**Where to find it** (two options):

**Option A — Upstash (recommended for production, free tier available)**:
1. Go to [upstash.com](https://upstash.com) → **Create database**
2. Choose region closest to your API
3. After creation, go to the database → **Details** tab
4. Copy the **Redis URL** — it looks like:
   `rediss://default:AXXXxxxxxxxxxx@us1-xxx-xxxx-00000.upstash.io:6379`
5. Note: `rediss://` (with double s) = TLS-encrypted

**Option B — Local Docker** (dev only):
```bash
docker run -d -p 6379:6379 redis:7-alpine
```
URL: `redis://localhost:6379`

---

### `ADMIN_TOKEN`
**Where**: you generate this yourself. It's the password for the admin dashboard.

Generate a secure random token:
```bash
openssl rand -hex 32
# Example output: a3f8b2c1d9e7f6a5b4c3d2e1f0a9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f2a1
```

Set the same value in two places:
1. `services/api/.env` → `ADMIN_TOKEN=your-token`
2. When you log in to the admin dashboard at `/admin/login` → enter this token

---

### Stripe variables (optional for v2 — payments handled by v1 Supabase functions)

If you're using the existing Supabase deployment alongside v2, you don't need these.
The v1 Supabase edge functions (`create-checkout`, `confirm-checkout`, `stripe-webhook`)
handle all billing and update `is_paid`/`is_pro` in the shared Postgres DB.

Grace v2 just reads those values — no separate Stripe integration needed.

**If you want to run v2 standalone** (no Supabase at all), you'd need:

`STRIPE_SECRET_KEY`:
1. [dashboard.stripe.com](https://dashboard.stripe.com) → **Developers** → **API keys**
2. Copy the **Secret key** (starts with `sk_live_` for production, `sk_test_` for testing)

`STRIPE_WEBHOOK_SECRET`:
1. Dashboard → **Developers** → **Webhooks** → **Add endpoint**
2. Endpoint URL: `https://api.yourdomain.com/stripe/webhook`
3. Events to listen for: `customer.subscription.created`, `customer.subscription.updated`,
   `customer.subscription.deleted`, `invoice.payment_failed`
4. After creating, copy the **Signing secret** (starts with `whsec_`)

---

## 4. Step-by-step: deploy the API

### Option A — Fly.io (recommended)

**Prerequisites**: `brew install flyctl` (Mac) or [fly.io/docs/hands-on/install-flyctl](https://fly.io/docs/hands-on/install-flyctl)

```bash
# 1. Log in
fly auth login

# 2. From the repo root, create the app
fly launch --name grace-api --region iad --no-deploy

# 3. Set all secrets (one command, adjust values)
fly secrets set \
  NODE_ENV="production" \
  PUBLIC_BASE_URL="https://grace-api.fly.dev" \
  DATABASE_URL="postgres://postgres:[password]@db.[project].supabase.co:6543/postgres" \
  DATABASE_SSL="true" \
  TWILIO_ACCOUNT_SID="YOUR_TWILIO_SID" \
  TWILIO_AUTH_TOKEN="YOUR_TWILIO_TOKEN" \
  TWILIO_WHATSAPP_FROM="whatsapp:+14155238886" \
  GEMINI_API_KEY="AIzaSy..." \
  GEMINI_MODEL="gemini-2.5-flash" \
  REDIS_URL="rediss://default:xxx@xxx.upstash.io:6379" \
  ADMIN_TOKEN="your-32-char-random-string" \
  RAG_ENABLED="true" \
  TOOLS_ENABLED="true"

# 4. Deploy
fly deploy --config services/api/fly.toml
# (If fly.toml doesn't exist yet, fly launch created one — edit it to point to services/api/)
```

**Creating `services/api/fly.toml`** if it doesn't exist:
```toml
app = "grace-api"
primary_region = "iad"

[build]
  dockerfile = "Dockerfile"

[http_service]
  internal_port = 3001
  force_https = true
  auto_stop_machines = false
  auto_start_machines = true
  min_machines_running = 1
```

And a `services/api/Dockerfile`:
```dockerfile
FROM node:22-slim
WORKDIR /app
RUN npm install -g pnpm
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/ packages/
COPY services/api/ services/api/
RUN pnpm install --frozen-lockfile
RUN pnpm -r build
WORKDIR /app/services/api
EXPOSE 3001
CMD ["node", "dist/server.js"]
```

**Check it's running**:
```bash
curl https://grace-api.fly.dev/health
# → {"status":"ok","db":"ok"}
```

---

### Option B — Railway

1. Go to [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub repo**
2. Select your Grace repo
3. Set the **Root Directory** to `services/api`
4. Railway auto-detects Node.js and builds it
5. Go to **Variables** tab → add all env vars from `services/api/.env.example`
6. Set `PORT` = `3001` (Railway provides the port via `$PORT` automatically — this is a default)
7. Your URL will be something like `https://grace-api.up.railway.app`

---

### After deploying: apply migrations

Run these SQL files against your Supabase database. Two ways:

**Via Supabase SQL editor** (easiest):
1. [supabase.com/dashboard](https://supabase.com/dashboard) → your project → **SQL Editor**
2. Click **+ New query**
3. Paste the contents of `supabase/migrations/20260507000001_grace_v2_core.sql`
4. Click **Run**
5. Repeat for `...000002_grace_v2_phase4.sql` and `...000003_grace_v2_users.sql`

**Via psql** (if you have it installed):
```bash
export DATABASE_URL="postgres://postgres:[password]@db.[project].supabase.co:5432/postgres"
psql "$DATABASE_URL" -f supabase/migrations/20260507000001_grace_v2_core.sql
psql "$DATABASE_URL" -f supabase/migrations/20260507000002_grace_v2_phase4.sql
psql "$DATABASE_URL" -f supabase/migrations/20260507000003_grace_v2_users.sql
psql "$DATABASE_URL" -f supabase/migrations/20260508000001_rlhf_user_flags.sql
```

All migrations are idempotent (`CREATE TABLE IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS`) — safe to run multiple times.

---

### Seed the knowledge base

This step embeds GLP-1 knowledge articles into pgvector so the `knowledge_search`
tool has content to retrieve. Do this once after migrations:

```bash
GEMINI_API_KEY=your-key DATABASE_URL=your-url \
  pnpm --filter @grace/api exec tsx scripts/seed-knowledge.ts
```

Or if running locally with Docker:
```bash
docker compose up -d
pnpm --filter @grace/api exec tsx scripts/seed-knowledge.ts
```

---

## 5. Step-by-step: deploy the web app

The web app (`apps/web`) serves:
- The customer-facing marketing site + onboarding flow (`/onboarding`)
- The admin dashboard (`/admin`)

### Environment variable for the web app

Create `apps/web/.env.production`:
```env
VITE_API_URL=https://grace-api.fly.dev
```

When this is set, the onboarding form posts directly to your v2 API.
When it's missing, it falls back to the v1 Supabase edge function.

### Deploy to Netlify

1. [netlify.com](https://netlify.com) → **Add new site** → **Import an existing project**
2. Connect your GitHub repo
3. Set **Base directory** to `apps/web`
4. Set **Build command** to `pnpm build`
5. Set **Publish directory** to `apps/web/dist`
6. Under **Environment variables**, add:
   - `VITE_API_URL` = `https://grace-api.fly.dev` (your API URL)
7. Click **Deploy**

### Deploy to Vercel

```bash
cd apps/web
npx vercel --prod
# Follow prompts, set VITE_API_URL when asked for env vars
```

Or via Vercel dashboard: import repo, set root directory to `apps/web`,
add `VITE_API_URL` as environment variable.

---

## 6. Step-by-step: Twilio webhook cutover

This is the single step that sends real WhatsApp traffic to your v2 API.

### Before you do this

Make sure:
- [ ] API is deployed and `/health` returns `{"status":"ok","db":"ok"}`
- [ ] You've tested with `POST /chat/send` and got a good response
- [ ] Migrations are applied
- [ ] You've sent a test message through the webhook (see §7)

### The cutover

1. Log in to [console.twilio.com](https://console.twilio.com)

2. **If you use the WhatsApp sandbox** (for testing):
   - Go to **Messaging** → **Try it out** → **Send a WhatsApp message**
   - Scroll down to **Sandbox configuration**
   - Change **"When a message comes in"** to:
     ```
     https://grace-api.fly.dev/webhook/twilio
     ```
   - Method: `HTTP POST`
   - Save

3. **If you have an approved WhatsApp Business number** (production):
   - Go to **Messaging** → **Senders** → **WhatsApp Senders**
   - Click your number
   - Under **Messaging configuration**, change the webhook URL to:
     ```
     https://grace-api.fly.dev/webhook/twilio
     ```
   - Method: `HTTP POST`
   - Save

4. Send yourself a test WhatsApp message and verify Grace responds.

5. Watch the logs for 30 minutes:
   ```bash
   fly logs -a grace-api
   # Look for: scheduler.started, webhook.received, ai.handle.ok
   # Red flags: webhook.ai.failed, scheduler.send.failed
   ```

**Rollback**: change the webhook URL back to the Supabase function URL.
The v1 function is still deployed and working — it's a zero-downtime rollback.

---

## 7. Step-by-step: test locally

No Twilio account needed for most of this.

```bash
# Step 1: Install dependencies
pnpm install

# Step 2: Copy and fill env vars
cp services/api/.env.example services/api/.env
# Edit services/api/.env — minimum required for local testing:
#   DATABASE_URL=your-supabase-url
#   GEMINI_API_KEY=your-key
#   ADMIN_TOKEN=any-string-for-local

# Step 3: Start dependencies (Postgres + Redis) and API
docker compose up -d   # starts postgres + redis
pnpm --filter @grace/api dev

# Step 4: Apply migrations (only needed once)
psql "$DATABASE_URL" -f supabase/migrations/20260507000001_grace_v2_core.sql
psql "$DATABASE_URL" -f supabase/migrations/20260507000002_grace_v2_phase4.sql
psql "$DATABASE_URL" -f supabase/migrations/20260507000003_grace_v2_users.sql
psql "$DATABASE_URL" -f supabase/migrations/20260508000001_rlhf_user_flags.sql

# Step 5: Check the API is healthy
curl http://localhost:3001/health
# → {"status":"ok","db":"ok"}

# Step 6: Create a test user (this sends a welcome WhatsApp if Twilio is configured)
curl -X POST http://localhost:3001/users/onboard \
  -H "Content-Type: application/json" \
  -d '{
    "firstName": "Yuval",
    "phone": "+15551234567",
    "medication": "Ozempic",
    "injectionDay": "Monday",
    "goals": ["Losing weight", "Eating enough protein"],
    "wakeTime": "07:00",
    "sleepTime": "22:00",
    "foodDislikes": "broccoli",
    "currentWeight": 210,
    "goalWeight": 185,
    "timezone": "America/New_York"
  }'
# → {"ok":true,"userId":"...","phone":"+15551234567"}

# Step 7: Chat with Grace (no Twilio needed)
curl -X POST http://localhost:3001/chat/send \
  -H "Content-Type: application/json" \
  -d '{"userId":"+15551234567","text":"I just had chicken breast and brown rice"}'
# → {"reply":"...","intent":"...","confidence":"high","latencyMs":1234,"toolResults":[...]}

# Step 8: Simulate a Twilio inbound webhook (tests the full path)
curl -X POST http://localhost:3001/webhook/twilio \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "From=whatsapp%3A%2B15551234567&To=whatsapp%3A%2B14155238886&Body=How+much+protein+did+I+have+today%3F&MessageSid=SM123test&NumMedia=0"
# → responds with empty TwiML (AI work is async)

# Step 9: Open the admin dashboard
pnpm --filter @grace/web dev
# Go to http://localhost:5173/admin
# Enter your ADMIN_TOKEN when prompted
```

---

## 8. Subscriptions

### How the free trial works

When a user completes the onboarding form:
1. `POST /users/onboard` creates their profile and sets `trial_start = now()`
2. The web app shows them the PaymentStep (Stripe)
3. They enter their card → Stripe creates a subscription with a **3-day free trial**
4. No charge for 3 days
5. Day 3: Stripe charges the card and the subscription becomes `active`
6. Stripe fires a webhook → v1 Supabase function sets `is_paid = true` in Postgres
7. v2 API reads `is_paid = true` → full access continues uninterrupted

### What happens when a trial expires without payment

The subscription gate in `webhook.ts` checks:
```
is_paid = false  AND  is_pro = false  AND  trial_start older than 3 days
```

If all three are true, Grace sends this instead of the AI response:
```
Hi Yuval — your Grace trial has ended 🧡 To keep your daily check-ins going,
subscribe at grace.com. Questions? Reply HELP.
```

The proactive scheduler also stops sending them messages (they're not `is_paid`).

### Manual subscription management

Do this directly in Supabase SQL editor or psql:

```sql
-- Give someone free access (comped account, beta tester, influencer)
UPDATE users SET is_paid = TRUE WHERE phone = '+15551234567';

-- Extend a trial by 3 more days
UPDATE users SET trial_start = now() WHERE phone = '+15551234567';

-- Mark as Pro
UPDATE users SET is_paid = TRUE, is_pro = TRUE WHERE phone = '+15551234567';

-- Pause (stops proactive messages, they can still reply)
UPDATE users SET paused = TRUE WHERE phone = '+15551234567';

-- Block completely (ignores all messages)
UPDATE users SET blocked = TRUE WHERE phone = '+15551234567';

-- Reactivate
UPDATE users SET paused = FALSE, blocked = FALSE WHERE phone = '+15551234567';
```

### Stripe price IDs (for your reference)

| Plan | Stripe Price ID |
|---|---|
| Standard (monthly) | `price_1TLha4E0DcWyPH4X2QxV9hh3` |
| Pro (monthly) | `price_1TLla9E0DcWyPH4XZnep2X7G` |

These are in the Supabase `create-checkout` and `stripe-webhook` functions.
Change them there if you create new Stripe prices.

---

## 9. Admin dashboard

Access at `https://yourapp.com/admin` (login with your `ADMIN_TOKEN`).

---

### Metrics page

Shows a 24-hour snapshot:
- **Messages sent** — how many conversations happened today
- **Tool usage** — which tools fired, success rate, p95 latency
- **Cache hit rate** — how well Redis is reducing Gemini API calls
- **RLHF feedback breakdown** — ratings, corrections, drop-offs from the last 7 days

Auto-refreshes every 30 seconds. Check this daily.

**Red flags to watch:**
- Tool `ok_rate` below 0.85 → a tool is breaking (check logs)
- p95 latency above 4000ms → Gemini is slow or a tool is timing out
- Cache hit rate below 0.3 → either not enough traffic yet, or cache isn't working

---

### Conversations page

Left panel: all active conversations, sorted by last message time.
Click any conversation to see the full message thread.

Toggle **Live** to stream new messages in real time via SSE — useful when debugging
a specific user's experience.

Use this to:
- Spot confusing or wrong AI responses
- See what your users are actually asking about
- Identify missing knowledge (if Grace often says "I don't know" → add to knowledge base)

---

### Users page

Full paginated user list. Search by phone number, name, or medication.

| Button | What it does |
|---|---|
| **RLHF off / RLHF on** | Toggles whether this user sees in-chat rating prompts (👍/👎) after each AI response. When on (amber), their ratings flow into `feedback_score` on embeddings — shaping future RAG retrieval. Enable this for engaged, technically curious users who want to help improve Grace. |
| **Reset** | Deletes messages, conversations, and embeddings for this user. Their profile (medication, goals, etc.) stays. Use when a user wants a fresh start or you're debugging. |
| **Delete** | Permanently removes the user and all their data (GDPR). Two-click confirm required. |

**Who to enable RLHF for:**
- Beta testers or early adopters who are highly engaged
- Users who have explicitly said they want to help improve the product
- Never enable for users who haven't agreed — the rating prompt adds visual noise to every message

**What opted-in users see** after each AI response:
```
_Rate this response: reply 👍 or 👎, or reply FEEDBACK: your comment_
```

They reply 👍, 👎, or `FEEDBACK: it gave me the wrong protein goal` — Grace intercepts
it, records the signal, adjusts the embedding score, and acknowledges before moving on.

---

### RLHF Feedback page

This is how you train Grace without touching code.

**How to use it:**
1. Browse the list of recent AI responses
2. For responses that are wrong, unhelpful, or off-brand → click 👎
3. For responses that are excellent → click 👍
4. That's it — the RLHF system handles the rest

**What happens internally:**
- 👍 on a response → its embedding's `feedback_score` increases by 1
- 👎 → `feedback_score` decreases by 1
- Future retrieval ranks that response 5% higher/lower per point
- Over time, Grace's context pool is shaped by your ratings

**What to rate:**
- Wrong nutrition facts → 👎
- Perfect injection-day handling → 👍
- Generic non-personalized response → 👎
- Response that used the user's name and goals naturally → 👍

Spend 10-15 minutes per week rating responses. The improvement compounds.

---

### Prompt Manager page

Left column: all saved prompt versions, newest first. Each shows version number and active status.

**To update Grace's personality:**
1. Click **+ New version**
2. Edit the prompt in the text area
3. Click **Save**
4. Read it over in the preview pane on the right
5. Click **Set active**

Grace uses the new prompt immediately for all new conversations. No restart needed.
Old versions are saved for rollback — click **Set active** on any previous version to revert.

**What to put in the prompt:**
- Grace's name, tone, and personality
- What Grace should always/never do
- Any brand-specific language or disclaimers
- The GLP-1 focus areas

The user's personal context (name, medication, goals, etc.) is added automatically
on top of this prompt for each user — don't include user-specific info in the base prompt.

---

### Tool Settings page

Each tool has:
- **Toggle** (on/off) — applies immediately, no restart
- **Priority** (number) — lower number = runs first when multiple tools are relevant

**When to disable a tool:**
- `log_food` producing too many false positives → disable temporarily
- `knowledge_search` adding latency with low-quality results → disable while you improve the knowledge base
- A tool consistently failing (ok_rate < 0.5 in Metrics) → disable, investigate, fix, re-enable

---

## 10. Managing users

### Viewing a user's data

In the admin dashboard → Users page, click their row to see their profile.
For their full message history, go to Conversations page and find their conversation.

### Setting up a test account for yourself

```bash
curl -X POST https://api.yourdomain.com/users/onboard \
  -H "Content-Type: application/json" \
  -d '{
    "firstName": "Your Name",
    "phone": "+1YOURNUMBER",
    "medication": "Ozempic",
    "injectionDay": "Monday",
    "goals": ["Losing weight"],
    "wakeTime": "07:00",
    "sleepTime": "22:00"
  }'
```

You'll receive a welcome WhatsApp immediately, then morning messages starting the next day.

To get unlimited access without going through Stripe:
```sql
UPDATE users SET is_paid = TRUE WHERE phone = '+1YOURNUMBER';
```

### Giving team members access to the admin dashboard

The admin dashboard uses a single shared token. Share the `ADMIN_TOKEN` value with
team members — they log in at `yourapp.com/admin`.

For proper multi-user auth with individual accounts, upgrade to Supabase Auth roles
(see CLAUDE.md § deferred items).

---

## 11. Updating the AI personality

Three levers, in order of ease:

**1. Prompt Manager** (easiest, immediate, no code):
Go to admin → Prompt Manager → create a new version → set active.
This controls Grace's tone, focus areas, and persona.

**2. RLHF ratings** (ongoing, compounds over time):
Rate responses in the Feedback page. Shapes what context Grace retrieves.

**3. Message templates** (requires code change + deploy):
The proactive messages (morning, midday, injection, etc.) use templates in
`services/api/src/scheduler/message-generator.ts`.
The `FALLBACKS` object contains per-type templates. Edit them, deploy.

---

## 12. Monitoring

### Health check

Set up an uptime monitor (Better Uptime, UptimeRobot, or Fly.io's built-in) to
ping `GET /health` every 60 seconds. It returns `{"status":"ok","db":"ok"}`.
Alert if it fails 2 checks in a row.

### Logs

```bash
# Fly.io
fly logs -a grace-api

# Docker (local)
docker logs grace-api-1 --follow
```

**Important log lines:**

| Log key | Meaning |
|---|---|
| `scheduler.started` | App booted successfully, cron running |
| `scheduler.sent` | Proactive message sent (check phone + type) |
| `scheduler.send.failed` | Proactive message failed — check Twilio |
| `webhook.received` | Inbound message arrived from Twilio |
| `ai.handle.ok` | AI responded successfully (check latencyMs) |
| `webhook.ai.failed` | AI failed to respond — user got no reply |
| `personalization.engine.done` | Nightly personalization ran |
| `user.onboarded` | New user signed up |

### Weekly review checklist

- [ ] Open admin Metrics — check ok_rates and latency
- [ ] Open admin Conversations — read 5–10 random recent conversations
- [ ] Open admin Feedback — rate 10–20 responses (👍/👎)
- [ ] Check uptime monitor — any downtime?
- [ ] Check Stripe dashboard — any failed payments?
- [ ] Check `GET /admin/users` count — is it growing?

---

## 13. Key files reference

| Task | File |
|---|---|
| Change AI personality | Admin → Prompt Manager (no code) |
| Add a new tool | `services/api/src/tools/[name].ts` + register in `services/api/src/services/ai.service.ts` |
| Change scheduling windows | `services/api/src/scheduler/scheduler.ts` |
| Change proactive message text | `services/api/src/scheduler/message-generator.ts` |
| Add an admin API endpoint | `services/api/src/routes/admin.ts` |
| Add an admin dashboard page | `apps/web/src/pages/admin/[Name]Page.tsx` + add route in `apps/web/src/App.tsx` + add nav link in `apps/web/src/components/admin/AdminLayout.tsx` |
| Add an onboarding step | `apps/web/src/components/onboarding/` + add step in `apps/web/src/pages/Onboarding.tsx` |
| Change trial length | `services/api/src/routes/webhook.ts` → `TRIAL_DAYS` constant |
| Change paywall message | `services/api/src/routes/webhook.ts` → `isAccessAllowed()` block |
| Add a new knowledge article | `pnpm --filter @grace/api exec tsx scripts/seed-knowledge.ts` (add content to the script) |
| Upgrade base AI model | `GEMINI_MODEL` env var |
