# Grace vs. "Nudge Your Wellness" — Comparative Evaluation

_Evaluator: deep architectural + behavioral comparison. Date: 2026-06-16._
_Method: full source read of both codebases (no live API keys, so behavioral
claims are derived from code paths, prompts, and test suites rather than live
A/B traffic — flagged inline where that matters)._

---

## 0. What we're comparing

| | **Project A — Grace** (this repo) | **Project B — Nudge Your Wellness** |
|---|---|---|
| Product | WhatsApp/SMS GLP-1 companion ("Grace") | WhatsApp/SMS GLP-1 companion (also "Grace") |
| Stack | pnpm monorepo: Fastify API (`services/api`) + pure `@grace/ai-core` + React admin/onboarding | Lovable: Vite/React front-end + **Supabase edge functions** (Deno) |
| Brain | Modular orchestrator pipeline, many deterministic stages | **One monolithic edge function** `handle-inbound-sms` (2,123 lines) |
| Base LLM | Gemini **2.5**-flash (planner) + 2.0-flash (judges) + `gemini-embedding-001` | Gemini **3**-flash-preview (text + vision), via Lovable AI Gateway |
| Philosophy | "Engineer the guardrails. Trust nothing; verify every layer." | "**The LLM owns the reply, end-to-end.** No regex intercepts, no verifiers." (their own header comment) |

These are not distant competitors — they are two philosophies of building the
*same product*. That makes the comparison unusually clean: the difference in
outputs is almost entirely a difference in **architecture**, not domain
understanding. Both have deep, correct GLP-1 domain knowledge baked in.

> **The single most important finding:** Nudge is on a **newer base model
> (Gemini 3 Flash)** with a **simpler, more trusting** architecture; Grace is on
> an **older base model (Gemini 2.5)** with a **far more defensive** architecture.
> Grace wins decisively on **safety, reliability, and degraded-mode behavior**.
> Nudge likely wins on **raw conversational naturalness and latency on the happy
> path**, and benefits from a model one generation ahead. Several of Grace's
> hardest-won guardrails exist precisely because its base model needed them —
> a newer model may let Grace *delete* complexity, not add it.

---

## 1. Response-generation pipeline

### Grace (per-turn, simplified)
```
webhook → signature verify → access gate → ensureUser → injection-done detect
  → RLHF intercept → settings/reminder/health-concern/hypoglycemia deterministic guards
  → fast-path (14 trivial categories, ~150ms, ZERO LLM)
  → coalesce (2s) → in-flight lock
  → AIService: classify intent → media analysis (2-pass) → SafetyGuard (crisis)
     → RAG retrieve (pgvector) + memory + profile + today's nutrition
     → AIOrchestrator → Planner → Gemini 2.5-flash + tools
     → VALIDATE: format-enforcer · content-checker (DB + code banned rules)
        · grounding precheck · relevance-check (LLM) · behavioral-guard (LLM)
        · quality-guard · critic (risky intents)  [guards run in parallel]
     → regen on failure → web-search fallback → deterministic safe fallback
  → TwilioSender (link rewrite, sanitize, truncation repair)
```
**LLM calls per complex turn:** 1 planner/gen + up to 3 parallel judges + optional
regen. **Trivial turns:** 0 LLM calls (fast-path). Degraded mode (Gemini down):
deterministic GLP-1 knowledge bank + multi-item food estimator still answer.

### Nudge (per-turn)
```
edge fn → Twilio signature verify → SID dedup → STOP/START/HELP
  → blocked/paused drop → rate-limit (10/min) → per-user DB mutex (12s wait)
  → load 24-turn history + today snapshot + food diary
  → [if image] describeImage (vision pass 1)
  → PARALLEL: extractFoodItems (LLM) + extractProfileUpdates (LLM)
  → apply food diary writes + profile writes
  → buildSystemPrompt (one ~6k-token prompt with ALL rules inline)
  → callLLM (single reply, Gemini 3 flash, temp 0.8)
  → postProcessReply (strip markdown, normalize emoji, hard-truncate 320)
  → judgeReplyAddressesMessage (LLM relevance, 1 regen if NO)
  → persist + sendSMS
```
**LLM calls per text turn:** 2 (food+profile extract, parallel) + 1 reply + 1
relevance judge = **~3 sequential round-trips minimum**; +1 vision pass for images.
Degraded mode: **if the reply LLM returns empty, NO message is sent** (logged as
`ai_empty_reply`). The user gets silence.

### Verdict
| Dimension | Winner | Why |
|---|---|---|
| Architectural clarity | **Nudge** | One file, one prompt, one reply call. Vastly easier to reason about and modify. |
| Validation depth | **Grace** | 7 validation stages vs. 1 relevance judge. |
| Hallucination mitigation | **Grace** | grounding precheck + critic + content rules + RAG citations. Nudge relies on prompt discipline + conservative extractors. |
| Happy-path latency | **Nudge (likely)** but close | Nudge does 3 sequential LLM hops on *every* text; Grace's fast-path is 0-LLM for trivial msgs but full pipeline is heavier for complex ones. Net: Nudge probably faster on a mid-complexity message, Grace much faster on "ok"/"thanks". |
| Degraded-mode behavior | **Grace, decisively** | Nudge sends nothing when the model fails. Grace always answers. |

---

## 2. Context understanding

Both pass recent turns as proper `user`/`assistant` alternation and both have an
explicit **"reply only to the latest message"** rule. Nudge's `buildHistory`
correctly handles proactive-vs-inbound ordering and coalesces same-role turns for
Gemini's strict alternation requirement — a clean, correct implementation.

- **History window:** Nudge **24 turns** vs. Grace **12** (tunable 4–40 via
  `CONVERSATION_HISTORY_TURNS`). Nudge sees more raw history by default. Grace
  *deliberately* cut to 12 then re-raised to 12 with anti-anchoring guards
  (topic-closer stripping, relevance check). **Trade-off:** Nudge's larger window
  helps long-range recall but increases old-topic anchoring risk; it leans on the
  Gemini-3 model + relevance judge to resolve that. Grace engineers it
  deterministically.
- **Multi-intent:** Grace has `splitMultiMealText`, "address EVERY meaningful
  part" prompt rules, and symptom-before-food ordering. Nudge relies on the model
  + a "LATEST MESSAGE RULE" that actually instructs it to *drop* older topics —
  simpler, occasionally at the cost of dropping a second question.
- **Reference resolution / follow-ups:** Grace has explicit
  `reconstructFoodFromClarification`, continuation gates, `briefDetailMatchesFood`.
  Nudge handles the same case structurally via `pending_portion` diary rows + the
  extractor's "resolve the pending item" path — arguably **cleaner** because the
  pending state lives in the DB, not in regex.

**Verdict:** roughly even, different mechanisms. Nudge's pending-portion diary
model is genuinely elegant; Grace's is more defensive and has deterministic
fallbacks. Grace edges it on guaranteed multi-intent coverage; Nudge edges it on
clean follow-up state.

---

## 3. Memory system

| | Grace | Nudge |
|---|---|---|
| Short-term | 12 turns from Postgres | 24 turns from `check_ins` |
| Long-term | `user_memories` (pgvector) with **recency-weighted** retrieval + RAG KB | `grace_notes` — an LLM-summarized "notebook" (<300 words) refreshed every 10 turns |
| Knowledge base | **pgvector RAG live in the reply path** (`gemini-embedding-001`, 768-dim) | `grace_knowledge` + embeddings table exists but **is NOT wired into the reply path** — dormant |
| Conflict resolution | recency penalty so new corrections outrank stale memories; RAG `feedback_score` clamped | "PROFILE IS THE SOURCE OF TRUTH — IT JUST REFRESHED" prompt block; current profile always overrides older turns |
| Profile writes from chat | **Forbidden.** Settings page is the single source of truth; chat only reads. | **Automatic.** `extractProfileUpdates` writes weight/med/injection-day/dietary/allergies straight to `users` from any message. |

This is the **deepest philosophical fork** between the two products.

- Nudge's `grace_notes` notebook is a smart, cheap long-term memory that survives
  past the 24-turn window (kid names, pets, side effects). Grace's equivalent is
  vector memories — more precise retrieval, more infrastructure.
- Nudge's **auto-profile-extraction** is a double-edged sword. Pro: "I switched to
  Mounjaro" / "I weigh 182 now" instantly updates the profile with no settings
  trip — lower user effort, feels magical. Con: it creates a **second source of
  truth** that can drift from the Settings page, can mis-extract, and the same
  prompt *also* tells the model to send the settings link for preference changes —
  an internal tension (it both writes the DB *and* tells her to go to settings).
  Grace explicitly fixed a class of bugs by **banning** chat-writes (the
  "Settings = single source of truth" work) — so Grace chose the opposite trade
  deliberately, after hitting the drift problems Nudge is exposed to.
- **Nudge's dormant RAG is a real gap.** It has the table, the embedder, the
  vector extension — but the live handler never retrieves from it. All knowledge
  comes from the model's parameters + the giant prompt. Grace's RAG actually
  grounds answers and is the substrate for the grounding/critic checks.

**Verdict:** **Grace** on precision, grounding, and conflict-safety. **Nudge** on
effort (auto-profile feels great when it's right) and notebook simplicity. Grace's
"don't write profile from chat" is the safer call for a health product.

---

## 4. Food-logging accuracy

Both are genuinely sophisticated here; this is the most mature subsystem in *both*
codebases.

**Shared strengths:** vague-portion clarification ("some tofu" → ask first, don't
fabricate), generic-category clarification ("had pizza" → ask type/portion),
two-pass image analysis (vision describe → text-only macro estimate to avoid
re-hallucination), wake-time day boundary, advice-vs-intake separation.

**Nudge specifics:**
- Structured `food_log` table with `confirmed` / `pending_portion` / `deleted`
  states, per-item rows, edit/delete via fuzzy `pickEditTarget`, idempotent on
  `(user_id, source_message_sid, item)`. This is a **clean, correct, well-modeled**
  diary. The pending→confirmed resolution flow is better-factored than Grace's.
- A **deterministic hedge-guard** backs up the LLM extractor (strips "some X"
  even if the LLM logged it). Good defense-in-depth.
- **Weakness:** every extraction is an LLM call with **no non-LLM fallback**. On a
  Gemini outage, `extractFoodItems` returns `none` → the meal silently isn't
  logged. Grace specifically hardened against exactly this (`estimateMultiItemFood`
  deterministic decomposer, "never-drop" multi-item logging) after a production
  incident where a Gemini outage dropped half a meal.

**Grace specifics:**
- Deterministic `detectVagueFood`, prep-method clarification (grilled/baked/fried),
  multi-item splitter with greedy token resolution, **no-LLM macro fallback**, and
  aggregated daily summaries that survive the WhatsApp format enforcer.
- More moving parts; occasionally over-asks (a tension the team actively manages).

**Verdict:** **even, with different failure modes.** Nudge has the cleaner data
model; Grace has the better outage resilience and multi-item guarantees. For a
*tracking* product, Grace's "never silently drop a logged meal" is the more
important property.

---

## 5. Personalization

Both inject a rich profile block (goals, medication, injection day, dietary
restrictions, dislikes, weights, schedule). Both filter food suggestions by
allergies/dislikes/dietary style and both surface a prominent "HARD CONSTRAINTS"
food-preferences banner.

- Nudge computes **age, days-on-Grace, plan tier** inline and has a strong
  goal→message-mode mapping for proactive content (protein/hydration/mood/fiber/
  loneliness). Its personalization is **immediate** thanks to auto-profile-extract:
  tell it something and the very next reply reflects it.
- Grace adds **GLP-1 week number** from `glp1_start_date`, calorie targets
  (Mifflin-St Jeor + activity + GLP-1 deficit), per-intent token budgets, and
  derives `effectiveDietaryRestriction` from both the enum and free-text field
  (a bug Grace fixed where vegans got salmon recs).

**Verdict:** **even.** Nudge's in-chat immediacy is a real UX win; Grace's
clinical-context richness (week number, calorie math) is deeper. Pick your poison.

---

## 6. Safety & clinical reliability — **the most consequential category**

This is where the architectural philosophies diverge most, and where it matters
most for a medical-adjacent product.

**Nudge:** all safety lives in the **system prompt**. Crisis ("hopeless", "no
point" → 988), dose deferral, interaction deferral, constipation 4-day red-flag,
reassurance-with-escalation, procedure/anesthesia, non-pharmacy sourcing — every
one is a *prompt instruction* the model is trusted to follow. There is **no
deterministic short-circuit** for crisis or emergencies. Consequences:
- If the reply LLM **times out or errors on a crisis message**, Nudge sends
  **nothing** — the worst possible failure on the highest-stakes message.
- Crisis handling is subject to the model ignoring the instruction under unusual
  phrasing or long-context drift. The prompt is excellent, but it's still
  best-effort.
- Upside: the prompt safety content is genuinely **comprehensive and well-written**
  — arguably more nuanced prose than Grace's, and it's all in one auditable place.

**Grace:** `SafetyGuard` runs **before** the orchestrator and short-circuits
crisis/emergency to a fixed 988/911 message **regardless of LLM state**. Plus
deterministic `hypoglycemia-warning`, `health-concern` (out-of-scope vitals),
`scope-guard` (legal/finance referrals), content-checker bans on
overconfident-diagnosis and premature-escalation language, and a critic on risky
intents. Crisis is **guaranteed** even if Gemini is down.

**Verdict:** **Grace, decisively, and this is the category that should weigh
most.** Nudge's prompt is superb but a single LLM failure on a crisis message =
silence. Grace fails safe. For a product serving women on prescription medication,
deterministic crisis handling is close to non-negotiable.

---

## 7. Response quality (tone, brevity, naturalness)

Here Nudge's philosophy plays to its strengths, amplified by the newer model.

- Nudge runs the reply at **temperature 0.8** with an extraordinarily detailed
  "HOW YOU TEXT" section (casual, contractions, "ugh"/"honestly", lead with
  warmth, **don't end with a question by default**, no gushy superlatives on
  repeat, one thought per message, <160 chars). Combined with Gemini 3, this likely
  produces **more natural, less templated** texts than Grace.
- Grace runs more conservative generation with **heavy post-gen enforcement**
  (format-enforcer strips lists/headers/colons/names; banned-phrase lists;
  behavioral guard). This guarantees consistency and kills known failure phrases,
  but the very same machinery can **flatten voice** and occasionally regenerate a
  good reply into a blander one.
- Both ban markdown/bullets and cap length. Nudge's cap is char-based (160/320);
  Grace's is per-intent sentence+char budgets.

**Risk for Nudge:** with no behavioral/content guard, a bad-but-non-empty reply
ships as-is (only relevance is checked). Grace will catch and regenerate it.
**Risk for Grace:** over-sanitization; the team has repeatedly had to *loosen*
guards (e.g. acute-escalation exemptions, food relevance carve-outs).

**Verdict:** **Nudge likely wins raw naturalness; Grace wins consistency and
floor.** A blind read of 100 happy-path replies probably favors Nudge; a read of
the worst 5% favors Grace.

---

## 8. Latency & performance

- **Nudge:** describe(image) → [food+profile extract ‖] → reply → relevance judge.
  That's **3 sequential LLM hops** on a normal text (extracts are parallel with
  each other but precede the reply, which precedes the judge), +1 for images, +1
  for a relevance regen. The per-user **DB mutex waits up to 12s**. No fast-path:
  even "thanks" pays the full extract+reply+judge tax. Mitigant: Gemini 3 flash is
  fast and there's no separate planner.
- **Grace:** fast-path returns trivial messages in **~150ms with 0 LLM calls**;
  complex turns run the generator once and the 3 judges **in parallel**, and the
  critic only on risky intents. Embedding cache (30min), FAQ cache, per-intent
  token budgets.

**Verdict:** **Grace** on trivial + tail latency (parallel guards, fast-path,
caches); **Nudge** plausibly comparable-to-faster on a single mid-complexity text
because it has fewer total stages and a faster base model — but it has no escape
hatch for "ok"/"👍", which are a large share of real traffic.

---

## 9. Proactive / reminder messaging

Strikingly similar designs (these products clearly share lineage):

| Rule | Grace | Nudge |
|---|---|---|
| Suppress during active convo | engagement cooldown (default 2h) + cooldown on reply | skip if `last_reply_at` < 3h **or** any activity < 3h |
| Global proactive cooldown | Redis-lock + cadence guards | **4h** between any two proactive |
| Daily cap | 2/day (settable 1–3) | 2/day |
| Injection day | dedicated state machine, exempt from caps | dedicated `send-injection-flow` fn; generic check-in suppressed that day |
| Quiet hours | 21:00–07:00 | within 90 min of sleep skipped; wake+offset start |
| Multi-machine dedup | Redis `SET NX` lock | DB slot_index + local-day dedup |
| Content | LLM generated + sanitized + near-dup guard + context-enriched (yesterday/today totals) | LLM generated, goal→mode mapping |

Both are mature. Grace's anti-repetition (`isNearDuplicate`, last-5 banned) and
context-grounding (morning uses yesterday's protein, evening uses today's) are a
notch more sophisticated. Nudge's cooldown logic is clean and correct.

**Verdict:** **Grace** by a small margin (anti-repetition + grounded content),
both solid.

---

## 10. Edge cases & failure modes

| Failure mode | Grace | Nudge |
|---|---|---|
| LLM outage on a normal msg | deterministic knowledge bank / fallback answers | **empty reply → no message sent** |
| LLM outage on a **crisis** msg | deterministic 988/911 short-circuit | **silence** |
| Profile drift (chat vs settings) | impossible (chat can't write) | possible (chat auto-writes) |
| Dropped item in multi-item meal | hardened against (deterministic decomposer) | possible on extractor failure |
| Old-topic anchoring | topic-closer stripping + relevance regen | relevance judge (1 regen) + "drop older topic" prompt |
| Bad-but-relevant reply ships | caught by content/behavioral/quality guards | **ships** (only relevance checked) |
| Rapid-fire messages | coalesce 2s + waiting in-flight lock | 12s DB mutex (serializes, can time out) |
| Language switching | classifier + prompt | "ENGLISH ONLY" prompt rule |

**Root-cause pattern:** nearly every Nudge failure mode traces to **"the LLM is a
single point of failure with no deterministic backstop."** Nearly every Grace
*weakness* traces to **"too many deterministic backstops, which add complexity and
can over-fire."** These are exactly the costs of their respective philosophies.

---

## 11. Quantitative scorecard (1–10)

| Dimension | Grace | Nudge | Notes |
|---|---:|---:|---|
| Trust / safety floor | **9** | 5 | Deterministic crisis handling vs prompt-only |
| Accuracy (grounding) | **8** | 6 | Live RAG + grounding vs parametric + prompt |
| Speed (perceived) | **8** | 7 | Fast-path + parallel guards vs 3 hops, faster model |
| Personalization | 8 | 8 | Different strengths, even |
| Natural conversation | 7 | **8** | Nudge's temp-0.8 + Gemini-3 + tone prompt |
| Reliability (uptime behavior) | **9** | 4 | Nudge sends silence on LLM failure |
| Food-logging | 8 | 8 | Clean model vs outage resilience |
| Memory precision | **8** | 6 | Vector + recency vs notebook; Nudge RAG dormant |
| Maintainability | 6 | **8** | One file vs monorepo of stages |
| Ease of use (effort) | 7 | **8** | Auto-profile-extract lowers effort |
| **Weighted overall** | **~7.9** | **~6.6** | Safety/reliability weighted heaviest |

(Radar shape: Grace = tall on safety/reliability/grounding/memory, shorter on
naturalness/maintainability. Nudge = balanced/round, peaking on
naturalness/maintainability/effort, with a deep notch on reliability/safety-floor.)

---

## 12. SWOT

**Grace — Strengths:** deterministic safety, multi-layer validation, live RAG
grounding, outage resilience, modular/testable core, anti-repetition proactive,
settings-as-source-of-truth.
**Grace — Weaknesses:** older base model, complexity/maintenance cost,
over-sanitization can flatten voice and over-fire, heavy per-turn machinery.
**Grace — Opportunities:** adopt Gemini 3 and *delete* guards the new model makes
unnecessary; borrow Nudge's pending-portion diary model and auto-extract (gated);
A/B naturalness.
**Grace — Threats:** a simpler competitor on a newer model that "feels" warmer in
the demo; guard maintenance burden slowing iteration.

**Nudge — Strengths:** newer model, clean single-file architecture, excellent tone
prompt, elegant pending-portion diary, auto-profile-extract UX, broad test suite
(40 test files), strong proactive cadence logic.
**Nudge — Weaknesses:** LLM single point of failure (silence on outage, *including
on crisis*), no post-gen validation beyond relevance, dormant RAG, profile-drift
risk, no fast-path (latency tax on trivial msgs), giant prompt is brittle to edit.
**Nudge — Opportunities:** add a deterministic crisis/empty-reply backstop (cheap,
huge safety win); wire up its existing RAG; add a fast-path.
**Nudge — Threats:** one bad crisis-message outage is a serious incident; prompt
sprawl will eventually hit context/consistency limits.

---

## 13. Top recommendations for Grace (prioritized)

### Quick wins (<1 week)
1. **Upgrade the base model to Gemini 3 Flash (or 2.5→latest) behind a flag and
   A/B it.** This is the highest-leverage change available. Nudge's biggest edge
   is simply being a model generation ahead. Run the existing auto-eval +
   regression suites on the new model; many of Grace's tone/naturalness guards may
   become removable, which *reduces* complexity. (Root cause of Nudge's
   naturalness edge.)
2. **Adopt Nudge's "don't end with a question by default" rule verbatim** into
   `prompts.ts` if not already as strong. Their phrasing of this is excellent and
   directly targets the #1 chatbot tell.
3. **Borrow Nudge's structured `pending_portion` diary state** as the canonical
   model for food clarifications, replacing some of Grace's regex continuation
   gates. Cleaner, DB-backed, less brittle. (Medium effort if done fully; the
   *concept* is a quick prompt/data alignment.)
4. **Loosen one notch on over-sanitization:** audit how often the
   behavioral/quality guards regenerate an already-good reply into a blander one
   (log "regen improved vs flattened"). This is Grace's main naturalness leak.

### Medium-term (1–4 weeks)
5. **Evaluate a gated version of auto-profile-extraction** for *non-identity*,
   low-risk fields only (e.g. weight log, mood) while keeping Settings as the
   source of truth for identity fields (medication, dietary, injection day). Capture
   Nudge's "feels magical" effort win without re-opening the drift bugs Grace
   already fixed. Write to a staging field + confirm, not silently.
6. **Wire a naturalness A/B harness** into the existing auto-eval: same 43
   scenarios, Grace-current vs Grace-on-Gemini-3 vs (if obtainable) Nudge-style
   minimal pipeline. Decide guard-by-guard which to keep.
7. **Latency: confirm the fast-path covers the same trivial share Nudge pays full
   price for** — this is already a Grace advantage; quantify and market it.

### Long-term (1–3 months)
8. **"Thin out" pass:** for every deterministic guard, run an ablation on the new
   model and remove the ones that no longer earn their complexity. Grace's
   architecture is its moat *and* its tax; on a stronger model the tax shrinks.
9. **Instrument production reliability comparison:** the one number that decisively
   beats Nudge is "% of messages that get *a* reply under partial LLM degradation."
   Grace should be ~100%, Nudge measurably <100%. Make this a tracked SLO and a
   sales/clinical-trust talking point.
10. **Keep the deterministic crisis/safety layer no matter what model you adopt.**
    It is Grace's single biggest durable advantage over Nudge and the philosophy
    most worth defending.

---

## 14. Bottom line

Nudge is an impressively clean, well-tested, newer-model implementation of the
same product, and on a polished happy-path demo it may well *feel* warmer and
snappier. But it is **one LLM failure away from sending silence on a crisis
message**, it has **no validation floor**, its **RAG is dormant**, and its
**auto-profile-extract reintroduces the exact drift class Grace deliberately
engineered away**.

Grace's architecture costs complexity and currently runs an older model, but it is
**safe by construction, reliable under degradation, and grounded in real
retrieved knowledge** — the properties that matter most for women on prescription
medication. The right strategic move is not to abandon Grace's defensive
architecture but to **put it on Nudge's newer model and delete the guards the new
model renders unnecessary** — keeping the deterministic safety/reliability layer
that is Grace's durable moat, while closing the naturalness/latency/effort gap that
is mostly attributable to model generation and a few borrowable ideas.

**Win condition:** Grace on Gemini 3 + pending-portion diary + gated auto-profile
for safe fields + a measured naturalness pass, with the deterministic safety/
reliability layer intact. That configuration beats Nudge on every axis, including
the two (naturalness, effort) where Nudge currently leads.
