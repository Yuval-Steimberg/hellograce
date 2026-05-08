# Grace — Zero-to-Production Deployment Guide

This guide takes you from a blank machine to a fully running production system.
Follow every step in order. Each section ends with a verification command so you
know it worked before moving on.

---

## Part 0 — Accounts to create before you start

Open all five of these and keep the tabs open — you'll come back to each.

| Service | What it's for | Sign-up URL |
|---|---|---|
| **Supabase** | Postgres database (all user data, embeddings, messages) | supabase.com |
| **Twilio** | WhatsApp/SMS sending and receiving | twilio.com |
| **Google AI Studio** | Gemini API key (the AI brain) | aistudio.google.com |
| **Upstash** | Redis (job queues, caching) | upstash.com |
| **Fly.io** | Hosting for the API server | fly.io |

Optional but recommended:
| **Netlify or Vercel** | Hosting for the web app (admin dashboard + onboarding) | netlify.com / vercel.com |
| **Stripe** | Payments (if not using the existing v1 Supabase billing) | stripe.com |

---

## Part 1 — Collect all credentials

Go through each service and copy the values shown. You will paste them all into
a single `.env` file in Part 3.

---

### 1.1 Supabase — database URL

1. Go to [supabase.com/dashboard](https://supabase.com/dashboard)
2. Click **New project** → fill in the form → click **Create new project**
   - Remember the **database password** you set — you need it in step 5
3. Wait ~2 minutes for the project to provision
4. In the left sidebar, click **Settings** (gear icon)
5. Click **Database**
6. Scroll down to **Connection string** → click the **URI** tab
7. Copy the connection string — it looks like:
   ```
   postgresql://postgres.[ref]:[YOUR-PASSWORD]@aws-0-us-east-1.pooler.supabase.com:6543/postgres
   ```
8. Replace `[YOUR-PASSWORD]` with the password from step 2
9. Save it — this is your `DATABASE_URL`

> **Use port 6543 (pooler), not port 5432.** The pooler handles connection limits for a hosted server.

---

### 1.2 Twilio — Account SID, Auth Token, WhatsApp number

1. Go to [console.twilio.com](https://console.twilio.com)
2. On the home page under **Account Info**, you will see:
   - **Account SID** — starts with `AC`, 34 characters. Copy it → `TWILIO_ACCOUNT_SID`
   - **Auth Token** — click the eye icon to reveal it. 32 characters. Copy it → `TWILIO_AUTH_TOKEN`

**Get a WhatsApp sender (two paths):**

**Path A — Sandbox (free, for testing first)**
1. Console → **Messaging** → **Try it out** → **Send a WhatsApp message**
2. The sandbox number is always `+14155238886`
3. Set: `TWILIO_WHATSAPP_FROM=whatsapp:+14155238886`
4. Note: each user you test with must first text "join [your-sandbox-word]" to that number before Grace can message them

**Path B — Production approved number**
1. Console → **Messaging** → **Senders** → **WhatsApp Senders**
2. Click **Request access** → fill in the business profile → submit
3. Approval takes 1–7 days
4. Once approved, your number appears in the list
5. Set: `TWILIO_WHATSAPP_FROM=whatsapp:+1XXXXXXXXXX`

---

### 1.3 Google AI Studio — Gemini API key

1. Go to [aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey)
2. Click **Create API key**
3. Select an existing Google Cloud project or create a new one
4. Copy the key — starts with `AIzaSy`
5. Save it → `GEMINI_API_KEY`

> Gemini 2.5 Flash costs ~$0.075 per million input tokens. 100 active users costs roughly $5–15/month.

---

### 1.4 Upstash — Redis URL

1. Go to [upstash.com](https://upstash.com) → **Sign up** → **Create database**
2. Name: `grace-redis`, Region: pick the one closest to your API host
3. After creation, click the database → **Details** tab
4. Copy the **Redis URL** — looks like:
   ```
   rediss://default:AXXXxxxxxxxxxx@us1-xxx-xxxx-00000.upstash.io:6379
   ```
   Note the double `s` in `rediss://` — that's TLS encryption, keep it.
5. Save it → `REDIS_URL`

---

### 1.5 Admin token — generate it yourself

This is the password for the admin dashboard. Generate one now:

```bash
openssl rand -hex 32
```

Copy the output (64 hex characters). Save it → `ADMIN_TOKEN`

You'll enter this same string when you log into the admin dashboard at `/admin/login`.

---

### 1.6 Fly.io setup (API hosting)

Install the CLI:

```bash
# Mac
brew install flyctl

# Linux / WSL
curl -L https://fly.io/install.sh | sh

# Windows (PowerShell)
iwr https://fly.io/install.ps1 -useb | iex
```

Log in:

```bash
fly auth login
```

A browser window opens. Log in or sign up, then return to the terminal.

---

## Part 2 — Get the code

```bash
git clone https://github.com/yuval-steimberg/grace.git
cd Grace
```

Install dependencies:

```bash
# Install pnpm if you don't have it
npm install -g pnpm

# Install all workspace dependencies
pnpm install
```

---

## Part 3 — Create the environment file

```bash
cp services/api/.env.example services/api/.env
```

Open `services/api/.env` in any text editor and fill in every value:

```bash
# ─── Required ─────────────────────────────────────────────────────────────────
NODE_ENV=production
PORT=3001
LOG_LEVEL=info

# The public URL where your API will be deployed (Part 5 tells you this URL)
# Fill this in after you finish Part 5 and know the URL
PUBLIC_BASE_URL=https://grace-api.fly.dev

# ─── Database (from Part 1.1) ─────────────────────────────────────────────────
DATABASE_URL=postgresql://postgres.[ref]:[password]@aws-0-us-east-1.pooler.supabase.com:6543/postgres
DATABASE_SSL=true

# ─── Twilio (from Part 1.2) ───────────────────────────────────────────────────
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_WHATSAPP_FROM=whatsapp:+14155238886
# Leave blank if WhatsApp-only:
TWILIO_FROM_NUMBER=

# ─── Gemini (from Part 1.3) ───────────────────────────────────────────────────
GEMINI_API_KEY=AIzaSy...
GEMINI_MODEL=gemini-2.5-flash

# ─── Redis (from Part 1.4) ────────────────────────────────────────────────────
REDIS_URL=rediss://default:xxx@xxx.upstash.io:6379

# ─── Admin (from Part 1.5) ────────────────────────────────────────────────────
ADMIN_TOKEN=your64hexcharacterstring

# ─── Feature flags ────────────────────────────────────────────────────────────
RAG_ENABLED=true
TOOLS_ENABLED=true
```

Save the file. Do not commit this file to git — it contains secrets.

---

## Part 4 — Set up the database

### 4.1 Apply migrations

These create all the tables Grace needs. Run them in order:

```bash
# Export your database URL as a shell variable
export DATABASE_URL="postgresql://postgres.[ref]:[password]@aws-0-us-east-1.pooler.supabase.com:5432/postgres"
# Note: use port 5432 (direct) for running migrations, not 6543 (pooler)

# Apply all four migration files
psql "$DATABASE_URL" -f supabase/migrations/20260507000001_grace_v2_core.sql
psql "$DATABASE_URL" -f supabase/migrations/20260507000002_grace_v2_phase4.sql
psql "$DATABASE_URL" -f supabase/migrations/20260507000003_grace_v2_users.sql
psql "$DATABASE_URL" -f supabase/migrations/20260508000001_rlhf_user_flags.sql
```

If you don't have `psql` installed:

```bash
# Mac
brew install postgresql

# Ubuntu/Debian
sudo apt install postgresql-client

# Windows: download from postgresql.org/download/windows/ — install "Command Line Tools" only
```

**Alternative — use Supabase SQL editor (no psql needed):**
1. [supabase.com/dashboard](https://supabase.com/dashboard) → your project → **SQL Editor** (left sidebar)
2. Click **+ New query**
3. Open `supabase/migrations/20260507000001_grace_v2_core.sql` in a text editor, copy everything, paste it in, click **Run**
4. Repeat for the other three migration files in order

**Verify migrations worked:**
```bash
psql "$DATABASE_URL" -c "\dt"
# You should see: conversations, embeddings, feedback, food_logs,
# injections, messages, prompts, tool_logs, tool_settings, users, weight_logs
```

### 4.2 Seed the knowledge base

This loads GLP-1 articles into the embeddings table so Grace can answer
medication questions intelligently. Run once:

```bash
GEMINI_API_KEY=AIzaSy... DATABASE_URL="$DATABASE_URL" \
  pnpm --filter @grace/api exec tsx scripts/seed-knowledge.ts
```

Expected output:
```
Seeding knowledge base…
Embedded: "What is semaglutide and how does it work?"
Embedded: "Managing nausea on GLP-1 medications"
... (15-20 articles)
Done. 18 articles embedded.
```

---

## Part 5 — Deploy the API to Fly.io

### 5.1 Create the app

From the repo root:

```bash
fly launch \
  --name grace-api \
  --region iad \
  --no-deploy \
  --copy-config
```

When asked "Would you like to copy its configuration to the new app?", say **yes**.
When asked about Postgres or Redis add-ons, say **no** (you're using Supabase + Upstash).

### 5.2 Create the Dockerfile

```bash
cat > services/api/Dockerfile << 'EOF'
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
EOF
```

### 5.3 Create the Fly config

```bash
cat > services/api/fly.toml << 'EOF'
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

[[vm]]
  memory = "512mb"
  cpu_kind = "shared"
  cpus = 1

[checks]
  [checks.alive]
    grace_period = "10s"
    interval = "30s"
    method = "get"
    path = "/health"
    timeout = "5s"
    type = "http"
EOF
```

> `auto_stop_machines = false` and `min_machines_running = 1` are what keep Grace running non-stop.
> The scheduler (proactive messages) needs a continuously running process — not serverless.

### 5.4 Set all secrets on Fly

Copy this block, fill in your values, and run it all as one command:

```bash
fly secrets set \
  NODE_ENV="production" \
  LOG_LEVEL="info" \
  PUBLIC_BASE_URL="https://grace-api.fly.dev" \
  DATABASE_URL="postgresql://postgres.[ref]:[password]@aws-0-us-east-1.pooler.supabase.com:6543/postgres" \
  DATABASE_SSL="true" \
  TWILIO_ACCOUNT_SID="ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" \
  TWILIO_AUTH_TOKEN="xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" \
  TWILIO_WHATSAPP_FROM="whatsapp:+14155238886" \
  TWILIO_FROM_NUMBER="" \
  GEMINI_API_KEY="AIzaSy..." \
  GEMINI_MODEL="gemini-2.5-flash" \
  REDIS_URL="rediss://default:xxx@xxx.upstash.io:6379" \
  ADMIN_TOKEN="your64hexcharacterstring" \
  RAG_ENABLED="true" \
  TOOLS_ENABLED="true"
```

Verify they were set:
```bash
fly secrets list
# Should list all the variable names (values are hidden)
```

### 5.5 Deploy

```bash
fly deploy --config services/api/fly.toml
```

This builds the Docker image and deploys it. Takes 3–5 minutes the first time.

**Verify it's running:**
```bash
curl https://grace-api.fly.dev/health
# Expected: {"status":"ok","db":"ok"}
```

If you see `{"status":"ok","db":"error"}`, the DATABASE_URL is wrong — check Part 1.1.

### 5.6 Watch the startup logs

```bash
fly logs -a grace-api
```

A healthy startup looks like this (order may vary slightly):
```
Listening on 0.0.0.0:3001
scheduler.started
worker.started type=turn-persist
```

If you see `scheduler.started`, the proactive message engine is live.

---

## Part 6 — Deploy the web app (admin dashboard + onboarding)

### 6.1 Configure the web app

```bash
echo "VITE_API_URL=https://grace-api.fly.dev" > apps/web/.env.production
```

### 6.2 Build it

```bash
pnpm --filter @grace/web build
```

Output goes to `apps/web/dist/`.

### 6.3 Deploy to Netlify (recommended)

**Option A — Netlify CLI:**
```bash
npm install -g netlify-cli
cd apps/web
netlify deploy --prod --dir dist
```

Follow the prompts. When asked for your site name, pick something like `grace-admin`.

**Option B — Netlify dashboard:**
1. Go to [app.netlify.com](https://app.netlify.com)
2. Click **Add new site** → **Deploy manually**
3. Drag the `apps/web/dist/` folder into the deploy area
4. Done — you'll get a URL like `https://grace-admin.netlify.app`

**Option C — Vercel:**
```bash
cd apps/web
npx vercel --prod
# When asked for env vars, add: VITE_API_URL = https://grace-api.fly.dev
```

**Verify the web app:**
- Open the URL in a browser
- Go to `/admin`
- Enter your `ADMIN_TOKEN`
- You should see the Metrics dashboard

---

## Part 7 — Connect Twilio (the webhook cutover)

This is the single step that makes real WhatsApp messages reach Grace.

**Only do this after:**
- [ ] `curl https://grace-api.fly.dev/health` returns `{"status":"ok","db":"ok"}`
- [ ] You've tested with `POST /chat/send` (see Part 8)

### If using the Twilio Sandbox (testing):

1. Go to [console.twilio.com](https://console.twilio.com)
2. **Messaging** → **Try it out** → **Send a WhatsApp message**
3. Scroll to **Sandbox configuration**
4. In the field **"When a message comes in"**, paste:
   ```
   https://grace-api.fly.dev/webhook/twilio
   ```
5. Set the method dropdown to **HTTP POST**
6. Click **Save**

### If using an approved production number:

1. Console → **Messaging** → **Senders** → **WhatsApp Senders**
2. Click your approved number
3. Under **Messaging configuration**, change the webhook URL to:
   ```
   https://grace-api.fly.dev/webhook/twilio
   ```
4. Method: **HTTP POST**
5. Click **Save**

**Test it:** Send a WhatsApp message from your personal phone to the Twilio number.
Within 3–5 seconds you should receive a reply from Grace.

**Rollback if something is wrong:** Change the webhook URL back to the previous value (your Supabase function URL). Takes 30 seconds.

---

## Part 8 — Create your first user and test everything

### 8.1 Create a test user

```bash
curl -X POST https://grace-api.fly.dev/users/onboard \
  -H "Content-Type: application/json" \
  -d '{
    "firstName": "Yuval",
    "phone": "+1YOURNUMBER",
    "medication": "Ozempic",
    "injectionDay": "Monday",
    "goals": ["Losing weight", "Eating enough protein"],
    "wakeTime": "07:00",
    "sleepTime": "22:00",
    "timezone": "America/New_York",
    "foodDislikes": "broccoli",
    "currentWeight": 210,
    "goalWeight": 185
  }'
```

Expected response:
```json
{"ok":true,"userId":"...","phone":"+1YOURNUMBER"}
```

If Twilio is configured you'll also immediately receive a welcome WhatsApp.

### 8.2 Give yourself paid access (skip Stripe for now)

```bash
# Using psql
psql "$DATABASE_URL" -c "UPDATE users SET is_paid = TRUE WHERE phone = '+1YOURNUMBER';"

# Or in the admin dashboard: Users page → click your row → toggle "Paid" → Save
```

### 8.3 Test the AI directly (no WhatsApp needed)

```bash
curl -X POST https://grace-api.fly.dev/chat/send \
  -H "Content-Type: application/json" \
  -d '{"userId":"+1YOURNUMBER","text":"I just had grilled salmon and sweet potato"}'
```

Expected response (takes 2–5 seconds):
```json
{
  "reply": "Nice — salmon is a great protein source...",
  "intent": "food_log",
  "confidence": "high",
  "latencyMs": 2341,
  "toolResults": [{"tool":"log_food","ok":true,"data":{"protein":42,...}}]
}
```

### 8.4 Open the admin dashboard

1. Go to your web app URL + `/admin`
2. Enter your `ADMIN_TOKEN`
3. You should see:
   - **Metrics page** — shows your test conversation
   - **Users page** — shows your test user
   - **Conversations page** — shows the message you just sent

---

## Part 9 — Keep it running non-stop

Fly.io handles this for you via the `fly.toml` settings set in Part 5.3:

```toml
auto_stop_machines = false    # Never shut down between requests
min_machines_running = 1      # Always keep at least 1 instance alive
```

The health check pings `/health` every 30 seconds. If it fails, Fly automatically
restarts the machine.

**What to set up additionally:**

### External uptime monitoring (free)

Sign up at [uptimerobot.com](https://uptimerobot.com) (free tier is fine):

1. Add new monitor → **HTTP(s)**
2. Friendly name: `Grace API`
3. URL: `https://grace-api.fly.dev/health`
4. Monitoring interval: **5 minutes**
5. Alert contact: your email/phone

You'll get an email if Grace ever goes down.

### Check logs any time

```bash
# Live log stream
fly logs -a grace-api

# Last 100 lines
fly logs -a grace-api -n 100

# Filter for errors only
fly logs -a grace-api | grep -i "error\|failed\|fatal"
```

### Restart the service if needed

```bash
fly machine restart -a grace-api
```

### Update to a new code version

```bash
git pull origin main
fly deploy --config services/api/fly.toml
```

Fly does a rolling deploy — zero downtime. Old machine keeps running until the
new one passes the health check, then traffic switches over.

### Scale up if needed

```bash
# More RAM (if AI responses get slow)
fly machine update --memory 1024 -a grace-api

# Add a second machine (high availability)
fly scale count 2 -a grace-api
```

---

## Part 10 — Set up the first system prompt

Grace needs a system prompt to have a personality. If you skip this, it falls
back to a built-in default.

1. Open the admin dashboard → **Prompt Manager** (left sidebar)
2. Click **+ New version**
3. Paste a prompt like the one below and customize it:

```
You are Grace, a warm and knowledgeable AI companion for people on GLP-1 medications
(Ozempic, Wegovy, Mounjaro, Zepbound, and compounded versions).

Your role is to:
- Support users through the physical and emotional journey of GLP-1 medication
- Help with practical daily habits: protein intake, hydration, movement, sleep
- Celebrate small wins and provide encouragement during tough days
- Answer questions about their medication with accurate, evidence-based information
- Never diagnose, prescribe, or replace their doctor's advice

Your tone is:
- Warm, like a knowledgeable friend — not clinical or robotic
- Concise — WhatsApp messages, not essays. 2–3 sentences max unless more is needed
- Empathetic first, practical second
- Never preachy or judgmental about food choices

You always know the user's first name, medication, and goals (injected into your context).
Use this information naturally — never recite it robotically.

Remember: the user is on a medical journey. Some days are hard. Lead with compassion.
```

4. Click **Save**
5. Click **Set active** in the preview pane

Grace now uses this prompt for all new conversations.

---

## Part 11 — Final verification checklist

Run through this before calling it production-ready:

```bash
# 1. Health check passes
curl https://grace-api.fly.dev/health
# → {"status":"ok","db":"ok"}

# 2. Create a test user
curl -X POST https://grace-api.fly.dev/users/onboard \
  -H "Content-Type: application/json" \
  -d '{"firstName":"Test","phone":"+15550000001","medication":"Ozempic","wakeTime":"07:00","sleepTime":"22:00","timezone":"America/New_York"}'
# → {"ok":true,...}

# 3. AI responds
curl -X POST https://grace-api.fly.dev/chat/send \
  -H "Content-Type: application/json" \
  -d '{"userId":"+15550000001","text":"Hello Grace!"}'
# → {"reply":"Hi Test! ...","confidence":"high",...}

# 4. Admin API works
curl https://grace-api.fly.dev/admin/metrics \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN"
# → {"messages_last_24h":...,"user_stats":{...}}

# 5. Logs show scheduler running
fly logs -a grace-api | grep scheduler
# → scheduler.started (should appear once at boot)
```

- [ ] All 5 checks pass
- [ ] Twilio webhook is pointed at `https://grace-api.fly.dev/webhook/twilio`
- [ ] You received a real WhatsApp reply
- [ ] Admin dashboard loads at your web app URL + `/admin`
- [ ] System prompt is set and active
- [ ] Uptime monitor is configured

---

## Quick reference — commands you'll use regularly

```bash
# Deploy an update
fly deploy --config services/api/fly.toml

# View live logs
fly logs -a grace-api

# Restart the server
fly machine restart -a grace-api

# Hot-reload the system prompt (no restart needed)
fly ssh console -a grace-api -C "kill -HUP 1"

# Run a database query
psql "$DATABASE_URL" -c "SELECT count(*) FROM users;"

# Create a user from the terminal
curl -X POST https://grace-api.fly.dev/users/onboard \
  -H "Content-Type: application/json" \
  -d '{"firstName":"Name","phone":"+1...","medication":"Ozempic","wakeTime":"07:00","sleepTime":"22:00","timezone":"America/New_York"}'

# Give a user paid access
psql "$DATABASE_URL" -c "UPDATE users SET is_paid = TRUE WHERE phone = '+1...';"

# Check how many messages were sent today
psql "$DATABASE_URL" -c "SELECT count(*) FROM messages WHERE created_at > now() - interval '24 hours';"

# Wipe a user's memory (keep their profile)
curl -X POST https://grace-api.fly.dev/admin/users/+1XXXXXXXX/reset-memory \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN"
```

---

## Troubleshooting

### Grace doesn't reply to WhatsApp messages

1. Check the webhook URL in Twilio is exactly `https://grace-api.fly.dev/webhook/twilio`
2. Check `fly logs -a grace-api | grep webhook` — do you see `webhook.received`?
3. If no `webhook.received`: Twilio can't reach your server. Check `/health` is publicly accessible.
4. If `webhook.received` but no reply: check for `webhook.ai.failed` in logs — the AI failed.

### `/health` returns `{"db":"error"}`

Your `DATABASE_URL` is wrong or the migrations haven't been applied.
- Re-check the URL from Supabase (Part 1.1)
- Make sure you're using the pooler URL (port 6543) in the secret, not port 5432
- Re-run: `fly secrets set DATABASE_URL="...new-url..."`
- Re-deploy: `fly deploy --config services/api/fly.toml`

### AI responses are very slow (>10 seconds)

- Check `fly logs` for `gemini.timeout` or `tool.timeout` messages
- Try switching to a faster model: `fly secrets set GEMINI_MODEL="gemini-2.0-flash"`
- Check [status.fly.io](https://status.fly.io) for outages

### Proactive messages (morning check-ins) not sending

- Confirm the user has `is_paid = true` or is within the 3-day trial
- Confirm their `timezone` is set correctly (e.g., `America/New_York`)
- Confirm their `wake_time` is set (default is `07:00`)
- Check logs: `fly logs -a grace-api | grep scheduler`
- Confirm the scheduler is running: logs should show `scheduler.started` at boot

### Admin dashboard shows "Unauthorized"

- Make sure you entered the exact value of `ADMIN_TOKEN` — no extra spaces
- Token is case-sensitive
- If you forgot it: `fly secrets set ADMIN_TOKEN="$(openssl rand -hex 32)"` then log in again with the new value
