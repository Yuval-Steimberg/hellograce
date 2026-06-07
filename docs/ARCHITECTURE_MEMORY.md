# Memory Architecture

Last updated: 2026-06-07 (Phase C of latency optimization program)

## Decision

Grace uses a **relational + structured + semantic Postgres** memory architecture
across 6 layered caches. This document records why this is the right design
for Grace today, and what would need to change to make a mem0 / memory.md /
managed-service alternative worth migrating to.

**TL;DR**: keep the current Postgres design. The brief's 11 memory requirements
(medication, dosage, injection day, weight, food preferences, restrictions,
activity level, symptoms, goals, profile, corrections) are all satisfied
today. The "I changed X to Y" conflict-handling pattern is already correct.
Don't rewrite what works.

---

## The six memory layers in production

| Layer | Storage | Read | Write | Cache TTL |
|---|---|---|---|---|
| Recent chat history | Postgres `messages` + in-memory Map | `MemoryService.getRecentTurns()` (last 6 turns) | `appendTurn()` via BullMQ turn-persist worker | 5s |
| Durable extracted facts | Postgres `user_profile_facts` table | `UserService.getKnownFacts()` (top 30 by confidence) | `FactExtractorWorker` (LLM extract, async after response) | 5min |
| Semantic memory | Postgres + pgvector `embeddings` | `RagService.retrieve()` (only when intent allows) | Background ingest | persistent |
| Structured user profile | Postgres `users` table (33 fields) | `UserService.getById()` | `tryHandleSettings()` 2-phase confirm + sync UPDATE for hard fields | 5s |
| Today's food summary | Postgres CTE + in-memory + Redis L2 (Phase A2) | `getTodaysFoodSummary()` | `invalidateTodaysFoodCache()` on every food log INSERT | L1 10s, L2 36h |
| Check-in count | Postgres CTE + in-memory | `countTodaysCheckIns()` | invalidated on send | 60s |

## How conflicts get resolved ("the latest user message wins")

The brief's example: `Memory: Injection day = Monday`, then user says
`I changed my injection day to Wednesday`. Grace must (1) use Wednesday
immediately, (2) update memory, (3) stop using Monday.

This pattern is implemented in three layers:

1. **Hard fields** (`users` table): regex detection in `services/api/src/routes/webhook.ts`
   short-circuits BEFORE the AI pipeline runs. Examples:
   - `detectInjectionDayChange()` — immediate sync UPDATE, also resets
     `injection_flow_stage` to clean state so no Monday-flavored proactive
     message goes out
   - `detectFrequencyChange()` — immediate UPDATE
   - `detectNaturalOptOut()` — opt-out flow

2. **Settings flow** (`services/api/src/services/settings-flow.ts`): for 12 fields
   (timezone, medication, dose_mg, weights, height, age, sex, primary_goal,
   food_dislikes, etc.), a Redis-backed 2-phase confirmation. User says
   "set my goal weight to 170", Grace asks "Confirm? Reply yes." User says
   "yes", sync UPDATE.

3. **Dietary detection** (`services/api/src/services/ai.service.ts`
   `detectDietaryRestriction`): explicitly checks `currentText FIRST`, then
   user history turns, then `userKnownFacts`, then the persisted
   `dietary_pattern`. So "I'm vegetarian today" in the current message wins
   over old "I eat meat" in known facts.

The data path is: classify the message → if a conflict-resolving pattern
matches, sync UPDATE the relevant `users` field BEFORE the AI generates a
response → AI sees the new state immediately via the 5-second user cache.

## Why not mem0 / memory.md / a managed service?

The brief asked us to evaluate alternatives. Decision matrix:

| Criterion | Current Postgres | mem0 | memory.md | Postgres + managed hybrid |
|---|---|---|---|---|
| Query-ability | SQL + indexed columns ✅ | SDK call, opaque | Grep | SQL + SDK |
| Conflict resolution | Sync UPDATE, current message > memory ✅ | Eventual consistency | Model rewrites whole file | Postgres for hard + SDK for soft |
| Background extraction | `FactExtractorWorker` shipped ✅ | Managed (external) | Manual or LLM-driven | Outsourced |
| Vendor lock-in | None (Postgres) | mem0 SaaS | None | Partial |
| Cost | Within Supabase plan | $$ per memory op | None | Postgres + per-op |
| Latency overhead | 50-150ms (in parallel_io) | 100-300ms network | <10ms file read | 50-150ms + 100-300ms |
| Cache layers | 5 (per-table TTLs) ✅ | 1 (provider's) | None | 5 + provider's |
| Test coverage | 35 settings-flow + 100+ misc ✅ | Would need rewrite | Would need rewrite | Hybrid integration tests |
| Migration risk | None | High (whole layer) | High (whole layer) | Lower (additive) |
| Reduces engineering surface | — | Yes (extraction) | No | Yes (semantic) |

### When the hybrid (Postgres + managed semantic) becomes attractive

Migrate the `user_profile_facts` table to a managed service (mem0, Zep, Letta)
when at least two of these are true:

- Daily memory operations grow past ~10x current volume (vendor pricing
  tips below maintenance cost)
- Extraction quality complaints accumulate (managed services have
  specialist tuning we'd need to reinvent)
- Engineering team needs to focus on product features instead of
  memory infrastructure
- The complexity of `FactExtractorWorker` + its prompts + dedup logic
  exceeds 1 engineer-week / quarter of maintenance

Pilot recipe: pick ONE intent (e.g. food preferences), wire the managed
service in parallel with the existing extractor, A/B test for 2 weeks on
response quality + latency + memory accuracy. Ship if measurably better.
Keep `users` table + `embeddings` table on Postgres — those don't benefit.

### memory.md — additive narrative layer, see Phase D

The brief specifically asked about memory.md. We're piloting it as an
ADDITIVE narrative layer in Phase D of the latency optimization program —
NOT a replacement for the current memory. Hard fields stay in `users`
(for sync UPDATE semantics); soft narrative context ("Sarah's been
worried about hair loss for 3 weeks, suggested telogen effluvium")
goes into a per-user markdown file. See
`/root/.claude/plans/transient-riding-ritchie.md` Phase D for details.

## Performance characteristics

### Memory reads in `parallel_io` (8 parallel DB queries)

| Read | Latency | Source |
|---|---|---|
| `getById(userId)` | 20-50ms | Profile cache (5s) |
| `ensureConversation()` | 50-100ms | Conversation cache (5min) |
| `isNewUser()` | 10-20ms | Cached |
| `getRecentTurns(6)` | 50-100ms cold / <1ms warm | 5s cache |
| `getTodaysFoodSummary()` | **100-150ms cold** / <1ms L1 hit / ~5ms L2 hit | 10s L1 + 36h L2 (Phase A2) |
| `getKnownFacts(30)` | 50-150ms | 5min cache |
| `getRecent CheckIns()` | 30-50ms | 60s cache |
| Optional: media analysis | 0 (none attached) | — |

Total `parallel_io` typical: ~1,250ms avg with one DB query roundtrip cost
dominating. With Phase A2 cache warmup, this drops by ~100-150ms.

### Memory writes are async

- Chat history append: via BullMQ `turn-persist` worker, concurrency 5
- Fact extraction: via BullMQ `fact-extract` worker, concurrency 3,
  LLM call to identify durable facts, INSERT into `user_profile_facts`
- Settings updates: sync UPDATE during the confirmation flow (user pays
  ~30-50ms but it's part of the two-phase UX, not the AI response path)
- Dietary pattern detection: async write after response

User-facing latency is never blocked by memory writes.

## Future evolution

If we hit any of these triggers, revisit:

- **>5s avg response time on emotional intent**: investigate whether more
  context from Postgres memory would actually help (probably not — the
  prompts.ts framework is intentionally context-light for emotional)
- **>20% of users have inaccurate memory** (e.g. wrong injection day
  surfaced): tighten the regex-based conflict detection, NOT rewrite the
  storage layer
- **Postgres `user_profile_facts` exceeds 10k rows per user**: implement
  pagination + relevance scoring, NOT migrate off Postgres
- **Daily memory ops cost dominates engineering time**: pilot managed
  service hybrid per recipe above

Don't migrate without a concrete pain point. The current design is fit
for purpose.
