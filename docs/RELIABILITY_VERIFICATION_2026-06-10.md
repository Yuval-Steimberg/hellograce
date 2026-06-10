# Grace Reliability Verification Report — 2026-06-10

**Scope:** Nutrition tracking, memory, context understanding, reminders, active-conversation
protection, profile/preferences, recommendations, injection day, data consistency.

**Method:**
- Full deterministic test suite executed in a clean environment: **614 / 615 passing**
  (the one failure is a date-dependent test flake, analyzed below — not a product bug).
- Execution-path analysis of every subsystem (webhook → coalesce → fast-path → orchestrator →
  guards → tools → scheduler), performed independently by five parallel investigations and
  cross-checked by hand against the actual source.
- Git history forensics for regressions.
- **Limitation:** no production secrets exist in this environment, so live LLM evals
  (`pnpm eval`, `auto-eval`) and live WhatsApp E2E could not run. Findings that depend on
  LLM behavior at runtime are marked accordingly. Everything else is verified against
  deterministic code paths and is not opinion.

**Bottom line:** 7 of 9 areas genuinely hold up — including the two most-feared ones
(nutrition hallucination/date-bleed and settings-write-from-chat), which are demonstrably
solved. **2 production-critical failures are real and confirmed**: (1) rapid consecutive
messages are silently dropped and message coalescing is structurally dead since 2026-06-04,
and (2) the user's check-in frequency setting is collected, displayed, and *claimed* by
Grace but never consulted by the scheduler.

---

## Verdict summary

| # | Area | Verdict | Confidence |
|---|------|---------|------------|
| 1 | Nutrition tracking reliability | **PASS** | High |
| 2 | Memory reliability | **PASS** (with 3 bounded caveats) | Medium-High |
| 3 | Context understanding | **FAIL** (rapid-sequence handling) | High |
| 4 | Reminder system reliability | **FAIL** (frequency setting ignored) | High |
| 5 | Active conversation protection | **PASS** | High |
| 6 | Profile & preference reliability | **PASS** (allergy-field design gap) | High |
| 7 | Recommendation reliability | **PASS** (same allergy caveat) | Medium-High |
| 8 | Injection day experience | **PASS** | High |
| 9 | Data consistency & system integrity | **PARTIAL** (the two failures above are cross-subsystem contradictions) | High |

---

## 1. Nutrition Tracking — PASS (High confidence)

### Confirmed strengths
- **No invention path exists.** Every `food_logs` INSERT originates from user input:
  `log-food.ts:302-313` rejects empty food args; forced log paths pass the user's verbatim
  text (`ai.service.ts:1820-1844`); the image auto-log extracts from the structured
  two-pass analysis whose prompt explicitly forbids inventing items
  (`multimodal/analyze.ts:126-212`). Gemini structured-output schema
  (`FOOD_ITEMS_SCHEMA`, `log-food.ts:147-172`) forces per-item decomposition.
- **Totals are server-summed, not LLM-summed.** `sumItemized` (`log-food.ts:249-265`)
  re-sums items locally and ignores any LLM-emitted total — this is the single source of
  truth for totals. Estimation runs at temperature 0.1 with a curated `COMMON_FOODS`
  fast-lookup and a USDA-anchored path before any LLM-only fallback.
- **Traceability:** every row stores `raw_text`, `source`, `confidence`, and a per-user
  per-minute `dedupe_key` backed by a unique index (migration `20260516000001`);
  `tool_logs` records each call with args/output/latency.
- **Historical logs cannot bleed into "today" — verified at every query site.** All
  food-date filters use `(created_at AT TIME ZONE user_tz - INTERVAL '5 hours')::date`
  compared against the same expression of `now()` — i.e. user-local calendar day with a
  5 AM rollover — consistently in `log-food.ts:390`, `remove-food.ts:38/55/80`,
  `user.service.ts:427-428/475-482`, `food-log-fast.ts:113`, `admin.ts:845-851`.
  Zero food queries use server-UTC `CURRENT_DATE`.
- **Redis L2 "today's food" cache is date-safe:** key = `(phone, user-local date with 5 AM
  rollover)` (`today-food-cache.ts:65-90`), invalidated on every new log **for both today's
  and yesterday's keys** to cover the rollover boundary (`user.service.ts:129-151`),
  fail-open to DB. Covered by `today-food-cache.test.ts` (timezone, rollover at 4 AM/6 AM,
  per-user and per-date key isolation).
- **Corrections supported:** `remove_food` tool deletes a user-scoped, today-scoped row by
  id and re-computes the daily total (`remove-food.ts:29-82`); force-called on removal
  intent. Re-logging covers edits.
- **User scoping:** every `food_logs` query filters `user_id`; composite index
  `(user_id, created_at DESC)` exists (migration `20260507000001`).

### Edge cases (acceptable, documented)
- No in-place `UPDATE food_logs` — corrections are delete + re-log by design.
- The 5 AM rollover is a product decision (late-night food counts toward the previous day);
  it is applied uniformly, so it cannot produce inconsistencies.

### One real test-suite defect (low severity)
`curated-meal-ideas.test.ts:131-153` ("different users on same day see different starting
points") **fails today, 2026-06-10**, and will fail again on other dates: the rotation seed
is `hash(userId|dayNumber|meal|diet)` (`curated-meal-ideas.ts:259-263`) and the two
hard-coded test user IDs collide on today's day number — the test's own comment admits
collision is possible. This is a flaky test, not a product bug, but it turns CI red roughly
1-in-8 days for this pair. **Recommendation:** assert determinism differently (e.g. fix the
day via fake timers, or assert across several user IDs that at least one differs).

---

## 2. Memory Reliability — PASS with bounded caveats (Medium-High confidence)

### Confirmed strengths
- **Strict user scoping everywhere:** `getRecentTurns` filters `user_id`
  (`memory.service.ts:31-54`); `user_memories` retrieval filters `user_id AND
  confidence >= 0.5` (`user-memory.service.ts:68-96`); RAG allows only
  `user_id = $2 OR user_id IS NULL` (own embeddings + global KB, `rag.service.ts:24-58`);
  `user_memory_md` is keyed by `user_id` (PK). Cross-user contamination is SQL-impossible.
- **Session contamination contained:** one active conversation per user (unique partial
  index), 6-turn history cap, topic-closer stripping and `stripAssistantTurns()` on detected
  topic switches (`orchestrator.ts:733-757`).
- **Authority ordering is structural:** hard profile fields (weight, dose, injection day,
  goals) are injected from the `users` table into the system prompt *above* learned
  facts/memory.md, which are framed as "background only" (`ai.service.ts:2693-2993`,
  `prompts.ts` MEMORY RELEVANCE rule). The memory.md updater is explicitly forbidden from
  inventing hard fields (`memory-md-updater.worker.ts:37-64`) and output is format-validated
  before persisting.
- **Bounded growth:** 6 turns / top-3 memories / top-5 RAG docs / 8,000-char memory.md cap
  with LLM-guided compaction.
- ~29 unit tests cover history caching, memory.md lifecycle, and RAG ordering.

### Confirmed caveats (real, bounded, evidence-based)
1. **No recency factor in `user_memories` retrieval** (`user-memory.service.ts:68-96`):
   ranking is similarity + confidence only; `created_at`/`last_used_at` exist but are not
   queried. An old high-confidence memory can outrank a newer correction. Mitigated (not
   eliminated) by the hard-field authority ordering and "background only" framing —
   the requirement "outdated memories cannot override newer information" therefore holds
   for **profile facts** but is only probabilistically enforced for soft narrative facts.
2. **`POST /admin/users/:phone/reset-memory` does not invalidate the memory.md in-process
   cache** (`admin.ts:926-935` deletes 6 tables but never calls `memoryMd.invalidate`) —
   up to 5 minutes of post-reset stale narrative per machine. The deletes are also not
   wrapped in a transaction (partial wipe possible on mid-sequence failure).
3. **RLHF RAG weighting is additive and unbounded:** score = cosine + `feedback_score *
   0.05` (`rag.service.ts:43`). A chunk with accumulated feedback_score ≥ ~4 can outrank a
   strictly more relevant chunk. No factual re-validation of highly-weighted chunks exists.

**Recommendations (supported by evidence):** add a recency window or decay term to
`user_memories` retrieval; call `memoryMd.invalidate(userId)` and wrap reset-memory in a
transaction; cap or normalize `feedback_score` in the RAG score.

---

## 3. Context Understanding — FAIL (High confidence)

### CONFIRMED CRITICAL FAILURE: rapid consecutive messages are silently dropped, and message coalescing is structurally dead

**Root cause:** commit `a2ae4bc` (2026-06-04, "Phase 1 architecture refactor") introduced a
per-user in-flight Redis lock **before** the coalesce step in the webhook pipeline.
Current order in `webhook.ts`:

1. Line 94: `SET inflight:{user} NX EX 30` — second concurrent request **returns at line 97**
   (`webhook.inflight_skip`) without ever reaching the coalesce buffer.
2. Lines 115-121: `coalesceMessages()` — `rpush` to the buffer happens only *after* the
   inflight lock is held, and the 2-second coalesce wait (`webhook.ts:707`) runs **inside**
   the locked section.

**Deterministic consequence** (no LLM involved, no race needed):
- Message M1 arrives → acquires inflight lock → enters coalesce → waits 2s.
- Message M2 arrives 1s later → inflight `SET NX` fails → **M2 is dropped. It is never
  buffered, never merged, never answered.**
- Therefore `coalesceMessages` can never receive a second message in production
  (Redis is always present). The merge branch (`webhook.ts:705`, "absorbed — the
  lock-holder will pick this up") is dead code. The code's own comment at lines 106-108
  describes behavior that can no longer happen.
- Worse than just losing coalescing: **any follow-up sent within the duration of an
  in-flight turn (~2-10s, which includes the 2s coalesce sleep) is silently discarded** —
  exactly the "fragmented input / corrections / rapid sequences" pattern WhatsApp users
  exhibit ("Will i go bold?" → "Bald", the documented motivating example, is now broken).

**Why tests didn't catch it:** `webhook.test.ts` tests `coalesceMessages` **as an isolated
function** with an in-memory Redis mock — the route-level interaction between the inflight
lock and the coalesce buffer has zero coverage.

**Recommended fix (behavior-restoring, no latency cost):** append the inbound text to the
coalesce buffer (`rpush` + TTL) **before** attempting the inflight lock; on lock failure,
return only after the buffer append (the lock holder's `lrange` then picks it up). The
inflight lock's original purpose (preventing duplicate concurrent pipelines, the 2026-05-29
bug) is preserved; the dropped-message regression is removed. Add a route-level test with
two overlapping webhook invocations.

### Other findings in this area
- **Topic anchoring defenses: PASS.** Deterministic topic-switch detection + assistant-turn
  stripping (`orchestrator.ts:733-757`, tested), multi-part message detection
  (`orchestrator.ts:785-815`, tested), correction-pattern acknowledgment markers
  (`orchestrator.ts:901-917`), plus LLM relevance/behavioral guards. The "ANSWER ONLY THE
  CURRENT MESSAGE" rule has deterministic backstops; residual risk is LLM-probabilistic and
  acceptable.
- **Fast-path guards are sound** (length > 40 / `?` / digits / media / `NEVER_FAST_PATH_RE`
  all fall through to the LLM), with one UX-only gap: after the injection-morning prompt,
  a reply of "done" correctly advances the state machine in `webhook.ts:129-135` (state is
  **not** lost), but the visible reply comes from the fast-path brief-ack pool ("Got it 👍")
  rather than an injection-aware confirmation. Minor, not a data bug.
- **Messages >2s apart** get two separate AI turns (two replies). By design after the fix
  above; acceptable.
- **Test gap:** no end-to-end test for the correction flow ("actually it was 2 eggs").

---

## 4. Reminder System Reliability — FAIL (High confidence)

### CONFIRMED CRITICAL FAILURE: the check-in frequency setting is collected, displayed, claimed — and ignored

Evidence chain (each link verified directly):
- Onboarding validates and writes it: `routes/users.ts:39` (`min(1).max(5)`), `:130-131`.
- The Settings page exposes it as editable: `apps/web/src/pages/Settings.tsx:67-69,104-106,235`
  (`checkin_frequency`, `checkin_count_per_day`, `checkin_days_interval`).
- The settings READ flow tells the user their value in chat: `settings-flow.ts:435-443`
  ("N per day").
- Grace's runtime context asserts it to the model: `ai.service.ts:2913-2914`
  (`CHECKIN FREQUENCY: N scheduled check-in(s) per day`), and `context-builder.ts:361`.
- **The scheduler never reads any of the three fields**: zero occurrences of
  `checkin_count_per_day` / `checkin_frequency` / `checkin_days_interval` in
  `scheduler.ts`. The schedule is hard-coded (morning daily; midday Mon/Wed/Fri; evening
  Tue/Thu/Sun; bonus nudge; capped by engagement dampener + 2/day cadence cap + 3h spacing).

**Consequences:** (a) "Reminders follow user settings accurately" — violated; (b) "Default
values cannot override active user settings" — violated for cadence (a user who sets 1/day
still gets up to 2/day); (c) "Grace never claims reminder schedules that conflict with user
configuration" — violated: Grace will state "Your check-in frequency is 1 per day" while the
scheduler operates on its own hard-coded plan.

**Also confirmed (consistency, lower severity):** CLAUDE.md and a scheduler comment claim
"engaged users still get the full 3-message schedule," but the 2/day cadence cap
(`scheduler.ts:355,400`) makes 3 non-critical sends impossible. In practice the weekly
day-split (midday and evening never share a weekday) means the cap rarely binds, but the
documented contract and the enforced contract disagree.

**Recommendation:** make `sendAndRecord` (or the per-type gates) consult
`checkin_count_per_day` as the daily non-critical cap (with the existing 2/day cap as the
ceiling), or — if product explicitly wants a fixed schedule — remove the field from
Settings/onboarding/AI context so Grace stops claiming it. Either direction resolves the
contradiction; leaving both as-is is the only wrong option. Add a test: user with
`checkin_count_per_day: 1` receives ≤ 1 non-critical proactive message/day.

### Everything else in this area genuinely passes
- **Timezone handling: PASS.** `localNow()` uses `Intl.DateTimeFormat` with per-user IANA
  zones and a safe fallback (`scheduler.ts:497-520`); tested for Asia/Jerusalem.
- **Wake/sleep/quiet hours: PASS.** Defaults (`08:00`/`22:00`) apply only when fields are
  NULL (`scheduler.ts:132-139`); quiet hours 21:00–07:00 are a hard code-level guard
  (`scheduler.ts:127-128`); tested.
- **Profile updates take effect within a minute: PASS.** `listActiveUsers()` re-reads every
  tick; the user cache TTL is 5s.
- **Multi-machine duplicate prevention: PASS.** Every send path goes through
  `sendAndRecord` → Redis `SET NX EX 82800` lock keyed `(phone, type, local date)`;
  failure-open with DB `last_*_sent_at` gates as backstop; race tested.
- **Known bounded gap:** no catch-up for windows missed entirely while a machine is
  cold-stopped beyond the 90-minute morning catch-up window — this compounds the
  already-tracked "Fly payment method / machines auto-stop" operational item.

---

## 5. Active Conversation Protection — PASS (High confidence)

- Engagement cooldown verified end-to-end: `ENGAGEMENT_COOLDOWN_HOURS` (default 2) →
  `scheduler.ts:377-391`; applies to **all** non-critical proactive types; resets via
  `last_reply_at`, which `ensureUser` updates on every inbound message (`webhook.ts:124-126`).
- Critical-exempt set is narrow and intentional (`injection_morning`, `injection_followup`,
  `trial_expiry_reminder` — `scheduler.ts:366-370`); `injection_dayafter` correctly respects
  the cooldown.
- Additional layers stack: 2/day cadence cap + 3h minimum spacing + engagement dampener +
  quiet hours.
- **Edge case (sub-minute):** a tick that fetched the user list just before a user's message
  arrives could send within seconds of that message (stale `last_reply_at` for ≤ ~1 minute).
  Theoretical, low impact; no action recommended without production evidence.

---

## 6. Profile & Preference Reliability — PASS (High confidence)

- **Chat cannot silently modify settings — verified, not assumed.** `tryHandleSettings`
  (`settings-flow.ts:508-570`) contains zero DB writes: READs answer + append the Settings
  URL; UPDATEs return the verbatim redirect. Repo-wide search found exactly **one**
  chat-initiated profile write: `detectInjectionDayChange` → `users.update({injection_day})`
  (`webhook.ts:162-184`) — the documented sole exception. Frequency changes
  (`isFrequencyChangeRequest`, `webhook.ts:153-160`) and natural opt-out send redirects with
  early return, no writes. Pause/resume flips only the `paused` flag (temporary state, not a
  profile setting). Tools write only to log tables (`food_logs`/`weight_logs`/mood), never
  to `users` profile fields. `settings-flow.test.ts` asserts redirect-no-write for dozens of
  phrasings including dietary-identity changes.
- **The Settings page exists** (`apps/web/src/pages/Settings.tsx`, full profile editing) —
  the redirect target is real.
- **Consistency across consumers: PASS.** All paths (personalised prompt, direct
  knowledge/medication paths, food-ideas tool, scheduler message generator) read the same
  `users.dietary_pattern` + `users.food_dislikes` columns, fetched fresh per turn, cleaned by
  the same prefix-stripping, with a post-generation forbidden-food check as backstop
  (`ai.service.ts:1014-1162`).
- **Design gap (real, scoped): no dedicated allergy field.** Allergies are commingled with
  taste dislikes in `food_dislikes` (acknowledged in code comment, `ai.service.ts:1049-1050`);
  no explicit allergy step in onboarding. Functionally allergies *are* enforced (the dietary
  context block says "dislikes or is allergic to: … Never suggest"), but safety-critical
  data shares a field with "I don't like rice." Recommendation: dedicated `allergies` column
  + onboarding question in a future migration.
- **v1 legacy edge function (`supabase/functions/handle-inbound-sms`)** still contains its
  own chat-write settings flow. The live Twilio webhook points at v2, so it receives no
  traffic today, but as long as it remains deployed it is a dormant second source of truth.
  This repo cannot verify Supabase deployment state — keep the existing follow-up
  ("disable/align v1 before any fallback re-enable") open and treat it as a production risk.

---

## 7. Recommendation Reliability — PASS (Medium-High confidence)

- Verified: dietary restriction and dislikes flow into every recommendation surface (curated
  ideas, `search_food_ideas` query building, dietary context block, scheduler prompts), with
  a deterministic post-generation forbidden-word check that drops violating responses.
- When `dietary_pattern` is NULL and dislikes are empty, **no dietary block is injected and
  no assumption is fabricated** — the model sees no constraint rather than a false one.
  There is no code path that asserts vegan/kosher/halal status that isn't user-entered.
- Residual risk is the allergy-field commingling above, plus LLM-probabilistic compliance
  for foods not caught by the forbidden-word check (e.g. a dish *containing* a forbidden
  ingredient not named in the dish). The eval/auto-eval harnesses cover this at runtime but
  could not be executed in this environment (no API key).

---

## 8. Injection Day Experience — PASS (High confidence)

- 4-stage state machine verified (`scheduler.ts:148-166,293-323`): morning fires in the
  user's wake-time window (timezone-aware, jittered) and **replaces** the regular morning
  message (early return — no double-send); follow-up fires 3h after `injection_done_at`
  (only after a "done" reply — the pre-2026-05-29 unconditional-followup bug is fixed and
  regression-tested); day-after message respects the engagement cooldown.
- "Done" detection runs early in the webhook, before any short-circuit can swallow the state
  change (`webhook.ts:129-135`).
- Mid-flow `injection_day` change resets the stage safely (`webhook.ts:172-177`); timezone
  changes mid-flow are safe because `injection_done_at` is a UTC timestamp (elapsed-time
  math is zone-independent).
- Dedicated message generation per stage exists in `message-generator.ts`; tested across
  `scheduler.test.ts:456-585`.
- UX nit shared with §3: the visible reply to "done" comes from the fast-path ack pool
  rather than an injection-aware line. State machine integrity is unaffected.

---

## 9. Data Consistency & System Integrity — PARTIAL (High confidence)

- **Settings-as-source-of-truth holds structurally** (§6) and profile data flows
  consistently into prompts, tools, scheduler, and recommendations.
- **The two confirmed failures are precisely cross-subsystem contradictions**, which is why
  this area cannot pass yet:
  1. The AI/Settings/onboarding subsystems all treat `checkin_count_per_day` as real; the
     scheduler does not (§4) — one subsystem's data silently contradicts another's behavior.
  2. The webhook's own coalesce comments and the documented architecture promise merge
     behavior the inflight lock makes impossible (§3) — the code contradicts its own
     contract, and users' messages are lost.
- Behavior is otherwise independent of account age / history length (caps everywhere:
  6 turns, top-k retrieval, 8KB memory.md, indexed user-scoped queries).
- Documentation drift to correct when fixing: CLAUDE.md's "full 3-message schedule" claim,
  and the stale coalesce comments in `webhook.ts`.

---

## Consolidated recommendations (only where evidence supports action)

| Priority | Action | Evidence |
|---|---|---|
| **P0** | Reorder webhook pipeline: buffer-append before inflight-lock check so concurrent messages are absorbed, not dropped; add a route-level two-message test | §3, `webhook.ts:90-121,695-712`, commit `a2ae4bc` |
| **P0** | Make the scheduler honor `checkin_count_per_day` (or remove the setting everywhere it's claimed); add a 1-per-day test | §4, `scheduler.ts` (zero reads) vs `users.ts:130`, `Settings.tsx:104`, `ai.service.ts:2913`, `settings-flow.ts:435` |
| P1 | `reset-memory`: invalidate memory.md cache + wrap deletes in a transaction | §2, `admin.ts:926-935` |
| P1 | De-flake `curated-meal-ideas` rotation test (fails on dates where the two fixed IDs collide — including today) | §1, `curated-meal-ideas.test.ts:131-153` |
| P2 | Recency factor in `user_memories` retrieval; cap RAG `feedback_score` contribution | §2 |
| P2 | Dedicated `allergies` field + onboarding question | §6 |
| P2 | Injection-aware ack for "done" instead of generic fast-path ack | §3/§8 |
| P2 | Keep the existing "disable v1 `handle-inbound-sms`" follow-up open — it's a dormant second settings-write path | §6 |

## Implementation status (addendum, 2026-06-10 — same session)

All confirmed failures and supported recommendations were implemented and tested
(627 API + 513 ai-core tests green, typecheck clean):

| Finding | Status | Where |
|---|---|---|
| P0 — inflight lock drops rapid messages / coalescing dead | **FIXED** — coalesce now runs before the lock; the lock WAITS (15×1s bounded retries) instead of dropping; `coalesceMessages` now releases its window lock after draining (a second pre-existing loss path: messages arriving 2-5s after the first were absorbed into an already-drained window) | `webhook.ts` + 6 new tests |
| P0 — scheduler ignores check-in cadence settings | **FIXED** — `sendAndRecord` honors `checkin_count_per_day` (clamped 1..3, default 2) and `checkin_days_interval` (every-N-days); critical health flows stay exempt; AI context line now claims the same clamped value | `scheduler.ts`, `ai.service.ts:2913` + 6 new tests |
| P1 — reset-memory cache/transaction | **FIXED** — core deletes wrapped in a transaction; `memoryMd.invalidate()` called; optional-table deletes stay best-effort outside the transaction | `admin.ts` |
| P1 — date-flaky curated-meal-ideas test | **FIXED** — asserts spread across 10 users (failure odds ~7e-9) instead of one fixed pair (~1-in-8 days) | `curated-meal-ideas.test.ts` |
| P2 — no recency factor in memory retrieval | **FIXED** — additive distance penalty: 0 under 30 days, linear to +0.30 at ~390 days | `user-memory.service.ts` |
| P2 — unbounded RLHF feedback weight in RAG | **FIXED** — feedback contribution clamped to ±0.25 (tiebreaker, not override) | `rag.service.ts` |
| P2 — generic ack for injection "done" | **FIXED** — deterministic injection-aware ack pool, short-circuits before the AI/fast-path; followup wording matches the 3h scheduler followup | `webhook.ts` |
| P2 — dedicated allergies field | **DEFERRED (deliberate)** — allergies are functionally enforced today via `food_dislikes` ("dislikes or is allergic to: … Never suggest" + post-generation check). A proper field requires coordinated changes to the live web onboarding UI and the v1 `update-user` Supabase edge function; a backend-only column nothing populates would be dead plumbing. Needs a product decision + web deploy. |
| P2 — v1 `handle-inbound-sms` dormant settings-write path | **DEFERRED (out of repo scope)** — requires disabling the deployed Supabase function in production; tracked in CLAUDE.md open items. |

## What was claimed broken but is actually solved (do not "fix")

- Food hallucination / invented logs — no such path exists; schema-enforced, server-summed.
- Historical food bleeding into today — timezone-aware 5 AM-rollover filter at every query
  site, including both cache layers, with boundary tests.
- Chat silently changing profile/diet/frequency settings — redirect-only, test-enforced,
  single documented exception (injection day).
- Cross-user or cross-session memory contamination — SQL-impossible by scoping + single
  active conversation invariant.
- Duplicate proactive messages across the two Fly machines — Redis `NX` locks on every send
  path, race-tested.
- Proactive messages interrupting active chats — layered cooldown/cap/spacing verified.
