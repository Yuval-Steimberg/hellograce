# Caching & Latency Reference

Grace runs on a tight latency budget — WhatsApp users feel any delay over
2 seconds. This document is the canonical guide to every caching layer and
fast-path in the system: what's cached, where, for how long, and why.

If you change any value here, update both the relevant file AND this doc.

---

## Latency budget — typical messages

| Message type | Pipeline | Target latency |
|---|---|---|
| Greeting ("Hi") | Fast-path (no LLM) | **~150 ms** |
| Brief feeling ("tired") | Fast-path (no LLM) | **~150 ms** |
| Thanks / goodnight / lol | Fast-path (no LLM) | **~150 ms** |
| Food log ("I had eggs") | Full pipeline + log_food tool | ~2.0–2.5 s |
| Food question ("what should I eat?") | Full pipeline + RAG | ~2.0–3.0 s |
| Knowledge question (GLP-1 science) | Full pipeline + 8192 token budget | ~2.5–3.5 s |
| Photo of food | Two-pass vision + log_food | ~3.5–5.0 s |
| Anything else | Full pipeline | ~1.5–2.5 s |

The fast-path bypasses LLM, RAG, tools, and ALL guards. The full pipeline
fires the orchestrator with parallel post-generation guards.

---

## Layer 1 — Fast-path responder

**File:** `services/api/src/services/fast-path.ts`
**Wired in:** `services/api/src/services/ai.service.ts` (top of `handleMessage`)
**Coalesce skip:** `services/api/src/routes/webhook.ts` (`shouldSkipCoalesce`)

For 14 categories of trivial messages, return a deterministic warm reply
**without calling the LLM at all**. End-to-end latency drops from ~3s to
~150ms because we skip:

- The 2-second coalesce wait
- RAG retrieval
- Long-term memory retrieval
- The planner
- The LLM generation
- All post-generation guards (critic, behavioral, relevance, content rules,
  format enforcer, quality guard)

### Categories

| Category | Sample triggers | Sample replies |
|---|---|---|
| `greeting` | "Hi", "Hey", "Good morning" | "Hey there.", "Hi 🤍" |
| `brief_positive` | "I'm feeling strong", "feeling great" | "Love hearing that." |
| `brief_negative` | "tired", "rough day", "stressed" | "Ugh. I'm here." |
| `brief_ack` | "ok", "got it", "noted" | "Got it 👍" |
| `confirmation` | "yes", "absolutely", "💯" | "Cool." |
| `denial` | "no", "nope", "i'm good" | "All good." |
| `thanks` | "thanks", "thank you", "tysm" | "Anytime." |
| `goodnight` | "goodnight", "heading to bed" | "Sleep well 🤍" |
| `farewell` | "bye", "see you later", "ttyl" | "Talk soon." |
| `laughter` | "lol", "haha", 😂 | "😄" |
| `apology` | "sorry", "my bad", "oops" | "No worries." |
| `reaction` | "wow", "omg", "hmm" | "Right?" |
| `appreciation` | "love you", "you rock" | "That means a lot 🤍" |
| `love_it` | "love it", "that's perfect" | "Really glad 🤍" |

Each pool is rotated by stable hash of `(userId + lowercased text)` so the
same user doesn't see identical replies on repeated triggers, but variety
exists across users.

### Hard exclusions — never fast-path

Even if a regex matches, the fast-path REFUSES to fire if:

- Message contains `?` (user is asking)
- Message contains a digit (could be a weight/food/dose log)
- Message starts with `#` (RLHF feedback comment)
- Message is longer than 40 chars
- Message has media attached (photo/voice always needs analysis)
- `NEVER_FAST_PATH_RE` matches: `nauseous`, `sick`, `pain`, `hungry`, `eat`,
  `protein`, `weight`, `injection`, `dose`, `suicide`, `harm`, etc.

This means "I'm in pain", "feeling nauseous", "hungry", "ate eggs", "need
to stop the injections" all fall through to the full pipeline where they
get real personalization, tool calls, and medical guidance.

### Tuning

To add a new category:

1. Add the regex to `fast-path.ts` — must be `^...$` anchored, single-message
   pattern, no continuation expected.
2. Add a reply pool of 4–8 warm one-liners. Rotate via `pickFromPool`.
3. Add the category to the `FastPathResult` type union and to the dispatch
   chain in `tryFastPath`. Order matters — more specific patterns first.
4. Mirror the regex in `webhook.ts` `COALESCE_SKIP_RE` so the 2-second
   buffer is also skipped.

To remove a category:

1. Drop the entry from `tryFastPath` dispatch — the regex stays harmless.
2. Remove from `COALESCE_SKIP_RE` so the coalesce window applies again.

To verify in production:

```bash
fly logs --app grace-api | grep ai.fast_path.hit
```

You should see `{category, latencyMs}` for every fast-path hit.

---

## Layer 2 — Coalesce window

**File:** `services/api/src/routes/webhook.ts` (`coalesceMessages`)
**TTL:** 2 seconds (lowered from 3.5 in Phase 15)

WhatsApp users sometimes send corrections within seconds:

```
User: "Will I go"
User: "bold?"
```

The coalesce window buffers text messages for 2 seconds. The first arrival
holds a Redis lock; follow-ups append to a Redis list keyed by phone. After
2 seconds the lock-holder reads the full list and processes as ONE turn.

### Bypasses

- Media (image/audio): fires immediately, no buffer
- Fast-path messages: `shouldSkipCoalesce()` returns true, no buffer

### Tuning

Lowering this trades correction-merging for snappier responses. 2 seconds
is the floor we found that still catches genuine multi-text bursts; 3.5s
felt slow. Don't go below 1.5s — corrections like "I had pasta" → "with
meatballs" would split into two turns.

---

## Layer 3 — Gemini context cache (system prompt)

**File:** `services/api/src/llm/gemini.ts` (`getOrCreateCachedContent`)
**TTL:** 1 hour (Gemini API side)
**Threshold:** system prompt > 2500 chars

Gemini API supports context caching for static system prompts. We hash the
system prompt (sha256, first 16 chars) — if the hash matches the last
cached one for that model, we attach the cached content reference to the
generation call. Otherwise we POST to `/v1beta/cachedContents` to create a
new cache entry.

**Effect:** ~75% reduction in input token cost on every cached call. Doesn't
reduce latency much directly, but the bandwidth savings are real for the
4–6KB Grace system prompt.

**Disabled when:** `req.useGoogleSearch` is true (search-grounded calls
require sending the full prompt every time).

### Tuning

- Lower threshold = more prompts cached, but each below 1024 tokens (~3000
  chars) isn't billed at the cached rate. We keep 2500 chars as the floor
  to stay safely above.
- The 1-hour TTL is set in the cache creation POST (`ttl: '3600s'`). If you
  shorten it, cached entries expire faster — Gemini will silently create
  a new entry on the next call.

---

## Layer 4 — LLM response cache

**File:** `services/api/src/llm/gemini.ts` (top of `generate`)
**Backend:** Redis (Upstash)
**TTL:** 30 minutes (`LLM_TTL_SEC`)
**Key:** sha256 of `{messages, temperature, maxOutputTokens, responseFormat}`

Identical LLM requests within a 30-minute window return the cached response
without hitting Gemini. Most useful when:

- The same user sends the same message twice (e.g. accidental resend)
- A regen loop fires with identical inputs (rare)
- Auto-eval / regression runs the same scenarios repeatedly

**Not useful for** normal conversation flow — every turn has different
recent history so the key never repeats.

### Tuning

- Lengthening the TTL increases hit rate on auto-eval / regression but adds
  staleness risk for real users (a prompt change wouldn't take effect until
  the cache expires).
- Disabling: pass no `cache` arg to `new GeminiProvider(...)`. Falls back
  to direct `callGemini`.

---

## Layer 5 — RAG embed cache

**File:** `services/api/src/rag/gemini-embedder.ts`
**Backend:** Redis (Upstash)
**TTL:** 30 minutes (`EMBED_TTL_SEC`, bumped from 5min in Phase 15)
**Key:** sha256 of query text

Query embeddings are deterministic for the same text — same input always
produces the same vector for a given model. Caching saves ~350ms per hit
(the round-trip to `gemini-embedding-001`).

Most common hits in production:

- "what should I eat" / variants
- "any snack ideas"
- Onboarding/help phrases

### Tuning

Pure win to lengthen this TTL — embeddings only change when the model
version changes. 30 minutes is conservative. Could safely be hours.

---

## Layer 6 — FAQ semantic cache

**File:** `services/api/src/cache/faq-semantic-cache.ts`
**Backend:** pgvector (`embeddings` table, source = 'faq')
**Threshold:** `FAQ_CACHE_THRESHOLD` env var (default 0.92)
**Gating:** `FAQ_CACHE_ENABLED` env var (default OFF — verify before enabling)

For **fresh-conversation messages** (no recent history) whose embedding
matches a seeded FAQ entry above the cosine-similarity threshold, return
the canonical seeded response instead of running the full pipeline.

End-to-end: ~50ms (embed + vector lookup + send) vs ~1500ms (full LLM
pipeline). 18 FAQ entries are seeded — covering most common
onboarding / first-message scenarios.

### Why it's off by default

False positives are catastrophic — returning a wrong canned answer feels
like a broken bot. We need 24+ hours of production monitoring with the
threshold at 0.95+ before enabling broadly.

### Tuning

Raise threshold → fewer hits, less risk. Lower → more hits, more risk.
0.92 is the SDK-recommended floor for `gemini-embedding-001`.

---

## Layer 7 — Content rules cache

**File:** `services/api/src/services/content-rules.service.ts`
**Backend:** In-memory (JS Map)
**TTL:** 60 seconds

The `content_rules` DB table is read on every message turn for the
content checker. Caching the active ruleset in memory with a 60-second
refresh interval reduces the hot-path DB load to ~1 query/minute
regardless of message volume.

Stale cache is kept on transient DB errors (never wipes on failure), so
the content checker keeps working even if Postgres has a hiccup.

### Tuning

- Lower the TTL → faster propagation when admins change a rule, more DB
  load. 60s is fine — admins testing a new rule wait at most a minute.
- Higher → less DB load, slower propagation. Don't go above 5 minutes
  without admins knowing.

---

## Layer 8 — Engagement cooldown (not a cache — a suppression rule)

**File:** `services/api/src/scheduler/scheduler.ts`
**Source of truth:** `users.last_reply_at` (updated on every inbound message)
**Default window:** 2 hours (`ENGAGEMENT_COOLDOWN_HOURS` env var)

After a user sends any message, all non-critical proactive reminders are
suppressed for the cooldown window. The user is actively engaged — Grace
doesn't need to ping them. Resets automatically on the next user message.

### Critical-exempt types (always send)

- `injection_morning` — today is the shot day
- `injection_followup` — same-day "did you take it?" check
- `trial_expiry_reminder` — time-bound to trial-end day

### Non-exempt (cooldown applies)

- `morning` / `midday` / `evening` / `bonus` — standard proactive
- `injection_dayafter` — next-day check-in, not urgent

### Tuning

```bash
fly secrets set ENGAGEMENT_COOLDOWN_HOURS=2 --app grace-api   # default
fly secrets set ENGAGEMENT_COOLDOWN_HOURS=3 --app grace-api   # gentler
fly secrets set ENGAGEMENT_COOLDOWN_HOURS=0 --app grace-api   # disable
```

To debug suppression in production:

```bash
fly logs --app grace-api | grep scheduler.engagement_cooldown_active
```

You'll see `{phone, type, hoursSinceUserReply, cooldownH}` per skip.

---

## Layer 9 — Per-intent token budgets

**File:** `packages/ai-core/src/orchestrator.ts` (generation budget block)

Gemini 2.5 Flash allocates "thinking" tokens from `maxOutputTokens`.
Tighter budgets shave 200–400ms per call. Simple intents disable
thinking entirely (`disableThinking: true`) — full budget goes to output.

| Intent | Budget | Thinking |
|---|---|---|
| `greeting`, `gibberish` | 256 | off |
| `food_log`, `weight_log`, `mood_log` | 512 | off |
| `emotional` | 1024 | off |
| `appointment_prep` | 8192 | on |
| `knowledge`, `food_question`, `general` | 8192 | on |

### Tuning

Tighten further to save latency on simple intents — but watch the
`scheduler.skipped_min_gap` log for truncation hits (`finishReason ===
'length'`). The truncation recovery addendum on regen helps, but the goal
is to size budgets so the first pass completes.

---

## Layer 10 — Parallel post-generation guards

**File:** `packages/ai-core/src/orchestrator.ts`

The three LLM-based guards (relevance check, behavioral guard, critic)
judge the same response independently — no ordering dependency. They
run via `Promise.all` instead of sequentially. Saves 500–800ms per turn.

Each guard:

- Uses `gemini-2.0-flash` (faster than 2.5 for binary judgment)
- Sets `disableThinking: true`
- Has a tight `maxOutputTokens` budget (150–500)

Skipped entirely for:

- Greetings / gibberish (trivial messages)
- Responses < 40 chars (no failure surface)
- Topic drift / regen violations already triggered (waste)

---

## Putting it together — request flow

```
Inbound text "Hi" arrives
  │
  ├── shouldSkipCoalesce("Hi") → true → bypass coalesce (no 2s wait)
  │
  ▼
AIService.handleMessage()
  │
  ├── safety classifier → safe
  ├── tryFastPath("Hi", userId) → { text: "Hey there.", category: 'greeting' }
  │
  ▼
Send via Twilio
  ──────────────────────────────────────
  Total latency: ~150ms
```

```
Inbound text "what should I eat for lunch" arrives
  │
  ├── shouldSkipCoalesce → false → wait 2s in coalesce buffer
  │
  ▼
AIService.handleMessage()
  │
  ├── safety classifier → safe
  ├── tryFastPath → null (has "what", "eat" → falls through)
  ├── handleMessageInner:
  │   ├── parallel: ensureUser, history, RAG retrieve, planner, memory retrieve
  │   │   └── RAG embed cache HIT → 350ms saved
  │   ├── buildPersonalisedPrompt (DB queries)
  │   ├── Gemini context cache HIT on system prompt → 75% input cost saved
  │   ├── orchestrator.run:
  │   │   ├── LLM generate (8192 budget, thinking on) → ~1500ms
  │   │   ├── format enforcer (deterministic)
  │   │   ├── content rules cache HIT → 0ms
  │   │   ├── content checker (deterministic)
  │   │   ├── grounding precheck (deterministic)
  │   │   ├── topic drift / Jaccard (deterministic)
  │   │   ├── PARALLEL: relevance + behavioral + critic → ~500ms (was 1500ms sequential)
  │   │   └── quality guard (deterministic)
  │   └── persist turn to BullMQ (background)
  │
  ▼
Send via Twilio
  ──────────────────────────────────────
  Total latency: ~2.5s (was ~4s before Phase 15)
```

---

## Debugging latency in production

The most useful log queries:

```bash
# Fast-path hit rate
fly logs --app grace-api | grep ai.fast_path.hit | wc -l

# Slow pipeline turns (anything > 3s)
fly logs --app grace-api | grep "latencyMs" | awk '{ if ($NF > 3000) print }'

# Truncation hits (finishReason === 'length')
fly logs --app grace-api | grep finishReason.*length

# RAG embed cache hit rate
fly logs --app grace-api | grep embed.cache

# Gemini context cache hits
fly logs --app grace-api | grep gemini.context_cache.created

# Engagement cooldown suppression
fly logs --app grace-api | grep scheduler.engagement_cooldown_active
```

---

## Last updated

2026-05-30 — Phase 15 latency pass. If you make changes to any caching
layer, update this doc and bump the date.
