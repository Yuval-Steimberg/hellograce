# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

_Also loaded automatically at session start. Update at the end of every session so the next session resumes without re-deriving context._

---

## 👉 SESSION SUMMARY (2026-07-07) — current `main` HEAD `5d2130f` (PR #217 = ONE-pass reply); deploy = `fly deploy` grace-api, verify `/health`. NOTE: GitHub MCP dropped for two fixes (ff'd to `main` directly) then reconnected (#217 via PR).

### 🔬 FULL-SYSTEM VALIDATION PLAYBOOK (delete user → onboard → verify)
Use this to validate end-to-end from scratch. **Deploy the latest `main` FIRST**
(`fly deploy` grace-api, confirm `/health`.version == HEAD) so you're testing
current code, not an old build.
- **DELETE the user (clean slate):** admin dashboard (`grace-admin-silk.vercel.app/admin`
  → Users → open your number → **Delete user**), OR curl `DELETE
  https://grace-api.fly.dev/admin/users/%2B<E164>` with `Authorization: Bearer
  $ADMIN_TOKEN` (URL-encode `+` as `%2B`). `purgeUserData` wipes every child table
  + user row + in-memory/today-food caches. **CAVEAT — not cleared by delete:**
  Redis keys keyed by phone (`food:pending:`, `settings:session:`/`:code:`,
  `paid:welcomed:`, `meal:rec:`, `daily_summary:`, `sched:`/`cadence:`,
  `profile:replay:`). They don't block onboarding (that keys off the DB row), but
  for a pristine test either flush them or, post-onboard, text "reset my food log"
  to zero pending. (Possible enhancement: have `purgeUserData` also clear these —
  needs the redis dep wired into UserService.)
- **ONBOARD from scratch:** text Grace anything → in-chat flow (webhook.ts ~557,
  gated on `SMS_ONBOARDING_ENABLED` default-on + `needsRegistration`). Slots in
  order (`onboarding-flow.ts` L121): first_name → medication → medication_frequency
  → injection day → timezone (AUTO from phone) → wake_sleep → dietary → consent →
  completion sets `trial_start` (trial begins). VERIFY: no re-asks, warm/varied
  wording, completion invites the FIRST food log.
- **VERIFY features (the session's fixes + one-pass):** clear food ("2 eggs") logs;
  ambiguous ("a sandwich") asks what's in it; portion-sensitive ("chicken and rice",
  no amount) asks how much; protein shake asks scoops/brand; "2 eggs with salad"
  asks about the salad; a portion answer ("one cup") → SHORT confirm, NO plan/history
  leak; "what have I eaten today?" → clean log summary (after reset → "nothing logged
  yet"); "reset my food log" → 0g; multi-topic planning msg mentioning ambiguous food
  → asks, never assumes a total, no numbered "game plan"; "when's my next reminder"
  → real schedule (no capability denial); "change my protein goal" → Settings link;
  "dashboard" → link. Watch latency: replies should be fast (one Gemini pass now).
- **VERIFY data surfaces:** admin `GET /admin/users/%2B<phone>/food-logs` (returns
  `{items,…}`) + the dashboard reflect what was logged.


**LATEST (PR #217) — unified reply collapsed to ONE Gemini pass + fast
deterministic floors.** User ask: latency too high, system too complex, "trust the
strong model, leave the most important guards, make them fast." The grounded path
had grown to a cascade of up to ~7 SEQUENTIAL Gemini calls/turn (main reply +
relevance judge + 5 LLM regens: relevance/report-shape/assumed-protein/false-total/
must-ask). Now ONE reply call + DETERMINISTIC-only floors (no extra LLM): report
shape → `stripReportShape`; ambiguous/pending food → `stripAssumedProteinSentences`
(only realTotal+goal allowed) + append `pendClarify` if the ask is missing; the
ONE LLM "extra" kept is a rare capability-denial retry (can't fix deterministically,
shipping "I'm an AI" is bad). Removed the relevance judge + all 5 LLM regens — their
deterministic equivalents remain, so NO fix regressed (no assumed number, no plan
shape, every pending food still asked). Worst-case chat/multi-topic: ~7 calls → 1.
Net −55 lines, one file (`runUnifiedReply` tail). UNTOUCHED: `foodStepUnified`
(salad/shake ambiguity, portion resolution, clarify-echo, backstop), the diary
intercept, and the cheap pre-LLM intercepts (crisis/hypo/settings/reminders). Food
turn path unchanged (extraction + one guarded warm call). **OPEN (user flagged, NOT
done — too risky blind): the master system prompt is still ~2500 lines ("too many
guards off the prompt"); tightening it to a Nudge-size accurate prompt needs a live
A/B, do it carefully next.** 1945 api + 659 ai-core green.

**A portion answer resolves pending food deterministically (no history
leak).** Prod IMG_6713: user answered "One cup" to a salad portion Q; Grace logged
it but dumped a numbered "plan for the rest of the day … parents' dinner tonight:
1. …" — leaking the earlier Friday-parents planning into a portion reply. Root
cause: a bare amount ("One cup") has no food word → `extractFood` returns
none/query → `foodSpanFromConsumption` null → `foodStepUnified` returned null →
turn fell to the GROUNDED path (fed FULL history at `effHistory = history`) → LLM
re-opened the planning thread. Fix (`foodStepUnified`): a short amount-only reply
while a portion is pending now logs each pending item with the stated amount
DETERMINISTICALLY (no extractor, no history, no grounded path); scoped out when it
names a new food / is a mutation / >6 words / has no amount. NOTE: current main
already blocked the *shape* two other ways (`UNIFIED_BREAKDOWN_RE` matches "here
is your plan … 1."; the deterministic food path carries no history), so IMG_6713
was an OLDER build — but this closes the underlying leak path. **USER FEEDBACK
(important): the accumulated guards/intercepts have made the reply system too
complex; they want a SIMPLER consolidated design. The direction: food logging is a
side-effect; a food/portion turn ALWAYS gets a short snapshot-based confirmation
with NO conversation history; only a genuine standalone question uses the LLM
(bounded history). Consider consolidating the food-reply branches in
`runUnifiedReply` toward that single invariant.** 1945 api + 659 ai-core green.

**"what have I eaten today" answered from the LOG, never conversation
history.** Prod IMG_6710: after a reset, "Good morning, what I have eaten today?"
was answered by the grounded LLM reading history → it dragged the PRE-RESET
shake+sandwich back up and offered to re-add them. Nudge (IMG_6711/6712) answers
plainly: "Nothing is logged yet for today." Root cause: a food-diary QUESTION had
no deterministic handler in the unified path; query-fast's summary regex is
anchored (^…$) so a greeting prefix ("Good morning,") + the "what I have eaten"
word order both miss it → fell to the grounded LLM (which reconstructs from
history). **General fix (whole class):** (1) new exported `isFoodDiaryQuery(text)`
— matches ANY phrasing/word order of "what have I eaten / what did I eat / how
much protein have I had / show my food today", greeting-tolerant; excludes
recommendations/plans + mutations. (2) Deterministic intercept in `runUnifiedReply`
(after query-fast, before the food step) answers from `getTodaysFoodSummary` via
`renderDailyFoodSummary` (per-local-day window) → empty log = "Nothing logged yet
today", never a reconstruction. (3) Grounded-prompt hardening (closes the class
for any phrasing the regex misses AND multi-topic turns): the "Total protein
TODAY"/"Foods logged today" lines are declared the ONLY source of truth for
intake — never infer from history/a reset, never offer to re-add mentioned food.
Tests: `food-diary-query.test.ts` (18 phrasings). Verified end-to-end on IMG_6710.
**1945 api + 659 ai-core green; typecheck + build clean. NOT deployed — `fly
deploy` grace-api, verify `/health`. No migration/env.**

**PR #215 — clarification never echoes the whole message as the food
name.** Prod IMG_6709 (same Friday-parents message): reply asked "…how many scoops
was the **I ate pretty light, just a protein shake and a sandwich, and I still
feel like I need more protein**, or what brand and size?" — the RAW consumption
span was injected as the food item. Root cause: `foodStepUnified`'s never-drop
backstop (fires when the span re-extraction returns nothing — e.g. a Gemini
timeout → `EMPTY_EXTRACTION`) pended + asked about the raw `span` string, so
`buildPortionConfirmQuestion` echoed the entire message. `food.clarify` (the
garbled backstop value) takes precedence over the clean reply-guard value in
`runUnifiedReply`. **Fix (two general layers):** (1) new exported
`ambiguousFoodNames(span, context)` returns only CLEAN food words ("sandwich",
"protein shake"), never the raw span — the backstop now pends/asks those; if none
nameable, logs the span (never-drop). `ambiguousEatenFoods` reuses it (unchanged
behavior). (2) Defense-in-depth: `buildPortionConfirmQuestion` runs each item
through new `foodLabel()` — a normal food phrase (≤32 chars, ≤5 words) passes
through, an over-long sentence-like value is reduced to its recognized food token.
So no path can ever echo a whole sentence. Verified end-to-end on the exact
IMG_6709 message (backstop clarify → "…what was in the sandwich; how many scoops
the protein shake was?"). Only `foodStepUnified` backstop + `buildPortionConfirmQuestion`
labeling changed. **1943 api + 659 ai-core green; typecheck + build clean. NOT
deployed — `fly deploy` grace-api, verify `/health`. No migration/env.**

**PR #213 — salad no longer masked by an adjacent protein.** Prod
IMG_6708 on the CONFIRMED-deployed build (`/health`==`05a0db9`): **"2 eggs with
salad" logged the salad SILENTLY** (→32g), no ask. Root cause found + fixed: when
the extractor returns the meal as ONE combined item ("eggs with salad"),
`isCompositionAmbiguousFood` tested `FILLING_KNOWN_RE` against the WHOLE string, so
the eggs' protein word ("egg"/"eggs") matched anywhere and MASKED the salad's
ambiguity → logged at an assumed greens value. **General fix (`food-portion.ts`):
a filling resolves an assembled/mixed food ONLY when it belongs to THAT food** — a
modifier directly before the noun ("chicken salad", "ham and cheese sandwich") or
attached after via with/of/in ("salad with chicken"). A SEPARATE food joined by
with/and ("eggs with salad", "eggs and salad") no longer resolves it → the salad
stays ambiguous and is ASKED. Named dishes ("egg salad", "chicken salad", "green
salad") still log; no over-asking. Single change covers BOTH the log path
(`foodStepUnified`) and the reply guard (`ambiguousEatenFoods`) since both call
`isCompositionAmbiguousFood`. The span-level check now agrees with the per-item
check (a bare side salad in "salmon + potatoes + salad" is asked too). Tests:
`food-portion.test.ts` (separate-food-vs-attached-filling matrix) +
`complex-message-guards.test.ts` (salad surfaced alongside eggs). **1941 api + 659
ai-core green; typecheck + build clean. NOT deployed — `fly deploy` grace-api,
verify `/health`==new HEAD. No migration/env.**

**PR #212:** (a) a bare **salad / poke-bowl / grain-bowl** is now
composition-ambiguous → ASKS "what's in it?" (prod "2 eggs with salad" logged the
salad at assumed ~2-4g because the "2" made the msg "quantified", masking it; now
composition-ambiguity fires regardless of quantity; a named-protein/greens salad
still logs). (b) **NO-ASSUMED-PROTEIN number guard** — when food is ambiguous, the
reply may state ONLY the real logged total + the goal; ANY other gram figure
(however phrased) is regenerated then STRIPPED (`hasDisallowedProteinNumber` /
`stripAssumedProteinSentences`, ai.service.ts). Replaces phrase-by-phrase total
detection — the general fix for the recurring "consumed ~50g / usually ~25-30g"
assumptions.


Two workstreams this session, all MERGED to `main` (detailed per-PR sections below):

1. **Nightly end-of-day summary** (NEW feature, PR #202) — a SEPARATE system from
   reminders (own `tick()` pass, own Redis lock, `check_ins.type='daily_summary'`,
   deterministic render, `raw:true` send). **Dark-launched:** does nothing until
   `DAILY_SUMMARY_ENABLED=true` + migration `20260706000001_daily_summary.sql`
   applied. Admin toggle wired (`daily_summary_enabled` column). See its section.

2. **Reply-path: complex multi-topic messages + food accuracy** (PRs #203–#211) —
   driven by live IMG_6697…6707 screenshots comparing Grace (blue) vs Nudge
   (green). The user's hard rule: **be accurate, NEVER assume; give a real GENERAL
   solution, not per-message patches.** Final architecture: **LLM owns warmth;
   DETERMINISTIC, MESSAGE-DERIVED guards own accuracy + structure** (they do NOT
   trust the LLM extractor, which drops food on complex planning messages).

**WHAT WAS AFFECTED (blast radius — the user asked explicitly):**
- **All food logging** (single or complex): a bare sandwich/wrap/burrito/taco/sub
  → asks "what's in it?"; a protein shake/powder w/ no scoop/brand → asks
  "scoops/brand?"; NEVER logs an assumed number. Obvious foods (apple/eggs/toast)
  still log with an estimate. Consumption detection broadened ("I only had X").
  "reset my food log" now also clears the Redis pending store.
- **Complex multi-topic replies:** every part answered; report-shape lists
  ("here's your game plan/strategy: 1.") deterministically STRIPPED to warm prose;
  every ambiguous eaten food asked; assumed totals ("you've consumed ~50g") caught.
- **One side-effect outside food:** a single-topic NON-food chat reply that comes
  back as a numbered "here's the plan" list is now rewritten to prose (grounded
  path). Only makes it more prose-like.
- **UNTOUCHED:** reminders, scheduler, injection flow, settings, onboarding, auth,
  Stripe, dashboard, weight/water/habit/symptom logging. 1933 api + 659 ai-core
  green (no existing behavior regressed in test).

**THE TOOL for the next complex-message report:** `services/api/src/services/
complex-message-guards.test.ts` — the OFFLINE HARNESS. Add the failing message to
its battery, generalize the guard (`ambiguousEatenFoods` / `statesFalseConsumedTotal`
/ `stripReportShape` / `UNIFIED_BREAKDOWN_RE` / `CONSUMPTION_RE`) until green.
Prove the class deterministically instead of a live round-trip. **The user deploys
incrementally and every "still broken" so far traced to an OLDER build — ALWAYS
have them confirm `/health` == current HEAD before diagnosing.** Prod runs the
UNIFIED path, so all reply fixes live in `runUnifiedReply` (`ai.service.ts`).

---

## 👉 READ FIRST — message-derived food guards + OFFLINE HARNESS (2026-07-06, MERGED to `main` HEAD `c72fc0d` via PR #211, NOT deployed)

The reply-layer accuracy guarantees no longer depend on the LLM extractor (which
drops food on complex planning messages). Prod bug: the Friday reply said "you've
likely consumed about 50g so far today" — an ASSUMED total (diary was empty) —
and didn't ask about the food. Now DETERMINISTIC + message-derived:

- **`ambiguousEatenFoods(text)`** (exported, ai.service.ts): from the message
  ALONE, names the eaten foods that can't be logged without a clarification (bare
  sandwich/wrap/burrito/…, or a protein shake w/ no scoop/brand) + the clarify.
  `runUnifiedReply`'s MUST-ASK guard uses `foodStepUnified` pending items OR — if
  the extractor dropped them — this message-derived set. So an ambiguous eaten
  food buried in a planning message is ALWAYS asked, never assumed.
- **`statesFalseConsumedTotal(reply, realTotal)`** (exported): catches an ASSUMED
  consumed total; only present-tense "consumed/so far today/you're at Ng" claims
  are checked (goal/target/"to go"/"need" left alone). The false-total guard now
  runs whenever there's food context (logged OR ambiguous-pending), not just when
  something was logged, and regens with the real total.
- **OFFLINE HARNESS** `services/api/src/services/complex-message-guards.test.ts`:
  runs the real user complex-message battery through the guards — proves the class
  without live Gemini. It IMMEDIATELY caught a general gap ("I only had a shake and
  a sandwich" wasn't recognized as consumption — adverbs only/recently/earlier
  missing from `CONSUMPTION_RE` filler set; broadened it). This is the tool to use
  for the NEXT complex-message report: add it to the battery, generalize the guard.

Test-only harness + additive guards; NO change to logging/reminder logic. api 1933
(+11) + ai-core 659 green. **Deploy = `fly deploy` grace-api, verify `/health`.**
Architecture: LLM for warmth, deterministic message-derived guards for accuracy.

---

## 👉 READ FIRST — multi-topic: GUARANTEE prose (deterministic strip) + fix eaten-food span (2026-07-06, MERGED to `main` HEAD `a62253d` via PR #209, NOT deployed)

On the CONFIRMED-deployed build (`/health`==`011db0e`) the Friday multi-topic
message STILL shipped "…Here is your strategy: 1." (truncated) and never asked the
food clarification. Real code bugs (not deploy lag), both deterministic:

1. **Report-shape regen didn't hold.** flash keeps emitting "here's your strategy:
   1. …" even when told not to, and the guard only adopts a CLEAN regen → it
   shipped the original list. New exported **`stripReportShape(text)`** (ai.service.ts):
   when the multi-topic regen STILL matches `UNIFIED_BREAKDOWN_RE`, cut the list/
   heading tail and ship the warm prose preamble (trimmed to last complete
   sentence). A numbered game-plan/strategy can NO LONGER reach the user — worst
   case is warm prose minus the list.
2. **`foodSpanFromConsumption` grabbed the wrong clause** (`meal-lifecycle.ts`).
   For "…there will probably be pasta, bread… Today I ate a protein shake and a
   sandwich…" it returned the FUTURE dinner food (pasta/bread) because it cut at
   the first sentence. Now it anchors the span at the earliest real consumption
   verb ("Today I ate…"), so the eaten shake+sandwich (not pasta) flow into the
   pending/clarify logic.

api 1922 (+4) + ai-core 659 green. **Deploy = `fly deploy` grace-api, verify
`/health`==new HEAD.** NOTE: the food-CLARIFICATION asking still partly depends on
the live `extractFood` LLM (returns the foods → confirmed loop pends+asks; returns
`none` → the now-fixed span backstop pends+asks) — couldn't exercise live Gemini
in-session, so the ASK wording needs the user's post-deploy look; the report-shape
strip is fully deterministic and guaranteed.

---

## 👉 READ FIRST — multi-topic replies: warm prose + always ask the food clarification (2026-07-06, MERGED to `main` HEAD `2ec1d0b` via PR #206, NOT deployed by me)

Live screenshots (IMG_6705/6706, the Friday family-dinner multi-topic message).
Two problems in the multi-topic grounded path from PR #203:
1. **Report shape** — reply came back as "Here is a game plan… 1. Before You Go
   (The 'Bridge' Snack)… 2. …" (numbered headings, truncated). #203 had DISABLED
   the breakdown/shape guard for multi-topic turns → report shapes shipped.
2. **Clarification not asked** — the food logged at assumed values (65g), and
   "How 65g?" admitted "Sandwich: ~23g (Assuming ~3-4oz deli meat…)". The
   deterministic `food.clarify` (from #204/#205) was computed but only used in
   the terse early-return path, never surfaced in the multi-topic reply.

**Fix (`runUnifiedReply`):** (a) the report-shape guard (`UNIFIED_BREAKDOWN_RE`)
now RUNS for multi-topic turns, but its regen KEEPS every part while forcing warm
flowing prose (no numbered steps/headings/"game plan"/bullets) instead of the old
"collapse to 1–2 sentences". (b) the exact `food.clarify` is injected into the
grounded note ("weave THIS question in…") + a MUST-ASK post-guard regenerates
once (then appends the deterministic clarify as a last resort) if the draft has no
"?". So a pending sandwich/shake always gets its accuracy question AND the other
parts are answered. api 1918 + ai-core 659 green.

**⚠️ DEPLOY NOTE:** the IMG_6705/6706 behavior (food logged at assumed values, no
ask) means prod was running an INTERMEDIATE build (after #203, before #204/#205/
#206). The user must `fly deploy` the LATEST `main` — verify `/health` — to get
ALL of #204 (sandwich asks) + #205 (shake asks) + #206 (prose + guaranteed ask).
No migration/env for these reply fixes.

**FOLLOW-UP (PR #207, MERGED to `main` HEAD `f1479af`, NOT deployed):** after the
user deployed, IMG_6707 STILL showed a game plan ("…Here is your game plan for
Friday… 1." truncated). #206's shape guard was live but `UNIFIED_BREAKDOWN_RE`
MISSED it — it required "1. <Capital>" (a reply truncated at a lone "1." doesn't
match) and didn't recognize "game plan"/"here's your plan" framing. Broadened the
regex to add `game plan`, `here is a/the/your … plan`, `here is how to/you/i`, and
a trailing lone-number `\d[.)]$` (truncated list). Verified vs the exact
IMG_6707/6705 strings (matches game-plans, leaves warm prose/plain answers alone).
ALSO: `detectFoodReset` now clears the Redis pending-food store (`clearPendingFood`)
so "reset my food log" truly zeroes the day. **The 65g in IMG_6707 was STALE
accumulated data from re-testing the same message — recommend the user text "reset
my food log" then send a FRESH message to see clean pending/ask behavior.** api
1918 + ai-core 659 green.

---

## 👉 READ FIRST — food logging never assumes a sandwich's filling (2026-07-06, MERGED to `main` HEAD `63c3ded` via PR #204, NOT deployed by me)

Live-testing screenshots (IMG_6699 Grace / IMG_6700 Nudge, same input). Grace
logged "a protein shake and a sandwich" at 65g and, asked "How 65g?", admitted
"Sandwich: ~23g (**assuming** deli meat/poultry and bread)". Nudge counted only
the shake at standard and said "still waiting on the details for your sandwich" —
never assumed the filling. The word "assuming" violates the standing "no
assuming, be accurate" rule.

**Root cause:** `foodStepUnified` only asked for a portion when a food was in the
PORTION-SENSITIVE set AND no quantity was present. `sandwich`/`wrap`/`burrito`
are in no ambiguity set, and the bare article "a" made `hasExplicitQuantity` true
→ logged at an assumed value. (`detectProteinProduct`/`detectAteOut` "ask even
though 'a' is present" logic existed but only on the COMPACT path, not unified.)

**Fix (`food-portion.ts` + `foodStepUnified` in `ai.service.ts`):**
- New `isCompositionAmbiguousFood(item)`: an ASSEMBLED food (sandwich, wrap,
  burrito, taco, sub, hoagie, quesadilla, panini) mentioned WITHOUT a filling has
  unknowable protein → must be ASKED, even when an article is present. A NAMED
  filling ("turkey sandwich", "chicken wrap", "egg sandwich", "PB sandwich") stays
  loggable. Non-assembled foods — INCLUDING a protein shake — are unaffected, so
  the shake still logs at standard, matching Nudge exactly.
- `foodStepUnified` (confirmed loop + never-drop backstop) downgrades a
  composition-ambiguous food to PENDING regardless of the article.
- `buildPortionConfirmQuestion` asks "what was in the sandwich?" (composition) vs
  "how much?" (portion-variable, unchanged). Multi-topic grounded pending-note
  updated to ask what's in an assembled food + never assume a number.

**Verified:** api 1878 (+5) + ai-core 659 green; typecheck + build clean. Live
extractor path needs a post-deploy look. **Deploy = `fly deploy` grace-api (no
migration, no env).**

**FOLLOW-UP (PR #205, MERGED to `main` HEAD `ec1fe29`, NOT deployed):** the user
then asked for the protein shake to ask too. New `food-portion.isProteinProductAmbiguous(item,
context)` — a protein shake/drink/powder/whey/mass-gainer with NO scoop count /
gram figure / known brand → ASK "how many scoops, or what brand and size?" (checks
the item AND the full message, so "a protein shake, 2 scoops"/"fairlife"/"30g"
logs; a protein BAR, a milkshake, and a bare "shake" are excluded). Wired into
`foodStepUnified` (confirmed loop + backstop) + a third branch in
`buildPortionConfirmQuestion` (scoops/brand vs composition vs portion) + the
multi-topic pending-note. So NOW both the sandwich AND the shake are asked, fully
matching Nudge on IMG_6699/6700. api 1883 (+5) + ai-core 659 green.

---

## 👉 READ FIRST — unified path no longer collapses multi-topic messages (2026-07-06, MERGED to `main` HEAD `944d7f8` via PR #203, NOT deployed by me)

Live-testing screenshots (IMG_6697/6698): the SAME long message sent to Grace
(blue/iMessage) and Nudge (green/SMS). The message mentions food eaten AND asks
several planning/emotional things ("I ate a protein shake and a sandwich… help me
plan what to eat before dinner, what to choose at the meal, and how to handle
dessert without feeling guilty?"). **Grace collapsed it into a terse 2-sentence
food-confirmation** ("you're already at 65g, try Greek yogurt + double meat") and
DROPPED the meal advice + dessert-without-guilt + reassurance; Nudge answered all
of it. NOTE: the 65g was REAL (the shake+sandwich were logged → 12g→65g), so this
was a COMPLETENESS/shape bug, not a hallucination.

**Root cause:** `runUnifiedReply`'s deterministic food early-return (built to kill
the 669g hallucination) fires on ANY food mention and its warm reply is capped at
1–2 sentences → it swallows the rest of a multi-part message. The `isMultiTopic`
guard that protects the compact path was never applied inside the unified food
block. **Prod runs the UNIFIED path, so this early-return is live.**

**Fix (all in `runUnifiedReply`, `ai.service.ts`):**
- Gate the food early-return on `!isMultiTopic` (`analyzeMessage(input.text).hasMultiple`,
  media-guarded). A PURE food log ("I just had eggs") is unchanged — still the fast
  deterministic confirmation with the exact grounded total.
- Food mentioned INSIDE a bigger ask → still LOG it (side-effect, `foodStepUnified`
  unchanged) but FALL THROUGH to the grounded path with a "FOOD JUST HANDLED" note
  (running total = authoritative `getTodaysFoodSummary`, the ONLY total it may
  state) + `buildMultiPartNote(understanding)` so every part is answered, feeling
  first. `todaysFood` already reflects the just-logged items.
- Skip the breakdown-shape regen (`UNIFIED_BREAKDOWN_RE`) for multi-topic turns so
  a legit multi-part answer isn't truncated back to 1–2 sentences.
- **Tight false-running-total guard** on the grounded reply for these turns: only
  an explicit "you're at Ng / total today is Ng" claim is checked vs the real
  total (advice/goal numbers like "aim for ~30g" left alone) → regen once with the
  correct number. Keeps the 669g class closed in the grounded path too.

**Verification:** the user's 15-message long multi-topic battery ALL route to the
full grounded answer (`hasMultiple=true`, each carries a `food` part so it's still
logged) — locked as regression tests in `message-understanding.test.ts` (+ the
exact IMG_6697 message). Pure food logs stay single-topic. **api 1873 + ai-core
659 green; typecheck + build clean.** Only `ai.service.ts` + `message-understanding.test.ts`
touched (95 insertions). **CAVEAT: could NOT run live Gemini in-session** — verified
the ROUTING deterministically (the actual bug); the generated WORDING needs the
user's live look after deploy. **Deploy = `fly deploy` grace-api (no migration, no
env change).**

---

## 👉 READ FIRST — nightly end-of-day summary (NEW feature, 2026-07-06, MERGED to `main` HEAD `b7f3f44` via PR #202, NOT deployed by me — needs migration + `DAILY_SUMMARY_ENABLED=true`)

A brand-new **daily recap** feature, deliberately SEPARATE from reminders (user's
hard constraint: "do not modify/damage the reminder system; this is not a
reminder"). Grace sends each eligible user a short warm end-of-day wrap-up of what
they logged + a soft take + 1–2 practical suggestions for tomorrow. **1890 api
(1855 + 35 new) + 659 ai-core green.** Additive only — reminder `processUser`/
cadence/injection state machine UNTOUCHED. **PR #202 open against main; branch is
NOT yet rebased onto the #203 merge (no conflict — #202 touches none of the same
files as #203).**

**Architecture (isolation is the point):**
- New `services/api/src/services/daily-summary.ts` (pure + best-effort):
  `gatherDailySummaryData` (fans out today's food/water/habits/symptoms/weight/
  injection via existing best-effort helpers, mirrors `routes/dashboard.ts`),
  `hasLoggedData`, **deterministic** `renderDailySummary` (NO LLM), plus pure
  window math `dailySummaryTargetMinutes` / `isInDailySummaryWindow`.
- New scheduler pass `Scheduler.sendDailySummaries()` — a **third independent
  `tick()` pass** (alongside `nudgeAbandonedOnboarding`/`reengageQuietOptedOut`),
  modeled on `reengageQuietOptedOut`. Does NOT go through `processUser`/
  `sendAndRecord`.
- **Dedup:** own Redis key `daily_summary:{phone}:{localDate}` (NX, 23h), distinct
  from reminder `sched:`/`cadence:`. **Fails CLOSED** (skip on Redis error).
  Records `check_ins.type='daily_summary'` (free-form column → no migration).
- **Send:** `sender.send({..., raw:true})` so the multi-line "Protein: 82g" recap
  survives the sanitizer (both iMessage + Sendblue honor `raw`).

**Product decisions (locked by the user):** (1) deterministic template, no LLM;
(2) **skip entirely on zero-log days** (no lock claimed, so a late log can still
trigger a send in the window); (3) **dark launch** — `DAILY_SUMMARY_ENABLED` env
default OFF + per-user `users.daily_summary_enabled` column default TRUE; (4) send
target = `sleep_time − 30min` clamped **19:00–21:00** local, default 21:00, 15-min
window. Audience = `listActiveUsers` minus onboarding-in-progress minus opted-out.

**Admin toggle wired:** `GET`/`PUT /admin/users/:phone` carry `daily_summary_enabled`;
`UserDrawer` has a "Nightly daily summary" switch (invalidates user-detail +
admin-users). `UserDetail` type carries it.

**Files:** `config/env.ts`, `user/user.service.ts` (GraceUser +col), `scheduler/
scheduler.ts` (+`pool`/`dailySummaryEnabled` deps, +tick call, +method), `server.ts`,
`routes/admin.ts` (GET+PUT), web `UserDrawer.tsx` + `lib/api.ts`, new
`services/daily-summary.ts` + `.test.ts` (35 cases), migration
`20260706000001_daily_summary.sql` (1 col, default TRUE).

**TO DEPLOY (user):** merge PR #202, apply migration `20260706000001_daily_summary.sql`
in Supabase, `fly deploy` grace-api, then `fly secrets set --app grace-api
DAILY_SUMMARY_ENABLED=true`. Until the env flag is flipped the whole pass no-ops.

---

## 👉 READ FIRST — GLP-1 start date + settings reads never fabricate (2026-07-05, branch `claude/injection-start-date-57bxof`, NOT merged, NOT deployed)

Live-testing screenshots (start-date questions). Branch off `main`; **1855 api +
659 ai-core green, all packages typecheck + build clean.** Commit `f0cd50e`. NOT
merged to main, NOT deployed. Governing rule the user set: **Grace must NEVER
fabricate ANY settings datum — answer from stored data, or ask the user to
set/confirm it; never invent.**

Three reported failures, all on the GLP-1 start date:
1. "When I started taking the injection" → "Today (Sunday) is your Ozempic shot
   day." A START question was stolen by the injection-timing intercept
   (`NEXT_RE` matched "when … injection").
2. "When I started with glp?" → the LLM **fabricated** "September 15, 2024 … your
   8th week … your jawline …" (matched neither the stored value nor reality).
3. Settings showed a garbage start date ("Jan 5, 1999"); a start date stated in
   chat was never saved.

Root cause: the **unified path (live in prod) had NO deterministic settings-read
layer** — `tryQueryFast` (start_date/week_number/medication/injection_day/weights/
age, all read from stored data, never fabricated) was wired into the COMPACT path
only. So on prod those questions fell to the LLM → fabrication.

Fixes (commit `f0cd50e`):
- `medication-schedule.ts`: `detectInjectionTimingIntent` now returns null for
  ONSET phrasing (started/began/"how long have I been on"/"first shot") so a
  start question is never answered with the next shot day.
- `query-fast.ts`: broadened `START_DATE_RE` to the no-"did" forms ("when I
  started with glp", "when I started taking the injection"). `start_date` +
  `week_number` use a **plausibility guard** — missing OR implausible stored date
  (future / <2015, e.g. "1999") → flag it and ASK, never parrot or compute a bogus
  week. Uses new `buildStartDateAnswer`/`isPlausibleStartDate`.
- **Wired `tryQueryFast` into `runUnifiedReply`** — after the deliberate unified
  intercepts (personal-stats keeps protein/calorie; query-fast owns the rest),
  before the food step. This is the big general win: all settings-field reads are
  now deterministic in the live path.
- New `services/api/src/services/medication-start-date.ts` (pure, fully tested):
  `parseStartDateStatement` captures a start date the user STATES in chat
  (absolute / relative "6 weeks ago" / duration "for 8 weeks"), with tight
  onset↔medication binding (won't capture "I started this diet 3 weeks ago") and a
  plausibility guard (never stores future/1999/unrelated). `buildStartDateCaptureReply`
  confirms it. Wired into BOTH reply paths before injection-timing.
- Validation: settings PUT + onboarding reject/skip an implausible `glp1_start_date`;
  Settings `<input type=date>` constrained to `[2015-01-01, today]`.
- `nudge-prompt.ts`: explicit "NEVER FABRICATE PERSONAL DATA (settings/profile)"
  rule for the residual LLM-handled fields (height/sex/tz/wake-sleep/etc.).

**Deploy = merge to main + `fly deploy` grace-api** (web auto-deploys on Vercel;
the chat-side fix needs the API deploy). No migration. **Note (not fixed, out of
scope):** the scheduler's `injectionNumberFromStart` would still compute an absurd
"#N" from a garbage stored date — self-corrects once the user fixes the date via
chat/Settings; guard it there if it resurfaces.

---

## 👉 READ FIRST — live-testing quality fixes + cross-surface sync (2026-07-05, MERGED to `main` HEAD `b2f1684`, NOT deployed by me)

Follow-on to the product-gaps roadmap below. Driven by real iMessage screenshots
+ a sync audit. All on `main` (branch `claude/grace-product-gaps-roadmap-h05gyn`),
1811 api green, api+web typecheck clean, web builds. **NOT deployed by me** — user
applies the 2 roadmap migrations (still pending) + `fly deploy` grace-api; web
auto-deploys on Vercel. **Prod is running the UNIFIED path (`UNIFIED_REPLY_PATH`
on)** — proven because the food portion wording matched the unified `warmSys`
verbatim. That matters: the unified branch (`ai.service.ts` ~1069) RETURNS EARLY,
so the ~20 handleMessageInner intercepts are bypassed — any reply-quality fix must
go inside `runUnifiedReply`, not the compact path.

**Commits:** `c8fa014` admin toggle UI fix → `0a57020` logging/reply-quality →
`bd71bcc` cross-surface sync → `b2f1684` suggest-a-number when a target is missing.

1. **Admin toggle switches didn't flip (`c8fa014`).** UserDrawer account switches
   (paid/pro/paused/blocked) + RLHF read `checked` from the `['user-detail',phone]`
   query, but the toggle mutations only invalidated `['admin-users']` → saved but
   never refetched. Both mutations now invalidate `['user-detail',phone]` too; RLHF
   switch reads from `detail` like the others.

2. **Protein-target inconsistency (`0a57020`).** "What is my protein goal?" hit the
   grounded LLM → invented a generic "100-120g" (with a report-shaped "Protecting
   Muscle / Fighting Fatigue" ramble), while the weekly summary + doctor questions +
   food logging all used the stored `protein_goal_grams` (140). Ported
   `tryPersonalStats` into `runUnifiedReply` (before the food step) → the goal +
   "how much have I had" answer from the SAME stored number everywhere. ONE source
   of truth.

3. **Multi-item portion question was generic (`0a57020`).** "chicken and rice" →
   "how much, a cup or a small container?" (fits neither). Root cause: the unified
   food `warmSys` FACTS forced ONE generic question. Now asks PER-DISH with a
   fitting reference (palm-sized piece for meat/fish, a cup for rice/pasta, a small
   container for yogurt) via new `portionHint()` in `food-portion.ts`;
   `buildPortionConfirmQuestion` multi-branch enumerates each dish.

4. **Doctor-questions follow-up was a truncated report (`0a57020`).** After the
   weekly recap offered "questions for your doctor?", "Yes please" fell to the
   grounded LLM → "Questions for your Doctor:" heading + list, cut off mid-sentence.
   Ported the deterministic `buildDoctorQuestions` intercept (confirm/refine/reject
   via `detectFollowUp` + `isDoctorQuestionsContext`) into `runUnifiedReply`,
   grounded + length-capped. Also hardened `isAcceptableRephrase` (rephrase.ts) to
   REJECT list/heading report-shape so ANY `warmlyRephrase` falls back to the clean
   template.

5. **Food day reset = local midnight — VERIFIED (no change).** `logging-window.ts`
   `userDayExpr`/`computeUserLoggingDay` already reset at local 11:59 PM→12:00 AM
   (no wake/5h shift anywhere in food queries or the Redis key).

6. **Cross-surface sync audit (`bd71bcc`).** Mapped dashboard / settings / admin /
   chat field coverage. Settings↔chat already fully synced (30 profile fields
   round-trip; `update()` invalidates the user cache). Fixed the real drift:
   (a) **Diet dual-source** — `effectiveDietaryRestriction` returned only
   `dietary_pattern` and DROPPED the free-text `dietary_restriction` (a "vegan +
   kosher" user lost kosher). Now MERGES both (keeps the pattern label so the diet
   key resolves, unions both forbidden sets). (b) **Admin parity** — added
   `starting_weight`+`checkin_days_interval` to admin GET; added `dose_mg`,
   `starting_weight`, `checkin_days_interval`, `medication_frequency`,
   `medication_time`, `exercise_habits`, `why_started`, `biggest_challenge`,
   `support_style` to the admin PUT schema (full Settings parity) + drawer inputs
   for dose/med-freq/starting-weight/height/sex/activity/primary-goal/interval +
   `UserDetail` type. (c) **Progress-photo weight** — `POST /dashboard/progress-photo`
   now also `logWeightEntry`s the optional weight (was stranded on the photo row,
   invisible to the chart + chat).

7. **Suggest-a-number when a target is missing (`b2f1684`).** `tryPersonalStats`
   used to derive+store a protein target from weight, but if weight was ALSO
   missing it returned null → the LLM invented a generic "100-120g". Now it never
   dead-ends: weight (or goal weight) present → suggests the `calculateProteinTarget`
   number + "confirm/adjust it in Settings"; no weight at all → gives a sensible
   GLP-1 suggestion (~100-120g) AND asks them to add their weight in Settings for
   the precise number. So a missing detail always yields a GROUNDED suggestion +
   a clear next step, never a made-up number. (Runs in both paths — the port is in
   `runUnifiedReply`, the compact path already calls it at ~1901.)

**NOTE on the unified path:** the doctor-questions + personal-stats ports were
added ONLY to `runUnifiedReply`; the compact path already had them. If the flag is
ever turned OFF, both paths are covered. Still NOT ported to unified (documented
gap): symptom-intelligence recall/record.

---

## 👉 READ FIRST — product-gaps roadmap: all-in-one GLP-1 command center (2026-07-05, MERGED to `main` HEAD `6c9757f`, NOT deployed by me)

**Full session arc (all on `main`, all green — 1807 api + 659 ai-core):** gap
analysis → 6 product-gap steps (protein targets, peptide safety, water, weekly
insights, habit checklist, dose timeline) → post-testing fixes (protein-goal chat
UX, capture-once profiling, surface-full-profile-in-prompt) → landing refresh +
pricing consistency + dead-code cleanup → reminders/scheduler verification + 7
fixes (2 injection quality + 5 minor). **Deploy = apply the 2 migrations
(`20260705000001_habit_logs.sql`, `20260705000002_dose_events.sql`) then
`fly deploy` grace-api (verify `/health` == HEAD); web/dashboard + landing
auto-deploy on Vercel from `main`.** No PR opened; merged via fast-forward.

**Reminders/scheduler verification (`4e7fdc6`):** full audit — cron every minute
(best-effort, allSettled), injection state machine (null→morning_sent→
done_confirmed→followup_sent→null, 24h stale reset, evening-injector fix), caps
(checkin_count_per_day 1-3, 3h gap, engagement cooldown 2h, quiet hours 21-07,
days-interval, jitter), Redis distributed lock (no dup across machines), content
rules + sanitizeProactiveOutput (salutation "For Yuval," strip), data grounding
(yesterday/today totals + symptom heads-up), reminder-service answers "when's my
next reminder". VERDICT: sound + all tests green (58 scheduler + 29 msg-gen + 23
reminder-service + 9 quiet-reengage). Fixed 2: (1) "done" detection was
exact-match → new `isInjectionDoneReply` (broad, scoped to morning_sent) so
"done ✅"/"all done"/"did it" advance; also now increments `injection_count`. (2)
injection msg now has a GROUNDED number + comfort supplies like the Nudge target:
`injectionNumberFromStart(glp1_start_date, freq)` → "#N" (null → prompt told not
to invent), fallback+prompt add site rotation + ginger tea/crackers/electrolytes,
threaded via `GenerateOpts.injectionNumber`. **Then fixed all 5 minor findings
(`ac4c8cd`):** (1) evening injectors' followup now fires in the late-evening quiet
window (21:00-22:59) instead of slipping to next AM, defers deep night, message
time-agnostic; (2) evening gate relaxed to `engagedToday || silentDays<1` (mirrors
midday); (3) `trial_expiry_reminder` split into CADENCE_EXEMPT (bypasses cap) vs
COOLDOWN_EXEMPT (only the 2 injection types) — trial nudge now respects the
engagement cooldown; (4) injection_morning/followup get `recentMessages` for
anti-repetition; (5) `toDateStr` now reads local wall-clock fields (tz-safe, no
UTC round-trip). +2 behavior tests. api 1807 green.


Session driven by a product-direction ask: make Grace the simple all-in-one
GLP-1 command center (medication, protein, habits, water, weight, symptoms,
weekly insights) instead of "a chatbot that answers questions." Did a full
gap analysis (dashboard/food-macro/medication/water/weekly/safety/subscription
mapped via parallel Explore agents), then implemented in verified, one-at-a-time
steps + follow-up fixes + a landing refresh. **ALL MERGED to `main` (HEAD
`5681007`). 1777 api + 659 ai-core green; all packages typecheck; web builds
clean. NOT deployed by me** — the user deploys `grace-api` on their Mac
(`fly deploy … --no-cache --build-arg GIT_COMMIT=$(git rev-parse --short HEAD)`,
verify `/health` == `5681007`); the web/dashboard + landing auto-deploy on Vercel
from `main` (so the marketing + dashboard changes are live on the next Vercel
build; the chat-side features need the API deploy).

**⚠️ TWO MIGRATIONS TO APPLY before Steps 5–6 work in prod (apply in Supabase
BEFORE / with the API deploy):** `20260705000001_habit_logs.sql` (habit checklist)
+ `20260705000002_dose_events.sql` (dose timeline). Both additive, RLS
default-deny; code degrades to empty/current-only until applied (like water_logs).
Steps 1–4 + the two follow-up fixes + the landing need **no** migration.

Steps shipped (each its own commit, verified before the next):
1. **Personalized protein/calorie targets for SMS-onboarded users** (`ac91779`).
   The calculators (`nutrition/protein-target.ts`, `calorie-target.ts`) existed
   but only ran on the deprecated web onboard route — SMS users (the default)
   silently got a generic 80g. New `nutrition/derive-targets.ts`
   (`deriveMissingTargets`, FILL-IF-MISSING, never clobbers a Settings value)
   wired into `onboarding-flow.ts` (after each field persist) +
   `UserService.logWeightEntry` + new `UserService.ensureNutritionTargets`.
2. **DIY-injectable / research-peptide safety guardrail** (`ee4b8fb`). New
   `safety/peptide-safety.ts` `detectPeptideSafety` — deterministic refusal for
   reconstitution/BAC-water/dosing-math/stacking/research peptides (warm, still
   offers safe tracking + clinician). Intercept in `ai.service.handleMessage`
   after the hypoglycemia block. Scoped so food "combine protein with carbs" +
   normal dose tracking pass through. Content-checker backstops for INSTRUCTIONAL
   outbound (BAC-water math, "to reconstitute", "draw up N units", "you can stack").
3. **Water on the dashboard + loggable** (`9726837`). Water was tracked
   (`water_logs`) + chat-logged since 2026-06-15 but invisible on the dashboard.
   `water-log.getDailyWaterHistory` (new) → `hydration` block in
   `/dashboard/summary` + `POST /dashboard/water` + `HydrationCard.tsx` (today vs
   range + 7-day consistency) + a Water tab in `QuickLog`. No schema.
4. **Weekly insights: totals + weight correlation + plateau** (`7367cd4`). New
   pure `services/weekly-insights.ts` (`weeklyProteinStats`/`weeklyWaterStats`/
   `weekWeightDelta`/`plateauSignal`/`buildWeeklyInsight`/`computeWeeklyStats`).
   Plateau only flags a real ≥14-day flat span; insight NEVER claims causation
   ("measurements often move before the scale"). `weekly` block in
   `/dashboard/summary` + `WeeklyReview.tsx` card + a hydration-consistency line
   in the chat weekly summary (optional `getDailyWaterHistory` dep on
   `UserService`, back-compat). No schema.
5. **Quick-checkmark habit tracking** (`110a819`, NEEDS the migration). 10
   canonical habits. `services/habit-checklist.ts` (CONSERVATIVE
   `detectHabitCheck` — multi-habit; macro habits need a completion frame;
   aspiration guard; bails on any specific food/consumption so it can't hijack a
   meal log; `injected` left to the existing injection state machine) +
   `detectSkipFoodLogging` ("don't want to log food" → offer checklist).
   `services/habit-store.ts` (check/uncheck/getTodaysHabits, pool-based,
   best-effort). Intercept in `ai.service` after the peptide guard. `habits`
   block in `/dashboard/summary` + `POST /dashboard/habit` toggle +
   `HabitChecklist.tsx` (tappable, optimistic).

6. **Medication / dose timeline** (`8b14a07`, NEEDS `dose_events` migration).
   New `services/medication-timeline.ts` (`recordDoseEvent`/`getDoseEvents` +
   pure `buildDoseTimeline` → dose periods with GLP-1 week span, weight change,
   top symptom per dose; synthesizes a current-dose period from `dose_mg` +
   `glp1_start_date` when no events yet). Centralized best-effort hook in
   `UserService.update()` + new `syncDoseEvent` records an event whenever
   `dose_mg` changes (fire-and-forget). `medicationTimeline` block in
   `/dashboard/summary` + `MedicationTimeline.tsx` card. Read-only history —
   never dosing advice.

**Follow-up fixes after live testing (same branch, HEAD `4480c45`):**
- **Protein-goal chat UX** (`c0f01ec`): a real test showed Grace asking "sitting /
  lightly active / on the move?", the user answering "Move", and Grace RE-asking
  (the parser needed "on the move", never matched bare "Move") + giving a generic
  range instead of the stored number. Fixed `parseActivity` (canonical enum, bare
  "move"/"moving"); a PROTEIN target now gathers only `current_weight` (not the
  full Mifflin chain); `tryPersonalStats` derives+stores the target on demand from
  weight so it answers THE number; gather-capture calls `ensureNutritionTargets`.
- **Capture & remember once, generally** (`4b0ec73`): the root re-ask class — a
  gathered answer that missed the strict parser was DROPPED → re-asked. The
  in-chat gather gate now has the same LLM-normalize fallback onboarding already
  had (`understandSlotWithLlm`, re-validated through the strict parser), so ANY
  reasonable answer to ANY field (sex/weight/height/age/activity/diet/dislikes/
  goal-weight/injection-day/wake-sleep) is captured the FIRST time. Plus chat
  weight logs now sync `users.current_weight` (`UserService.syncCurrentWeight` +
  the log_weight tool), so weight is remembered in the profile, not just weight_logs.
- **Landing pages** (`4480c45`): the live marketing pages (`DesktopLanding`,
  `MobileHero`, `FeatureGrid`, `PricingSection`, `FAQSection`, `seo-schemas`) now
  reflect the all-in-one command center (targets, water, habit checklist, weekly
  insights/plateau, dose timeline, symptom memory, dashboard) and FIX the stale
  pricing on DesktopLanding (**7-day→3-day trial, $15→$12/mo**; rest of the site
  was already 3-day/$12). Only shipped features advertised (NO fiber/carbs/
  measurements).
- **Pricing consistency + dead-code cleanup** (`5681007`): `Terms.tsx` aligned to
  the single **$12/mo** plan (was listing a stray "$24/mo Pro Plan"). Deleted 5
  orphaned landing components verified unreferenced in the route tree
  (`HeroSection`, `DesktopHero`, `ChatMockup`, `MedicationsBar`, `FooterCTA`).
  Pricing is now consistent EVERYWHERE (landing / pricing / FAQ / SEO / Terms =
  3-day trial → $12/mo). NOTE: admin `BusinessPage.tsx` still shows a `$24.99`
  plan row — admin-internal analytics, left as-is (not customer-facing).
- **Progressive profiling — capture once + USE it in replies** (`bad8c51`, plus
  the `4b0ec73` gather LLM-fallback + `c0f01ec` protein fix). Verified the
  gather→persist→no-repeat loop (`progressive-profile.ts`: `relevantProfileSlot`
  ask-first, `contextualGatherSlot` topic-driven, `isProfileSlotFilled` skips
  filled fields, Redis pending/asked markers). The remaining gap was the REPLY
  PROMPT: the live compact + grounded builders only surfaced name/med/diet/
  dislikes(/targets), so Grace couldn't personalize from most stored settings and
  could re-ask for a goal weight she already had. New exported
  `buildKnownProfileFacts(user, opts)` (in `ai.service.ts`, tested) renders the
  FULL profile (name, med+dose, injection day, sex/age/height, current+goal
  weight, activity, primary goal/goals, diet, dislikes, protein+calorie targets,
  exercise habits, why-started, biggest challenge, support-style/tone) into BOTH
  builders with "USE this — never ask for what's here". Encrypted blobs never
  surfaced; the recitation-prone schedule+diary stay relevance-gated in grounded.
  So the gather-level no-repeat now has an LLM-level complement. Gather slots
  cover the core personalization fields; `support_style`/`why_started`/
  `biggest_challenge`/`exercise_habits` are Settings-only (not gathered — a
  "how should I talk to you" question has no natural contextual trigger).

**Deliberately untouched (kept the standing constraint "don't touch the rest"):**
the live reply path (`runDirectReply`/unified), Stripe/trial gate, onboarding
flow logic, reminders, injection state machine, food-logging internals, auth.
Every addition is additive + best-effort (degrades, never throws).

**NEXT (recommended order → explain-then-apply for any migration):**
Priority-1 remaining — Simple vs Detailed tracking mode (`users.tracking_mode`,
one column). Priority-2 — balanced-plate/carb-pairing helper (NO schema), fiber
pipeline (food_logs `fiber_g` + the ~250-entry lookup table — the biggest lift),
body measurements (new table). Priority-3 (business decision) — free vs paid
feature tiering (access is all-or-nothing today; `is_pro`==`is_paid`). No PR
opened yet.

---

## 👉 READ FIRST — admin dashboard + onboarding/trial fixes (2026-07-04, MERGED to `main`)

Two PRs merged to `main` this session (branch `claude/grace-admin-dashboard-z7xajj`).
**Latest `main` HEAD `f51c9c0`.** All API-side; **NOT deployed by me** — the user
deploys `grace-api` on their Mac (`fly deploy … --no-cache --build-arg
GIT_COMMIT=$(git rev-parse --short HEAD)`, verify `/health` == HEAD). The admin
**web** auto-deploys on Vercel; the API does NOT. 1687 api + 657 ai-core tests
green; all packages typecheck + build clean.

**BEFORE Campaigns works in prod: apply migration `20260704000001_admin_campaigns.sql`
in Supabase.** For live MRR: `grace-api` needs `STRIPE_SECRET_KEY` (else MRR shows
"Estimated"). No other env/migration changes.

### PR #199 — Admin dashboard (cohorts, funnel, analytics, live MRR, group messaging)
Admin-only; **no user-facing reply/scheduler/onboarding/Stripe-subscription code
touched**. Analytics + campaign SQL validated end-to-end against a real local
Postgres (incl. the un-migrated degraded path).
- `services/api/src/services/admin-analytics.ts` (read-only) — 30+ whitelisted
  cohort predicates over an enriched CTE (users + per-user message/food/photo
  aggregates); unifies the trial/paid/active/onboarded definitions previously
  duplicated across `/admin/metrics` + `/admin/business`. Schema-probes
  `progress_photos`/`subscription_status`/`onboarding_state`, degrades to 0 when
  absent. Endpoints: `GET /admin/cohorts`, `/admin/cohorts/:key/users`,
  `/admin/funnel`, `/admin/analytics`.
- `services/api/src/services/admin-campaigns.ts` — cohort/ad-hoc group messaging.
  Excludes paused (opt-out)/blocked/inactive; requires `confirm`; cap
  `MAX_AUDIENCE=5000`; content guard blocks medical/dose advice; per-recipient
  status; dedupe via `UNIQUE(campaign_id,phone)`; logs to conversation + audit;
  sends only through `deps.sender`. **`enhanceMessage()`** rewrites a draft in
  Grace's voice via `deps.llm` then RE-RUNS `checkCampaignMessage` on the output
  (AI can't introduce medical/dose content). Endpoints: `POST
  /admin/campaigns/{preview,send,draft,enhance}`, `POST /admin/campaigns/:id/send`,
  `GET /admin/campaigns[/:id]`.
- **Live MRR:** `stripe.service.getStripeMrr()` sums normalized-monthly amounts
  from active/trialing/past_due Stripe subs (cached 5min, capped, best-effort);
  `/admin/business` returns it with `mrr_source: 'stripe'|'estimated'`, falls back
  to count × configured-price estimate. Business page labels live vs estimated.
- **Frontend:** nav entries **Cohorts** (`/admin/cohorts`), **Growth & Funnel**
  (`/admin/growth`), **Campaigns** (`/admin/campaigns`); shared
  `components/admin/CohortUsersPanel.tsx` (drill-down → reuses `UserDrawer`); Users
  page gained a cohort filter dropdown; client methods in `lib/api.ts`.
- **Honest data gaps (surfaced as "not tracked", not faked):** website visits,
  dashboard opens, voice usage — need event instrumentation (pixel / event table).
  Everything else (onboarding/trial/paid/activity/food/reminder cohorts,
  DAU/WAU/MAU, conversion/churn, drop-off) is real.

### PR #200 — Onboarding + trial fixes (from a Nudge-style review of 4 failures)
Audited Grace against 4 reported onboarding/trial failures; **#2 was already
prevented, fixed the other 3.** Isolated to the trial intercept + onboarding flow.
- **#2 "repeats/fabricates answers" — ALREADY PREVENTED (no change).** The next
  onboarding question is built deterministically from slot + name only
  (`onboarding-flow.ts` `fallbackQuestion`) and NEVER echoes a prior answer, so
  Grace can't invent "Mondays it is". Skips answered slots; LLM-normalizes before
  re-asking.
- **#4 trial-length inconsistency ("told 7 days, cut at 3") — FIXED.** New
  `services/api/src/services/trial-info.ts` holds `TRIAL_DAYS=3` as the SINGLE
  source of truth — `webhook.ts isAccessAllowed` imports it, so the access gate and
  what Grace SAYS can't drift. Deterministic intercept in `ai.service.handleMessage`
  (right after the reminder intercept) answers "how long is my trial / when does it
  end / how many days left / when am I charged" from `trial_start + TRIAL_DAYS` —
  never an LLM guess (`detectTrialQuestion` + `buildTrialReply`).
- **#3 ignores emotional disclosures in onboarding — FIXED.** `detectEmotionalDisclosure`
  + `buildEmotionalAck` (onboarding-flow.ts): a loaded disclosure ("9 months, lost
  zero and actually gained") gets one warm, validating, NON-medical line prepended
  to the next question — acknowledged without derailing the slot flow. LLM ack only
  runs when there's something to acknowledge (fast common path unchanged).
- **#1 day-1 activation — FIXED the free half.** `buildSignupCompleteReply` now
  invites the FIRST food log (the action that retained the one real customer)
  instead of pointing at a question. The proactive half already existed — the day
  1–3 `journey` messages (`message-generator.ts`) are already activation-focused
  ("text me your next meal and I'll log it") — verified, left unchanged.
- **Open / not verified live:** the LLM-generated emotional-ack *tone* couldn't be
  exercised in CI (no Gemini key) — detection/wiring/fallback/safety are tested;
  worth a quick live look after deploy.

---

## 👉 READ FIRST — unified food logging is DETERMINISTIC now + intercepts ported (2026-07-04 EOD)

**Merged to `main` — latest HEAD `f634ed8`.** Chain of PRs this session: #192
(`19c9560`, deterministic food + ported intercepts) → #193 (docs) → #194
(`71c9cf5`, reset command) → #195 (`49348f6`, portion precision) → #196
(`f634ed8`, scope the ask). Branch `claude/grace-dashboard-redesign-366yjj`. 1674
api tests green; all packages typecheck clean. No migration. **Not deployed by
me** — the user deploys on their Mac (`fly deploy … --no-cache --build-arg
GIT_COMMIT=$(git rev-parse --short HEAD)`, verify `/health` version == HEAD `f634ed8`)
and activates with `fly secrets set --app grace-api UNIFIED_REPLY_PATH=true`.
(The user CONFIRMED the deterministic food fix + reset command working live after
deploying `71c9cf5`; portion precision + scoping ship on the next deploy.)

**THE #1-COMPLAINT FIX — the "669g" hallucination.** Prod screenshot (`IMG_6655`):
"ate yogurt with berries" → *"I've got that logged along with your **669g** of
protein"*, but the next turn "how much protein today" → *"12 grams"*. The 669g was
a **hallucination** — the unified food turn was letting the LLM WRITE the
confirmation (incl. the protein number), and the model invented a total AND falsely
claimed a *pending* item was logged. Models are unreliable at repeating/withholding
exact numbers. **Fix (`runUnifiedReply`, ai.service.ts ~3135): the food
confirmation is now built DETERMINISTICALLY by `formatFoodReply` (already
unit-tested) and RETURNS EARLY — the LLM never generates it.** The exact protein
number = the authoritative day total (`getTodaysFoodSummary`); "logged" is claimed
ONLY for items actually logged; a pending item gets a portion question with NO
number. The LLM is used ONLY to answer a genuine side question
(`UNIFIED_FOOD_SIDE_Q_RE`: "…any snack idea?"), and is FORBIDDEN to mention
logging/grams/totals — with a post-guard that drops a side answer that smuggles a
number or "log" in. So the 669g class is now structurally impossible. Also
broadened `UNIFIED_BREAKDOWN_RE` to catch "here is **the/my** breakdown" and
numbered "1. The Eggs" enumerations (the "How 51g?" essay in `IMG_6656`).
Consequence: on a food turn the unified path now runs the tight food block →
early-return; the grounded-prompt/judge/breakdown/denial tail below only runs for
NON-food chat (its `isFoodTurn`/`didLog` branches were simplified away).

**PORTED the deterministic intercepts the unified branch was BYPASSING** (they run
in `handleMessageInner` AFTER the unified branch at line ~915, so flag-on skipped
them). Now mirrored INSIDE `runUnifiedReply` right after the data load:
progressive-gather gate (ask-first + replay), reminder intent (`detectReminderIntent`
→ next/explain/change via reminder-service, never denies capability), dashboard
link (`detectDashboardRequest` → `buildDashboardLinkReply`), and weekly summary
(`detectSummaryRequest` → `gatherWeeklySummary`/`renderWeeklySummary`, warmed).
Injection-timing + date intercepts were already there.

**VERIFIED unaffected (they run in `webhook.ts` BEFORE `deps.ai.handleMessage` at
line ~649, so the unified branch never reaches them):** settings (`tryHandleSettings`),
onboarding (`runOnboardingTurn`), natural opt-out (`detectNaturalOptOut`),
frequency-change redirect, and the paid/after-payment welcome (fires on the Stripe
webhook + admin PUT, not the chat path). So settings + dashboard + onboarding +
payment all still work "as before" with the flag on.

**STILL BYPASSED under the flag (deliberately not ported — out of the user's
explicit ask + adds latency to the lean path):** the note-only **symptom-intelligence**
recall/record (the differentiator memory stops compounding when the flag is on).
If the user wants the flag ON as the permanent default, port the symptom
record + `buildSymptomRecallNote` into `runUnifiedReply` next. In prod the flag is
DEFAULT OFF, so nothing is bypassed until deliberately flipped.

**How the user reaches the dashboard via messages:** text "dashboard" / "show my
progress" / "the app" → `detectDashboardRequest` → link to `<PUBLIC_WEB_URL>/dashboard`
(host rewritten by TwilioSender). First open = phone + 6-digit code (same session
token unlocks BOTH dashboard and Settings). Settings the same way ("settings").

**FOLLOW-UPS shipped after the deploy (all merged to `main`, unified path):**
- **"reset today's food" command** (PR #194, `food-reset.ts` + `UserService.clearTodaysFood`):
  "reset my food log" / "clear today's food" / "start over" → deletes today's
  `food_logs` rows (prior days untouched) + invalidates cache → "Done — cleared
  today's food log. You're back to 0g…". Deterministic intercept in `handleMessage`
  BEFORE the unified branch (works in both flag states). Scoped so "remove the
  pizza" (single delete) never wipes the day. Added because a day of testing had
  accumulated ~50 yogurt logs → 687g (the total was REAL/deterministic, not a bug —
  the estimate/window/dedup are all correct; the user needed a way to zero out).
- **PORTION PRECISION** (`food-portion.ts` + `foodStepUnified` rewrite, `hasExplicitQuantity`
  gate): the product ask "log clear amounts, ASK when the amount isn't precise —
  don't estimate a default serving." Now in `foodStepUnified`: if the message has
  NO explicit amount (`hasExplicitQuantity` false — no number/unit/size/article),
  the extractor's confirmed items are NOT logged; they're downgraded to PENDING
  with `buildPortionConfirmQuestion` ("Before I log the yogurt with berries,
  roughly how much — a standard serving is about 18g protein? …or say 'that's
  about right'…"). The user's reply resolves it: a real amount ("a cup") logs via
  the extractor; an affirmation ("that's about right" → `isPortionAffirmation`)
  logs the pending item at the standard estimate. So a portion-less "I ate yogurt
  with berries" now ASKS first and logs accurately after — never a silent 18g
  guess. The never-drop backstop also asks when unquantified. **SCOPED so Grace
  doesn't over-ask (`isPortionSensitiveFood`, PR #196):** the portion ask fires
  ONLY for foods whose serving swings the macros — proteins (chicken/beef/fish/
  tofu…), variable carbs (rice/pasta/oatmeal/potato…), dairy/fats (yogurt/cheese/
  nuts…), and mixed dishes (soup/smoothie/salad/bowl…). An OBVIOUS / low-variance
  food (an apple, a banana, toast, a boiled egg, a granola bar) logs with the
  estimate — no clarification. So "I ate yogurt with berries" asks, but "an apple"
  just logs.
- **WARM food replies, NUMBER-GUARDED (PR #198)** — the user showed a NUDGE
  screenshot (+662 number, NOT Grace) as the target tone ("Yum, yogurt with
  berries is such a classic… Nice, that adds about 10g to your day, a great light
  choice for a Saturday!") and asked for Grace to be that friendly/casual. The
  deterministic food confirmation was safe but robotic. Fix (`runUnifiedReply`
  food block): the LLM now re-phrases the SAME facts WARMLY, but the draft is
  GUARDED — (a) every gram/calorie number it uses must appear in the safe
  deterministic reply's number set (`allowed`), and (b) a pending-only turn must
  not claim a log. On any violation it ships the deterministic `safeReply`
  (formatFoodReply / buildPortionConfirmQuestion, now also warmed up). So warmth
  when trustable, the exact number always — the 669g class stays impossible. This
  is the Nudge model (LLM owns the reply, reads the authoritative snapshot) with a
  number guard bolted on. `buildPortionConfirmQuestion` reworded warm ("Yum,
  {food} 🙌 About how much — a cup, a handful, or one of those small containers?
  Or say 'that's about right'…"), no longer leads with grams.

---

## 👉 READ FIRST — reply-path root cause found (2026-07-04 PM)

**THE BUG behind "I turned the flag off but replies are still bad":** a Zod
footgun. `z.coerce.boolean()` does `Boolean(value)`, so the STRING `"false"`
(and `"0"`/`"off"`) is truthy → the flag turned **ON** when set to `"false"`.
`fly secrets set UNIFIED_REPLY_PATH=false` silently PINNED it on. So every "bad"
reply the user saw was the **unified/grounded path** (flag stuck on) — they were
NEVER actually on the compact path. **Fixed** (`config/env.ts`): all 12
`z.coerce.boolean()` flags now use a `boolish()` parser (only `true/1/yes/on` →
true; `false/0/off/''` → false). +4 regression tests (`config/env.test.ts`).
After deploy, `UNIFIED_REPLY_PATH=false` (or `fly secrets unset`) genuinely
turns it off; `=true` keeps it on.

**Two more grounded-path bugs fixed** (`ai.service.ts buildGroundedPrompt` +
`runUnifiedReply`): (1) the prompt embedded a VERBATIM reply example
(`"Nice, yogurt with berries is a solid start"`) → Gemini copied it word-for-word
and dropped the user's "any snack idea?" question. Removed the example; made
"answer the question in the same reply" a hard rule. (2) Weak food ack ("Thanks
for letting me know") → the just-logged note now carries the running total and
forbids bare thanks/got-it/noted. (3) Added Nudge's **LATEST MESSAGE RULE** to
the grounded prompt (reply to the FINAL message; drop older topics unless the
latest refers back) — fixes "answers the wrong last message / not following the
conversation."

**Nudge architecture (studied from the user's uploaded source
`handle-inbound-sms/index.ts`):** ONE system prompt + ONE Chat Completions call
(`max_tokens 500, temp 0.8`, messages = `[system, ...24 history turns, latest]`).
Header comment: *"NO regex intercepts, NO canned replies, NO post-generation
verifiers, NO state-machine flows. The LLM owns the reply end-to-end. Operational
safety only."* ALL behavior (food-log bans, symptom triage, dose deferral,
settings redirects, tone/length) lives as RULES INSIDE that one prompt. Food
logging is a SEPARATE extraction pass that updates a "today snapshot"; the reply
call just READS the authoritative snapshot (totals/diary) — logging and reply
text are decoupled. **Grace's `runUnifiedReply` is already this exact shape.**

**IMPORTANT — the unified mega-bypass drops "the rest".** `runUnifiedReply`
(flag on) BYPASSES the ~20 intercepts (reminders, symptom-intelligence, water,
weekly-summary, settings redirects, meal-preference) + the 7 food layers. The
user's standing constraint is "response generation is the problem, DON'T touch
the rest" — so making the unified bypass the permanent default would drop
reminders/symptom/etc. The compact path (flag OFF, `runDirectReply`) is ALSO
one Gemini call for a normal message, but KEEPS the intercepts for the special
cases — so it honors "don't touch the rest" AND is Nudge-like for chat. Current
recommendation: deploy the footgun fix, run with `UNIFIED_REPLY_PATH=false`
(now actually off), verify the compact path. Grounded-path fixes protect the
unified path too if kept on. Branch: `claude/grace-dashboard-redesign-366yjj`
(commit `55f7ac3`). 1652 api + 657 ai-core green; no migration.

---

## 👉 READ FIRST — current state (as of 2026-07-04)

**Before doing anything, read the newest dated section immediately below**
("Reply grounding + consolidation + food-sync…"). It has the LIVE production
config and the current state. Do NOT re-derive context or start editing until
you've read it.

- **Latest commit on `main`: `a3f6a4f`** (UNIFIED_REPLY_PATH → lean grounded
  prompt; prior: `3b766b6` food-drop fix, `71070b4` consolidation step 2,
  `8694110` step 1, `2a4f57f`/`5a09f0e`/`7eb167e`/`fb052b7` grounding A–K,
  `1883033` dashboard redesign PR #174). **Merged directly to main via git
  fast-forward** (GitHub MCP was down); local `main` was on a STALE unrelated
  lineage — always `git reset --hard origin/main` before deploying.
- **Live prod config** (from `fly logs | grep startup`): `directReplyMode: true`,
  `geminiFirst: true`, `trustGemini: true`, `compactReplyMode: true`, guards OFF.
  So the live reply = single Gemini call via `runDirectReply` + the COMPACT
  prompt (`buildCompactReplyPrompt`). **`UNIFIED_REPLY_PATH` defaults OFF** — the
  consolidation is dormant until deliberately flipped after an eval/A-B.
- **Grounding is LIVE and verified by real iMessages** (date, injection, dose,
  multi-part all correct). The two production screenshots (injection denial +
  "May 14, 2024" hallucination) are FIXED.
- **DEPLOY = `fly deploy --app grace-api --config services/api/fly.toml
  --no-cache --build-arg GIT_COMMIT=$(git rev-parse --short HEAD)`.** The API is
  NOT auto-deployed (web/dashboard auto-deploys on Vercel). Verify with `curl -s
  https://grace-api.fly.dev/health` → `version` must equal HEAD. Most "the fix
  didn't work" reports were the fix not deployed. **No DB migration needed for
  any grounding/food-sync work — all code-only.**
- **Diagnosing prod from a laptop**: admin API is reachable with the ADMIN_TOKEN
  (`GET /admin/users/%2B<phone>/food-logs` returns `{items,...}` — NOT an array,
  so `jq '.items'`). `fly logs --app grace-api | grep -iE "food_extract|ai.direct
  .reply|forced_log_food|injection_timing"`. The cloud session usually CANNOT
  reach `grace-api.fly.dev` (HTTP 000) or run auto-eval (no GEMINI_API_KEY) — the
  USER runs live evals + prod curls on their Mac.
- **Working style the user demands**: GENERAL fixes (catch any wording), NOT
  per-phrase patches; test after every change (full `pnpm --filter @grace/api
  test` + `pnpm -r build` so ai-core `dist` is fresh — stale dist = phantom test
  failures); don't break unrelated areas (reminders, images, multi-part, logging);
  merge to `main`, no PRs unless asked. The user compares Grace to Nudge and
  wants the Nudge model: ONE lean prompt + ALL data + full history + one call.

---

### Reply grounding + consolidation + food-sync + dashboard (2026-07-04)

Big session. Four workstreams, all on `main` (HEAD `a3f6a4f`), deployed.

**1. Premium dashboard redesign (PR #174, merged, live on Vercel).** Reworked
the user progress dashboard (`apps/web/src/pages/Dashboard.tsx` + new
`components/dashboard/*`: `TodayOverview`, `GraceInsightCard`, `RecentWins`,
`InjectionCard`, `TodaysMeals`, `ProfileCompleteness`, `DashboardStates` + pure
`lib/dashboard-insights.ts`). Progress rings, a "note from Grace", client-derived
injection countdown, wins, profile-completeness meter, skeleton/error states.
Dashboard-only; no backend touched. All derivations are client-side from the
existing `/dashboard/summary`.

**2. Reply grounding (Domains A–K) — LIVE, fixes 2 prod screenshots.** Root
principle: *any fact the model can't know (date, schedule, what the user told us)
must be computed deterministically, injected into EVERY prompt, and answered by a
deterministic layer — never guessed; one question must not hit three code paths.*
- **A — temporal truth** (`services/api/src/services/temporal-context.ts`,
  9 tests): full authoritative local date/time/next-7-days, tz+DST-safe, injected
  into BOTH prompt builders (compact had NO date → hallucinated "May 14, 2024").
  `content-checker` bans the false "real-time" claim.
- **B — schedule truth** (`services/api/src/services/medication-schedule.ts`,
  28 tests): ONE cadence-aware engine (`computeInjectionSchedule` +
  `detectInjectionTimingIntent` + `buildInjectionTimingReply` +
  `buildScheduleFactLine`) for weekly injectables AND daily pills. Deterministic
  intercept in `handleMessage` (next/last/is-today/days-until) — never denies,
  asks for the day if unknown. `content-checker` bans injection/dose/record
  capability-denial. Fixes "I cannot tell you when your next injection is."
- **C — memory** (`profile-extract.mightStateProfileChange` broadened): captures
  present-tense injection-day statements ("my shot day is Saturday") into the
  profile via the EXISTING `tryLearnProfile`/`extractProfileUpdates` (kept the
  abandoned-fact guard). Explicit change commands still confirm via the webhook.
- **F — topic-aware reasoning** (`orchestrator.getToolAwareFallback`): "How 4
  days?" after a shot answer explains the CALENDAR gap, not weight math.
- **G/I — no-denial + profile reads**: existing "as an AI" ban + new injection/
  record/real-time bans; profile reads grounded by prompt facts.
- **H — profile-thin**: compact prompt now asks for a missing number, never
  invents. **J — onboarding audit**: read-only, NO gap — in-chat onboarding
  correctly captures name/med/freq/injection_day/timezone(→IANA)/wake-sleep/diet.
- Regression lock: `services/api/src/services/grounding-replay.test.ts` (9) replays
  Uri's exact transcript. Verified live: "next injection"→real date, "today"→real
  date, "How 4 days?"→calendar, multi-part preserved.

**3. Food-sync fix (`3b766b6`) — the yogurt-not-logged bug.** Prod: "I ate yogurt
with berries … any snack idea?" was acknowledged but the dashboard's Today's
meals stayed empty. Confirmed from logs (`food_extract.done intent=log items=2
pending=2, logged=false`): the extractor marked both items `pending_portion`, so
`runDirectReply` logged nothing and the multi-part reply answered the snack
question. **Fix (`runDirectReply` food block ~3165): a DEFINITE consumption
(`foodSpanFromConsumption` matches) promotes every specific item to CONFIRMED and
logs it with a standard-portion estimate — a finished meal is never held pending.**
Plus `meal-lifecycle.foodSpanFromConsumption` now slices trailing state clauses
(`CONSUMPTION_TAIL_RE`: "…after my injection and now I'm hungry" → "I ate yogurt
with berries"), guarded against over-cutting. Sync architecture verified: chat
`log_food` and dashboard both read the same `food_logs` via `getTodaysFoodSummary`.

**4. Consolidation — `UNIFIED_REPLY_PATH` (env, default OFF).** The "one lean
grounded path" toward the Nudge model. **Key lesson (a mistake I corrected):**
step 1 first pointed the flag at the big `buildPersonalisedPrompt` (2,500-line
instruction pile) → replies regressed to hedging + "what kind of injection did
you have?" — the exact behaviour compact exists to prevent. **Corrected: new
`buildGroundedPrompt` = the compact prompt's TIGHT rules + ALL data (name, med,
schedule fact, today's LOGGED food ITEMS + totals, goals, diet, dislikes, known
facts, memory.md, temporal block) + FULL history (step 2 widened history under
the flag) + one call.** Rules: answer from what it knows, acknowledge a stated
meal by name, NEVER ask for info it already has. Flag OFF = compact path
(byte-identical, proven excellent). Flag ON = the grounded/Nudge path — needs a
live A/B before trusting (I can't run Gemini in-session). To A/B:
`fly secrets set --app grace-api UNIFIED_REPLY_PATH=true` (rollback `=false`,
no redeploy). **The compact path (flag OFF) already ships Nudge-quality replies;
consolidation is optional cleanup, not required.**

Tests: 1648 api + 657 ai-core green; typecheck clean. No migration.

### Multi-part latency + chained-colon shape guard (2026-07-03, PR #170)

Same "I had breakfast late, skipped lunch… big or small dinner?" turn (false-log
gone), two new issues: a verbose colon breakdown reply + slow.
- **LATENCY (the SAFE extraction-skip the user vetted):** new deterministic
  `foodActionable` gate on the `runDirectReply` food block — the ~1.5s
  `extractFood` LLM pass runs ONLY when it can act: `namesSpecificFood ||
  foodSpanFromConsumption || pending || FOOD_DIARY_QUERY_RE || FOOD_MUTATION_RE`.
  A pure rec/planning question skips it. Conservative: a delete/edit/diary-query
  is never skipped for lacking a food word (its own regex keeps extraction on),
  so the gate can only drop a genuine no-op — never a real log/edit/delete/query.
- **SHAPE:** `looksStructured` missed the reply because its labels had apostrophes
  ("Let's"/"You're") → only 1 clean `Label:` hit. Added a chained heading-colon
  check (`>=2` `\w:\s+[A-Z]` segments) so the breakdown is caught + regenerated to
  plain prose. Root-cause config fix: turn ON `COMPACT_REPLY_MODE`.
Tests: +1 looksStructured (exact prod colon shape). 1600 api + 654 ai-core green.

---

### Fix: bare meal-time word logged as food (2026-07-03, PR #168)

Regression from the never-drop work (PR #164): "I had breakfast late, skipped
lunch, and now I'm not sure if I should eat a big dinner or something small" →
"Glad that's logged" — the extractor logged the meal-TIME word "breakfast" as a
food, derailing the multi-part answer. Meal-time/container words (breakfast/
lunch/dinner/snack/a big meal) name WHEN/how-much, not WHAT → nothing to log.
New `meal-lifecycle.namesSpecificFood(text)` (strips generic words, then checks
`FOOD_MENTION_RE` → "breakfast burrito" true, "I had breakfast late" false).
Applied in `runDirectReply` to filter BOTH confirmed + pending extracted items,
to the never-drop raw-text path, and inside `foodSpanFromConsumption`; plus a
food-extract prompt rule. Salmon case still logs. +3 tests; 1599 api + 654
ai-core green. **Deploy: standard `fly deploy` — no migration.**

**Multi-part latency (open, user-requested):** the multi-part path skips the
single-intent short-circuits → `runDirectReply` with `history=[]` + the plain
multi-part note, then a single flash reply. For a food-shaped multi-part it also
runs `extractFood` (now flash-lite) SERIALLY first. Proposed safe cut (not yet
done): skip the `extractFood` LLM call when the message names no specific food
AND isn't a consumption/diary-query (`!namesSpecificFood && !foodSpanFromConsumption
&& no pending && not a "what did I eat" query`) → saves ~1.5s with zero accuracy
loss (nothing to log anyway). Bigger option: run extract concurrently with the
reply (log becomes a pure side-effect; reply loses same-turn "logged X"
confirmation).

---

### Response latency — analysis + first cuts (2026-07-03, PR #166)

Branch `claude/grace-progressive-data-collection-401n8m` → squash-merged to main
(`2f989c3`). User asked why some replies are slow. **The live `directReplyMode`
critical path is SERIAL LLM calls**, not one: for a food/profile message the
reply waits on, in order — coalesce (2s, `webhook.ts`) → `tryLearnProfile`
(profile-extract, awaited at `ai.service.ts:3607`) → `extractFood` (awaited
~`:3055`) → the reply call (`:3259`, soft cap `DIRECT_REPLY_TIMEOUT_MS`=13s,
provider hard cap `GEN_TIMEOUT_MS`=18s) → an optional 2nd reply call
(`looksStructured` regen, `:3323`). Worst realistic case (food + profile stmt +
structured reply) ≈ 43s; typical food ≈ 8s. Multipliers: provider retries
800/1600/3200ms on 503/429 (`gemini.ts:271`); context cache disabled 10 min on a
403 (`gemini.ts:123`); big history prompt. **Real per-stage data already exists**
via `persistLatency(userId, intent, totalMs, stageTimings, …)` — read that before
tuning further.

**Shipped (latency-only, both env-revertible, graceful fallbacks — no behavior
change):**
1. The two SEQUENTIAL structured-JSON extraction passes (`food-extract`,
   `profile-extract`) now use **`gemini-2.5-flash-lite`** (new env
   `GEMINI_EXTRACT_MODEL`, default lite; revert = set it to `gemini-2.5-flash`).
   Caps tightened 9s→5s (food) and 6s→3s (profile) — a slow tail degrades to the
   existing never-drop / learn-nothing paths. A bad model id auto-falls back to
   `GEMINI_FALLBACK_MODEL` in the provider, so extraction can't break.
2. **`CONVERSATION_HISTORY_TURNS` default 24→12** (`env.ts`) — smaller reply
   prompt, faster generation + fewer input tokens. Raise to 24 to restore.

**Not yet done (proposed follow-ups, higher-risk/behavior trade):** (a) take
`tryLearnProfile` OFF the critical path (fire-and-forget; the same-turn reply
would use the pre-update value, next turn fresh) — removes up to 3s from
profile-ish msgs; (b) confirm `COMPACT_REPLY_MODE`/`LEAN_REPLY_MODE` on so the
`looksStructured` regen 2nd call rarely fires; (c) verify context caching is
actually live in prod (grep logs for the `cachedContents` 403 → 10-min disable).

Tests: 1596 api + 654 ai-core green; typecheck clean. **Deploy: standard `fly
deploy` — no migration.**

---

### Food-log never-drop for "I ate X … <question>" + hunger (2026-07-03, PR #164)

Branch `claude/grace-progressive-data-collection-401n8m` → squash-merged to main
(`603dd77`). Two prod bugs from real iMessage screenshots.

1. **"I had salmon with potatoes and salad. How much protein is that, and what
   should I eat later?" was answered but NEVER logged** (dashboard showed only
   yogurt). Root cause: the single-intent `food-extract` returns `none`/`query`
   when a consumption message ALSO asks a question, and the classifier tags the
   whole thing `food_question`, so the existing never-drop (which only fired for
   `params.intent === 'food_log'`) never ran → silent drop.
   - **`food-extract.ts` prompt** — a consumption statement ("I had/ate/drank X")
     is LOGGED even when the same message also asks a question; only food NOT yet
     eaten stays unlogged. Added the salmon example; scoped the advice/planning
     bullet so it can't cancel a real intake in the same message.
   - **`meal-lifecycle.foodSpanFromConsumption(text)`** (NEW, pure, +7 tests) —
     deterministic backstop: when the message confirms eating AND names a real
     food, returns JUST the eaten-food span with the trailing question/planning
     clause sliced off (cut at earliest of first `.`/`!`/`?` or a QUESTION_TAIL_RE
     clause). Null for pure questions, preference/planning, negated eating,
     non-food. Requires `mentionsFood`, so the reflection guard still holds.
   - **`ai.service.runDirectReply`** — (a) `foodish` now also true when
     `foodSpanFromConsumption` matches, so a consumption forces the food path even
     if the classifier tagged it otherwise; (b) the old `food_log`-only never-drop
     `else if` chain became one `else` that logs `consumptionSpan ?? rawText`
     (never-drop) and only renders the diary-summary for a pure `query` with NO
     consumption span. logNote now also tells Gemini to still answer the question.
2. **"I ate yogurt … now I'm a little hungry. Any snack idea?" got a bare snack
   list** — ignored the hunger. `message-understanding` now recognizes plain
   hunger ("a little hungry", "still hungry", "starving"; negated hunger excluded
   via lookbehind) as an APPETITE note, and the multi-part note leads with any
   feeling OR physical state (hungry/tired/stressed) before answering. +1
   multi-topic test (the exact yogurt message → food+craving+food_question).

**NOT chased:** the dashboard's double yogurt. `log_food` already has a 60s
`dedupe_key`, so that's consistent with two separate turns, not a single-message
double-log; not reproducible from the screenshots → left alone.

Tests: 1596 api + 654 ai-core green; `pnpm -r typecheck` clean. **Deploy: standard
`fly deploy` — no migration.**

---

### Progressive profiling made CONTEXT-AWARE (2026-07-03, PR #162 merged)

Branch `claude/grace-progressive-data-collection-401n8m` → squash-merged to main
(`13b2824`). Product ask: Grace should keep learning the user over time by asking
a natural follow-up RELEVANT to the current topic — like a supportive friend, not
a survey — never out of nowhere, always after answering the actual message.

The gathering system already existed (ask-first relevance gate
`progressiveGatherGate`, throttled proactive weave `applyProgressiveProfiling`,
passive learning `profile-extract.tryLearnProfile`). The gap: the proactive weave
asked for the **next missing field in blind priority order**, ignoring what the
user was talking about. This session made the weave **topic-driven**.

- **`onboarding/progressive-profile.ts`** — new pure `contextualGatherSlot(user,
  text)`: everyday topic → single most useful MISSING field — food→dislikes/diet,
  medication/shot→injection_day, exercise→activity, progress/weight→goal_weight
  then current_weight, sleep→wake_sleep. Skips entirely on symptom/heavy turns
  (`HEAVY_OR_LOG_RE`) — the "out of nowhere" guard. **`injection_day` is now a
  first-class gatherable slot** (added to `PROGRESSIVE_SLOTS`), FREQUENCY-AWARE
  via `isWeeklyInjectable` so a daily-pill/unknown-cadence user is NEVER asked a
  shot day (`isProfileSlotFilled('injection_day')` = filled unless weekly + null).
  `ProfileShape` gained optional `medication`/`medication_frequency`. Added
  GATHER_REASON + CLARIFY entries for injection_day.
- **`ai.service.applyProgressiveProfiling`** — prefers the contextual slot over
  `nextMissingProfileSlot`. A slot with a STRICT next-turn parser (`injection_day`
  / `activity` / `wake_sleep` — a weekday/enum/time can't misparse as a weight)
  may weave on a TOPICAL turn; every other slot (incl. the blind fallback) stays
  neutral-turn-only (`gatherSafeTurn`) to protect the answer parse. Still throttled
  1/20h (`PROFILE_GATHER_COOLDOWN_HOURS`), still returns early if another intercept
  already set `directContextNote`. **Now also skips MULTI-TOPIC messages**
  (`analyzeMessage().hasMultiple`) — mirrors the ask-first gate so gathering never
  disrupts the multi-part answer (the user explicitly flagged this).

**Deliberately NOT touched (safety):** the ask-first `relevantProfileSlot`
short-circuit was left AS-IS — it runs BEFORE the deterministic reminder/symptom/
weekly-summary intercepts (line ~1123, before ~1144+), so broadening it would risk
preempting them. All new coverage flows through the non-short-circuiting proactive
weave on the direct path (line ~2044, AFTER every intercept) → zero ordering risk.
No schema/DB change ("typical meals / protein habits" have no column; deferred).

Tests: +9 progressive-profile cases (35 total). 1588 api + 654 ai-core green;
`pnpm -r typecheck` clean. Flag: `PROGRESSIVE_PROFILE_ENABLED` (default on) +
`directReplyMode` (on in prod). **Deploy: standard `fly deploy` — no migration.**

---

### Reply-quality war: multi-topic, shape guard, Nudge-style modes (2026-07-02→03)

Branch `claude/system-migration-process-dtkyp3` (merged to main each commit).
A long production-debugging thread driven by real iMessage screenshots. Root
theme: **Grace's chat replies were verbose, mis-shaped (headings/breakdowns/
lists), dropped parts of multi-topic messages, and bled stale history.** Many
fixes were "patches for one phrasing"; the session converged on GENERAL,
structure-based fixes. **Latest commit `855d8de`.**

**CRITICAL production config (confirmed from `fly logs | grep startup`):**
`directReplyMode: true`, `geminiFirst: true`, `trustGemini: true` →
**the reply is a SINGLE Gemini call via `runDirectReply` AND the regeneration
guards (relevance/behavioral/quality) are OFF.** So reply quality relies ONLY
on: the system prompt + the deterministic outbound format floor + the NEW
shape-regen. There is no automatic "regenerate a bad reply" unless we add it.
`runDirectReply` (`ai.service.ts` ~2979) is the live path — edits gated on
`this.directReplyMode` DO apply in prod. (Earlier confusion: env DEFAULT is
false, but the prod Fly secret sets it true.)

**`/health` now returns the deployed commit** (`routes/health.ts` +
Dockerfile `ARG GIT_COMMIT`). Deploy with
`--build-arg GIT_COMMIT=$(git rev-parse --short HEAD)`; verify with
`curl …/health` → `version` must equal your commit. **Most "your fix didn't
work" reports were the fix not being deployed** — always confirm `/health`
version + the `startup` log flags BEFORE concluding a fix failed.

**Multi-topic messages (the biggest thread).** `services/api/src/services/
message-understanding.ts` — `analyzeMessage(text)` deterministically splits a
message into topic kinds (food, food_question, symptom, progress_question,
question, emotion, injection, medication, weight, sleep, exercise, hydration,
craving, appointment, social, reminder, gratitude); `hasMultiple` = ≥2 kinds.
Broadened to all subjects + slang/typos ("I'm nervous", "stressing me out",
"had chicken n rice", `naus\w*`, "drank all my water"). `buildMultiPartNote` is
a SINGLE plain-language instruction (NOT an enumerated "Parts to cover: 1)…2)…"
block — that structure made Gemini reply "Here's an analysis of your entries,
categorizing them…"). In `ai.service.handleMessageInner`: `isMultiTopic =
analyzeMessage(input.text).hasMultiple`; when true, the single-intent direct
short-circuits (`handleFoodQuestionDirect`, knowledge/emotional/etc.) are
SKIPPED so the message routes through `runDirectReply` where the multi-part
note is appended and every part is answered.

**History-bleed fixes (Gemini answered a STALE message).** In `runDirectReply`
`effectiveHistory` logic: multi-topic → `[]` (no history); pure food log →
micro-prompt, no history; food log → user-turns only; **SUBSTANTIVE STANDALONE**
message (≥8 words, not a short follow-up, no back-reference like "earlier"/"you
said"/"the salmon I…") → `history.slice(-2)` (keep only the immediately-prior
exchange). This stopped "I'm eating at my friend's Friday night…" from getting
a salmon-protein answer from an earlier turn. Default window
`CONVERSATION_HISTORY_TURNS`=12.

**GENERAL reply-shape guard (the real fix, not per-phrase).** `looksStructured(text)`
(exported from `ai.service.ts`, unit-tested) returns true for ANY report shape
regardless of words: ≥2 `Label:` segments, bullet/numbered lists, an inline
numbered item, a leading heading clause ending in a colon, or a mid-reply colon
introducing an enumerated list (incl. truncated "…steps: … 1."). When true (and
not a log turn), `runDirectReply` REGENERATES once with a hard minimal prompt
(1–3 plain sentences, no headings/lists/labels/preamble, answer every part,
give a number for foods) and adopts it only if the rewrite is clean. This is the
"catch any variation" solution the user demanded after per-phrase strips failed.

**New reply-mode flags (all default false, flip via `fly secrets`):**
- `LEAN_REPLY_MODE` — strips the analytical BACKGROUND blocks from
  `buildPersonalisedPrompt` (dashboard PROGRESS SNAPSHOT, learned SIDE-EFFECT
  PATTERNS, foods-logged-today enumeration) that Gemini was "categorizing".
  Shared by both orchestrator + direct paths.
- `COMPACT_REPLY_MODE` — swaps the big personalised prompt for a TINY Nudge-style
  one (`buildCompactReplyPrompt`: name/med/today's totals/diet + hard style
  rules). A small prompt can't produce breakdown essays. Not used for a new
  user's first message. **Nudge's whole trick = a tight prompt + one call;**
  Grace's big prompt is why replies sprawled.

**Format-enforcer (`packages/ai-core/src/format-enforcer.ts`, runs on EVERY
outbound via `sanitizeOutbound`):** fixed the length-cap HOLE (a run-on whose
only early period is a short opener now hard-caps instead of shipping the whole
essay); broadened the opener-strip class ("let's break down/dive/discuss",
"that sounds like a delicious meal", "here's a general idea/breakdown",
leading gerund headings "Estimating Protein in Your…:", "this is a rough
estimate…, but" hedge) + strips CHAINED openers (3 passes); `labelColonRe`
prefix broadened to `,`/`:` so comma/colon-chained labels flatten.

**Other fixes this session:**
- Onboarding completion (`onboarding-flow.ts buildSignupCompleteReply`): NO
  payment link (trial link comes later via Day-2 reminder + paywall), explains
  the dashboard option; kept UNDER the 420-char outbound cap (it was truncating
  the dashboard line).
- Clickable links: `twilio/sender.ts ensureLinkScheme(text, webUrl)` prepends
  `https://` to bare Grace-host links (iMessage only auto-links schemed URLs).
  Applied in all 3 senders after `rewriteCanonicalLinks`.
- Complete user delete: `UserService.purgeUserData(phone)` — deletes EVERY child
  table (incl. `symptom_episodes`, `progress_photos`, `check_ins` by user_id OR
  phone for NULL-phone mood rows) + evicts user/today-food/known-facts caches.
  Wired into admin delete + GDPR delete. (Bug: deleted users still showed data on
  the dashboard.)
- Quiet re-engagement: opted-out (`paused`) users get ONE warm "I'm still here"
  hello after `REENGAGE_QUIET_AFTER_HOURS` (24h) silence, throttled by
  `REENGAGE_QUIET_MIN_GAP_HOURS` (72h). `scheduler.reengageQuietOptedOut` +
  `quiet-reengagement.ts` + `users.listPausedUsers()`.
- Time-of-day food recs: `handleFoodQuestionDirect` scopes to the current meal
  from the user's local hour (`localHourForTimezone`/`mealForLocalHour`/
  `wantsFullDayPlan`) unless a meal is named or a full-day plan is asked.
- Progressive-profiling gate (`progressive-profile.ts relevantProfileSlot`):
  `TARGET_QUESTION_RE` tightened to real "how much should I eat / my target"
  questions + `FOOD_CONTENT_RE` guard, so a factual "how much protein IS that"
  is answered directly, never interrupted with an activity-level ask. The gate
  is also SKIPPED entirely for multi-topic messages.
- Morning reminder content (`scheduler.enrichGenerateOpts` + `message-generator`
  `CONVO_CONTEXT`): food logs/questions are FILTERED OUT of the "follow up on a
  topic" conversationContext (a reminder's food angle comes from the REAL totals),
  and the generator is told never to frame a logged past meal as today's food /
  "a good start to the day". (Bug: 7:15 AM reminder said "that salmon sounds like
  a great start to the day".) Reminder TIMING is separately governed by
  `wake_time` + `timezone` — a wrong-hour reminder is almost always the timezone
  defaulting to `America/New_York` instead of the user's real zone.
- Regression net: the 5 production screenshots are permanent scored cases in
  `auto-eval/regression-scenarios.ts` (multipart feeling+food, no-essay,
  no-meta-analysis, progressive-not-out-of-nowhere, no-history-bleed). Run via
  `POST /admin/regression/run` (Bearer ADMIN_TOKEN) — several minutes (33
  scenarios × Gemini).

**Deploy (user does this on their Mac):**
```
git pull origin main && fly deploy --app grace-api --config services/api/fly.toml \
  --no-cache --build-arg GIT_COMMIT=$(git rev-parse --short HEAD)
curl -s https://grace-api.fly.dev/health   # version must match HEAD
```

**Open / next steps:** (1) Confirm `COMPACT_REPLY_MODE=true` is actually set +
deployed (a heading in a reply means it's OFF). (2) The durable end-state is the
consolidation: make the single lean/compact path the default, delete the per-turn
notes, keep only safety+logging+format floor+shape-regen, gated by the regression
net. (3) If shape-regen + compact still leak, re-enable the relevance guard
(Option B) behind a flag — but `trustGemini` currently disables all regen. (4)
Verify user timezone is `Asia/Jerusalem` for the test number (+972…) if morning
reminders land at the wrong local hour.

---

### In-chat onboarding is now the DEFAULT — no more web quiz (2026-07-02)

Product: "no more web quizzes." The live entry is iMessage-first ("Start with
Grace" → `sms:<line>&body=…` → user texts first), so Grace already has the phone
from the inbound — bouncing them to the web `/onboarding` form (which re-asked
the phone) was redundant. The conversational onboarding was already fully built,
wired, and tested (`onboarding/onboarding-flow.ts` `runOnboardingTurn`: short warm
slot sequence — first_name, medication, frequency, injection day/schedule,
timezone auto-from-phone, wake_sleep, dietary, consent; completion sets
`trial_start` so they're registered without leaving Messages; every other webhook
intercept already gated behind `!onboardingActive`). It was just disabled.
**Change: `SMS_ONBOARDING_ENABLED` now defaults ON** (`config/env.ts`, opt-out
via `fly secrets set SMS_ONBOARDING_ENABLED=false`) — so a new number texting is
onboarded entirely in chat and the web-signup bounce never fires. The web
`/onboarding` quiz remains only as a desktop fallback (`startWithGrace` opens
iMessage when `VITE_IMESSAGE_NUMBER` is set, else navigates to `/onboarding`).
**Requires the `20260628000001_sms_onboarding.sql` migration in prod** (adds
`onboarding_state`/`onboarding_last_slot`/`onboarding_started_at`) — without it
the in-chat `users.update` throws and the flow loops. 65 onboarding-flow + 42
webhook tests green; 1497 api green.

---

### Post-payment "welcome back" message (trial → paid) (2026-07-02)

When a user upgrades to paid/pro, Grace no longer re-introduces herself — she
celebrates that they're CONTINUING with her, by name, and reminds them of every
option. `services/api/src/services/paid-welcome.ts` (tested): `buildPaidWelcome`
(no self-intro, name via `isEncryptedBlob`-guarded `cleanName`, reminds
food/photo logging + symptom learning + weight/mood + "text dashboard") +
`sendPaidWelcomeOnce` (Redis `paid:welcomed:{phone}` SET NX, once per user, best-
effort, sends on the user's channel). Triggered on the not-paid→paid transition
from BOTH the admin `PUT /admin/users/:phone` (is_paid/is_pro false→true) and the
v2 Stripe webhook (`registerStripeWebhookRoutes` now takes `sender`/`redis`/
`users`; snapshots is_paid before/after to fire only on a genuine transition, not
renewals). Note: the legacy v1 Supabase checkout path doesn't hit either trigger.
Tests: paid-welcome (2). 1497 api green.

---

### Units: enter/read weight & height in any unit (kg/lb/stone, cm/ft-in) (2026-07-02)

Product ask: Grace should understand any unit so users put their own data in
whatever they think in. Canonical storage unchanged (weight = lbs, height = cm);
units are parsed on the way in, displayed on the way out.
- **`services/api/src/nutrition/units.ts`** (NEW, pure/tested — 15 cases):
  `parseWeightToLbs` (lb/pound/kg/kilo/stone + "12 st 6 lb", bare number →
  defaultUnit), `parseHeightToCm` (cm/m/`5'10`/`5 ft 10 in`/`5 foot 10`/inches,
  bare ≥90→cm else inches), converters (`kgToLbs`/`lbsToKg`/`cmToFeetInches`/
  `feetInchesToCm`), `formatWeight`/`formatHeight`.
- **Chat**: `weight-log-fast.parseWeight` now also understands **stone** (kg/lbs
  already worked) — "12 stone 6" logs correctly.
- **Dashboard API**: `POST /dashboard/weight` + `/dashboard/progress-photo`
  accept `unit: 'lbs'|'kg'` and normalize to lbs (range-check AFTER conversion).
- **Frontend `apps/web/src/lib/units.ts`** (NEW): converters + localStorage unit
  prefs (`grace_weight_unit`/`grace_height_unit`).
  - **QuickLog** weight tab: lbs/kg toggle (persisted); sends the unit.
  - **Settings**: Body & goals weight fields show/save in lbs **or** kg (toggle);
    Height entered as **cm** or **ft/in** (two inputs). Form still stores
    canonical lbs/cm — conversion is display-only. `Field` label widened to
    `ReactNode`; new `UnitToggle` component.
  - **Dashboard read**: hero weight stat cards + the weight chart (axis, goal
    line, tooltip) render in the user's chosen unit.
  - **Onboarding** (`WeightStep.tsx`, added 2026-07-02): the About-you step has
    the same lbs/kg weight toggle + cm/ft-in height toggle; parent state stays
    canonical (lbs/cm), conversion is display-only, so `/users/onboard` is
    unchanged. Height validation message made unit-neutral.
Tests: units (15) + weight-log-fast stone (+1). 1495 api green, web builds +
typecheck clean. No migration.

---

### Food day = LOCAL CALENDAR DAY (midnight → 11:59 PM) (2026-07-02)

Product ask: food/protein/calorie totals should run "from wake-up until 11:59
PM." A window can't both start at wake AND end at 11:59 PM without gaps, so the
clean implementation is the **local calendar day** (12:00 AM → 11:59 PM in the
user's timezone) — functionally identical to "from when you wake until 11:59 PM"
for anyone asleep overnight (fresh at midnight, closes at 11:59 PM). This
SUPERSEDES the 2026-06-15 wake_time-to-next-wake_time window (which let a day
bleed ~7h past midnight). Single source of truth `nutrition/logging-window.ts`:
`userDayExpr` → `(col AT TIME ZONE tz)::date` (no wake shift); `isCurrentUserDay`
compares local dates; `computeUserLoggingDay` (the Redis-key twin) returns the
local date, wake arg ignored. Because EVERY food "today"/per-day read routes
through these helpers, the change applies everywhere at once — chat context,
`getTodaysFoodSummary`, `getDailyProteinHistory`, `log-food`/`remove-food`
running totals, `food-log-fast`, admin food-logs, the L2 cache key, the
scheduler reminders, AND the dashboard (`/dashboard/summary` today + history +
streak). Tests updated (logging-window + today-food-cache); 1479 api green,
typecheck clean. To revert to wake-based: restore the `- user_tz.wake` in
`userDayExpr` + the pre-wake shift in `computeUserLoggingDay`.

---

### User progress dashboard — the app behind the messages (2026-07-02)

Branch `claude/system-migration-process-dtkyp3` (merged to main). Product ask:
"a real app behind the messages" the user opens from a link Grace texts — see
progress (charts/graphs/details), upload stuff, put/read data, save all progress.

- **Auth reuses the Settings session token EXACTLY** (`settings:session:{token}`
  in Redis) — one phone+code verification unlocks BOTH Settings and the
  dashboard, no second login. Frontend shares `grace_settings_token`.
- **`services/api/src/routes/dashboard.ts`** (NEW): `GET /dashboard/summary`
  (profile snapshot + weight progress/series + nutrition today/history/streak +
  mood series + symptom patterns/recent) — every read best-effort (a missing
  table degrades that section to empty, never 500). Writes: `POST
  /dashboard/{weight,mood,symptom,food,photo}`. Symptom logging feeds the SAME
  symptom-intelligence memory as chat (records episode w/ days-since-injection +
  dose, attributes a named remedy). Food uses the real `makeLogFoodTool`
  estimator. **Photo upload = zero new infra**: browser downscales to a `data:`
  URL, undici's `fetch` resolves it, so `analyzeMedia` runs the exact inbound
  vision pipeline (food auto-logs w/ `parseFoodImageAnalysis`; progress photo
  returns a warm read, never logged). Per-route 12MB bodyLimit.
- **`services/api/src/services/dashboard-data.ts`** (NEW, pure/tested):
  `glp1WeekNumber`, `weightProgress` (lost/to-go/pct), `loggingStreak`
  (consecutive logged days, alive if today not-yet-logged but yesterday was),
  `summarizeSymptoms` (group→analyze→order). Wired via `registerDashboardRoutes`
  in server.ts (deps: redis, users, pool, llm, logger, gemini{apiKey,model,fallback}).
- **`services/api/src/services/dashboard-link.ts`** (NEW, tested):
  `detectDashboardRequest` ("show my progress/charts/stats", "the app", guarded
  against "log/track my protein") → early short-circuit intercept in ai.service
  (`intent:'dashboard_link'`, before food paths) returns
  `buildDashboardLinkReply()` with the `/dashboard` link (host rewritten by
  TwilioSender). Grace never denies the app exists.
- **`user.service.ts`**: `logWeightEntry` (+ syncs `current_weight`, invalidates
  cache), `logMoodEntry`, `getMoodHistory`.
- **Frontend** (`apps/web`): `pages/Dashboard.tsx` (brand-consistent,
  framer-motion, phone+code gate, hero stats, charts, symptom panel, quick-log,
  today's meals), `components/dashboard/DashboardCharts.tsx` (recharts weight
  area / nutrition bars w/ protein|calorie toggle + goal line / mood line + the
  "what Grace has learned about your body" pattern cards), `QuickLog.tsx`
  (weight/meal/symptom/mood/photo w/ client-side canvas downscale),
  `lib/dashboardApi.ts`. Route `/dashboard` in App.tsx. Dashboard bundle ~24kB.

- **Progress photo gallery (added 2026-07-02):** migration
  `20260702000001_progress_photos.sql` (table stores downscaled data URLs inline
  — full ~1024px + ~400px thumb — so NO object-storage bucket is needed; RLS
  default-deny). `user.service` gained `saveProgressPhoto`/`listProgressPhotos`
  (metadata + thumb only, light payload) / `getProgressPhoto` (full, owner-scoped)
  / `deleteProgressPhoto`. Routes: `POST /dashboard/progress-photo`,
  `GET /dashboard/photos`, `GET /dashboard/photos/:id`, `DELETE …/:id` (owner-
  scoped, `NotFoundError` added to errors.ts). Frontend
  `components/dashboard/ProgressGallery.tsx` (thumbnail grid + save-sheet with
  optional note/weight + lightbox that fetches the full image on click + delete)
  + `lib/image.ts` (shared `fileToDataUrl`/`fileToFullAndThumb`, QuickLog reuses
  it). Photos are private, never logged as food.

- **Chat grounded in the dashboard data (added 2026-07-02):** every orchestrator
  reply now sees a PROGRESS SNAPSHOT of the user's real journey.
  `AIService.gatherDashboardSignals` (cached 60s, best-effort, fetched in the
  RAG/planner `Promise.all` so zero added latency) derives weight lost + % to
  goal (`weightProgress`), food-logging streak (`loggingStreak`), recent mood +
  trend (`getMoodHistory`), and the learned symptom patterns
  (`summarizeSymptoms`) → passed to `buildPersonalisedPrompt` as
  `dashboardSignals` and rendered as two background lines ("PROGRESS …
  acknowledge ONLY if the user asks about progress/weight/streak/mood" +
  "SIDE-EFFECT PATTERNS … reference ONLY if the user brings up a symptom"). So
  Grace talks about the user's real numbers when relevant, never as a data dump.
  Post-onboarding welcome tells the user to text **"dashboard"** to get the link.

Tests: dashboard-data (11) + dashboard-link (5). 1482 api green, web builds
clean, typecheck clean across all packages. **Deploy: `fly deploy` (API) + web
auto-deploys on Vercel. Apply the symptom_episodes migration (symptom panel) +
the new progress_photos migration (gallery); the rest of the dashboard needs no
migration.**

---

### Symptom intelligence — personal side-effect pattern memory (2026-07-01)

Branch `claude/system-migration-process-dtkyp3`. The signature DIFFERENTIATOR
(product ask: "make the best in the market to sell more"). Grace learns how THIS
person's body handles GLP-1 side effects over time so she recalls a PERSONAL
pattern instead of generic advice — "this usually hits you the day after your
shot, and ginger tea helped last time." The one thing a generic tracker or a
15-minute clinic visit structurally can't do; it compounds into a switching-cost
moat (you can't export what Grace learned about your body).

- **`services/api/src/services/symptom-intelligence.ts`** (NEW, pure/fully
  unit-tested): `classifySymptom` (9 canonical GLP-1 symptoms, specific→generic
  so "throwing up"→vomiting not nausea); `detectRemedyOutcome`/`extractRemedy`
  (named remedy from "the ginger tea helped", negation-voided);
  `localDayOfWeek(tz)` + `daysSinceInjection(injectionDay, dow)`;
  `analyzeSymptomPattern` (typical timing = a CLEAR majority of
  days-since-injection, ≥2 occ & ≥half — never over-claims from noise; topRemedy
  = most frequent); `buildSymptomRecallNote` (reactive directContextNote) +
  `buildInjectionDaySymptomNote` (proactive). Note builders assert ONLY what we
  have (timing and/or remedy), never invent, always keep safe-guidance framing.
- **`supabase/migrations/20260701000001_symptom_episodes.sql`** (NEW) — table
  `symptom_episodes(user_id, symptom, days_since_injection, dose_mg,
  remedy_helped, created_at)` + 2 indexes, RLS default-deny (API uses direct PG).
  **Apply in Supabase before deploy.**
- **`user.service.ts`** — 4 best-effort methods: `recordSymptomEpisode`,
  `getSymptomEpisodes` (by symptom), `getRecentSymptomEpisodes` (all),
  `setLastEpisodeRemedy` (attributes a named remedy to the most recent OPEN
  episode within 72h).
- **`ai.service.ts`** — note-only intercept in the directContextNote block
  (after the reminder intercept, gated `input.text.trim()`, in BOTH modes): on a
  classified symptom → record THIS episode (days-since-injection from
  `injection_day`+tz, dose from `dose_mg`) + inject `buildSymptomRecallNote` for
  Gemini to phrase warmly; on a positive remedy report → attribute the NAMED
  remedy to the last open episode. Wrapped in try/catch — NEVER short-circuits
  (safety/hypo handlers stay in control) and never blocks a reply.
- **`scheduler.ts` + `message-generator.ts`** — proactive: `injection_morning`
  now weaves in `buildSymptomHeadsUp(user)` (groups the user's episodes by
  symptom → analyzes each → strongest timed pattern) via new
  `GenerateOpts.symptomHeadsUp`, so the injection reminder can gently pre-empt a
  recurring effect + name what helped. Null when no confident pattern (never
  manufactures worry).

Tests: `symptom-intelligence.test.ts` (18). 1466 api green, typecheck clean
across all packages. Flag: none (always on; degrades to no-op without the
migration since every DB call is best-effort). **Deploy: apply the migration +
`fly deploy`.**

---

### Nudge-style food-photo flow: describe + confirm, then log (2026-06-29)

Branch `claude/grace-landing-redesign-b8tdkd`. Production bug: a photo of a
*basket of bananas* → "Okay, I logged your meal. That's about 22.5g of protein."
(slow, wrong number, and silently logged food the user never ate).

- **`multimodal/analyze.ts`** — the FOOD prompt now resolves in the single vision
  pass (main already collapsed the old 2-pass for iMessage MIME work) and emits
  `MEAL_STATUS: eaten_meal|ambiguous`, `ITEMS`, `TOTAL: protein Xg`, `CONFIDENCE`,
  and `ASK` (a confirm question), with inline protein anchors + "a bowl of fruit
  is mostly carbs — never inflate protein for produce". Removed the dead
  `USDA_PROTEIN_TABLE` + `buildFoodMacroCalculationPrompt`. Body/Other unchanged.
- **`services/ai.service.ts`** — new pure exported `parseFoodImageAnalysis()`
  (tested) + rewired image branch: **auto-log only when `eaten_meal` && conf≠low
  && protein parsed** → persist via `persistEstimatedFood` (mode-independent,
  2-min dedupe) + a natural reply. **Ambiguous / low-conf / produce → DO NOT
  log**; describe + ask ONE question + `addPendingFood` so the user's portion
  answer logs it next turn (existing text pending path). Removed the old rigid
  "Call log_food / I logged your meal" forced template + dead `buildFoodLogArg`.
- **Double-log guards:** `shouldForceLogFood` requires `input.media.length===0
  && !imageFoodAutoLogged`; `runDirectReply` gained `mediaPresent` to skip text
  food-extract when a photo is present.
- Tests: `food-image-analysis.test.ts` (6, incl. the banana regression).
  **Live path = DIRECT_REPLY_MODE.** Needs `fly deploy` to reach prod (API isn't
  auto-deployed). NOTE: the earlier landing redesign on this branch (PR #111) was
  superseded by main's later editorial landing — this commit is food-photo only.

---

### Personalization gather gate — ask-then-answer for EVERY response (2026-06-28)

Branch `claude/system-migration-process-dtkyp3`. Driven by: "grace should gather
all the missing data before giving responses to make the responses very specific
for the user … it should gather any missing data for every response, not just
food … grace needs to sound very accurate for each user separately to give them
the feeling she knows them very well." Production: "What should I eat today?" from
a profile-thin user → generic ideas (no diet, no dislikes).

Root cause: progressive profiling (`applyProgressiveProfiling`) only ran on the
ORCHESTRATOR path (ai.service ~1768), but `handleFoodQuestionDirect` (and the
knowledge/emotional direct paths) short-circuit BEFORE it — so a food/knowledge
question never gathered first. Its "relevance" ask also only injected a
directContextNote (a hint) rather than truly asking first.

**New unified early gate — `progressiveGatherGate(input)` in `ai.service.ts`**
(runs right after the capability intercept, before ALL substantive paths; gated
on `progressiveProfile && directReplyMode`):
- **Ask-first**: if THIS message needs a missing field to be specific
  (`relevantProfileSlot` — food-idea→dietary then dislikes; protein→Mifflin
  inputs), Grace asks ONE warm question (`buildGatherClarify(slot)`), stashes the
  original question (`setReplayQuery`, Redis `profile:replay:{phone}`, 1h TTL),
  and short-circuits with `intent:'profile_gather'`.
- **Replay**: next turn, the user's answer resolves the pending slot
  (`parseProfileReply` → persist via `users.update`), then the stashed question is
  REPLAYED (`input = {...input, text: replay}`) so the rest of the pipeline answers
  it — now personalized. Replay only fires when we actually captured a value.
- Throttled by the existing 20h `askedProfileRecently` so it never feels like a
  survey; skipped entirely while `onboarding_state === 'in_progress'` (onboarding
  owns collection); media/empty turns skip.
- `progressive-profile.ts` gained `setReplayQuery`/`getReplayQuery`/
  `clearReplayQuery` + `CLARIFY` table + `buildGatherClarify(slot)`.
- `applyProgressiveProfiling` slimmed to the PROACTIVE half only (the pending +
  relevance branches moved into the gate); the throttled neutral-turn ask stays.

Tests: +3 in `progressive-profile.test.ts` (replay round-trip, redis-absent
no-op, clarify-per-slot). 1421 api + 645 ai-core green; typecheck clean across
all packages. Flag: `PROGRESSIVE_PROFILE_ENABLED` (default true).

---

### Sendblue iMessage provider + consumption-feedback follow-ups (2026-06-27)

Branch `claude/system-migration-process-dtkyp3` (PRs #103–#105 merged). Two
threads this session:

**1. Sendblue as an alternative iMessage relay (live, tested in prod).** The
iMessage channel was hard-wired to LoopMessage's contract; added an
`IMESSAGE_PROVIDER` switch (`loopmessage` default | `sendblue`).
- `src/imessage/sendblue-sender.ts` — POSTs `api.sendblue.co/api/send-message`
  with `sb-api-key-id`/`sb-api-secret-key` + `{number, content, from_number}`.
  `from_number` (the Sendblue line, env `IMESSAGE_FROM_NUMBER`) is REQUIRED on
  multi-line/free_api accounts — without it Sendblue 400s "missing required
  parameter from_number" (hit in prod). 20s timeout + one retry on a
  network/timeout abort (NOT on a non-2xx — avoids duplicate sends).
- `src/imessage/sendblue-normalize.ts` — maps `number`→userId, `content`→text,
  `media_url`→media, skips `is_outbound` status callbacks.
- `webhook.ts` picks the normalizer by provider + accepts Sendblue's
  `sb-signing-secret` header for signature verification. `server.ts` builds the
  sender by provider (Sendblue needs only key-id+secret, no sender name).
- Prod setup: `IMESSAGE_PROVIDER=sendblue`, `IMESSAGE_AUTH_KEY`(=key-id),
  `IMESSAGE_SECRET_KEY`(=secret), `IMESSAGE_FROM_NUMBER`(=line), and the
  Sendblue Inbound webhook → `…/webhook/imessage` with the Global Secret =
  `IMESSAGE_WEBHOOK_SECRET`. `free_api` only sends to verified contacts.

**2. Consumption-feedback follow-ups (the 4th meal-lifecycle signal).**
Production: after Grace recommended breakfast incl. a smoothie, "Thanks I feel
good after drinking smoothie" RESTARTED the recommendation flow ("what kind of
breakfast? any dietary restrictions?") — it was feedback after trying a
suggestion, not a new request. Root cause: `detectMealConsumption` returned
`'neither'` (the "after drinking X" / "I feel good" phrasing is neither
consumption nor preference) → fell to `classifyIntent` → recommendation path.
- `meal-lifecycle.ts` — new `detectConsumptionFeedback(text)` (tried-it /
  how-it-felt / back-reference to a suggestion; voided by negation +
  `NEGATIVE_FEEDBACK_RE` so "I don't feel good after eating that" stays a
  symptom) + `extractFoodMention(text)`.
- `ai.service.ts` — new feedback branch in the meal block (BEFORE classify /
  the recommendation path), gated on food context (named food OR last turn was
  a food rec). Returns `buildConsumptionFeedbackReply` (`recommendation-
  context.ts`): warm ack + OFFER to log (never force, never assume macros) +
  one short question, echoing the dish. Stores the dish as the active meal;
  post-turn `extractAndStore` remembers it sat well. Bare back-refs ("I had it")
  still log the known stored meal via `tryLogStoredMeal`.
- `prompts.ts` — general "WHEN SHE GIVES FEEDBACK AFTER TRYING SOMETHING" rule
  (any topic): connect to the prior turn, don't restart/re-list/re-ask
  preferences already in profile, ack + offer to log, keep it short.
- Tests: +21 (meal-lifecycle feedback matrix + extractFoodMention + reply
  builder). 1224 api + 645 ai-core green.

---

### Nudge-style food handling: structured extraction + pending resolution (2026-06-19)

Branch `claude/grace-competitive-eval-g52g71`. Production: "Just had pasta and
chicken" → endless clarification loop ("what kind?" → "sauce?" → "how much?")
that re-asked even after the user gave a quantity. Ported the competitor's food
model (read from its source) into Grace's direct mode.

- **`services/api/src/services/food-extract.ts`** — one structured LLM pass
  (`extractFood`, temp 0.1, JSON, thinking off) → `{ intent: log|edit|delete|
  query|none, items:[{item,protein_g,calories,status:confirmed|pending_portion,
  clarify_question}], edit_ref }`. Prompt ported from Nudge (confirmed vs
  pending, standard-portion table, planning/advice → `none`, water/coffee →
  `none`). `parseFoodExtraction` validates/clamps (protein 0-300, cal 0-5000,
  pending → null numbers) and tolerates code-fence wrapping.
- **`services/api/src/services/food-pending-store.ts`** — Redis pending-item
  state (`food:pending:{phone}`, 6h TTL). The NO-LOOP key: a pending item ("had
  pizza") is stored + fed back into the next extraction, so a portion answer
  ("2 slices") comes back as `intent:edit, edit_ref:pizza` → resolved as
  confirmed, pending cleared — never re-asked. `addPendingFood` (dedupe),
  `resolvePendingFood` (fuzzy match on the food word).
- **`runDirectReply` wiring** — weight stays the fast path; food (when
  `food_log`/`food_question` OR a pending item exists) runs `extractFood`:
  confirmed items → `log_food` (its USDA estimator), new pending → stored +
  ONE clarify question injected into the reply note, `delete` → `remove_food`,
  `query`/`none` → no log. Never-drop fallback: a confident `food_log` classify
  with an `none`/`query` extraction still logs the raw text. The reply is still
  the single Gemini call — it phrases the confirmation + the at-most-one clarify
  from the injected note.

Tests: `food-extract.test.ts` (10) + `food-pending-store.test.ts` (6). 1167 api
green, typecheck clean. Only active under `DIRECT_REPLY_MODE`.

---

### DIRECT REPLY MODE — single Gemini call, no orchestrator (2026-06-19)

Branch `claude/grace-competitive-eval-g52g71` → merged to `main`. The competitor
(Nudge) source was provided: its user-facing reply is ONE call to
`[system prompt + last 24 history turns + user message]`, temp 0.8, max_tokens
500, then ship — only a relevance judge, no banned-phrase/quality regen. (It
reaches `google/gemini-3-flash-preview` via the **Lovable AI gateway**, which
Grace's rules forbid — so Grace stays on the direct Google API with
`gemini-2.5-flash`.) Grace's orchestrator was making replies feel "dry/system":
per-intent directive wrapping ("respond in ONE sentence"), tiny per-intent token
budgets, and the guard/regen cascade.

New env flag **`DIRECT_REPLY_MODE`** (`config/env.ts`, default **true**, instant
revert `fly secrets set DIRECT_REPLY_MODE=false`). Threaded
`env.DIRECT_REPLY_MODE → guards.directReplyMode → private get directReplyMode`
(defaults false so the 1152 unit tests keep the orchestrator path). In
`handleMessageInner`, the `orchestrator.run(...)` call is branched: when
`directReplyMode`, `runDirectReply()` does ONE `llm.generate([system, ...history,
user])` (temp 0.8 / 500 tokens) on the warm, non-directive user text and ships it.

**Preserved (NOT the dry cascade):** crisis SafetyGuard (988/911, runs earlier),
the personalized system prompt (today's protein/calorie totals, medication, week
number — keeps replies personal), deterministic food/weight logging (the real
`log_food`/`log_weight` tools run as a side-effect so totals stay accurate; a
`[just logged … now Xg today]` note is injected so Gemini phrases the
confirmation warmly), and a single **dose-safety BLOCK** check on the final text
(advising extra/double dose → safe deferral). Everything else ships as Gemini
wrote it. Startup logs `startup.direct_reply_mode`. Typecheck clean; 1152 api +
639 ai-core green.

**Facts-to-Gemini for the early intercepts (2026-06-19, follow-up):** under
`directReplyMode` the reminder / water / weekly-summary / meal-preference
intercepts no longer RETURN canned text — they compute the real facts
(deterministic logic for data + persistence) and stash them in a
`directContextNote` that `handleMessageInner` appends to the system prompt, so
the single Gemini call generates EVERY reply from the guidance with accurate
data (e.g. "When is my next reminder" → Gemini phrases the real schedule warmly;
water/weekly-summary inject the real totals; a meal "sounds good" injects a
"don't log, it's interest" note). Crisis + hypoglycemia (and the vague-food
clarification + health-concern scope referral) stay deterministic — the
safety/correctness floor. Each intercept keeps its old return path when
`directReplyMode` is false. 1152 api + 639 ai-core green.

---

### GEMINI-FIRST quality mode: every normal response generated by Gemini (2026-06-19)

Branch `claude/grace-competitive-eval-g52g71`. Driven by the "response-quality
parity with Nudge" spec: Grace was sometimes shipping deterministic templates
that felt generic/repetitive because several latency shortcuts bypass Gemini
entirely. New env flag **`GEMINI_FIRST`** (`config/env.ts`, default **true**,
instant-revert via `fly secrets set GEMINI_FIRST=false`, no deploy) demotes the
quality-reducing shortcuts so every NORMAL user-facing response is generated by
the orchestrator + Gemini. Threaded `env.GEMINI_FIRST → AIServiceDeps.guards.geminiFirst`
(server.ts) → `private get geminiFirst()` (defaults false so the 1097 unit tests,
which construct AIService without `guards`, keep the deterministic paths and stay
green). Startup logs `startup.gemini_first_mode`.

**Demoted when `geminiFirst` (detection still runs, tools still execute — only the
user-facing TEXT moves to Gemini):**
- trivial fast-path (`tryFastPath` — greetings/small talk/acks) → orchestrator
- food-log fast template (`tryFoodLogFastResponse`, both the early path and the
  clarification-continuation path) → orchestrator force-logs `log_food` with the
  clean phrase + Gemini phrases the confirmation (the log still persists)
- weight-log fast template → orchestrator (`log_weight` still persists)
- FAQ semantic cache (canned educational answers) → orchestrator
- deterministic recommendation-ack advance → orchestrator

**Deliberately UNCHANGED (spec's "safety checks may still assist" clause — these
are correctness/safety guarantees, not quality shortcuts):** crisis SafetyGuard
(988/911), hypoglycemia acute handler, water tracker (separate table / data
integrity), reminder-interface answers (prevents capability-denial), meal-
preference no-log guard, Settings single-source-of-truth redirects. Degraded
fallbacks (`glp1-knowledge` bank, `buildResilientFallback`, `getToolAwareFallback`)
are also untouched — they ONLY fire when Gemini actually fails, which is exactly
the spec's intent (the floor when the LLM is down, never the primary path).

Trade-off accepted by the spec: +1-2s latency for a real, contextual, personalized
answer (weaves in this user's medication, week number, recent logs). Typecheck
clean; 1097 api tests green. **Deploy note:** ships on the next `fly deploy`; the
DB-active prompt is unchanged so no `sync-from-code` needed. To A/B the old
latency-first behavior: `fly secrets set --app grace-api GEMINI_FIRST=false`.

---

### Multi-channel: WhatsApp/SMS + iMessage (2026-06-17)

Grace now delivers on **both Twilio (WhatsApp/SMS) and iMessage** simultaneously.
Full setup: `docs/IMESSAGE.md`. The AI pipeline is transport-agnostic.
- **Outbound**: every caller sends through a `MessageSender` (interface in `twilio/sender.ts`).
  `ChannelRouter` (`src/channel-router.ts`) dispatches by `msg.channel`: `'imessage'` →
  `ImessageSender` (LoopMessage relay, `src/imessage/sender.ts`, reuses `sanitizeOutbound` +
  `rewriteCanonicalLinks`); `'whatsapp'|'sms'` → `TwilioSender`. iMessage requested but
  unconfigured → falls back to Twilio WhatsApp (never silent).
- **Inbound**: `webhook.ts` extracted the shared `processInboundMessage(deps, normalized, log)`;
  `POST /webhook/twilio` and new `POST /webhook/imessage` both call it. iMessage payloads map
  via `src/imessage/normalize.ts`; webhook verified via `src/imessage/signature.ts` (shared-secret
  header or HMAC, enforced only in production).
- **Per-user channel**: `users.channel` column (migration `20260617000001_user_channel.sql`,
  default `'whatsapp'`) drives PROACTIVE sends (scheduler reads `user.channel`). Inbound replies
  always go back on the arriving channel. An inbound iMessage auto-aligns `users.channel='imessage'`
  so scheduled check-ins follow. Editable via `PUT /admin/users/:phone {channel}` + admin manual send.
- **Env** (`config/env.ts`): `IMESSAGE_AUTH_KEY` / `IMESSAGE_SECRET_KEY` / `IMESSAGE_SENDER_NAME`
  (all three required to enable) + optional `IMESSAGE_API_URL`, `IMESSAGE_WEBHOOK_SECRET`.
  OFF until configured; WhatsApp/SMS unchanged when off. Log tag: `imessage.channel.enabled`.
- Tests: `imessage/normalize.test.ts` (8), `imessage/signature.test.ts` (4), `imessage/sender.test.ts`
  (6), `channel-router.test.ts` (3). 1094 api tests green, typecheck clean.
- **Caveat**: relay APIs are against Apple ToS (accounts can be throttled) — iMessage is an
  optional channel layered on WhatsApp/SMS, not a replacement.

---

## What this project is

**Grace** — a production-grade WhatsApp/SMS AI companion for people on GLP-1
medications (Ozempic, Wegovy, Mounjaro, Zepbound, compounded semaglutide/tirzepatide).

Users sign up via a web onboarding flow, then receive personalized daily check-ins,
meal/hydration guidance, injection-day flows, and on-demand chat — all via WhatsApp/SMS.
No app required.

The v2 Node.js orchestration service is **live in production**:
- API: `https://grace-api.fly.dev` (Fly.io, region `iad`, 2 machines)
- Admin web + onboarding: deployed to Vercel as `grace-admin` (alias `https://grace-admin-silk.vercel.app`) with `VITE_API_URL=https://grace-api.fly.dev`
- Twilio WhatsApp sandbox webhook points at `https://grace-api.fly.dev/webhook/twilio`
- End-to-end verified 2026-05-12 with a real WhatsApp message.
- KB re-embedded against `gemini-embedding-001` (768-dim) — RAG returns real GLP-1 knowledge.
- Multimodal fully working: voice notes (transcribed via Gemini File API), food photos (per-item USDA breakdown + auto log_food), body/progress photos (compassionate GLP-1-aware analysis). All fixed 2026-05-13.

Open follow-ups: add a Fly payment method (trial machines auto-stop after 5 min idle),
get a WhatsApp Business sender approved by Meta to drop the "Twilio Sandbox:" prefix,
set the 5 Vercel env vars (`VITE_API_URL`, `VITE_WHATSAPP_NUMBER`, `VITE_WHATSAPP_JOIN_CODE`,
`VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`), disable the legacy v1
`handle-inbound-sms` edge function once 24h of stable v2 traffic is confirmed.

---

## Repo layout

```
.
├── apps/
│   └── web/                # @grace/web — Vite + React + shadcn/ui
│                           # Onboarding flow + admin dashboard at /admin
├── services/
│   └── api/                # @grace/api — Fastify orchestration service (v2)
│                           # All AI, scheduling, webhooks, admin API
├── packages/
│   ├── shared/             # @grace/shared — canonical TS types
│   └── ai-core/            # @grace/ai-core — pure orchestrator, planner, validator
├── supabase/
│   ├── functions/          # Legacy v1 edge functions (Deno) — still live in prod
│   └── migrations/         # SQL migrations
├── docs/
│   ├── STATUS.md           # Phase tracker + open todos
│   ├── OPERATIONS.md       # Production setup guide + subscriptions + admin
│   ├── CACHING.md          # Canonical caching + latency reference (every layer documented)
│   ├── USER_GUIDE.md       # End-user guide (share with users)
│   └── WELCOME_EMAIL.md    # Welcome email template with personalization notes
├── docker-compose.yml      # One-command local: Postgres+pgvector + Redis + api
└── CLAUDE.md               # This file
```

---

## Architecture (v2 — fully built)

```
WhatsApp/SMS (Twilio)
        │
        ▼
POST /webhook/twilio
        │
        ├── isAccessAllowed() — 3-day trial / is_paid / is_pro gate
        ├── UserService.ensureUser() — upsert, update last_reply_at
        ├── injection "done" detection → advances state machine
        ├── RLHF feedback intercept (👍/👎/FEEDBACK:) for opted-in users
        ├── shouldSkipCoalesce() — trivial messages bypass the 2s buffer
        │
        ▼
AIService.handleMessage()
        │
        ├── tryFastPath() — 14 categories of trivial messages (greetings,
        │                   brief feelings, thanks, goodnight, etc.) get
        │                   instant deterministic replies, ZERO LLM call.
        │                   Pure latency win: ~150ms instead of ~3s.
        ├── analyzeMedia() — if media present (runs before orchestrator)
        │     ├── fetchMedia() with Twilio Basic Auth (SID:token)
        │     ├── image → classifyImage() → 'food' | 'body' | 'other'
        │     │     ├── food  → per-item USDA breakdown (ITEMS/BREAKDOWN/TOTAL/NOTES)
        │     │     └── body  → GLP-1-aware progress analysis (muscle + encouragement)
        │     └── audio → Gemini File API upload → transcribe → delete
        │
   ┌────┴───────────────────────────────────────┐
   ▼                   ▼                        ▼
SafetyGuard      MemoryService            RagService
(crisis check)   (Postgres history)       (pgvector + RLHF weights)
        │
        ▼
AIOrchestrator (packages/ai-core)
   ┌────┴──────┐
   ▼           ▼
Planner    ToolRegistry (8 tools, DB-gated)
   │
GeminiProvider (gemini-2.5-flash) → Validator → RelevanceCheck (gemini-2.0-flash)
   │
BullMQ turn-persist worker → Postgres
   │
TwilioSender → WhatsApp/SMS
```

**Scheduler** (node-cron, in same process as API):
- Every minute → proactive messages per user (timezone-aware)
  - Morning at wake_time (daily — the "at least 1/day" anchor)
  - Midday Mon/Wed/Fri 11am–2pm local (only fires if engaged today or <1 day silent)
  - Evening Tue/Thu/Sun 90min before sleep_time (only fires if user replied today)
  - Injection day flow (4 stages: morning_sent → done_confirmed → followup_sent → day-after)
  - Side-effect follow-up 4h after keyword detected
  - Bonus spontaneous nudge: 1 extra daily message at a varied random time (adds variety to the schedule)
- **Engagement dampener** (`userEngagedToday`, `userSilentDays` helpers): caps a silent user at 2 messages/day (morning + 1 nudge), drops to 1/day (morning only) after >1 day of no reply. Engaged users still get the full 3-message schedule.
- **Engagement cooldown** (Phase 15, configurable via `ENGAGEMENT_COOLDOWN_HOURS`, default 2h): after a user sends a message, ALL non-critical proactive types are suppressed for the cooldown window. Resets on every user reply. Critical-exempt types (always allowed): `injection_morning`, `injection_followup`, `trial_expiry_reminder`. `injection_dayafter` is NOT exempt — it's a check-in, not urgent. Logs `scheduler.engagement_cooldown_active` with the elapsed hours.
- **Message coalescing**: 2s window to merge rapid multi-message sends into a single AI turn. Trivial messages (greetings, brief acks, thanks, goodnights, etc.) bypass coalesce via `shouldSkipCoalesce()` for instant response.
- Daily 3am UTC → personalization engine (low_mood_mode, midday_skip)

---

## Subscription model

| Tier | DB flag | Stripe price ID | Access |
|---|---|---|---|
| Free trial | `trial_start` set | — | 3 days from signup |
| Standard | `is_paid = true` | `price_1TLha4E0DcWyPH4X2QxV9hh3` | Full AI + proactive |
| Pro | `is_pro = true` | `price_1TLla9E0DcWyPH4XZnep2X7G` | Full + priority |

Stripe flow (v1 Supabase edge functions, still active):
1. `create-checkout` → Stripe subscription with 3-day trial
2. `confirm-checkout` → marks `is_paid = true` in shared DB
3. `stripe-webhook` → syncs subscription events → `is_paid`/`is_pro`

v2 API reads `is_paid`/`is_pro` from the same Postgres DB — no duplication needed.
Subscription gate in `webhook.ts` fires paywall message if trial expired and not paid.

---

## Complete API surface

### Public
- `POST /webhook/twilio` — Twilio inbound (WhatsApp + SMS)
- `POST /chat/send` — demo/testing chat endpoint
- `GET /chat/stream/:conversationId` — SSE live message stream
- `GET /chat/history/:userId` — last 100 messages for a user
- `POST /users/onboard` — create user profile + set trial_start + send welcome WhatsApp
- `DELETE /users/:phone/data` — GDPR self-serve data deletion
- `GET /health` — liveness check

### Admin (Bearer `ADMIN_TOKEN` required)
- `GET /admin/metrics` — messages/tools/feedback/cache stats + `user_stats` breakdown (auto-refresh 30s)
- `GET /admin/conversations` + `/:userId/messages` — conversation viewer
- `GET /admin/users?limit&offset` — paginated user list; includes `rlhf_enabled`
- `GET /admin/users/:phone` — full user detail: profile + check-in history + weight logs + message count
- `PUT /admin/users/:phone` — update any profile/account field (Zod-validated)
- `DELETE /admin/users/:phone` — hard delete user + all data
- `POST /admin/users/:phone/reset-memory` — wipe messages/conversations/embeddings
- `PUT /admin/users/:phone/rlhf` — toggle `rlhf_enabled` for a user `{ enabled: boolean }`
- `GET|POST /admin/feedback` — RLHF signal viewer + submit
- `GET|POST /admin/prompts` — system prompt versions
- `PUT /admin/prompts/:id/activate` — hot-swap active prompt (atomic)
- `GET /admin/tool-settings` + `PUT /admin/tool-settings/:name` — tool toggles

---

## Tools (9 registered per-request, admin-toggleable)

| Tool | What it does |
|---|---|
| `log_food` | LLM-estimates protein/kcal for food text (handles multi-item + pre-calculated totals from image analysis), writes to `food_logs` |
| `log_weight` | Records lbs to `weight_logs` |
| `log_mood` | Records mood score 1–10 |
| `knowledge_search` | pgvector RAG over GLP-1 knowledge base |
| `get_user_profile` | Returns user's goals, medication, weight, behavioral flags |
| `get_weight_trend` | Last 10 weight entries + up/down/stable trend |
| `get_food_summary` | Today's protein + calories + protein_goal_met (≥80g target) |
| `log_side_effect` | Sets side_effect_flow → schedules 4h follow-up message |
| `search_food_ideas` | Calls Gemini with Google Search grounding to find current, varied, diet-specific meal/snack ideas. Builds query with dietary restriction + food dislikes + "GLP-1 friendly". Grace calls this for all food recommendation requests. |

---

## Database migrations (apply in order)

```bash
psql "$DATABASE_URL" -f supabase/migrations/20260507000001_grace_v2_core.sql
psql "$DATABASE_URL" -f supabase/migrations/20260507000002_grace_v2_phase4.sql
psql "$DATABASE_URL" -f supabase/migrations/20260507000003_grace_v2_users.sql
psql "$DATABASE_URL" -f supabase/migrations/20260508000001_rlhf_user_flags.sql
psql "$DATABASE_URL" -f supabase/migrations/20260513000001_prompt_optimizer_columns.sql
psql "$DATABASE_URL" -f supabase/migrations/20260513000002_protein_personalization.sql
psql "$DATABASE_URL" -f supabase/migrations/20260513000003_glp1_start_date.sql
psql "$DATABASE_URL" -f supabase/migrations/20260516000005_content_rules.sql
psql "$DATABASE_URL" -f supabase/migrations/20260527000001_enable_rls_all_tables.sql
psql "$DATABASE_URL" -f supabase/migrations/20260528000001_calorie_goal.sql
psql "$DATABASE_URL" -f supabase/migrations/20260601000001_real_data_corpus.sql
psql "$DATABASE_URL" -f supabase/migrations/20260601000002_content_rules_auto_fix_type.sql
```

**`20260516000005_content_rules.sql`** — IMPORTANT: run in Supabase SQL Editor with "No limit" toggle OFF (not in Neon). Creates `content_rules` table + 48 seed rules. Verify with: `SELECT severity, COUNT(*) FROM content_rules GROUP BY severity;` → should show `block: 4, regen: 44`.

**`20260527000001_enable_rls_all_tables.sql`** — Enables Row Level Security on all 16 public tables. Default-deny policy blocks the Supabase `anon` key from reading/writing any table. Service-role and direct connections (used by the API) are unaffected.

Core tables: `users`, `conversations`, `messages`, `embeddings`, `tool_logs`,
`feedback`, `food_logs`, `weight_logs`, `check_ins`, `injections`, `prompts`, `tool_settings`.

Key columns:
- `20260508000001`: `users.rlhf_enabled BOOLEAN DEFAULT FALSE`
- `20260513000002`: `users.age INT`, `users.primary_goal TEXT`, `users.protein_goal_grams INT`
- `20260513000003`: `users.glp1_start_date DATE` — drives accurate week-number context

---

## Credentials (local dev)

All secrets live in `services/api/.env` (gitignored — never commit it).
The following are already filled in for this project:

| Variable | Status |
|---|---|
| `GEMINI_API_KEY` | ✅ set in `.env` and Fly secrets |
| `REDIS_URL` | ✅ Upstash TLS, in `.env` and Fly secrets |
| `DATABASE_URL` | ✅ Supabase Transaction Pooler (`aws-1-ap-northeast-1.pooler.supabase.com:6543`) |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` | ✅ in `.env` and Fly secrets (auth token rotated 2026-05-12) |
| `TWILIO_WHATSAPP_FROM` | ✅ sandbox `whatsapp:+14155238886` |
| `PUBLIC_BASE_URL` | ✅ `https://grace-api.fly.dev` in Fly secrets — used by Twilio signature verification |
| `ADMIN_TOKEN` | ✅ set in `.env` and Fly secrets |
| `ENGAGEMENT_COOLDOWN_HOURS` | ⚙️  Optional, default 2. Window in hours during which scheduled non-critical proactive messages are suppressed after the user replies. Set to 0 to disable. |
| `ADMIN_PHONE` | ✅ set in Fly secrets (`+972547722420`) — receives WhatsApp RLHF optimizer report after each nightly run |

Full deployment instructions: `docs/DEPLOY.md`

---

## Commands

```bash
pnpm install

# Run everything via Docker (Postgres + Redis + API on :3001)
export GEMINI_API_KEY=your-key
docker compose up -d
pnpm --filter @grace/api exec tsx scripts/seed-knowledge.ts

# Local API dev (no Docker)
cp services/api/.env.example services/api/.env && vim services/api/.env
pnpm --filter @grace/api dev

# Tests / typecheck / build
pnpm test          # 47 tests, all green
pnpm -r typecheck  # clean across all 4 packages
pnpm -r build

# Single test file / single test by name (vitest)
pnpm --filter @grace/api test -- guard.test
pnpm --filter @grace/ai-core test -- -t "planner"

# Eval harness — measures accuracy/safety across ~50 GLP-1 cases
# Requires GEMINI_API_KEY. No DB needed (tools are mocked).
pnpm --filter @grace/api eval
# Filter / tune concurrency:
EVAL_FILTER=food EVAL_CONCURRENCY=5 pnpm --filter @grace/api eval

# Auto-eval — multi-turn simulated conversations with LLM judge
# Generates realistic user interactions via 20 personas × 43 scenarios,
# runs them through the real orchestrator, evaluates with a detailed
# 15-dimension LLM rubric, detects patterns, and generates RLHF preference pairs.
# Requires GEMINI_API_KEY. No DB needed (tools are mocked).
pnpm --filter @grace/api auto-eval
# Filter by category / persona / limit scenario count:
AUTO_EVAL_CATEGORIES=food_logging,emotional_support pnpm --filter @grace/api auto-eval
AUTO_EVAL_PERSONAS=sarah_new,mike_terse pnpm --filter @grace/api auto-eval
AUTO_EVAL_SCENARIOS=10 AUTO_EVAL_CONCURRENCY=3 pnpm --filter @grace/api auto-eval
# Skip preference pair generation:
AUTO_EVAL_SKIP_PAIRS=1 pnpm --filter @grace/api auto-eval
# Use a different model for evaluation:
GEMINI_EVALUATOR_MODEL=gemini-2.5-pro pnpm --filter @grace/api auto-eval

# Hot-reload system prompt without restart
docker kill --signal HUP grace-api-1  # or: kill -HUP <api-pid>

# Demo (no Twilio needed)
curl -X POST http://localhost:3001/chat/send \
  -H "Content-Type: application/json" \
  -d '{"userId":"+15551234567","text":"I just had chicken and rice"}'
```

> If `pnpm` is missing on a fresh machine: `corepack enable pnpm && corepack prepare pnpm@9.12.0 --activate`.

---

## Working agreements

- **Active branch**: `main`. Prior feature branches have all been merged — cut new branches off `main` and PR back when ready.
- **Don't break Twilio contract.** `POST /webhook/twilio` accepts Twilio form payload, replies empty TwiML. Outbound goes via `TwilioSender` async.
- **Keep `@grace/ai-core` pure.** No `pg`, no `pino`, no env reads. Inject all deps.
- **Tests first for orchestration changes.** 47 tests, keep them green.
- **No Lovable.** No `lovable-tagger`, no `ai.gateway.lovable.dev`.
- **Commit messages: imperative, focused on why.**

---

## Canonical deploy workflow

**Always use this exact sequence to deploy to production. Do not improvise alternatives.**

The flow: work on a feature branch → open a PR → merge via GitHub (squash) → user runs the command below to pull latest main and deploy.

```bash
cd "$(git -C ~/Grace rev-parse --show-toplevel 2>/dev/null || find ~ -maxdepth 4 -type d -name Grace -exec test -d '{}/.git' \; -print 2>/dev/null | head -1)"
git fetch origin
git checkout main
git pull origin main
fly deploy --app grace-api --config services/api/fly.toml --no-cache
```

Why each piece exists:
- `cd "$(...)"` — the user's repo isn't at `~/Grace`; this finds the real Git toplevel wherever it lives. Failing silently in zsh was a recurring bug.
- `git fetch origin` — refreshes remote-tracking refs. Without this, `git merge` and `git pull` operate on stale local copies of remote branches and silently say "Already up to date".
- `git pull origin main` — fast-forwards local main to remote HEAD (which now includes the squash-merged PR).
- `--no-cache` — Depot's build cache aggressively reuses layers keyed on file content, but quirks have caused "all CACHED" deploys to ship stale code. `--no-cache` adds ~3 minutes but guarantees the new code compiles into the image. Use it on every production deploy.

**Verification after deploy:**
- `git pull origin main` should report `Updating XXXX..YYYY  Fast-forward` (NOT "Already up to date")
- The build should run `[build 5/5] RUN pnpm ... build` for ~11s (NOT `CACHED`)
- `curl https://grace-api.fly.dev/health` returns `{"status":"ok",...}`
- `fly logs --app grace-api | grep <log-tag-for-the-new-code>` shows the new path firing on real traffic

---

## Accuracy / eval harness

Lives in `services/api/eval/`. Runs every case through real Gemini + mocked tools, grades against expected intent / tool calls / required + forbidden phrases / length bounds, writes JSON to `eval/results/<timestamp>.json`.

- `eval/cases.ts` — the dataset. Add a case when you fix a real failure so it doesn't regress.
- `eval/grade.ts` — deterministic checks (no LLM judge yet — coming in Step 2).
- `eval/runner.ts` — concurrent runner + report formatter.
- Crisis/emergency wording is NOT in the eval set — `SafetyGuard` short-circuits the pipeline before the orchestrator runs, and is unit-tested in `services/api/src/safety/guard.test.ts`.

### Auto-evaluation system (advanced)

Lives in `services/api/auto-eval/`. A multi-turn simulated conversation engine with LLM-powered evaluation.

**Architecture:**
```
auto-eval/
├── types.ts                    # All type definitions
├── personas.ts                 # 20 user personas (varied styles, medications, goals)
├── scenarios.ts                # 43 scenario templates across 15 categories + dynamic generation
├── conversation-generator.ts   # LLM-powered realistic user message generation
├── simulator.ts                # Runs multi-turn conversations through the real orchestrator
├── evaluator.ts                # 15-dimension LLM judge (Gemini) with per-turn + conversation-level scoring
├── analyzer.ts                 # Pattern detection, regression tracking, improvement suggestions
├── preference-pairs.ts         # RLHF preference pair generation (chosen/rejected)
├── reporter.ts                 # Human-readable terminal reports + JSON
├── store.ts                    # JSON file storage for all artifacts
├── runner.ts                   # Main 5-phase pipeline orchestrator
└── index.ts                    # Public exports
```

**15 evaluation dimensions** (each scored 1-5):
relevance (HIGHEST PRIORITY), context_memory, tone_match, conciseness, naturalness, no_repetition, no_generic_fallback, conversational_continuity, no_unnecessary_questions, no_hallucination, guardrail_compliance, topic_tracking, empathy, actionability, persona_awareness.

**20 personas** spanning: terse/verbose/emoji/formal/anxious/casual communication styles, all medication types (weekly injection, daily pill), dietary restrictions (vegan, vegetarian, pescatarian), emotional states (frustrated, anxious, celebratory, lonely), edge-case behaviors (typos, mixed language, topic switching, boundary testing).

**15 scenario categories**: food_logging, emotional_support, topic_switching, medical_question, correction, frustration, multi_question, slang_typos, injection_day, side_effects, weight_tracking, edge_case, onboarding, long_term_memory, proactive_response.

**Pipeline phases:**
1. Simulate — generate realistic user messages per persona, run through real orchestrator with mocked tools
2. Evaluate — LLM judge scores each Grace response on 15 dimensions + conversation-level assessment
3. Analyze — detect recurring failure patterns, compare against previous runs for regressions
4. Preference pairs — generate RLHF-style chosen/rejected pairs for low-scoring turns (LLM generates improved alternatives)
5. Report — terminal output + JSON artifacts stored in `auto-eval/results/`

**Output artifacts** (all in `auto-eval/results/`):
- `conversations/` — full simulated conversation transcripts with orchestrator metadata
- `evaluations/` — per-conversation evaluation breakdowns
- `preference-pairs/` — RLHF training data (context + chosen + rejected + reasoning)
- `reports/` — aggregate run reports with category/dimension breakdowns, patterns, regressions

**Feedback loop** (`auto-eval/feedback-loop.ts`) — closes the auto-eval → live chatbot loop via three mechanisms:

1. **Preference pairs → prompt optimizer**: Auto-eval preference pairs are loaded at server startup and injected into the nightly `PromptOptimizer` as synthetic negative feedback. The optimizer sees both real RLHF 👎 ratings AND simulated low-quality responses, giving it thousands of additional learning signals. Flow: `auto-eval/results/preference-pairs/*.json` → `loadPreferencePairs()` → `pairsToSyntheticFeedback()` → `promptOptimizer.injectSyntheticFeedback()` → merged into `gatherSignals()` negative samples.

2. **Eval-gated prompt activation**: Before any prompt is activated (both admin `PUT /admin/prompts/:id/activate` and nightly auto-activation), a quick auto-eval run (8 scenarios) checks the overall score against `EVAL_GATE_BASELINE` (default 2.5). If the score drops below baseline, activation is blocked and the prompt is saved as a draft for manual review. Skip with `?skip_eval=1` on the admin endpoint. Set baseline via `EVAL_GATE_BASELINE` env var.

3. **Auto-generated content rules**: `POST /admin/content-rules/auto-generate` analyzes all stored auto-eval evaluations, detects recurring failure patterns (frequency ≥ 3, score impact ≥ 1.5), and uses Gemini to generate runtime content-checking rules. Rules are inserted as **inactive drafts** (`is_active = false`) — an admin must review and activate them. Only `regen`/`log` severity allowed (never `block`).

Roadmap (in progress, in this order):
1. ✅ Eval harness + 50-case dataset (`services/api/eval/`).
2. ✅ LLM-critic on risky intents (`safety_*`, validator-flagged `possible_medical_advice`, or low-confidence). `knowledge_lookup` removed from risky list (2026-05-15) — it was incorrectly failing food/nutrition responses. Regenerate once on critic fail, safe fallback if second attempt also fails. Implementation: `packages/ai-core/src/critic.ts` + orchestrator wiring.
3. ✅ Fact-grounding: deterministic precheck (`packages/ai-core/src/grounding.ts`) detects quantitative medical claims (doses, durations, frequencies, percentages) and interaction-safety assertions in the response and verifies them against retrieved KB chunks. Unsupported claims fail-close to regen — saves a Gemini call vs. invoking the LLM-critic. Surfaced via `CriticReport.unsupportedClaims` + `source: 'precheck' | 'llm'`.
4. ✅ Eval-gated prompt activation + auto-eval preference pairs → prompt optimizer + auto-generated content rules. Implementation: `auto-eval/feedback-loop.ts`, wired into `prompt-optimizer.ts` + `routes/admin.ts` + `server.ts`.
5. ✅ LLM relevance checker (`packages/ai-core/src/relevance-check.ts`): post-generation semantic verification using `gemini-2.0-flash`. Topic-closer history stripping + ratio-based drift detection. Emergency LLM fallback for pipeline crashes.
6. ⏳ Gemini prompt caching for static system prompt + tool defs; skip planner for pure-chat intents.

---

## Phase completion status

| Phase | Scope | Status |
|---|---|---|
| 1 | Monorepo, Fastify, Twilio webhook, Gemini orchestrator, memory + RAG, tests | ✅ |
| 2 | Real tools, safety, RLHF feedback, admin API, multimodal | ✅ |
| 3 | Redis cache, BullMQ workers, SSE streaming, per-tool timeouts | ✅ |
| 4 | Admin dashboard (web app) | ✅ |
| 4b | Full chatbot: users, scheduler, proactive messages, all tools, onboarding API | ✅ |
| 4c | Subscription gate, GDPR delete, chat history, admin user CRUD | ✅ |
| 4d | User-side RLHF: per-user ratings + feedback comments, admin toggle | ✅ |
| 4e | Admin dashboard overhaul: user drawer, create modal, richer metrics | ✅ |
| 5 | Cut Twilio webhook from v1 → v2 | ✅ live at `https://grace-api.fly.dev` |
| 6 | Multimodal: voice notes + food photos + body/progress photos | ✅ Gemini File API audio, image classification, per-item nutrition, body analysis |
| 6b | Admin dashboard premium redesign + animated landing page | ✅ deep slate + indigo admin shell, colorful animated blob background |
| 7 | AI quality pass from WhatsApp QA: persona, hallucination guards, quiet hours, settings redirect, food-dislike paraphrase, brief-reply rule, GLP-1 week number, 50+ emotional patterns | ✅ |
| 8 | Master prompt operationalization: full prompt rewrite from `gracemasterprompt.md`, unified safety message (988+911), reminder-style proactive messages, in-chat frequency change, natural-language opt-out, runtime context (Today is / Time of day / Total protein TODAY / Scheduled check-ins sent today / Medication type) | ✅ |
| 9 | Production quality pass: proactive message label/truncation fix, humanized timing jitter, trial Day 2 reminder, RLHF on proactive messages, admin WhatsApp optimizer report, food recommendation rules, every-response-unique rule, critic tuned for food facts, safe fallback improved, name stripping in code | ✅ 2026-05-15 |
| 10 | DB-driven content guardbands: `content_rules` table (48 rules: 4 block + 44 regen), `ContentRulesService` with 60s cache, applied to both reactive AI and proactive scheduler paths. Admin CRUD + test endpoint. Redis distributed lock on scheduler to prevent duplicate messages across Fly machines. | ✅ 2026-05-16 |
| 11 | AI quality pass: GREETING RULE (pure greeting → one sentence, topic reset), FOOD VARIETY rule + 40-food pool, `search_food_ideas` tool (Google Search grounding for food questions), two-pass scientific food image analysis (Pass 1: visual ID with USDA anchors; Pass 2: text-only macro calculation with 50-food USDA table). | ✅ 2026-05-19 |
| 12 | Auto-evaluation system: 20 personas × 43 scenarios × 15 categories, multi-turn conversation simulation through real orchestrator, 15-dimension LLM judge, pattern detection, regression tracking, RLHF preference pair generation. `pnpm --filter @grace/api auto-eval`. | ✅ 2026-05-24 |
| 13 | Security hardening + Conversation intelligence + Production quality: RLS on all tables, LLM relevance checker, topic-closer history stripping, medical tone graduated escalation, message coalescing 3.5s, bonus spontaneous reminders, emergency LLM fallback, optimizer switched to gemini-2.0-flash, Docker fix. | ✅ 2026-05-27 |
| 14 | QA tools + behavioral defense + calorie parity: regression suite (`/admin/regression`, 17 scenarios replaying every fixed bug), production-realistic replay tool (`/admin/replay` with in-memory orchestrator + mock tools), prompt-version diff, auto-eval presets/category filter, calorie tracking full parity with protein (Mifflin-St Jeor + activity + GLP-1 deficit, force tool calls, prompt rules, content rules), behavioral guard (LLM judge against 10 principles), generalized content checker (catch-all regexes), force log_food with classifier + safety net + continuation. | ✅ 2026-05-28 |
| 15 | Latency + comprehensive feedback pass: fast-path responder (14 categories of trivial messages get instant ~150ms replies skipping LLM entirely), parallel LLM guards (relevance + behavioral + critic via Promise.all), per-intent token budgets, coalesce 3.5s→2s + bypass for fast-path messages, RAG embed cache 5min→30min, critic on gemini-2.0-flash + disableThinking, image follow-up context (preserves analyzed image across turns), food-log preamble leak guard, privacy rule strict scoping (no more misfires on self-referencing health questions), banned-phrase expansion (18 new patterns), list-format hardening, appointment_prep intent + classifier, EMOTION BEFORE DATA rule, ANSWER ONLY THE CURRENT MESSAGE rule with 7 production-failure examples, clinical redirect template, plateau-feeling education rule, two-question detector, protein-from-current-weight guard, configurable engagement cooldown (suppresses non-critical proactive messages within ENGAGEMENT_COOLDOWN_HOURS of any user reply — default 2h, set via env). | ✅ 2026-05-30 |
| 16 | Deep-research coverage expansion: 22 new FAQ seeds across 10 new categories (travel, injection site rotation, dose timing, exercise during nausea, sleep, pregnancy redirect, diarrhea, heartburn, alcohol expanded, hangover recovery) + 5 new classifier intents (`exercise_log`, `injection_log`, `medication_question`, `social_situation`, `pause_request`) + 11 new verified-knowledge sections in `prompts.ts` (diarrhea / heartburn / injection site rotation / dose escalation / travel / alcohol / sleep / pregnancy redirect / exercise / medication questions / social situations) + pause/auto-resume via webhook short-circuit + SafetyGuard now runs BEFORE all webhook short-circuits + intent library (51 hand-curated entries across 10 domains in `services/api/coverage/intents.json`) + `taxonomy.md` / `safety-framework.json` / `journey-map.json` + Gemini-driven question generator (`scripts/generate-coverage-questions.ts`) + coverage test suite (`services/api/coverage/suite.ts`, `runner.ts`, `grader.ts`, `reporter.ts`) feeding through real orchestrator via `runSandboxReplay` + admin UI `/admin/coverage` with domain/safety filters and case-by-case view + admin endpoints `GET /admin/coverage/intents`, `POST /admin/coverage/run`, `GET /admin/coverage/runs[/:runId]`, `POST /admin/coverage/ingest` (classify CSV of prod messages → discover uncovered intents) + 50-case coverage smoke wired into the 4am UTC optimizer cron with pass-rate delta appended to admin WhatsApp report. | ✅ 2026-05-31 |
| 17 | Real-world conversation research: unauthenticated Reddit JSON scraper (`services/api/src/research/reddit-scraper.ts`) for 8 GLP-1 subreddits (Ozempic, Mounjaro, Zepbound, WegovyWeightLoss, Semaglutide, GLP1, loseit, WeightLossAdvice) with SHA-256 username hashing + NSFW/stickied/deleted/link-only filtering + 17 unit tests; new `real_data_corpus` Postgres table (migration `20260601000001_real_data_corpus.sql`) with content_hash dedup + indexed by intent/subreddit/status/scraped_at; `CorpusService` (`services/api/src/research/corpus.service.ts`) with four idempotent stages — `ingestPosts` (dedup) → `classifyAndCheckCoverage` (deterministic classifier + nearest-intent token-overlap matcher) → `replayAndGrade` (sandbox replay + deterministic grader) → `evaluateFailures` (15-dimension LLM evaluator ONLY on grade fails OR uncovered intents); admin endpoints `POST /admin/research/scrape`, `POST /admin/research/upload` (Facebook / forum CSV ingest), `GET /admin/research/corpus`, `GET /admin/research/corpus/:id`, `POST /admin/research/corpus/:id/promote` (returns suggested `intents.json` entry), `POST /admin/research/corpus/:id/reject`, `GET /admin/research/coverage-gaps`; weekly cron at Sunday 5am UTC pulls top-of-week from each subreddit + classifies + replays + LLM-evals failures + sends admin WhatsApp summary; admin UI `/admin/research` with Corpus tab (filterable by subreddit/intent/coverage/status) + Coverage Gaps tab (top uncovered posts prioritized by upvote, breakdown by intent + subreddit, weakest LLM-eval dimensions) + side-panel detail with Grace's replay + grade verdict + eval scores + Promote/Reject actions. | ✅ 2026-06-01 |

---

### Settings = single source of truth (2026-06-09)

Profile, dietary, and reminder fields are owned EXCLUSIVELY by the Settings page. Grace may **read** them in chat but must **never** create, save, overwrite, or confirm a change to them from a chat message — that prevents a conflicting second source of truth. Enforced deterministically (before the AI ever runs) so it can't drift:

- **`services/api/src/services/settings-flow.ts`** — `tryHandleSettings()` now only READS + REDIRECTS. The two-phase Redis confirm/apply flow and all chat writes were removed. READ requests answer + append the Settings URL (unchanged). UPDATE requests (timezone, medication, dose, weights, height, sex, name, age, primary goal), dietary-identity changes (`DIETARY_CHANGE_PATTERNS`: "I'm vegan now", "change my diet", "I no longer keep kosher", "remember I don't eat meat"), and food-dislike adds all return the verbatim `PROFILE_REDIRECT` message. Deps slimmed to `{ logger }` (no more `users`/`redis`). Dietary patterns are conservative — a passing mention like "I'm vegan, what should I eat?" still flows to food-ideas.
- **`services/api/src/routes/webhook.ts`** — `detectFrequencyChange()` (which wrote `checkin_count_per_day`) replaced by `isFrequencyChangeRequest()` → sends `REMINDER_REDIRECT_REPLY` to Settings. No cadence write from chat.
- **SOLE EXCEPTION:** injection-day change, still handled in-chat by `detectInjectionDayChange()` (writes `injection_day`).
- **`packages/ai-core/src/prompts.ts`** — SETTINGS MANAGEMENT + CHECK-IN FREQUENCY sections rewritten to "redirect, never confirm in chat / never claim to remember"; the only in-chat exception is injection day. Starting-weight redirect no longer offers "tell me 'set my starting weight to ___'".
- Tests: `settings-flow.test.ts` rewritten to assert redirect (no writes). Full suite green (615 api + 513 ai-core).
- **Follow-up:** the legacy v1 `supabase/functions/handle-inbound-sms` edge fn still has its own chat-write settings flow ("Reply yes to confirm"). It's not the live v2 path, but disable/align it before re-enabling v1 as a fallback.

---

### Reliability verification + fixes (2026-06-10)

Full-system verification report: `docs/RELIABILITY_VERIFICATION_2026-06-10.md` — evidence-based
PASS/FAIL for nutrition, memory, context, reminders, conversation protection, profile/settings,
recommendations, injection day, data consistency. Two production-critical failures found and
fixed the same session, plus five smaller items. Branch `claude/grace-reliability-verification-r77eph`.

**Fixed — webhook message loss (CRITICAL, regression since `a2ae4bc` 2026-06-04):**
- The per-user in-flight lock ran BEFORE coalescing, so any follow-up arriving while a
  turn was processing (including within the 2s coalesce window) failed `SET NX` and was
  silently dropped — coalescing was dead code in production.
- `webhook.ts` now: (1) coalesces FIRST (buffer append before any lock), (2) the in-flight
  lock WAITS with bounded retries (`acquireInflightSlot`, 15×1s, exported + tested) instead
  of dropping, (3) `coalesceMessages` explicitly releases its window lock after draining —
  previously it relied on the 5s TTL, so messages arriving 2–5s after the first were
  absorbed into an already-drained window and lost.

**Fixed — scheduler ignores cadence Settings (CRITICAL):**
- `checkin_count_per_day` / `checkin_days_interval` were collected at onboarding, editable
  in Settings, claimed by the AI context ("CHECKIN FREQUENCY: N") — and never read by the
  scheduler (hard-coded 2/day cap). `sendAndRecord` now honors `checkin_count_per_day`
  (clamped 1..3, default 2 — default behavior unchanged) and `checkin_days_interval`
  (every-N-days, phase = user-local day number mod interval). Critical health flows
  (`injection_morning`, `injection_followup`, `trial_expiry_reminder`) remain exempt.
  The AI context line now reports the same clamped value.

**Also fixed:** injection "done" reply now gets a deterministic injection-aware ack
(short-circuits before fast-path's generic "Got it 👍"; state machine unchanged);
`reset-memory` admin endpoint wraps core deletes in a transaction + invalidates the
memory.md cache; `user_memories` retrieval adds a recency penalty (0 under 30 days,
max +0.30 distance at ~390 days) so old memories can't permanently outrank new
corrections; RAG `feedback_score` contribution clamped to ±0.25; date-flaky
`curated-meal-ideas` test de-flaked (asserts spread across 10 users).

**Deliberately deferred:** dedicated `allergies` column (functionally enforced today via
`food_dislikes`; needs coordinated web-UI + v1 edge-fn changes — product decision);
disabling the dormant v1 `handle-inbound-sms` settings-write path (prod Supabase action,
already in open items). Tests: 627 api + 513 ai-core green.

---

### Execution-path verification + production fixes (2026-06-11)

Branch `claude/grace-production-readiness-x2k1oj`. Full report:
`docs/VERIFICATION_2026-06-11.md`. New tooling: `services/api/verification/`
— a production-shaped harness (real webhook→coalesce→locks→AI→workers→Postgres
pipeline on local Postgres+Redis; deterministic stub LLM/embedder/sender that
records every LLM call) with a 54-check battery (P1-P9, incl. deterministic
content accuracy + anti-hallucination/context phases) + 24-user stress run.
All green; 635 api + 513 ai-core tests green.

**Fixed (production):**
1. Fast-path silent drops — `'Hi 🤍'`, `'😄'`, `'😆'`, `'🤍'`, `'On it.'`
   failed the webhook `/[A-Za-z0-9]{3,}/` junk gate → user got NO reply.
   Pools reworded + brute-force regression test in `fast-path.test.ts`.
2. DB content rules (incl. all 4 block-severity dose rules) were NOT applied
   on `runDirectPath` / `handleFoodQuestionDirect` / emergency fallback / FAQ
   cache. Now threaded via `AIService.getDbRules()` (cached, ~0ms).
3. Code-level banned-phrase violations carry NO `severity`; direct-path gates
   only checked `'block'|'regen'` → every code-level banned phrase shipped on
   knowledge/emotional/food direct paths (reproduced live). Gates now treat
   missing severity as regen, matching orchestrator semantics.
4. `FOOD_LOG_SKIP_RE` missed "I **just** had/ate/drank …" → +2s coalesce tax
   on the most common food-log phrasing. Fixed; e2e 2011ms → 9ms in harness.
5. `user_memory_md` migration had an unimplementable TEXT→UUID FK (fails on
   every DB; table is keyed by phone). FK dropped. **Verify the table exists
   in prod Supabase** — if the migration never applied, Phase D pilot can't
   enroll anyone (fails soft).
6. Core migration `CREATE EXTENSION pgvector` → `vector` (the old name errors
   on every Postgres and halted `docker compose up` initdb).
7. `USDA_API_KEY` was a no-op — `UsdaFoodService` was never constructed.
   Now built in server.ts when the key is set.
8. "Calories/protein left today?" matched no query_fast pattern → routed to
   knowledge_direct, which can't see today's intake → generic/hallucinated
   answers. New PROTEIN_LEFT_RE / CALORIE_LEFT_RE route to the existing
   DB-backed protein_today/calorie_today renderers (+5 unit tests).
9. Durable facts (user_profile_facts) never reached the direct paths'
   prompts — runDirectPath now injects top-8 getKnownFacts (cached, fetched
   in parallel with the profile) as "Known about this user:".

**Documented, not fixed:** `ConversationSummaryService`, `TopicTrackerService`,
`ResponseFingerprintService`, `BanditService` are scaffolded + accepted as deps
but never instantiated anywhere — summaries/topic-tracking/repetition-
fingerprinting/bandit loop are dead code in prod. Wiring them changes live
behavior; needs live-Gemini evals first.

---

### Full-sentence multi-item comprehension (2026-06-11, continued)

Branch `claude/grace-production-readiness-x2k1oj`. Driven by a production report:
"For breakfast I ate 2 eggs. For lunch I had chicken breast with bowl of rice"
logged only ~12g protein (the eggs) — the chicken + rice were silently dropped.

**Root cause (a Gemini-outage failure):** `splitMultiMealText` correctly split the
message into two per-meal `log_food` calls, but the lunch call
("chicken breast with bowl of rice") hit the fast-lookup **multi-food bail**, then
both USDA decomposition and the LLM estimator needed Gemini (down on free-tier
quota) → `log_food` returned `ok:false` and the lunch was dropped. `log_food` had
**no deterministic last resort**, so on any LLM outage a recognizable compound meal
vanished.

**Fixes:**
1. **`services/api/src/tools/log-food.ts`** — `makeLogFoodTool` now falls back to
   `estimateMultiItemFood` (the no-LLM macro-table decomposer) before returning
   `ok:false`. A multi-item meal now totals correctly during a total Gemini outage.
   `estimateSource` gains `'deterministic'`; logs `tool.log_food.deterministic_fallback`.
2. **`estimateMultiItemFood` hardened** — splits on meal-label boundaries (not just
   strips them) so punctuation-free "2 eggs for lunch chicken and rice" still
   separates; and any leftover piece that still holds multiple foods is resolved by
   a new greedy `resolvePieceTokens` (longest-window-first scan) so nothing drops.
3. **`packages/ai-core/src/prompts.ts`** — MULTI-PART PARSING section gains a
   "MULTI-ITEM FOOD LOGS — enumerate EVERY food" rule + an INFORMATIVE CONFIRMATION
   requirement (name each food, separate by meal, give the total + brief uncertainty,
   never a bare "Got it 👍" for a multi-item meal) + a food-specific self-check.
4. **`services/api/src/services/ai.service.ts`** — the deterministic food fallback
   confirmation now enumerates every item + includes calories ("Got it — 2 eggs,
   chicken breast (4oz), and rice (1 cup). Roughly about 46g protein and 520 calories…").

**Validation:** new `estimateMultiItemFood` unit tests (incl. the exact production
case → 46g, not 12g); P10 verification phase strengthened to assert the multi-meal
reply names chicken AND rice and totals ≥40g under GEMINI_DOWN. Full battery
66 pass / 0 fail; 534 ai-core + 653 api tests green.

**Note (design):** no general LLM "did-you-cover-everything" completeness judge was
added — that's the brittle judge class `TRUST_GEMINI` deliberately disables. The
completeness guarantee is deterministic (the log itself now captures all items) plus
the prompt enumeration rule, consistent with the existing architecture.

---

### Aggregated food-log summaries (2026-06-11, continued)

Branch `claude/grace-production-readiness-x2k1oj`. Production report: "what did I
eat today?" returned a raw, repetitive DB dump — "chicken, rice, 2 eggs, 2 eggs,
chicken, rice, … and 12 more" — a database export, not a summary.

**Root cause:** `query-fast.ts` `food_summary_today` joined raw `food_logs.items`
(one row per log, with leaked internal labels) capped at 8 with "and N more". No
dedup, no aggregation. The same raw list also fed the LLM prompt context
(`ai.service.ts`), so tool-path answers could echo the duplicates too.

**Fix — new `services/api/src/services/food-summary.ts`:**
- `aggregateFoodItems(items)` — explodes multi-item meal labels ("3 eggs + salad
  + rice"), strips portion parentheticals ("chicken breast (4oz)"), parses a
  leading count as a multiplier ("2 eggs" ×3 logs → Eggs ×6) UNLESS it's a
  serving word ("1 can tuna" stays intact), and dedupes into `{name, qty}` ordered
  by qty.
- `formatAggregatedInline(items)` — compact "Eggs × 6, Chicken breast × 3" label
  for prompt context (overflow → "+N more items").
- `renderDailyFoodSummary(items, protein, cal)` — the user-facing answer as ONE
  conversational line: "Today you've had Eggs × 6, Chicken breast × 3, Rice × 2,
  plus 2 more foods. That's 171g protein and 2,040 calories." Single line on
  purpose — the WhatsApp outbound enforcer (`twilio/sender.ts` + `format-enforcer`)
  strips bullets / "Here's your day:" intros / "Label:" headers / multi-line lists,
  so a sectioned report gets gutted to an empty reply. Totals are passed in (summed
  upstream) — aggregation never recomputes them, so a summary can't change the day's
  numbers.

**Wiring:** `query-fast.ts food_summary_today` → `renderDailyFoodSummary`;
FOOD_SUMMARY_LIST_RE broadened to match "eat" (not just "ate") + "summarize my
meals/day/intake". Prompt-context "Foods logged today:" line + `get_food_summary`
tool (`items_aggregated` field) + replay sandbox all use the aggregated inline
form. `prompts.ts` gains a "FOOD LISTING vs PROTEIN BREAKDOWN" rule (LISTING =
aggregate; "how did I reach X grams" = per-item walk-through, unchanged).

**Validation:** `food-summary.test.ts` (aggregation + render), updated query-fast
tests, new P12 verification phase (9 checks) proving the aggregated one-line
summary survives the full webhook→enforcer→sender pipeline with duplicates +
a long tail. Battery 75 pass / 0 fail; 534 ai-core + 668 api green.

---

### Food day boundary = LOCAL MIDNIGHT (2026-06-11, continued)

Branch `claude/grace-production-readiness-x2k1oj`. Spec: the food day is the
user's local calendar day, 12:00 AM – 11:59 PM. The code used a **5am rollover**
(`- INTERVAL '5 hours'` in every "today" SQL query + a matching 5h pre-shift in
the Redis cache key), so a log between midnight and 4:59 AM silently counted
toward *yesterday* — contradicting `getTodaysFoodSummary`'s own doc comment,
which already claimed "resets at the user's local midnight".

**Change (mechanical, conventions must stay in lockstep):** dropped the 5-hour
shift everywhere → `(created_at AT TIME ZONE user_tz.tz)::date = (now() AT TIME
ZONE user_tz.tz)::date`:
- `user/user.service.ts` — `getTodaysFoodSummary` (L3 query) + `getDailyProteinHistory` (day keys + window)
- `tools/log-food.ts` — post-insert running total
- `tools/remove-food.ts` — all 3 queries (match, list, recount)
- `services/food-log-fast.ts` — fast-path daily total
- `routes/admin.ts` — `/admin/users/:phone/food-logs` day filter
- `cache/today-food-cache.ts` — `computeUserToday` no longer pre-shifts 5h (the
  L2 Redis key MUST use the same date convention as the SQL or the cache serves
  a different day window than the DB)

Everything else the daily-reset spec asks for was already true and is now
verified: per-user isolation (`WHERE user_id = $1` everywhere), history never
deleted (the "reset" is purely a query-window convention — totals are always
recomputed from rows, nothing is carried over), full timestamps stored per row,
history queryable per local day via `getDailyProteinHistory`.

**Validation:** `today-food-cache.test.ts` rollover tests replaced with
midnight-boundary tests (11:59 PM = today, 12:00 AM = new day, 1 AM = new day);
new **P13** verification phase (7 checks): inserts rows at yesterday-11:30 PM /
today-12:30 AM / now, proves today = 22g not 72g (the 12:30 AM row is the
discriminator — old code put it in yesterday), history keeps yesterday's 50g,
users isolated, WhatsApp "protein today" answers 22g. Battery 82 pass / 0 fail;
534 ai-core + 669 api green.

---

### Reminders: grounded context + anti-repetition + salutation fix (2026-06-11, continued)

Branch `claude/grace-production-readiness-x2k1oj`. Production report: reminder
shipped as **"For Yuval, Hope you're having a good day…"** — mail-merge tone,
generic, unconnected to the user's actual behavior.

**Root causes & fixes (scheduler + message-generator):**
1. **Salutation bug** — `buildPrompt` opened with "Generate a single short SMS
   for ${name}", baiting Gemini into echoing "For Yuval, …" as a salutation.
   Prompt no longer names the user ("Write the next short proactive SMS…
   NEVER address the user by name / never open 'For <name>' / 'Dear user' /
   'As your assistant'"), and `sanitizeProactiveOutput` now strips
   `ADDRESSED_OPENER_RE` (For/Dear/To + Capitalized-name — catches nicknames
   that don't match `users.first_name`) + `ROLE_OPENER_RE` ("Dear user", "As
   your assistant", "Grace here:"). Capital-letter requirement distinguishes
   "For Yuval," (strip) from "For breakfast," (keep).
2. **No real context** — morning/evening reminders were goal-template-only.
   `Scheduler.enrichGenerateOpts()` (best-effort, never blocks a send) now
   feeds the generator: **morning** → YESTERDAY's totals via
   `getDailyProteinHistory` ("yesterday you were short on protein → plan one
   solid protein meal early"; no-logs day gets shame-free framing); **evening**
   → TODAY's running totals via `getTodaysFoodSummary` ("you're at 82g — eggs
   or yogurt tonight closes the gap"; target-hit → acknowledge, no suggestion).
   Prompt carries a DATA ACCURACY rule: use ONLY provided REAL DATA lines,
   never invent logs/symptoms/numbers.
3. **Repetition** — all generative types now receive the last 5 sent reminder
   texts (`getRecentCheckIns().message_sent`) as a RECENTLY SENT banned list,
   plus a deterministic `isNearDuplicate` backstop (normalized exact or ≥85%
   token Jaccard) that ships the daily-rotating fallback instead of a near-dupe.

**Verified pre-existing and now tested:** 2/day default cap (user-settable
1..3) + 3h min gap + Redis day counter; per-user-per-day jitter (new test:
offsets vary across a week, stable within a day); 2h engagement cooldown;
quiet hours; injection flows fully separate (own state machine, exempt from
caps, skip regular check-ins on injection day, NOT context-enriched).

Tests: `message-generator.test.ts` (NEW — 12: salutation strips incl. the
exact production string, near-duplicate, prompt grounding, no-invention rule)
+ 5 scheduler context-enrichment tests + 2 jitter tests. 688 api + 534 ai-core
green; battery 82/82.

---

### Admin dashboard ops pass: Stripe two-way sync + manual ops + deep audit (2026-06-13)

Branch `claude/grace-admin-dashboard-4n3s37`. Full operator guide +
live-verification checklist: `docs/ADMIN_DASHBOARD.md`. The dashboard already
covered ~70% of the requested spec; this pass closed the genuine gaps
(RBAC roles were explicitly out of scope this session).

**Migration `20260613000001_admin_dashboard_ops.sql` (NEW — run in Supabase):**
adds `users.stripe_customer_id / stripe_subscription_id / subscription_status /
subscription_plan / stripe_synced_at / stripe_sync_error`; extends `audit_logs`
with `actor / target_user / before / after / reason`; creates `stripe_events`
(unique on `stripe_event_id` → idempotent + retryable), `admin_notes`,
`flagged_responses`. RLS-enabled (default-deny; API uses direct PG, bypasses).

**Stripe two-way sync (`services/api/src/services/stripe.service.ts`):**
`syncSubscriptionToDb` (mirror live status/plan/`is_paid`/`is_pro`; no-customer
→ leaves `is_paid` untouched; error → `stripe_sync_error`, never throws),
`reactivateSubscription`, `changePlan(base|pro)`, `handleStripeWebhookEvent`
(created/updated/deleted + invoice failed/succeeded; resolves user by
`stripe_customer_id` then customer.metadata.phone, backfilling the id),
`recordStripeEvent`, `constructWebhookEvent`. New v2 webhook
`POST /webhook/stripe` (`services/api/src/routes/stripe-webhook.ts`) —
registered ONLY when `STRIPE_WEBHOOK_SECRET` set; encapsulated Fastify scope
with a raw-buffer JSON parser for signature verification; records every event.
The v1 Supabase `stripe-webhook` edge fn is still live — v2 is additive +
idempotent; cut Stripe over to one endpoint and retire v1 once verified.

**New admin endpoints (`routes/admin.ts`):** `POST /admin/users/:phone/stripe/{sync,reactivate,change-plan}`,
`GET /admin/stripe/events`, `POST /admin/stripe/events/:id/retry`,
`POST /admin/users/:phone/send-message` (real WhatsApp send + persists turn as
`intent:'admin_manual'`), `POST /admin/users/:phone/{pause,resume}`,
`GET/POST /admin/users/:phone/notes` + `DELETE /admin/notes/:id`,
`POST /admin/messages/:id/flag` + `GET /admin/flagged` + `PUT /admin/flagged/:id/resolve`,
`GET /admin/audit-logs`. `AdminDeps` gained `sender`, `memory`,
`stripeBasePriceId`, `stripeProPriceId` (wired in `server.ts`).

**Deep audit:** `auditLogFull()` helper + `actorOf(req)` (reads `X-Admin-Actor`
header, defaults `admin` — attribution without RBAC). `PUT /admin/users/:phone`
now records a before→after diff (PII decrypted) + `X-Admin-Reason`. Stripe
actions / manual send / pause-resume / notes / flags all audit. All audit/
notes/flags/event writes are best-effort (swallow missing table/column).

**Env (`config/env.ts`):** `STRIPE_WEBHOOK_SECRET` (optional), `STRIPE_BASE_PRICE_ID`
+ `STRIPE_PRO_PRICE_ID` (default to the test-account prices).

**Frontend:** `lib/api.ts` sends `X-Admin-Actor` (from `localStorage.grace_admin_actor`)
+ new `stripe.*`, `sendMessage`, `pauseUser/resumeUser`, `notes.*`, `flags.*`,
`auditLogs` calls + `getActor/setActor`. New page `pages/admin/AuditLogPage.tsx`
(Audit & Ops: Audit Log / Flagged / Stripe Events tabs, route `/admin/audit`,
nav entry added). `UserDrawer.tsx` gained Sync-from-Stripe / Reactivate /
Switch-plan buttons + last-sync/error line, a manual-message box, and an
internal-notes section.

**Tests:** `stripe.service.test.ts` (15, mocked Stripe SDK) +
`admin-ops.test.ts` (10, Fastify inject) — **713 api tests green**, api +
web typecheck clean, web build clean. Live Stripe/WhatsApp/deploy verification
deferred to the checklist in `docs/ADMIN_DASHBOARD.md` (no Stripe keys / live
sender / deploy in CI).

**Registration gate fix (same branch, 2026-06-13):** a deleted user could keep
using Grace — `ensureUser` re-INSERTs their row on the next inbound message
with `trial_start = NULL`, and `isAccessAllowed` treated `trial_start = NULL`
as "allow" (unlimited, never-expiring access), so they reappeared as Active and
chatted normally. Fixed in `routes/webhook.ts`: `isAccessAllowed` now returns
`false` for a null trial; new `needsRegistration(user)` (`!is_paid && !is_pro &&
!trial_start`) fires a sign-up message (`buildSignupUrl` → `/onboarding`, new
`register` template key w/ fallback) BEFORE the trial-expired paywall, then
returns. Effect: only web-onboarded (`trial_start` set by `POST /users/onboard`)
or paid/pro users get AI access; any unregistered number — brand-new OR
deleted — gets the sign-up prompt on its first message. Admin delete +
GDPR self-delete now also call `UserService.invalidate(phone)` (new public
method) so the deleted user isn't served from the 60s in-memory cache. Tests:
+5 in `webhook.test.ts` (gate matrix). 718 api tests green.

---

### Food-log fast-path bypassed the vague-food clarification gate (2026-06-13)

Production screenshot: "I had pizza" → "Logged pizza (2 slices), roughly 22g
protein. Running total: 22g." — an assumed portion the user never gave.

Root cause: `tryFoodLogFastResponse` (`services/api/src/services/food-log-fast.ts`)
runs EARLY in `handleMessage` (ai.service ~534), before the well-tested
`detectVagueFood` gate (ai.service ~1966). The common-food macro table
(`lookupCommonFoodMacros`) has bare-category defaults — `'pizza' → 'pizza
(2 slices), 22g'` (log-food.ts:555) — so a bare vague food got fast-logged with
a fabricated portion, skipping the clarification ask entirely. The vague-food
system already existed and was correct; the fast path was the only bypass (other
paths — degraded/force-log, FAQ cache — sit after the 1966 gate).

Fix: `tryFoodLogFastResponse` now calls `detectVagueFood(trimmed)` and returns
null when vague, deferring to the full pipeline (which returns the "what exactly
did you have?" clarification). `detectVagueFood` returns vague=false the moment
a quantity/specific item is present, so "2 slices of pizza" / "a chicken
sandwich" still fast-log. Also added `'salad'` to `VAGUE_CATEGORIES`
(`safety/vague-food.ts`) — bare "salad" spans a 2g side to a 40g chicken-caesar;
"chicken salad" / "large salad" stay specific via the qualified/sized regexes.
Tests: +2 in `food-log-fast.test.ts`. 720 api tests green. NOTE: regression fix
to the EXISTING gate, not a new ask-always policy — the team deliberately avoids
over-asking, and multi-item meals still log deterministically (never-drop
hardening) rather than asking per-item.

---

### Vague-category expansion + prep-method clarification + multi-item formats (2026-06-13)

Follow-on to the fast-path fix above. All in `safety/vague-food.ts` (single
source of truth — `detectVagueFood` is called by both the food-log fast path
and the pipeline gate, so changes here cover both automatically).

- **Expanded `VAGUE_CATEGORIES`**: added `casserole, bowl, noodles, ramen,
  omelette, omelet, smoothie, milkshake, stew` (+ `salad` from the prior fix).
  Qualified forms stay specific: added `omelette|omelet|noodles|casserole|stew`
  to `QUALIFIED_CATEGORY_RE` ("cheese omelette", "chicken noodles", "beef stew")
  and to `SIZED_PORTION_RE`. Note: bare `bowl` is intentionally inconsistent —
  "rice bowl"/"poke bowl" → vague, but "a bowl"/"a bowl of X" reads as a
  quantity (bowl is a UNIT_WORD) → specific. `shake` was NOT added (would break
  "protein shake"); only `milkshake`.
- **Prep-method clarification** (`detectPrepNeeded`, folded into
  `detectVagueFood`): a bare prep-ambiguous protein/side (`chicken, fish,
  salmon, shrimp, prawns, tofu, pork, wings, eggplant, potato(es),
  cauliflower, tilapia, cod`) with NO prep word, NO sauce word, and NO quantity
  → asks "grilled, baked, or fried? any sauce or oil?" (calories swing ~2x).
  Tightly scoped to a SINGLE bare food: naming a cut ("chicken breast"), a dish,
  a quantity ("6 oz salmon"), prep ("grilled chicken", "mashed potatoes"), or
  listing multiple foods ("chicken and rice") all skip the ask and log normally.
  The prep question contains "calories" + "?" so the existing continuation gate
  (`lastWasFoodQuestion`) fires; `briefDetailMatchesFood` (ai.service ~2180)
  gained prep words (grilled/fried/baked/…/sauce/oil) so a one-word reply
  ("grilled") combines + logs. `PRIOR_ASK_RE` recognizes the prep ask for
  follow-up templating.
- **Multi-item formats**: `estimateMultiItemFood` already split on newlines,
  periods, commas, "and", and meal labels — verified with tests for the two
  requested formats: "for breakfast i ate eggs. for lunch chicken breast, rice
  and salad" → eggs+chicken breast+rice+salad = 49g; "rice\nchicken" → 2 items.
  No code change needed there; the splitter was already correct.

Tests: +34 (vague-food: expanded categories + prep matrix; log-food: the two
multi-item formats; food-log-fast from the prior fix). 754 api + 534 ai-core
green, typecheck clean. Still a regression/scoping change to the EXISTING
clarification gate — not an ask-always policy; multi-item + portioned + dish/cut
logs are untouched.

---

### Onboarded users locked out by the registration gate (2026-06-13)

Production: user completed web signup, got NO welcome, and still got the
"sign up here" prompt on every message. The registration gate (`needsRegistration`,
added earlier today) blocks any user with `!is_paid && !is_pro && !trial_start`.
The lockout means `trial_start` never landed for the webhook's phone.

Root cause (defensive fixes for both):
1. **Onboarding could roll back `trial_start`.** `POST /users/onboard` set the
   whole core profile — including newer columns like `starting_weight` — in ONE
   un-try/caught `users.update`. A single missing-migration column threw, rolling
   back the entire UPDATE (incl. `trial_start`), so the user was never registered.
   Fix: register FIRST with base-schema columns only (`await users.update(phone,
   { active: true, trial_start: new Date() })`) immediately after `ensureUser`,
   THEN best-effort the full profile inside try/catch. A missing column can no
   longer un-register anyone.
2. **The gate was too strict.** `needsRegistration` now also returns false when
   the user has onboarding profile data (`medication` set OR `goals` non-empty),
   so a user who onboarded but whose `trial_start` didn't land (legacy path /
   partial write) is treated as registered instead of locked out. A bare
   deleted/never-onboarded row (no medication, no goals) still gets the sign-up
   prompt. The paywall branch now only fires when `user.trial_start` is set (a
   trial actually started + expired) — a registered-but-null-trial user is no
   longer dumped into the paywall.

Immediate manual unblock (no deploy): admin dashboard → open the user → toggle
Paid, or "Reset trial" (sets trial_start) → access restored under current code.
Note: the missing welcome is partly Twilio-sandbox mechanics — outbound fails
until the user has sent `join <code>` and is inside the 24h session window.
Tests: +1 webhook gate case (onboarded-no-trial not locked out). 755 api green.

---

### Food-log continuation: clean reconstruction of clarification answers (2026-06-13)

Production: Grace asked "For the pizza, how many slices and what kind?", user
replied "2 slices", Grace responded "Two slices is a perfect amount…" — generic,
didn't log, broke the flow. The continuation gate (ai.service ~2171) DID fire
(`lastWasFoodQuestion` + brief reply), but it built the food arg as the messy
blob `"<entire 200-char question>: 2 slices"` and handed that to `log_food` —
which the LLM turned into chat instead of a log.

Fix: new `reconstructFoodFromClarification(lastGraceMsg, reply)` (exported from
`ai.service.ts`) pulls the food the clarification was about ("pizza" from "For
the pizza…", "chicken" from "How was the chicken prepared…") and joins it with
the answer into a CLEAN phrase — quantity answers get "of" ("2 slices" →
"2 slices of pizza"), prep/other answers prefix ("grilled" → "grilled chicken").
The continuation block then (1) tries `tryFoodLogFastResponse` on the clean
phrase and, when it resolves in the macro table, returns a DETERMINISTIC log
confirmation immediately (no LLM detour) with `intent:'food_log_continuation'` +
persisted turns; (2) otherwise sets the orchestrator force-log to the clean
phrase (not the blob). Brand replies ("what did you have at KFC?" → "3 tenders")
return null from the reconstructor and keep the existing path (the reply is
already specific). Tests: +4 reconstruct cases (`ai.service.test.ts`). 764 api
green.

---

### Health-concern guard: stop logging out-of-scope vitals questions (2026-06-13)

Production: "I'm having blood pressure problems what should I do" → Grace replied
"Logged." A health concern + guidance request got routed into a logging
workflow. Earlier "How about my blood pressure?" got a generic GLP-1 education
blurb instead of recognizing the user was asking about THEMSELVES.

Fix: new `services/api/src/safety/health-concern.ts` — `detectHealthConcern(text,
lastGraceMessage?)` flags PERSONAL concern / guidance phrasing ("my bp", "I'm
having…", "what should I do") about out-of-scope cardiovascular vitals (blood
pressure / heart rate / pulse / palpitations / cholesterol; blood sugar
deliberately excluded — GLP-1-relevant). Wired into `ai.service.handleMessageInner`
right after the vague-food guard and BEFORE the FAQ cache + force-log, returning
a supportive, clarifying, scope-aware referral and short-circuiting so it can
NEVER be logged or answered with generic education. Pure education ("does GLP-1
affect blood pressure?") does NOT fire — it flows to the educational pipeline.
Follow-up aware: once we've asked, a vital-less reply ("high readings") recovers
the vital from our prior question and gives a refer-focused answer instead of
re-asking. Crisis/emergency stays with the SafetyGuard (runs earlier). Tests:
`health-concern.test.ts` (8). 771 api green.

Note (deferred): the broader "mandatory relevance validation on every response"
(user ask) is partially served by the existing LLM relevance-check
(`packages/ai-core/src/relevance-check.ts`), which is gated by
`RELEVANCE_CHECK_ENABLED` / disabled under `TRUST_GEMINI`. This guard adds
deterministic coverage for the reported failure class without re-enabling the
LLM judge.

---

### Global response-validation gap + scope referrals (2026-06-13)

Reframing the BP failure as a CORE conversation-engine issue, not a topic patch.
The "response validation layer" the spec describes already exists and is ON by
default: `RELEVANCE_CHECK_ENABLED` / `BEHAVIORAL_GUARD_ENABLED` /
`QUALITY_GUARD_STRICT` all default TRUE, `TRUST_GEMINI` defaults FALSE
(`config/env.ts`). The relevance check (`relevance-check.ts`) regenerates any
response that doesn't address the user's latest message.

The gap was its skip rule. `orchestrator.ts` treated ANY response < 40 chars as
`isTrivial` and skipped the relevance/behavioral judges — so a bare "Logged." to
"what should I do about my blood pressure?" was never validated. Fix: a short
response is only trivial-skip when the user's message is NOT a question
(`validated.text.length < 40 && !looksLikeQuestion`). Now a suspiciously short
reply to a real question is validated + regenerated, globally, for every
non-food intent. Food/log intents remain in `RELEVANCE_SKIP_INTENTS` (the
2026-06-04 carve-out that fixed clearly-on-topic dinner responses being flagged
"not relevant" — deliberately kept).

Scope handling made global with professional referrals (`safety/scope-guard.ts`):
legal → "one for a lawyer", finance → "a financial advisor is the right person",
instead of a flat "not my area". Combined with the medical health-concern guard
(refers to doctor) and the existing politics/war/tech/meta categories, every
out-of-scope domain now acknowledges + refers appropriately. Tests: +2 scope
referral cases. 534 ai-core + 773 api green.

Deferred (not a clearly-observed failure, and risks misrouting legit flows):
an account/billing "contact support" referral category; removing the food
relevance carve-out. The conversation pipeline now is: classify intent →
deterministic routing (scope / health-concern / vague-food / continuation) →
generate → validate (content + grounding + relevance + behavioral + quality) →
regen on failure.

---

### Complete questions treated as incomplete + general fallback gap (2026-06-13)

Production: "is it possible that i feel that my muscles get smaller?" → Grace
replied "What's the rest of that?" — a complete question treated as truncated.

Root cause (NOT classification — `classifyMessage` correctly returns `knowledge`
for it): the topic-specific knowledge answers in `getToolAwareFallback`
(`orchestrator.ts`, muscle / water / alcohol / sleep / hair / plateau / protein)
were gated on `type === 'knowledge'`. When a health question lands in `general`
(classifier near-miss, or a generation failure that resolved to the general
fallback), ALL those helpful branches were skipped → straight to the
`TYPED_FALLBACKS.general` clarification pool, which included "What's the rest of
that?" (reads as "you didn't finish your sentence").

Fixes (`packages/ai-core/src/orchestrator.ts`):
1. The topic-answer block now runs for `type === 'knowledge' || 'general'`. Each
   branch only RETURNS on a topic-keyword match, so non-health general messages
   fall through untouched — but a health question that landed in general now
   gets the real answer (verified: water/alcohol/muscle under `general`).
2. Muscle fallback verb set broadened beyond affect/loss to include perception/
   shrinkage phrasing: `smaller|shrink\w*|weaker|wasting|atrophy|thinner|…` so
   "muscles get smaller" matches.
3. `TYPED_FALLBACKS.general` reworded to never imply truncation ("What's the
   rest of that?" removed) — these fire on genuinely unclassifiable messages,
   not incomplete ones.

Tests: +3 in `orchestrator.test.ts` (muscle question under both intents, health
topics under general, no-truncation phrasing). 537 ai-core + 773 api green.

---

### Comprehensive, typo-tolerant GLP-1 knowledge bank (2026-06-13)

New `packages/ai-core/src/glp1-knowledge.ts` — `answerGlp1Topic(msg)` +
`matchGlp1Topic` + `normalizeKnowledgeText`. A single ordered topic table
(~40 topics, specific→generic) covering: nausea / nausea duration / vomiting /
constipation / diarrhea / heartburn / bloating-gas / stomach pain / fatigue /
dizziness / headache / brain fog / hair loss / muscle / Ozempic-face-skin /
food-noise-appetite / appetite-return / missed dose / dose increase / injection
site / injection timing / storage-travel / mechanism / how-long-take /
weight-regain / expected-loss / alcohol / caffeine / blood sugar / gallbladder /
pregnancy (redirect) / birth control / fiber / electrolytes / water / sleep /
exercise / plateau / protein target.

Typo tolerance: `normalizeKnowledgeText` collapses 3+ repeated letters and
applies a GLP-1 misspelling map (nausia→nausea, diarhea→diarrhea, constipaton,
muscels→muscles, protien→protein, hartburn, bloted, etc.) before matching, and
topic regexes include common variants. Verified: "im so naus", "how do i deal
with constipaton", "is hair loose commn on glp" all resolve.

Wired as the PRIMARY deterministic answer source in BOTH fallback paths
(de-duplicating them): `orchestrator.getToolAwareFallback` (knowledge||general
block, before the legacy inline branches) and `ai.service.pickKnowledgeTopicFallback`
(before its legacy checks). This is the degraded-mode floor — the live primary
path is still Gemini + RAG; the bank guarantees accurate answers to common
questions when Gemini is down. Each topic regex requires a health keyword, so
non-health messages return null and fall through untouched.

Safety: missed-dose answer warns "don't double up" (never advises doubling);
pregnancy/birth-control defer to the clinician; severe/red-flag symptoms route
to the doctor. The orchestrator critic-failure test was tightened from a blunt
`not.toContain('double')` to forbid the DANGEROUS advice ("take an extra/double
the dose") while allowing the curated safe missed-dose guidance.

Tests: `glp1-knowledge.test.ts` (53 — coverage + typos + non-health null +
safety). 590 ai-core + 773 api green. Follow-up: the legacy inline topic
branches in both paths are now mostly shadowed by the bank — safe to delete in a
later cleanup once the bank is confirmed in prod.

---

### Every knowledge question routed to the reasoning path; no generic fallback for questions (2026-06-13)

Production: "Is it possible that I feel that my hair is shorter?" → "I'm with
you. What can I help with right now?" — a clear question got a generic fallback.

This is an ENGINE-LAYER fix (not a hair patch), applying to every knowledge
question:
1. **`classify.ts`** — final catch-all: a substantive question (>= 8 chars,
   ending in `?` OR starting with is/are/can/could/would/should/will/does/do/
   did/why/how/what/when/where/which/who) now classifies as `knowledge`, not
   `general`. By that point food/medication/scheduling/pause/symptom questions
   are already routed, so a remaining question is a genuine info request → it
   gets the knowledge path (strongest reasoning budget + always-on relevance
   check + the knowledge bank). Bare one-word follow-ups ("Why") stay `general`
   (length gate) for the reasoning/continuation handlers.
2. **`orchestrator.getToolAwareFallback`** — final safety net: if the message is
   a question (`?` or interrogative start) and nothing else matched, it returns
   an honest, on-topic answer ("changes on a GLP-1 trace back to the weight loss
   itself…, share what you're noticing, anything off → your doctor") instead of
   a generic "I'm with you / tell me more" clarification. So a question can never
   resolve to a generic engagement prompt, regardless of topic.
3. **Hair topic broadened** (`glp1-knowledge.ts`) beyond loss to appearance
   changes (shorter/thinner/different/texture/volume/dry/brittle), with an
   answer that addresses "feels shorter".

Net: ANY genuine question is routed to the knowledge/reasoning path and answered
(by Gemini when available; by the comprehensive bank or the honest
question-aware fallback when degraded) — never a generic clarification. Tests:
+ hair-appearance cases, + classify question-routing, + question-aware fallback
(and caught my own fallback using the banned "tell me a bit more" phrasing).
594 ai-core + 773 api green.

---

### Food recommendations ignored the signup diet (read wrong field) (2026-06-13)

Production: a vegan who set it at signup still got salmon/chicken dinner recs.

Root cause: onboarding stores the diet in `users.dietary_restriction` (free
text, `routes/users.ts:218`), but EVERY food-recommendation path read only
`user.dietary_pattern` (the vegan/vegetarian/pescatarian ENUM, which signup
never sets) → `buildRestrictionFromLabel(null)` → no filtering. The main
orchestrator prompt (`buildPersonalisedPrompt`) DID inject `dietary_restriction`
+ a top banner, so the Gemini path respected it; the FOOD-QUESTION DIRECT path
(the fast path for "dinner ideas") + the resilient fallback + the FAQ-cache
diet check all bypassed it by reading only `dietary_pattern`.

Fixes (`services/api/src/services/ai.service.ts`):
1. New `effectiveDietaryRestriction(user)` — derives the restriction from
   `dietary_pattern` ?? `dietary_restriction`. All food paths now use it
   (handleFoodQuestionDirect, buildResilientFallback, the direct-path USER
   PROFILE block, and the FAQ-cache safety check).
2. `buildRestrictionFromLabel` extended beyond vegan/vegetarian/pescatarian to
   kosher / halal / gluten-free (celiac/coeliac) / dairy-free (lactose), with
   forbidden lists for each, and separator/synonym normalization
   ("gluten-free"/"gluten_free"/"gluten free"/"plant-based").
3. `DietaryRestriction.label` union widened (`packages/shared/src/ai.ts`) +
   `DietaryRestrictionLite` in `orchestrator.ts` to match.

Allergies / avoided ingredients already flow through `food_dislikes` (prompt +
`buildForbiddenSet` post-gen filter) — unchanged. NOTE: deferred mapping signup
`dietary_restriction` → the `dietary_pattern` enum at onboard (the effective
helper reads the free-text directly, so not required). Tests:
`dietary-restriction.test.ts` (7). 594 ai-core + 780 api green.

---

### Dietary end-to-end: signup → enum → admin visibility/edit (2026-06-13)

Completes the dietary chain so it works perfectly end-to-end:
- **Signup form** already collects + sends `dietaryRestriction` (`Onboarding.tsx`
  → FoodStep). Confirmed.
- **Onboard now also populates the `dietary_pattern` ENUM** when the signup diet
  is vegan/vegetarian/pescatarian (best-effort), so every path that reads the
  enum (admin, chat-detection persistence) sees it — not just the
  `effectiveDietaryRestriction()` free-text reader (`routes/users.ts`).
- **Admin detail** (`GET /admin/users/:phone`) now returns `dietary_pattern` +
  `calorie_goal_kcal` (were missing from the SELECT; `dietary_restriction` was
  already there).
- **UserDrawer** gained a Diet dropdown (none/vegan/vegetarian/pescatarian →
  `dietary_pattern`), an "Other diet" free-text (`dietary_restriction`, for
  kosher/halal/gluten-free/etc.), and a Calorie-goal field — all editable and
  saved via the existing `PUT /admin/users/:phone` (empty select → null so the
  Zod enum doesn't reject ''). Frontend `UserDetail` type extended.

Net chain: survey → stored (free-text + enum) → respected in every food rec via
`effectiveDietaryRestriction` → visible + editable in the admin drawer. api
typecheck + 780 tests green; web typecheck + build clean.

---

### Settings modification intent: "change my X" redirects, never reads (2026-06-13)

Production: "Change my protein goal" → "Your daily protein target is 114g" — a
MODIFY request answered as an INFO request, then a clarify loop.

Root cause: `settings-flow.ts` had no field for `protein_goal_grams` /
`calorie_goal_kcal`, and existing fields' update patterns required an explicit
"to <value>". So "change my protein goal" matched nothing → fell to the AI,
which force-called get_user_profile and read the value.

Fix: a GENERAL settings-modification detector at the TOP of `tryHandleSettings`
(before the READ loop): `MODIFY_VERB_RE` (change/update/edit/modify/adjust/set/
lower/raise/increase/decrease/reduce/fix/correct/switch/reset/customize) +
`SETTINGS_FIELD_RE` (protein goal/target, calorie goal, goal/current/starting
weight, height, age, sex, name, timezone, wake/sleep time, medication, dose,
primary goal, my goals, my diet/dietary, food dislikes/preferences/restrictions,
reminders, check-ins, my profile/settings, preferences) → returns
`PROFILE_REDIRECT`. Distinguishes ACTION from INFO so a change request is never
answered with the current value. Field nouns are SETTING phrasings ("protein
goal", not bare "protein"), so nutrition questions ("how do I increase my
protein intake") are untouched. Injection-day excluded (its own in-chat
handler); check-in frequency handled earlier in the webhook (REMINDER_REDIRECT).
Resolves the action-vs-info, repeated-clarification-loop, and
non-deterministic-flow failures in one deterministic gate. Applies to ALL
settings/survey fields, not just protein. Tests: +12 in `settings-flow.test.ts`.
792 api tests green.

**Cross-turn follow-up (same day):** a bare settings-field reply ("protein
goal", "my goal weight") to a PRIOR settings clarification now inherits the
modify intent → redirect, instead of being read back. `settings-flow.ts` exports
`isBareSettingsFieldReply` (cheap regex: names a field, no modify verb, not a
read question) + `wasSettingsClarification(lastGraceMessage)` (Grace asked
"which setting?") + `tryHandleSettingsFollowUp(text, lastGraceMessage)`. Wired in
`webhook.ts` right after `tryHandleSettings`: the cheap gate fires first, and
only then does it fetch the prior Grace message (`deps.ai.getRecentTurnsForUser`)
— so the extra read only happens for the rare bare-field follow-up. Resolves the
context-inheritance + repeated-clarification-loop points (#3/#4). +4 tests; 796
api green.

---

### Terse "How 32" reasoning challenges explain the number, not switch topics (2026-06-13)

Production: user logged food, Grace said "32g protein", user asked "How 32"
(= how did you get 32g?) → Grace replied with a GLP-1 side-effects/hair/appetite
lecture. Two failures:
1. `detectReasoningRequest` (`orchestrator.ts`) missed terse challenges: its
   `REASONING_TRIGGERS_RE` "how" branch requires "how did you calculate/get…",
   and the shared trailing `\b` rejects alternatives ending in '?' or a unit. So
   "How 32" / "how 32g?" / bare "how"/"how?" weren't detected as reasoning →
   fell to the question-aware general fallback (the GLP-1 framing added earlier).
   Fix: explicit terse checks in `detectReasoningRequest` — `^how\s*\??$` (bare)
   and `^(?:how|why|where)\b[^?]*?\d` (number challenge) — still gated by
   `PRIOR_REASONING_ANCHOR_RE` (prior Grace msg must contain a number/target).
2. The reasoning fallback was weight/goal-specific. Now it's topic-aware: if the
   prior message was about protein (or has a `\d+g`) → explains the protein
   estimate ("that 32g is added up from the foods you logged… tell me serving
   sizes and I'll tighten it"); calories → calorie version; weight/goal → the
   weight math; else a generic "want me to walk you through it?". Transparent
   (it's an estimate) + offers to refine with portions, never switches topics.

The live path (Gemini up) already had history to explain; this fixes the
degraded/fallback path AND the routing (so a number-challenge is treated as
reasoning, never the generic fallback). +1 test (`orchestrator.test.ts`). 595
ai-core + 796 api green.

---

### Settings links use the deployment URL, not hardcoded graceglp.com (2026-06-13)

`settings-flow.ts` hardcoded `https://graceglp.com/settings` in every redirect/
read response; the webhook's `REMINDER_REDIRECT_REPLY` did the same. On the
sandbox/Vercel deployment those links don't resolve. Now they use the running
deployment's `PUBLIC_WEB_URL`:
- `settings-flow.ts`: `resolveSettingsUrl(webUrl)` → `<webUrl>/settings`;
  `profileRedirect(settingsUrl)` builds the redirect; `SettingsHandlerDeps`
  gains `webUrl`. `tryHandleSettings` computes the URL once and uses it for all
  redirects + read responses; `tryHandleSettingsFollowUp(text, last, webUrl)`.
  Falls back to the `graceglp.com` default when `webUrl` is absent (so the unit
  tests, which pass no webUrl, are unchanged).
- `webhook.ts`: passes `deps.env.PUBLIC_WEB_URL` into both settings calls;
  `REMINDER_REDIRECT_REPLY` const → `buildReminderRedirectReply(webUrl)`.

Note: the LLM system prompt (`prompts.ts`) and a few orchestrator fallback
strings still mention `graceglp.com/settings` — those are static prompt text the
model echoes, not the deterministic settings-flow redirects; left for a separate
pass. Tests: +2 in `settings-flow.test.ts` (webUrl honored / default fallback).
798 api green.

---

### Self-serve Settings page on the v2 API (phone + code verification) (2026-06-13)

Rebuilt the Settings page so it no longer depends on the Supabase edge functions
+ the unset `VITE_SUPABASE_*` Vercel env vars (which made the settings LINK error
when pressed). Now fully on the v2 API under the Vercel domain.

**Backend — `services/api/src/routes/settings.ts`** (registered in server.ts with
`{ redis, sender, users, whatsappEnabled: !!env.TWILIO_WHATSAPP_FROM }`):
- `POST /settings/request-code` { phone } → normalize, look up user; if
  registered, generate a 6-digit code (Redis `settings:code:{phone}`, 10-min
  TTL) and send via WhatsApp (or SMS). Enumeration-guarded (always returns
  `{ok,sent}`, only sends for a real account). Rate-limited 5/10min.
- `POST /settings/verify-code` { phone, code } → checks code + attempt counter
  (lockout after 5), issues an opaque Redis session token (`settings:session:
  {token}`, 30-min sliding TTL), returns `{ token, profile }`.
- `GET /settings/me` (Bearer token) → profile.
- `PUT /settings/me` (Bearer token) → updates the user-editable subset only
  (no is_paid/is_pro/blocked/trial_start/paused). `UserService.update` encrypts
  PII + invalidates the user cache so changes take effect on the next message.
  Bulk update falls back to field-by-field on a missing-migration column.
- Tests: `settings.test.ts` (8 — code send/enumeration, verify + lockout,
  session gate, update). 806 api green.

**Frontend** — `apps/web/src/lib/settingsApi.ts` (user-facing fetch client, NO
admin token, token in sessionStorage `grace_settings_token`) + rewritten
`pages/Settings.tsx`: 3 stages (phone → 6-digit code → full profile form),
resumes an existing session on load, edits every profile field (about you /
medication / body & goals / diet / check-ins) grouped, saves via PUT. Uses
`VITE_API_URL` (already set on Vercel). web typecheck + build clean.

Note: code delivery uses WhatsApp when `TWILIO_WHATSAPP_FROM` is set (sandbox
requires the user to have joined; real users need the approved WhatsApp sender
or SMS). A user must be registered (onboarded) to receive a code.

---

### Every outbound message rewrites graceglp.com → the deployment URL (2026-06-13)

The deterministic settings-flow redirects already use `PUBLIC_WEB_URL`, but
Gemini-generated responses still echo `graceglp.com/settings` from the system
prompt (`prompts.ts`) + a few orchestrator fallback strings, so some settings
replies showed the wrong (non-resolving) link. Rather than thread a URL through
the 2,500-line prompt, the guaranteed fix is at the OUTBOUND layer:
`twilio/sender.ts` `rewriteCanonicalLinks(text, webUrl)` rewrites any
`graceglp.com` host (protocol'd, www, or bare) to the deployment host while
preserving the path (`/settings`, `/upgrade?phone=…`). Applied to EVERY outbound
in `TwilioSender.send()` — raw + sanitized — so links from the LLM, the system
prompt, fallbacks, or the DB-active prompt all resolve. `TwilioSenderConfig`
gains `canonicalWebUrl` (wired from `env.PUBLIC_WEB_URL` in server.ts). No-op
when the deployment IS graceglp.com (set `PUBLIC_WEB_URL=https://graceglp.com`
once that domain is live and links follow automatically). Tests: +5 in
`sender.test.ts`. 811 api green.

---

### Outbound sanitizer was truncating trailing URLs → broken settings link (2026-06-13)

Production: the WhatsApp settings link arrived as `https://grace-admin-silk.vercel`
— missing `.app/settings` — so Safari said "server can't be found." (Also
diagnosed + fixed an unrelated Vercel issue: the project had Deployment
Protection / "Require Log In" ON, 403-ing the public; that's a dashboard toggle,
not code.)

Root cause: `sanitizeOutbound` (`twilio/sender.ts`) mid-sentence-truncation
repair. A message ending in a URL doesn't end in terminal punctuation, so it was
flagged `endsMidWord=true`, then trimmed to the last `.` — which is the dot in
`vercel.app` — chopping the link to `…vercel.`. Every settings/upgrade message
(which always ends with a URL) was mangled.

Fix: compute `endsWithUrl` (`https?://\S+$` OR a bare `host.tld[/path]$` for
com/app/io/org/net/co/dev/ai/me/health/care) and skip the truncation repair when
true — a message ending in a URL is complete. Genuine mid-word truncation (no
URL) still repairs. Tests: +4 in `sender.test.ts` (full link preserved, link +
trailing period, bare-domain link, real truncation still trimmed). 815 api green.

---

### Reasoning-about-a-number intercept ("How 88g") — deterministic, never rambles (2026-06-13)

Production: after "What I ate today?" → "Eggs ×2, pizza ×2, salmon, rice. That's
88g protein…", the user asked "How 88g" / "How 88 g of protein". Grace replied
with (a) the generic GLP-1 "changes on a GLP-1…" fallback and (b) a confused
Gemini ramble that re-asked what they ate (already told). The #53 reasoning fix
only covered the orchestrator FALLBACK path — the degraded resilient-fallback
(`buildResilientFallback`, common on free-tier quota) didn't pass
`isReasoningRequest`, and a bad-but-non-empty Gemini generation bypassed the
fallback entirely.

Fix: a deterministic reasoning intercept in `ai.service.handleMessageInner`
(right after the health-concern guard, BEFORE the FAQ cache / force-log /
orchestrator): when `detectReasoningRequest(input.text, lastGraceMessage)` is
true — gated on the prior Grace turn containing a number/target, so it only
fires when there's a number to explain — it returns the topic-aware
`getToolAwareFallback(..., { isReasoningRequest: true })` explanation
("that 88g is added up from the foods you logged… tell me serving sizes and
I'll tighten it") and short-circuits. Covers "How 88g", "How 88 g of protein",
"why 32", bare "how?", in both live and degraded modes — never a generic or
confused answer. Trade-off (accepted for reliability): a reasoning challenge no
longer reaches Gemini for a richer per-item breakdown; the deterministic
explanation is on-topic + offers to refine with portions. 815 api green.

---

### Meal lifecycle: interest ≠ consumption — preference language never logs (2026-06-15)

Branch `claude/meal-lifecycle-states-7ayf7w`. Production bug: after Grace
recommended a meal, "Halloumi and roasted vegetable plate sounds good" (INTEREST)
was logged as if eaten — inflating protein/calorie totals for a meal the user
never had. Root cause: no explicit meal lifecycle (suggested → consumed); the
old `meal_selection` guard fired too late (after the food-log fast path) and only
when a recommendation was found in history, so a missed recommendation let the
message reach Gemini, which called `log_food`.

**New deterministic lifecycle (single source of truth):**
- **`services/api/src/services/meal-lifecycle.ts`** — `detectMealConsumption(text)`
  → `'consumed' | 'preference' | 'neither'`. Consumption checked FIRST so
  "I ended up eating the dal that sounded good" → consumed. `CONSUMPTION_RE`
  (I ate/had, just finished, for <meal> I had, ended up having/making, "log/track/
  add it" imperative) with a negation void ("didn't eat", "haven't had yet").
  `PREFERENCE_RE` (sounds/looks good, I like that, maybe, I'll have/make/go with,
  I think I'll have, I might make it, planning to eat, considering it, that works,
  going with, the X one). Plus `mentionsFood()` (broad dish vocabulary) and
  `isBareConsumptionBackReference()` ("I ended up making it" / "had it").
- **`services/api/src/services/meal-recommendation-store.ts`** — Redis-backed
  active suggestion (`meal:rec:{phone}`, 5h TTL, status `suggested`). Set on
  selection, overwritten on new pick, cleared after logging. Redis-optional
  (no-ops + never throws when absent). Enables "I ended up making it" to log
  without repeating the dish.

**Wiring (`services/api/src/services/ai.service.ts`):**
- Early guard BEFORE every logging path (fast-log / weight / classify / force-log
  / orchestrator): `detectMealConsumption === 'preference'` (≤12 words, no `?`,
  AND real food context — names a food OR Grace's last turn was a food
  recommendation, so a bare "that sounds good" to a non-food offer isn't
  hijacked) → returns a non-logging, goal-aware `meal_suggested` reply via
  `buildMealSuggestionReply` ("…solid pick, ~Xg protein… Let me know once you've
  had it and I'll log it.") and stores the dish. `=== 'consumed'` + bare
  back-reference → `tryLogStoredMeal` logs the stored meal deterministically +
  clears it; otherwise clears the stale suggestion and falls through.
- The old `meal_selection` block (which required a detected recommendation) was
  removed/subsumed. Defense-in-depth: `shouldForceLogFood` gained
  `!isMealPreference`.
- **`packages/ai-core/src/prompts.ts`** — new "MEAL LIFECYCLE — INTEREST IS NOT
  CONSUMPTION" rule covers the LLM path for longer preference messages that
  bypass the 12-word cap (lists never-log preference phrases vs. only-log
  consumption phrases, with the exact production failure as a ✗/✓ pair).

Tests: `meal-lifecycle.test.ts` (54) + `meal-recommendation-store.test.ts` (5).
1009 api + 614 ai-core green; typecheck clean across all packages.

---

### Reminders: Grace is the interface, never denies capability (2026-06-15)

Branch `claude/meal-lifecycle-states-7ayf7w`. Production bug: user asked "When is
my next reminder?" (Grace implied reminders exist) then "Would you send a reminder
tomorrow morning?" → Grace replied **"I can't send reminders … I don't have the
ability to initiate messages at a future time."** Two contradictions: (1) it
exposed an LLM/architecture limitation, and (2) it denied the core product (Grace
DOES send scheduled reminders).

Root cause: reminder-status questions had NO deterministic handler — they fell
through to Gemini, which faced **contradictory prompt rules**: one section said
"echo the pre-computed Next scheduled reminder," another said "Grace has zero
visibility into the proactive scheduler … NEVER state a future reminder time …
banned absolutely." The model resolved the conflict by denying capability.

**Fix — deterministic reminder service + ownership model:**
- **`services/api/src/services/reminder-service.ts`** (NEW, pure/testable) — the
  source of truth for ANSWERING reminder questions. `computeReminderSchedule(user,
  now)` mirrors the scheduler math (morning = `wake_time`; evening = `sleep_time −
  EVENING_LEAD_MIN`; midday Mon/Wed/Fri; injection day REPLACES the regular
  schedule; quiet hours 21:00–07:00; `checkin_days_interval` walked forward to the
  next eligible day; `paused` = disabled). Times are computed DYNAMICALLY from
  wake/sleep settings via named offset constants (`MORNING_OFFSET_MIN`,
  `EVENING_LEAD_MIN`) — never hardcoded 12pm/6pm. `detectReminderIntent(text)` →
  `next | explain | change | null`. Reply builders explain the schedule + redirect
  to Settings; the change builder ("I can't customize reminder times through chat,
  but you can set them in Settings…") never exposes a limitation.
- **`services/api/src/services/ai.service.ts`** — early deterministic intercept in
  `handleMessage` (before the orchestrator): a reminder-intent message is answered
  from the user's real config (`getByPhone` → reminder-service), short-circuiting
  so it NEVER reaches Gemini. `change` → Settings redirect; `next`/`explain` →
  computed answer. Settings URL uses `graceglp.com/settings` (rewritten to the
  deployment host by `TwilioSender`). Verified the webhook's earlier short-circuits
  (`isFrequencyChangeRequest`, `isSettingsKeyword` anchored, settings-flow READ
  patterns anchored) do NOT pre-empt status/explain/change questions.
- **`packages/ai-core/src/prompts.ts`** — reconciled the contradiction: the
  "zero visibility / NEVER state a future reminder time / banned absolutely" rule
  became "use the pre-computed Next scheduled reminder field; never INVENT a
  different time." New **"REMINDERS — GRACE IS THE INTERFACE, NEVER EXPOSES
  LIMITATIONS"** section with the BANNED capability-denial phrases ("I can't send
  reminders", "I don't have the ability to…", "unable to initiate messages",
  "I don't have access…") and explain-then-redirect examples.
- **`packages/ai-core/src/content-checker.ts`** — backstop: 5 capability-denial
  regexes added to `BANNED_PHRASES` (regen severity) so the phrasing can never
  ship even if the LLM emits it.

**Ownership model (per spec):** Settings own configuration; the scheduler owns
delivery; Grace owns explanation only. Grace can tell when reminders fire, explain
behavior/limits, and redirect to Settings — she cannot create/edit/disable
reminders or promise a custom one-off in chat. The scheduler already implements
the delivery rules correctly (morning at wake, evening before sleep, ≤ cadence/day,
injection-day flow, quiet hours) — verified, no changes needed. Note:
`reminders_enabled`/`morning_reminder`/`evening_reminder` columns don't exist;
`paused` is the existing enable/disable toggle and the reminder service uses it.

Tests: `reminder-service.test.ts` (18 — intent detection, schedule math incl.
injection day / paused / every-other-day, and reply builders asserting no
capability denial). 1026 api + 614 ai-core green; typecheck clean.

---

### Per-user food logging day = wake_time (verified end-to-end) (2026-06-15)

Branch `claude/meal-lifecycle-states-7ayf7w`. Requirement: food/protein/calorie
totals must reset on each user's PERSONAL day (starts at their `wake_time`), not
the calendar day or a fixed reset. The window itself was already implemented in
`services/api/src/nutrition/logging-window.ts` (`USER_DAY_CTE` / `userDayExpr` /
`isCurrentUserDay` SQL helpers + `computeUserLoggingDay` JS twin; default
`07:00`; a row's logging day = its local timestamp shifted back by wake_time,
taken as a date). This session was a **full audit + verification** that it's
applied everywhere, plus one consistency fix.

**Verified on the wake window (no change needed):** `getTodaysFoodSummary` +
`getDailyProteinHistory` (user.service — the source for nearly everything),
the L2 Redis cache key (`today-food-cache` → `computeUserLoggingDay` with
wake_time), `log-food` running total, `remove-food` (all 3 queries),
`food-log-fast`, water log, admin `/admin/users/:phone/food-logs` (uses
`userDayExpr`/`isCurrentUserDay`), `get-food-summary` tool, `query-fast`
(protein/calorie today + remaining renderers), the ai.service context lines
("Total protein/calories TODAY", "Foods logged today"), and the scheduler
reminder/progress messages (`scheduler.ts` → `getDailyProteinHistory` for
morning, `getTodaysFoodSummary` for evening). All food/protein/calorie "today"
reads route through these — so a Settings wake-time change re-buckets totals
dynamically (no rows move), and a pre-wake 2 AM snack counts toward the prior
logging day across DB + cache identically.

**Out of scope (correctly NOT a per-day window):** the anomaly detector's
rolling multi-day `food_logs` counts (`now() - interval '3/10 days'`), the
`persistEstimatedFood` 2-minute dedupe (a relative window — timezone-independent
by construction), and the admin `messages/feedback/tool_logs` 30-day analytics
(`DATE_TRUNC('day', …)` — global charting, not a user's food day).

**Fixed (the one inconsistency):** `ai.service.countTodaysCheckIns` used a
calendar-day boundary (`(created_at AT TIME ZONE tz)::date = …`), so "check-ins
today" could disagree with "food today" at the pre-wake boundary. Now uses
`USER_DAY_CTE` + `isCurrentUserDay('created_at')` — same window as food. (In
practice they rarely differed because quiet hours block proactive sends before
07:00, but "today" is now a single consistent concept system-wide.)

Tests: `logging-window.test.ts` extended with the spec scenarios — 7 AM example
(8 AM = today, 2 AM = prior day, 23:30 = same day), custom/late wake, wake-time
change re-buckets the same timestamp, missing wake → 07:00 default, non-UTC tz.
1031 api + 614 ai-core green; typecheck clean.

---

### Conversational continuity for small talk + leading-punctuation fix (2026-06-16)

Branch `claude/meal-lifecycle-states-7ayf7w`. Production: Grace asked "anything
specific making you feel that way?", user replied "just having good day", Grace
replied ", what would you like to dig into?" — ignored the answer, switched
topics, sounded robotic, and had a leading-comma formatting bug. Fixed as GENERAL
mechanisms (per the report's "comprehensive, not specific to this one"), not a
one-off:

1. **Leading orphan-punctuation strip (ALL outbound)** —
   `twilio/sender.ts sanitizeOutbound` now strips leading whitespace +
   punctuation (`, ; : . ! ? ) ] } – —`) and re-capitalizes, as the final guard
   before every send. Upstream edits (first-name stripping → "<name>, what…",
   greeting-prefix removal, em-dash→comma) could leave a reply starting with
   orphaned punctuation; this fixes the entire class from any source. A leading
   emoji is preserved; an all-punctuation body is left unchanged (never emptied).
2. **Comprehensive small-talk fast-path** (`services/api/src/services/fast-path.ts`)
   — short rapport replies now get a warm continuation instead of degrading to a
   generic fallback or a forced health pivot. `GOOD_DAY_RE` ("good day", "had a
   good week", "just having a good day"), `POSITIVE_STATE_RE` ("all good",
   "doing fine", "can't complain", "not bad") → `brief_positive`; new
   `SMALL_TALK_RE` ("not much", "same old", "just chilling", "keeping busy") →
   new `small_talk` category with acks that leave a soft door and NEVER mention
   food/protein/symptoms. `GOOD_DAY_RE` is added as a `NEVER_FAST_PATH_RE`
   exception (it trips the "had" food guard but names a day/week, never a food;
   a real "had a good lunch/breakfast" doesn't match and stays blocked). Bare
   "same" stays excluded (ambiguous → full pipeline resolves it with history).
3. **Reworded the robotic `general` fallback** (`packages/ai-core/src/orchestrator.ts`)
   — removed "Happy to help — what would you like to dig into?" (topic-switching
   + its em-dash mangled into the leading comma). Replaced with warm, open
   continuations for the residual genuinely-unclassifiable cases.

Deliberately NOT done: the report's wholesale "dialogue state machine / give
Gemini more ownership / multi-stage reasoning" rewrite. The response-validation
layer it asks for already exists and is ON by default (relevance-check,
behavioral-guard, content-checker, quality-guard — they regenerate off-topic /
short responses), the pipeline already passes recent turns + reconstructs
follow-ups, and the team deliberately avoids brittle LLM judges
(`TRUST_GEMINI`). These three deterministic fixes resolve the reported failure
class (small talk, short answers, formatting) without that risk.

Tests: fast-path small-talk matrix (+ the exact production case, neutral acks
don't pivot, bare "same" excluded, food log not hijacked) + sender
leading-punctuation cases. 1060 api + 614 ai-core green; typecheck clean.

---

### Conversation context window is now tunable (default 12 turns) (2026-06-16)

Branch `claude/meal-lifecycle-states-7ayf7w`. Driven by a "never interpret a
message in isolation" request. The orchestrator history window had been cut
12→6 (Phase 13) to fight old-topic anchoring; the anchoring guards added since
(relevance check, topic-closer history stripping, "answer THIS message" focus
markers) now make a larger window safe. New `CONVERSATION_HISTORY_TURNS` env
(default **12**, clamp 4–40) threads through `AIServiceDeps.historyTurns` to the
single orchestrator `getRecentTurns` call (`ai.service.ts` ~2189). Doubles the
context Gemini sees (short-reply resolution, multi-turn continuity) at a small
latency/token cost; tunable up to 40 without a deploy (accuracy prioritized over
latency). 1060 api + 614 ai-core green.

**Audit (the rest of the "universal conversation understanding" framework is
already present):** validation layer = relevance/behavioral/content/quality
guards (on by default, regenerate off-topic/short responses); multi-intent =
"Grace MUST address EVERY meaningful part" prompt section + `splitMultiMealText`
+ symptom-before-food force-log suppression; short replies = `reconstructFollowUp`
+ continuation gates + (now) more history; emotional = EMOTION BEFORE DATA +
small-talk fast-path; memory = RAG + `user_memories` (recency-weighted) +
privacy scoping; unstructured input = typo-tolerant classifier + multi-item
estimator. **Genuinely deferred (needs live-Gemini evals before wiring):** the
persistent structured dialogue-state object (`active_topics`/`open_threads`/
`awaiting_response`) and conversation-summary injection — `TopicTrackerService`
+ `ConversationSummaryService` are scaffolded but NOT instantiated (dead code);
wiring them changes live behavior and must be eval-gated.

---

### Diagnostic confidence + contextual triage (symptoms are clues) (2026-06-16)

Branch `claude/meal-lifecycle-states-7ayf7w`. Production screenshot: user said
"I'm shaky, sweaty, and lightheaded" → Grace replied **"That sounds like your
blood sugar might be low. Please grab a quick source of sugar right now…"** — a
specific diagnosis AND a condition-specific treatment from symptoms alone.

Two rules added (prompt + deterministic backstop):
- **`packages/ai-core/src/prompts.ts`** — new **H8b DIAGNOSTIC CONFIDENCE**
  (symptoms are clues, not conclusions: never volunteer a named diagnosis or
  guess-based treatment; hedge with "one possibility is…" / "can sometimes occur
  when…", ask the 1–2 questions that narrow it, give SAFE general steps, name the
  signs that mean get help now; calibrate confidence to available info) with the
  exact screenshot as ✗/✓, and **H8c CONTEXTUAL TRIAGE** (read symptoms ACROSS
  recent turns, not in isolation; an evolving/worsening trajectory — especially
  neurological: confusion, sudden weakness, fainting — means rising risk → raise
  concern + escalate, don't repeat reassurance). The larger history window
  (`CONVERSATION_HISTORY_TURNS`) is what lets Gemini see the earlier symptoms.
- **`packages/ai-core/src/content-checker.ts`** — 5 regen-severity patterns that
  catch definitive symptom→diagnosis framing ("that/this sounds like (your) low
  blood sugar / hypoglycemia / dehydration / pancreatitis", "your blood sugar
  is/might be low", "you probably have …", "this is likely …") while the hedged
  forms ("can sometimes occur when blood sugar is low", "one possibility is…")
  are deliberately NOT matched. Defense in depth so the phrasing can't ship even
  when degraded.

Note: the SafetyGuard (chest pain / breathing / self-harm → 988/911) is
unchanged — this is about diagnostic LANGUAGE + cross-turn triage, not the
emergency classifier. Tests: `content-checker.test.ts` (+12 — flags the
definitive forms, allows the hedged forms). 1060 api + 626 ai-core green;
typecheck clean.

---

### Hypoglycemia warning: hedge the label, still give safe action (2026-06-16)

Branch `claude/meal-lifecycle-states-7ayf7w`. Second screenshot on the same
symptom cluster: "I'm shaky, sweaty and light headed" → Grace replied
"You might be experiencing symptoms of low blood sugar or dehydration." (hedged
but USELESS — no empathy, no action, no next step), then **stalled with NO reply**
on the follow-up "What should I do?". The prior fix (H8b) had over-corrected into
passivity. The user's desired behavior: empathy + the SAFE immediate action
(quick sugar now + call your doctor) while HEDGING the label ("this could be low
blood sugar"), and it must never stall.

**Deterministic handler — `services/api/src/safety/hypoglycemia-warning.ts`:**
`detectHypoglycemiaWarning(text, lastGrace?, lastUser?)` fires on (a) ≥2 distinct
adrenergic/neuroglycopenic warning symptoms (shaky / sweaty / lightheaded-dizzy /
weak / confused / palpitations / blurry vision) in the current message, or (b) a
bare "what should I do?" follow-up when the prior turn established low-blood-sugar
/ symptom context. Returns a warm, ACTIONABLE, hedged response ("Get some quick
sugar in you right now — juice or regular soda — and call your doctor right away.
This could be low blood sugar and needs a medical look. If you feel worse or more
confused, call 911."). Wired in `ai.service.handleMessage` right after the
SafetyGuard (before fast-path/orchestrator) so it's guaranteed regardless of
Gemini's state and can never "stick". Cheap regex gate; only reads history for
the follow-up. SafetyGuard (988/911) unchanged; `health-concern.ts` still
excludes blood sugar (this module owns it).

**Prompt H8b reworked** (`prompts.ts`): "hedge the LABEL, STILL give safe action"
— hedging the diagnosis does NOT mean withholding help; for an acute cluster,
lead with empathy + safe immediate action + hedged cause + call doctor, don't
bury help behind clarifying questions. Both screenshots embedded as ✗ (the
overconfident one AND the useless-passive one) with the desired ✓.

**Content-checker acute exemption** (`content-checker.ts`): the pre-existing
"call your doctor right away / immediately" escalation bans (added to stop alarm
language on NORMAL effects) were blocking the legitimate urgent response. The 4
escalation patterns are now `acuteExempt: true` and skipped when the response
contains acute markers (`ACUTE_ESCALATION_CONTEXT_RE`: 911 / low blood sugar /
quick sugar / fainting / dosing error / severe / can't keep liquids down) — so
urgent escalation ships for a real warning but is still softened for a normal
side effect. (The deterministic handler bypasses the content-checker anyway; this
fixes the LLM path for all other acute cases.)

Tests: `hypoglycemia-warning.test.ts` (12 — cluster, follow-up, no-fire cases,
asserts hedged-not-definitive) + content-checker acute-exemption cases. 1069 api
+ 629 ai-core green; typecheck clean.

---

### Weekly/recent-history summary + encryption fail-safe (2026-06-18)

Branch `claude/missing-evening-reminder-gcek4y` (PRs #87, #88, #89, all merged).
Production screenshot: a user asked "give me a summary of how my last week was"
before a doctor appointment → got "12g of protein today" (wrong window, single
day); the follow-up "Add all the data you have to make it comprehensive" was
misread as the user offering more info and answered with the generic `general`
fallback ("Tell me more whenever you're ready"); when a summary finally came it
was a list-with-headers report (the WhatsApp enforcer guts those) AND it printed
the user's medication as raw ciphertext.

**New `services/api/src/services/weekly-summary.ts`** — the missing recap
capability (there was none; `appointment_prep` only suggests questions, every
"today" path is single-day, an unhandled compile-data instruction fell to the
generic fallback).
- `detectSummaryRequest` / `mightBeSummaryRequest`: cheap regex for explicit
  recaps ("summary of my last week", "how has my week been", "summarize my
  progress") and standalone data-compilation language ("all the data you have",
  "make it comprehensive"). Weak continuations ("expand on that") only fire
  inside an active summary/appointment context. Excludes single-day food
  questions and appointment-QUESTION requests (those keep their paths).
- `gatherWeeklySummary`: real last-7-days data — protein/calorie history
  (`getDailyProteinHistory`), in-window weight trend, mood from `check_ins`,
  medication/dose, injection day, active `side_effect_flow`. Best-effort per
  source.
- `renderWeeklySummary`: ONE block of clean WhatsApp prose — no headers/bullets/
  label-colons, under the ~420-char outbound cap, omits lines it has no data
  for, honest "not much logged yet" fallback. Ends offering doctor questions.
- Wired as an early deterministic intercept in `ai.service.handleMessage` (after
  the reminder intercept, before the food-logging paths) so a recap is grounded
  in real data, never logged as food, never hits a generic fallback. Cheap
  pre-gate; only reads history to confirm weak continuations.

**Encryption leak + fail-safe (the medication ciphertext).** Root cause:
`FIELD_ENCRYPTION_KEY` is ABSENT from the prod API process, so
`isEncryptionEnabled()` is false and `decryptUser` no-op'd, surfacing the raw
`enc:<iv>:<data>:<tag>` blob for `medication`/`first_name` (the two encrypted
fields). `decryptField` returns the blob unchanged (rather than throwing) ONLY
when the key is missing — that's how we know it's absent, not merely rotated.
- **`crypto/field-encrypt.ts`** — new canonical `isEncryptedBlob(value)`.
- **`user.service.decryptUser`** now fails SAFE via `safeDecryptField`: key ON +
  decrypts → plaintext; key ON + wrong key (throws) → null for a blob (used to
  throw and fail the WHOLE user fetch); key OFF + value still a blob → null;
  plaintext → unchanged. `null` = "unknown", which every caller already treats
  as absent — so NO path (summary, LLM prompt, greeting, admin) ever sees
  ciphertext or crashes. System-wide, not a summary patch.
- **`twilio/sender.ts sanitizeOutbound`** — belt-and-suspenders: redacts any
  `enc:` blob from every outbound BEFORE `enforceFormat` mangles the colons.
  Logs `twilio.sanitize.encrypted_field_redacted`.
- **`weekly-summary.gatherWeeklySummary`** also drops a `looksEncrypted`
  medication at the source (delegates to `isEncryptedBlob`).
- **Migration `20260618000001_null_unrecoverable_encrypted_fields.sql`** — NULLs
  unrecoverable `enc:` blobs in `users.medication`/`first_name` at rest (anchored
  hex match; plaintext untouched). Irreversible — the ciphertext is the only
  copy and can't be decrypted without the original key.

**Decision (this session): encryption is DROPPED** (key is lost). It's already
effectively off in prod. With the key absent, `UserService.update` stores
re-entered medication as PLAINTEXT, so affected users just re-enter it via
Settings/admin and it reads back correctly. If the original key is ever found,
re-adding `FIELD_ENCRYPTION_KEY` to grace-api restores decryption instead.

Tests: `weekly-summary.test.ts` (26), `field-encrypt.test.ts` (3),
`user-service-cache.test.ts` decryptUser fail-safe (+2), `sender.test.ts`
redaction (+2). 1130 api tests green, typecheck clean. No env/secret changes;
the leak fixes are pure-additive. PR #87 (summary), #88 (outbound redaction +
source guard), #89 (decryptUser fail-safe + migration).

---

## Where to start in a new session

1. Read this file + `docs/STATUS.md` + `docs/OPERATIONS.md` + `docs/CACHING.md` (caching/latency reference).
2. `git log --oneline -10` to see recent commits.
3. Active branch: `main`. Latest commit: `9b365c9` — Engagement cooldown: configurable, applies to all non-critical proactive types. All Phase 15 work has been merged to main.
4. **Daily QA workflow:** `/admin/regression` (1-2 min, runs 17 known bug scenarios) → `/admin/replay` (paste WhatsApp msgs, see what Grace would say, with tool calls + regen status) → `/admin/auto-eval` (presets: Quick smoke 5, Standard 15, focused categories, Full sweep).
5. **Migrations needed before deploying Phase 14 code:**
   - `20260528000001_calorie_goal.sql` — adds `calorie_goal_kcal INT` to users
   Apply in Supabase SQL Editor: `ALTER TABLE public.users ADD COLUMN IF NOT EXISTS calorie_goal_kcal INT;`
4. Production is live at `https://grace-api.fly.dev` (API) and `https://grace-admin-silk.vercel.app` (web). Tail logs with `fly logs --app grace-api`.
5. Top open items: Fly payment method (machines auto-stop), WhatsApp Business sender approval (drops "Twilio Sandbox:" prefix), Vercel env vars for Stripe, disable v1 edge fn, rotate DB password.

### Phase 7 — AI quality pass (commits `bb420da`, `b09fe0f`, `174112e`, `c23584b`)

Driven by the WhatsApp QA feedback PDF (`/root/.claude/uploads/.../Grace_WhatsApp_Summary.pdf`) — 1 month of real GLP-1 user testing surfaced these production bugs and fixes:

**System prompt (`packages/ai-core/src/prompts.ts`)** — rewritten with:
- NON-NEGOTIABLE TRUTHS: Grace is proactive (never deny scheduled messages), Grace remembers (answer from user context, never hallucinate, never deny knowing), never quote raw food-dislike text verbatim
- SETTINGS MANAGEMENT hard override: settings changes (wake time, injection day, food prefs, etc.) → `https://graceglp.com/settings`, NOT doctor
- BRIEF REPLY RULE: 1–4 word replies ("ok", "tired", "thanks") get one warm sentence back, no question, no paragraph
- KEY EMOTIONAL MOMENTS: medical abandonment (validate fully — Grace IS the companion their doctor didn't provide), fear of stopping (validate + educational), loss of food-noise identity (don't rush "great news"), Ozempic face / body image
- GLP-1 WEEK NUMBER guidance with milestone examples (Week 1/4/8/12/26/52)
- NON-JUDGMENTAL STANCE with explicit banned implicit-shaming patterns
- HEALTH EDUCATION vs MEDICAL ADVICE — relaxes blanket "see your doctor" redirect into "Research shows…" framing with explicit escalation triggers (driven by the 50+ women research pivot)
- RE-ENGAGEMENT LADDER (1/3/7/14 day silence escalation) + PAUSE MODE
- GLP-1 MEDICATION KNOWLEDGE: tirzepatide vs semaglutide mechanism, Rybelsus empty-stomach rule, muscle loss ~25–35% of weight lost, protein target 1.2–1.6g/kg, Ozempic face mechanism, hair loss telogen effluvium, plateau science

**Scheduler (`services/api/src/scheduler/scheduler.ts`)** — quiet hours (21:00–07:00 local) added as code-level hard guard, passes `GenerateOpts` (isWednesday, lowMoodMode) to `generator.generate()`.

**Message generator (`services/api/src/scheduler/message-generator.ts`)** — food dislike prefix-stripping regex (`/^(i\s+(don'?t|do\s+not|hate|can'?t\s+stand|dislike)\s+(like\s+)?|no\s+|avoid\s+)/i`) so Grace doesn't say "you're not a fan of i don't like rice." Welcome prompt capped at 1–2 sentences with explicit paraphrase instruction.

**AI service (`services/api/src/services/ai.service.ts`)** — `buildPersonalisedPrompt` now includes:
- Injection day computed as TODAY/TOMORROW/YESTERDAY/in N days
- Weight as `X lbs → goal Y lbs (Z lbs to go)`
- GLP-1 week number from `glp1_start_date` (e.g. `GLP-1 week: Week 8 (started Mar 18, 2026)`)
- Food dislikes with same prefix-stripping regex
- LOW MOOD MODE explicit action instruction
- isNew → "FIRST message. Welcome them warmly."

**Onboarding** — `glp1StartDate` added to `OnboardSchema` (`services/api/src/routes/users.ts`) + WeightStep (`apps/web/src/components/onboarding/WeightStep.tsx`) as optional date input. Wrapped in try/catch so signup doesn't break if migration `20260513000003` hasn't been applied yet.

**Stripe** — publishable key + price IDs now match `acct_1TWfwc` (commits `5b09c9e`, `57b569a`). Price: `price_1TWgb5LMk6wjvxD9Y9azDUfZ`.

### Phase 8 — Master prompt operationalization (this session, 2026-05-13)

Adopts `gracemasterprompt.md` as the canonical Grace behavioral spec.

**`packages/ai-core/src/prompts.ts`** — full rewrite. New sections: QUESTION RULE (default: NO question mark) · MESSAGE TYPES · PROACTIVE MESSAGES ARE REMINDERS (with reminder vs. question style examples) · CHECK-IN FREQUENCY IN-CHAT exception · MISSED OR FORGOTTEN DOSE (5-day general guideline) · OPT-OUT HANDLING (natural language → settings link) · MEDICATION TYPE rule (weekly_injection / daily_pill / daily_injection / unknown — strict separation) · HOW GRACE EXPLAINS CHECK-INS · SCHEDULE EXPLANATION RESPONSES · FOOD SUGGESTIONS (banned vague phrases) · HOW TO USE MEMORY · TIME OF DAY · IMPORTANT DATE RULE · 15+ inline EXAMPLES.

**`services/api/src/safety/guard.ts`** — unified `SAFETY_RESPONSE` for both emergency (chest pain, breathing) and crisis (self-harm, suicide), word-for-word per spec. Single message surfaces both 988 (crisis line) and 911 (physical emergency).

**`services/api/src/scheduler/message-generator.ts`** — RULES block rewritten: proactive messages are REMINDERS, default to a STATEMENT (no question mark), explicit ✓/✗ examples ("Protein first today" vs "How's your eating?"), banned internal labels ("morning check-in", "midday nudge").

**`services/api/src/services/ai.service.ts`** — runtime context enriched. New lines: `Today is: <weekday>` · `Time of day for this user right now: morning/afternoon/evening/night` · `Medication type: weekly_injection|daily_pill|daily_injection|unknown` · `CHECKIN FREQUENCY: N` · `Scheduled check-ins sent today: N` · `Total protein TODAY: Xg (Y kcal)` · `Foods logged today: …`. Two new parallel DB reads per turn: `getTodaysFoodSummary` + `countTodaysCheckIns` — both already indexed.

**`services/api/src/routes/webhook.ts`** — two new in-conversation intercepts:
- `detectNaturalOptOut()` — 6 regex patterns ("stop texting me", "I want to cancel", "don't want messages", etc). Reply word-for-word per spec; redirects to `https://graceglp.com/settings`. Short-circuits before AI handler.
- `detectFrequencyChange()` — patterns for "text me less/more", "once a day", "twice a day", "every other day". Originally updated `users.checkin_count_per_day` directly. **SUPERSEDED 2026-06-09 (Settings single-source-of-truth):** replaced by `isFrequencyChangeRequest()`, which now redirects the user to the Settings page instead of writing the field. See the dated section below.

### Phase 9 — Production quality pass (2026-05-15)

All changes landed on `main`, deployed to `https://grace-api.fly.dev`.

**`services/api/src/routes/webhook.ts`**
- Paywall URL fixed: `grace.com` → `graceglp.com`
- Paywall message removes user name (RLHF rule)
- `detectFrequencyChange()` patterns expanded to cover indirect phrasings: "stop texting so much", "you message too much", "tone it down", "back off a bit", "less reminders", "check in more", "bump up the messages", etc.

**`services/api/src/scheduler/scheduler.ts`**
- **Trial Day 2 reminder**: fires `trial_expiry_reminder` during morning window when `trial_start` is 24–48h old for unpaid users, using `last_morning_sent_at` as gate. Replaces regular morning message that day.
- **Humanized timing (jitter)**: `jitterMinutes(seed, max)` — deterministic hash-based per-user-per-day offset so messages never fire at the exact same minute. Morning: 0–55 min, midday: 0–165 min across 11:00–13:45, evening: 0–30 min, injection: 0–45 min. Survives restarts/retries (same seed = same window within a day).
- **RLHF on proactive messages**: `sendAndRecord()` now appends `👍 👎 / #` rating prompt for `rlhf_enabled` users, same as reactive messages.

**`services/api/src/scheduler/message-generator.ts`**
- `MsgType` union extended with `trial_expiry_reminder`
- All proactive fallbacks except `welcome` now name-free (RLHF ZERO TOLERANCE rule)
- `maxOutputTokens` bumped 120 → 280 (Gemini 2.5 Flash thinking tokens were eating the output)
- `sanitizeProactiveOutput(raw, firstName)`:
  - Strips forbidden label prefixes (`Midday reminder:`, `Morning check-in —`, etc.) that the LLM emits ~10% of the time despite prompt instructions
  - Strips user's first name from non-welcome messages at the code level
  - Rejects output that doesn't end with punctuation/emoji (detects mid-sentence truncation)
  - Falls back to warm canned message on any rejection
- RULES block in `buildPrompt` now lists every forbidden opener pattern with `✗` examples

**`packages/ai-core/src/orchestrator.ts`**
- `knowledge_lookup` removed from `RISKY_INTENT_PREFIXES` — it was too broad, causing food/nutrition questions to run through the critic which then failed on USDA protein-gram facts not verbatim in retrieved KB chunks. Only `safety_` intents now gate the critic.
- `SAFE_FALLBACK_TEXT` replaced: cold "could you share a bit more…" → neutral "I'm not sure I caught all of that — can you give me a bit more detail so I can actually help?"

**`packages/ai-core/src/critic.ts`**
- `CRITIC_SYSTEM` updated: general nutritional facts (protein grams, USDA food values, calories) explicitly score `grounding: 5`. Only drug doses/interaction claims still penalised.

**`packages/ai-core/src/prompts.ts`** — three new sections:
- **FOOD RECOMMENDATIONS — ANSWER DIRECTLY**: Grace gives 3–5 specific foods with brief reasoning, filtered by user dislikes, GLP-1-aware (small/dense), ends every food reply with "These are general suggestions — a registered dietitian can tailor this further." Includes ✓/✗ examples.
- **EVERY RESPONSE IS UNIQUE — HARD RULE**: If a different user with a different message would get the same reply → rewrite. Every response must reference something concrete from THIS message (a word they used, a number, today's protein total, their medication, weeks in). Includes ✓/✗ examples.
- **NO PHRASE REPETITION** strengthened with more rotation examples.

**`services/api/src/scheduler/prompt-optimizer.ts`**
- `OptimizerRunReport` interface + `onRunComplete` hook added
- `saveVersion()` now returns the version number
- After each nightly run (4am UTC), calls `onRunComplete` with stats (totalMessages, pos/neg counts, satisfaction %, fallback count), analysis, activated/draft status

**`services/api/src/server.ts`**
- `onRunComplete` wired to `buildOptimizerReport()` → `sender.send()` to `ADMIN_PHONE`
- Report format: version, 14-day stats, what changed, same-pattern prevention note, link to `graceglp.com/admin/prompts`

**`services/api/src/config/env.ts`**
- `ADMIN_PHONE` optional env var added (E.164, receives RLHF optimizer WhatsApp report)

**`services/api/src/scheduler/prompt-optimizer.ts`**
- `SAFE_FALLBACK_SNIPPET` updated to match new fallback text

### Phase 10 — DB-driven content guardbands + scheduler reliability (2026-05-16)

All changes on branch `claude/icloud-access-clarification-5hsRr`. Deploy: `fly deploy --app grace-api`.

**`supabase/migrations/20260516000005_content_rules.sql`** (NEW — run in Supabase SQL Editor)
- Creates `content_rules` table with: `rule_type`, `pattern`, `is_regex`, `flags`, `reason`, `severity` (block/regen/log), `applies_to` (ai/scheduler/all), `is_active`
- Trigger auto-updates `updated_at`
- Seeds 48 rules: 4 `block` + 44 `regen`
  - **block** (4): extra dose, double dose, exceeding prescribed amount, prescribing authority
  - **regen** (44): medication safety (6), medical authority (10), emotional safety (10), banned phrases (14), privacy leaks (4)
- All block rules and most regen rules have `applies_to = 'all'` (both paths)
- One rule (`seek immediate medical help`) is `applies_to = 'ai'` only — safety guard handles real emergencies

**`services/api/src/services/content-rules.service.ts`** (NEW)
- `ContentRulesService` singleton: 60-second in-memory TTL cache, zero latency on hot path
- `getActive(target: 'ai' | 'scheduler')` filters by `applies_to`
- `start()` loads immediately + refreshes on interval; `stop()` clears timer
- Keeps stale cache on transient DB error (never wipes on failure)

**`packages/shared/src/ai.ts`** (MODIFIED)
- Added `DbContentRule` interface (id, rule_type, pattern, is_regex, flags, reason, severity, applies_to)
- Added `dbRules?: DbContentRule[]` to `OrchestratorInput`

**`packages/ai-core/src/content-checker.ts`** (MODIFIED)
- Added `severity?: 'log' | 'regen' | 'block'` to `ContentViolation`
- Added `dbRules?: DbContentRule[]` to `ContentCheckOpts`
- Added `checkDbRules(text, rules)` — silently skips invalid regex patterns (never crash on bad admin input)
- Extended `checkContent()` to call `checkDbRules` when opts.dbRules provided
- Extended `buildContentRegenInstruction()` to format `db_rule_*` violations

**`packages/ai-core/src/index.ts`** (MODIFIED)
- Added `export * from './content-checker.js'` so `checkDbRules` is importable by scheduler

**`packages/ai-core/src/orchestrator.ts`** (MODIFIED)
- Block-severity gate: if any violation has `severity === 'block'` → immediate safe fallback, no regen attempt
- Split violations into `blockViolations` / `regenViolations` / `logViolations`
- `needsReview` uses `regenViolations.length > 0` only
- Retry also checks `retryBlockViolations` — block after regen still falls through to safe fallback

**`services/api/src/services/ai.service.ts`** (MODIFIED)
- Added `contentRulesService?: ContentRulesService` to `AIServiceDeps`
- In `handleMessage()`: loads `dbRules` from `contentRulesService.getActive('ai')`, passes to orchestrator

**`services/api/src/scheduler/message-generator.ts`** (MODIFIED)
- Added `rulesService?: ContentRulesService` field + `updateRulesService()` method
- In `generate()`: after `sanitizeProactiveOutput`, loads scheduler rules and runs `checkDbRules`
- Any block/regen violation → returns canned fallback (proactive messages can't regen with chat history)

**`services/api/src/scheduler/scheduler.ts`** (MODIFIED)
- Added `redis: Redis` to `SchedulerDeps`
- `sendAndRecord()` now acquires a Redis `SET NX EX 82800` lock (`sched:{phone}:{type}:{todayStr}`)
  before generating + sending. Only first Fly machine to win the lock sends; second skips silently.
  Lock released on failure so next tick can retry. Prevents duplicate messages from 2-machine deploy.

**`services/api/src/routes/admin.ts`** (MODIFIED)
- 5 new endpoints under `/admin/content-rules`:
  - `GET` — list/filter by type/severity/active with pagination
  - `POST` — create (validates regex before saving)
  - `PUT /:id` — partial update
  - `DELETE /:id` — soft-deactivate (sets `is_active = false`)
  - `POST /test` — test any text against all active rules, returns violations JSON

**`services/api/src/server.ts`** (MODIFIED)
- `ContentRulesService` instantiated, `start()` called, `stop()` in shutdown
- Injected into `AIService` (constructor) and `MessageGenerator` (`updateRulesService()`)
- `redis` passed to `Scheduler`

**Smoke test** (confirmed working in production):
```bash
curl -s -X POST https://grace-api.fly.dev/admin/content-rules/test \
  -H "Authorization: Bearer <ADMIN_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"text":"You could take an extra dose to make up for it"}' | jq .
# → {"violations":[{"id":1,"severity":"block","reason":"Advising an extra dose...","match":"take an extra dose"}],"clean":false}
```

### Phase 11 — AI quality pass: response accuracy + food variety + image analysis (2026-05-19)

All changes on branch `claude/icloud-access-clarification-5hsRr`.

**`packages/ai-core/src/prompts.ts`**
- **GREETING RULE** (new section): pure greetings ("hi", "hey", "hey grace", "hello") → ONE warm sentence only, topic reset. Greetings must NOT continue the previous topic. Includes exact production failure as ✗ example (user said "Hey Grace" → Grace responded with drink paragraph from old history).
- **FOOD VARIETY — HARD RULE** (new section): never suggest same food twice in one conversation. Wide food pool added: 30+ plant-based options (tempeh, chickpea curry, falafel, black bean tacos, quinoa bowl, kefir, hemp seeds, etc.) + 15+ meat options (only suggested when user has no stated restriction). Two example pairs showing different foods on first vs second ask.
- **SEARCH_FOOD_IDEAS TOOL guidance** (added to FOOD RECOMMENDATIONS section): instructs Grace to call `search_food_ideas` for all food recommendation requests. Specifies how to build the query (dietary restriction + food dislikes + "GLP-1 friendly" + meal type). Example queries included.
- **TOPIC PIVOT HARD RULE** (added in previous session, now documented): self-check before sending — "Is my reply answering the message the user JUST sent or still answering the previous one?"

**`services/api/src/tools/search-food-ideas.ts`** (NEW)
- `makeSearchFoodIdeasTool(deps)` — calls Gemini with `useGoogleSearch: true` (Google Search grounding)
- Builds a targeted query with dietary restriction, dislikes, meal type, "GLP-1 friendly"
- Returns structured JSON array: `[{ name, protein_g, why }]`
- Falls back gracefully (returns `{ ok: false }`) if search or parse fails
- Enabled by default; admin-toggleable via `tool_settings` (no DB migration needed — new tools are allowed when no row exists)

**`services/api/src/services/ai.service.ts`** (MODIFIED)
- Imports and registers `search_food_ideas` tool alongside the existing 8 tools
- Passes `llm` provider to the tool so it can make grounded Gemini calls

**`services/api/src/multimodal/analyze.ts`** (MODIFIED — food path only)
- **Two-pass food image analysis** (see Multimodal section above for full detail)
- `IMAGE_CLASSIFY_AND_IDENTIFY_PROMPT`: enhanced Pass 1 with visual anchors and cooking-method detection
- `USDA_PROTEIN_TABLE`: embedded 50-food reference (poultry, seafood, eggs/dairy, plant proteins, grains, vegetables)
- `buildFoodMacroCalculationPrompt(pass1)`: constructs Pass 2 text-only prompt with USDA table + step-by-step methodology
- Body/audio/other paths: zero changes

**`services/api/src/scheduler/prompt-optimizer.ts`** (MODIFIED)
- `generateAdditions()` now extracts previous BEHAVIORAL ADJUSTMENTS from the active prompt and passes them to Gemini as "ALREADY IN PLACE" context — prevents optimizer from re-deriving the same rules every nightly run
- LLM instructed: "Do NOT repeat rules already covered. Refine with concrete examples if they're not working."
- `TS2532` fix: `previousAdditions` extraction uses `?? ''` null guard

**`services/api/eval/cases.ts`** (MODIFIED)
- Added 11 eval cases targeting known 👎 failure patterns: topic pivot, food-logging over-asking, food deflection, brief emotional replies, side effect deflection

**Known production bugs fixed (2026-05-19):**
- `tryWebSearchFallback()` now rejects regen-severity violations (was only checking block) — prevents banned phrases from reaching users via the web search path
- Morning reminders weren't firing for Israel users: root cause was DB default timezone `'America/New_York'`. At 08:00 Israel = 01:00 EDT → quiet hours blocked. Fixed per-user via admin PUT to `Asia/Jerusalem`. **New users still default to `'America/New_York'` in the migration — update timezone immediately after manual user creation.**

### Phase 13 — Security hardening + Conversation intelligence + Production quality (2026-05-27)

All work on branch `claude/grace-auto-evaluation-HiMb8`, merged to main.

**`supabase/migrations/20260527000001_enable_rls_all_tables.sql`** (NEW)
- Enables Row Level Security on all 16 public tables (`users`, `conversations`, `messages`, `embeddings`, `tool_logs`, `feedback`, `food_logs`, `weight_logs`, `check_ins`, `injections`, `prompts`, `tool_settings`, `content_rules`, plus 3 others)
- Default-deny policy blocks Supabase `anon` key from all operations
- Service-role and direct Postgres connections (used by the API) are unaffected

**`packages/ai-core/src/relevance-check.ts`** (NEW)
- LLM relevance checker module: post-generation semantic check using `gemini-2.0-flash` (~150ms)
- Verifies response actually answers the user's latest message, not an older topic
- Returns `{ relevant: boolean, reason: string }` — triggers regen on `relevant: false`

**`packages/ai-core/src/orchestrator.ts`** (MODIFIED)
- Wired LLM relevance check after generation: if response fails semantic relevance → regen with explicit instruction to address the latest message
- Topic drift detection: ratio-based check (old-topic keywords > 2x current keywords → regen)
- Topic-closer history stripping: after "thanks"/"ok"/"got it", all history before the closer is stripped from orchestrator input so old topics don't anchor the response

**`packages/ai-core/src/prompts.ts`** (MODIFIED)
- Memory block reframed as "BACKGROUND — DO NOT mention unless relevant"
- Tool results similarly reframed as background-only context
- User data block changed to "background only"
- Dynamic response length: match response length to user's message energy
- Brief reply = topic closer: "Thanks" explicitly closes previous topic, no re-reference allowed

**`packages/ai-core/src/content-checker.ts`** (MODIFIED)
- Banned "oh dear"/"oh my"/"yikes" alarm language
- Banned premature medical escalation patterns ("I'm really concerned", "please see your doctor immediately" for non-emergency contexts)
- Added concern-without-panic rule enforcement

**`services/api/src/services/ai.service.ts`** (MODIFIED)
- History reduced from 12 → 6 turns to reduce old-topic anchoring
- Medical tone: 6-step mandatory response structure, 4-level graduated escalation logic (acknowledge → educate → suggest → escalate)
- Message coalesce window increased from 2s to 3.5s
- Emergency LLM fallback: if full pipeline crashes, minimal Gemini call still answers the user

**`services/api/src/services/user.service.ts`** (MODIFIED)
- `ensureUser()` no longer crashes when `phone_hash` column missing; `medication_time`/`sms_consent` moved to try/catch block

**`services/api/src/routes/webhook.ts`** (MODIFIED)
- RLHF feedback acknowledgment replaced: developer-like "Thanks for the feedback, I'll work on that!" → Grace-appropriate "Got it. I hear you."
- Stray colon cleanup: format enforcer strips mid-sentence colons from LLM output

**`services/api/src/scheduler/scheduler.ts`** (MODIFIED)
- Bonus spontaneous reminders: 1 extra daily message at a varied random time
- Scheduler tick includes the new spontaneous nudge type alongside morning/midday/evening

**`services/api/src/scheduler/prompt-optimizer.ts`** (MODIFIED)
- Switched from `gemini-2.5-flash` to `gemini-2.0-flash` for both primary and retry attempts — thinking tokens from 2.5-flash were eating the JSON output budget, causing parse failures

**`services/api/src/config/ssl.ts`** (MODIFIED)
- Reverted `rejectUnauthorized` back to `false` for Supabase transaction pooler compatibility

**`Dockerfile`** (MODIFIED)
- Added `pnpm-lock.yaml` to runtime COPY stage for frozen-lockfile install

**Key architecture notes:**
- Conversation context pipeline: 6 history turns → topic-closer detection strips old turns → LLM relevance check catches semantic drift → content checker catches banned phrases → format enforcer cleans formatting
- Optimizer now uses `gemini-2.0-flash` (not `gemini-2.5-flash`) to avoid thinking token budget issues
- Message coalesce window is 3.5s (was 2s)
- Topic closers ("thanks", "ok", "got it") reset conversation context — all history before the closer is stripped

### Phase 14 — QA tools + behavioral defense + calorie parity (2026-05-28)

**Calorie tracking — full parity with protein:**
- `supabase/migrations/20260528000001_calorie_goal.sql` — `calorie_goal_kcal INT` column on users
- `services/api/src/nutrition/calorie-target.ts` — Mifflin-St Jeor BMR + activity factor + GLP-1 deficit (fat_loss 500, recomp 350, maintenance 300, muscle_gain -200 surplus). Floor at BMR or 1200 kcal, cap at 4000 kcal.
- `services/api/src/routes/users.ts` — wires calculator into onboarding, degrades silently if any input missing
- `services/api/src/user/user.service.ts` — `calorie_goal_kcal` added to GraceUser interface
- `services/api/src/services/ai.service.ts` — context now shows "Total calories TODAY: X / Y target (Z remaining)" as first-class line + "Personal daily calorie target: X kcal" with range guidance
- `packages/ai-core/src/prompts.ts` — new "CALORIES LEFT FOR TODAY" required pattern mirror of protein rule
- `services/api/src/tools/get-food-summary.ts` — added `calorie_goal_kcal`, `calorie_goal_met`, `calories_remaining` fields (parity with protein)
- `packages/ai-core/src/content-checker.ts` — 7 calorie-shame banned patterns (under-ate, over-ate, "way over budget", starvation language, "you should be eating more/less")
- `packages/ai-core/src/classify.ts` — added patterns for "calories left/remaining", "did I overeat", "can I still eat", "am I over my goal"
- `services/api/src/services/ai.service.ts` — force-call get_food_summary when classifier detects calorie query

**Force-call hardening (food logs not detected):**
- `packages/ai-core/src/classify.ts` — broadened FOOD_LOG regex: present tense ("I'm eating"), comma-separated food lists, 50+ food words, "and"/"with" joiners, quantity units
- `services/api/src/services/ai.service.ts` — additional safety net: detects food verb + food word combination, force log_food even if classifier missed. Logs `ai.handle.forced_log_food` for debug.
- Force-call CONTINUATION turns: when last Grace message was a food question and user replies with brief detail ("one scoop", "with milk"), combine both messages and call log_food. Logs `ai.handle.forced_log_food_continuation`.

**New admin QA tools:**
- `services/api/auto-eval/regression-scenarios.ts` — 17 scenarios replaying every production bug fixed in sessions 13+14 (weight loss alarm, fatigue premature escalation, "Thanks" topic leakage, muscle loss concern, food log format/clarification, protein/calorie left today, developer feedback ack, connection excuse, memory relevance, long responses, excessive questions, protein shake log, brief continuation fallback)
- `services/api/auto-eval/regression-runner.ts` — runs each scenario through Grace, checks for banned phrases (literal) AND required behaviors (LLM judge)
- `POST /admin/regression/run` + `GET /admin/regression/scenarios` endpoints
- `apps/web/src/pages/admin/RegressionPage.tsx` — one-click "Run all 17 scenarios" UI with pass/fail per scenario, expandable details
- `services/api/src/replay/sandbox.ts` — production-realistic replay using REAL AIOrchestrator + in-memory mock tools (log_food, get_food_summary, get_user_profile). State persists across turns. Returns rich metadata: intent, tool calls, regenerated flag, critic issues.
- `POST /admin/replay` rewritten to use sandbox (was raw llm.generate)
- `POST /admin/replay/diff` — same messages against two prompt versions
- `apps/web/src/pages/admin/ReplayPage.tsx` — paste WhatsApp messages, see what Grace would actually say (with tool calls, regen status, banned-phrase highlighting)
- Auto-eval UI: 6 presets (Quick smoke 5, Standard 15, Food/protein focus, Emotional/medical focus, Edge cases, Full sweep), concurrency selector (1/2/4/8), category multi-select chips, live time estimate

**Triple-layer behavioral defense:**
- Layer 1: Prompt instructions (existing)
- Layer 2: Generalized regex patterns — single catch-all instead of 5 specific:
  - Sycophantic openers: `(great|awesome|wonderful|perfect|fantastic|amazing|excellent|brilliant|marvelous|splendid|terrific|superb|outstanding|incredible|stellar|nice job|good job|way to go|kudos)[!,]`
  - Refusals: `i (don'?t|do not) (know|have) (what you'?ve|what you have|your)`, `without knowing`, `it depends on`, etc.
  - Clarification questions: any "how much/what was/what size/which brand" on user's food
  - Generic fallbacks: any "I'm here to help" / "what's on your mind" / "feel free to ask"
- Layer 3 (NEW): `packages/ai-core/src/behavioral-guard.ts` — LLM judge against 10 high-level principles (uses available data, logs without clarification, answers the actual question, calm not alarmist, no sycophantic openers, no developer voice, no fabricated excuses, no irrelevant memory, concise to brief, no generic fallbacks with clear context). Runs after quality guard, before send. Returns `{violations: [{principle, reason}]}`. Triggers regen with specific principle quoted.

**Scheduler cadence guardrails:**
- `services/api/src/scheduler/scheduler.ts` — strict rules in `sendAndRecord`:
  - Maximum **2** proactive messages per user per day (Redis counter)
  - Minimum **3 hours** between any two proactive messages (Redis timestamp)
- Tracked in Redis: `cadence:{phone}:{date}` counter + `cadence:last:{phone}` timestamp, both with 24h TTL
- Exempt time-critical flows: `injection_morning`, `injection_followup`, `injection_dayafter`, `trial_expiry_reminder`

**Welcome message rewrite:**
- `services/api/src/scheduler/message-generator.ts` — 3 short paragraphs: greeting + medication, what Grace does (1-2 check-ins/day, text anytime for food/symptoms/weight/feelings, photos/voice work), expectations (no pressure to reply)

**Pipeline order now:**
1. Format enforcer (deterministic) — em dashes, markdown, bullets, colons, names, length caps
2. Content checker — banned phrases (generalized regex)
3. Grounding precheck — unsupported medical claims
4. Topic drift (keyword + Jaccard) — old-topic continuation
5. LLM relevance check — semantic off-topic
6. Quality guard — too long, too many numbers, multiple questions
7. **Behavioral guard (NEW)** — 10 high-level principles, LLM judge
8. Critic (risky intents only) — safety / medical accuracy
9. → regen if any fails → web search fallback → safe fallback

**Key files added this session:**
- `services/api/src/nutrition/calorie-target.ts`
- `services/api/src/replay/sandbox.ts`
- `services/api/auto-eval/regression-scenarios.ts`
- `services/api/auto-eval/regression-runner.ts`
- `packages/ai-core/src/behavioral-guard.ts`
- `apps/web/src/pages/admin/RegressionPage.tsx`
- `apps/web/src/pages/admin/ReplayPage.tsx`
- `supabase/migrations/20260528000001_calorie_goal.sql`

### Phase 15 — Latency pass + comprehensive feedback fixes (2026-05-30)

Driven by two production feedback reports (`gracefullfeedback.html` — 24 exchanges across 7 screenshots; `gracefeedbacksession3.txt` — 11 exchanges) plus targeted latency work.

**`services/api/src/services/fast-path.ts`** (NEW) — instant deterministic responder. 14 categories (greeting, brief_positive, brief_negative, brief_ack, thanks, goodnight, farewell, laughter, apology, reaction, appreciation, love_it, confirmation, denial). Each has a rotating reply pool seeded by `hash(userId + text)` so same user doesn't repeat the same line. Hard guards: length >40 chars / `?` / digits / media → falls through to LLM. `NEVER_FAST_PATH_RE` defensively blocks medical/food/crisis keywords. Wired into `AIService.handleMessage()` before `handleMessageInner()`. Logs `ai.fast_path.hit` with category + latencyMs. End-to-end: ~150ms.

**`services/api/src/routes/webhook.ts`** — `shouldSkipCoalesce()` mirrors fast-path patterns. Trivial messages bypass the 2-second coalesce buffer entirely. Coalesce window also dropped 3.5s → 2s for messages that still go through it.

**`packages/ai-core/src/orchestrator.ts`** — parallel LLM guards: relevance, behavioral, critic now run via `Promise.all` instead of sequentially. Skip rules for trivial intents and very short responses (<40 chars) avoid the LLM calls entirely. Critic gated by `shouldRunCriticEarly` — joins the parallel batch only when needed, otherwise runs lazily inside the regen branch. Per-intent token budgets: greeting/gibberish 256, food_log/weight_log/mood_log 512, emotional 1024, knowledge/complex 8192. New `appointment_prep` intent type with 8192 budget. Truncation recovery addendum on regen: when finishReason was 'length' or response ended mid-word, the retry prompt is appended with "TRUNCATION RECOVERY: rewrite in 2-3 short sentences, no lists, ensure complete sentence ending."

**`packages/ai-core/src/critic.ts` + `packages/ai-core/src/behavioral-guard.ts`** — both now run on `gemini-2.0-flash` + `disableThinking: true`. Saves 300-500ms per call vs default 2.5-flash with thinking enabled. Critic also bumped from 300 → 500 maxOutputTokens (smaller models truncated JSON at 300 → malformed_response).

**`services/api/src/rag/gemini-embedder.ts`** — embed cache TTL bumped 5min → 30min. Query embeddings are deterministic — same "what should I eat?" hits cache instead of re-embedding (~350ms saved per hit).

**`packages/ai-core/src/classify.ts`** — added `appointment_prep` MessageType + `APPOINTMENT_PREP` regex patterns. Detection runs BEFORE knowledge/general so "Help me write my questions for my endocrinologist appointment" routes correctly on the FIRST message, not the second (fixes Session 3 feedback Exchange 6 bug).

**`packages/ai-core/src/content-checker.ts`** — major expansion driven by the feedback reports:
- 18 new banned-phrase patterns (incredibly common, completely understandable, really important question, excellent that you're thinking, absolutely critical questions, you MUST discuss, holistic approach, layers of complexity, hope it hit the spot, classic breakfast, I'm here and ready to help, etc.)
- Context-aware checks accepting `userMessage`:
  - `checkPrivacyMisfire()` — Grace said "I only know about you and your journey" on a self-referencing health question (e.g. "I feel nauseous after my shot") → regen. Fixes Bug 1 from feedback.
  - `checkTwoQuestions()` — counts `?` in response, regen if >1.
  - `checkFoodLogPreambleLeak()` — if user's message is a food log AND response opens with "That's great you're feeling…" callback → regen. Fixes the "just had protein shake" → "That's great you're feeling strong" production bug from screenshot.
- List-introducing phrase blocks: `Here's a breakdown:`, `Here's why it's happening:`, `Why it's happening:` etc.
- Wrong-redirect block: `share this feeling with your doctor` when paired with "isn't working" language (the user's frustration about a plateau is NOT a clinical question).
- Image capability denial blocks: `I cannot see images` / `text-based AI` / `describe the picture to me` (Grace HAS image analysis — denying it contradicts the prior turn).
- Protein-from-goal-weight factual error block: `per kilogram of your goal body weight`.

**`packages/ai-core/src/format-enforcer.ts`** — label-colon threshold dropped 2 → 1 (a single `Bananas: easy to digest` leaks list-feel through). Added `list_intro_stripped` and `section_header_stripped` passes for `Here's a breakdown:` / `Why it's happening:` / `What to do:` patterns. Added `appointment_prep` MessageContext with 800-char cap.

**`packages/ai-core/src/quality-guard.ts`** — added `appointment_prep` to sentence and char limits (8 sentences / 800 chars).

**`packages/ai-core/src/prompts.ts`** — major rewrite at the top of the system prompt:
- **PRIVACY RULE — STRICTLY SCOPED**: fires ONLY on third-party queries, with the exact "I feel nauseous after my shot" production failure as a memorized example.
- **ANSWER ONLY THE CURRENT MESSAGE — RULE #1**: highest-priority rule with 7 exact production transcripts as ✗/✓ pairs (hair vs nausea, face vs hair, constipation vs face, bloating vs exhaustion, food noise vs plateau, failing-feeling vs stale food log, protein shake vs stale "feeling strong"). SELF-CHECK instruction before every response.
- **EMOTION BEFORE DATA — HARD RULE**: if user's message is emotional, respond to the emotion FIRST. Never open with food logging, protein numbers, or data.
- **H3 PROSE ONLY** strengthened: 6 production list-format failures shown with ✗/✓ pairs (BRAT staples, Why Muscle Loss Can Happen, breakdown of how they differ, etc.) + self-check.
- **H3a NO TWO QUESTIONS**: max one `?` per response, at the end.
- **H9 PROTEIN TARGET — NOT goal weight**: explicit ✗/✓ examples for the "per kilogram of your current body weight" phrasing.
- **H10 CLINICAL REDIRECT TEMPLATE**: gold-standard "That one I'd genuinely leave to your doctor. They can [reason]. Worth calling them this week." Banned warning-label phrasing list.
- **H11 "FEELING LIKE IT'S NOT WORKING" — EDUCATION**: never redirect plateau-feeling vents to doctor. The right response is validate + plateau science + grounded hope.
- **H12 banned phrases list expanded** to match content-checker.
- **IMAGE FOLLOW-UP — CRITICAL** (in non-negotiable truth #5): if Grace already analyzed an image earlier, follow-up questions like "what do you see?" MUST reference what was seen. Never deny image capability.
- **BANNED FOREVER list expanded** with all 18 new patterns.

**`services/api/src/services/ai.service.ts`** — image follow-up context injection. When user's message references "picture/image/photo/the meal" but no new image was sent, scan recent history for Grace's prior image analysis reply (matching "looks like / that meal" + grams or protein) and inject as `[IMAGE FOLLOW-UP — your previous analysis said: "…". Reference what you saw.]`. Prevents Grace from denying she analyzed the image.

**`services/api/src/scheduler/scheduler.ts`** — engagement cooldown. New `engagementCooldownHours` dep (configurable via `ENGAGEMENT_COOLDOWN_HOURS` env var, default 2). LAYER 1: cooldown applies to ALL non-critical types — if `user.last_reply_at` is within window, skip. Resets automatically when next user message updates `last_reply_at`. Critical-exempt list narrowed: `injection_morning`, `injection_followup`, `trial_expiry_reminder`. `injection_dayafter` now respects cooldown. Logs `scheduler.engagement_cooldown_active`.

**`services/api/src/config/env.ts`** — added `ENGAGEMENT_COOLDOWN_HOURS` z.coerce.number().min(0).max(48).default(2).

**`services/api/src/server.ts`** — passes `env.ENGAGEMENT_COOLDOWN_HOURS` into `new Scheduler(...)`.

**Key files added/touched this phase:**
- `services/api/src/services/fast-path.ts` (NEW)
- `services/api/src/routes/webhook.ts` (coalesce 3.5→2, shouldSkipCoalesce)
- `services/api/src/services/ai.service.ts` (fast-path wiring, image follow-up context)
- `services/api/src/scheduler/scheduler.ts` (engagement cooldown)
- `services/api/src/config/env.ts` (cooldown env var)
- `services/api/src/server.ts` (cooldown wiring)
- `services/api/src/rag/gemini-embedder.ts` (embed TTL 5→30 min)
- `packages/ai-core/src/orchestrator.ts` (parallel guards, per-intent budgets, truncation addendum)
- `packages/ai-core/src/critic.ts` (gemini-2.0-flash + disableThinking)
- `packages/ai-core/src/behavioral-guard.ts` (disableThinking)
- `packages/ai-core/src/classify.ts` (appointment_prep)
- `packages/ai-core/src/content-checker.ts` (18 new bans, 3 context-aware checks)
- `packages/ai-core/src/format-enforcer.ts` (label-colon 2→1, list-intro stripping)
- `packages/ai-core/src/quality-guard.ts` (appointment_prep limits)
- `packages/ai-core/src/prompts.ts` (PRIVACY scoped, ANSWER ONLY RULE #1, EMOTION BEFORE DATA, H3 hardened, H10–H12, IMAGE FOLLOW-UP, BANNED FOREVER expanded)
- `docs/CACHING.md` (NEW — caching + latency layers reference)

### Phase 7+8 — known follow-ups not yet shipped

- **`is_paused` flag** on `users` table to support pause-mode in the re-engagement ladder. Currently `paused: boolean` exists but isn't toggled by chat — needs a separate handler for "pause" / "I'm back" phrases.
- **Base tier 10-msg/day cap** with upgrade nudge in webhook gate (not yet enforced)
- **Twilio A2P campaign resubmission** — rejected twice (sample #2 said "Nudge" not "Grace"; use-case was Customer Care vs Mixed). Action: add real unchecked SMS consent checkbox to graceglp.com signup
- **Grace Pro Stripe price ($24/mo)** — not yet created in `acct_1TWfwc`; `PRO_PRICE_ID` in `supabase/functions/upgrade-to-pro/index.ts` still points to old account
- **Welcome email** — template ready (`docs/WELCOME_EMAIL.md`), not wired into `/users/onboard`
- **DB password** — `Giburking18!` was exposed in terminal output twice; MUST be rotated at https://supabase.com/dashboard/project/uifadtlktpddtfohwxfi/settings/database then update `fly secrets set --app grace-api DATABASE_URL="postgresql://postgres.uifadtlktpddtfohwxfi:NEW_PASSWORD@aws-1-ap-northeast-1.pooler.supabase.com:6543/postgres"`

---

## Web app — landing + onboarding component map

| File | What it does |
|---|---|
| `apps/web/src/components/Logo.tsx` | Reusable logo lockup — botanical sprig SVG mark (sage + terracotta) + serif wordmark. 3 sizes (small/default/large). |
| `apps/web/src/pages/Landing.tsx` | Sticky desktop nav + mobile header + section composition. |
| `apps/web/src/components/landing/HeroSection.tsx` | Editorial chat mockup left, copy + CTA right. |
| `apps/web/src/components/landing/ChatMockup.tsx` | WhatsApp-style phone-frame mockup showing real Grace exchange. |
| `apps/web/src/components/landing/MedicationsBar.tsx` | Pill row of all supported GLP-1 meds. |
| `apps/web/src/components/landing/QuoteSection.tsx`, `PhilosophySection.tsx`, `FeatureSpread.tsx`, `FAQSection.tsx`, `FooterCTA.tsx` | Below-fold content sections, all GLP-1-specific. |
| `apps/web/src/pages/Onboarding.tsx` | 11-step quiz wrapper. POSTs to `/users/onboard` when `VITE_API_URL` set, falls back to Supabase edge fn otherwise. Passes `rlhfEnabled` consent + `glp1StartDate` through. |
| `apps/web/src/components/onboarding/PhoneStep.tsx` | Final form: phone, SMS consent, optional RLHF consent checkbox. |
| `apps/web/src/components/onboarding/WeightStep.tsx` | Optional personalization fields: weight, height, age, primary goal, **GLP-1 start date** (drives Grace's week-number accuracy). |
| `apps/web/src/components/onboarding/PaymentStep.tsx` | Stripe checkout via Supabase edge fn. Needs `VITE_SUPABASE_*` env vars. |
| `apps/web/src/components/onboarding/ConfirmationStep.tsx` | Success screen with primary `wa.me` deeplink CTA. Pre-fills `join <code>` in sandbox mode (`VITE_WHATSAPP_JOIN_CODE`), clean link in production. |
| `apps/web/vercel.json` | SPA rewrite — every route serves `index.html`. |
| `apps/web/src/index.css` | Design tokens. Sage primary + terracotta accent + cool gray-white background, with a fixed dual-halo body gradient (terracotta top-right, slate bottom-left). `.admin-shell` scope overrides all tokens to deep slate + indigo for the admin dashboard. |
| `apps/web/src/components/landing/AnimatedBackground.tsx` | Five colorful animated blobs (coral, mint, lavender, gold, sky) on the landing page. Uses `isolate` stacking context in Landing.tsx wrapper to keep z-index contained. |

## Admin dashboard — component map

| File | What it does |
|---|---|
| `apps/web/src/components/admin/AdminLayout.tsx` | Sidebar nav + auth guard |
| `apps/web/src/components/admin/AdminAuth.tsx` | Token context (localStorage) |
| `apps/web/src/components/admin/UserDrawer.tsx` | Right slide-over: profile edit, account toggles, weight chart, check-ins |
| `apps/web/src/components/admin/CreateUserModal.tsx` | Dialog to onboard a new user without curl |
| `apps/web/src/pages/admin/MetricsPage.tsx` | Activity KPIs + user stats row + charts |
| `apps/web/src/pages/admin/ConversationsPage.tsx` | Two-panel thread viewer + SSE live stream |
| `apps/web/src/pages/admin/UsersPage.tsx` | Paginated table; click row → UserDrawer; Add User → CreateUserModal |
| `apps/web/src/pages/admin/FeedbackPage.tsx` | RLHF feedback list + quick rate buttons |
| `apps/web/src/pages/admin/PromptsPage.tsx` | Prompt versioning + one-click activate |
| `apps/web/src/pages/admin/ToolsPage.tsx` | Per-tool enable/disable + priority |

---

## Multimodal implementation notes

`services/api/src/multimodal/analyze.ts` is the single entry point for all media.

**Images — food (two-pass scientific algorithm, 2026-05-19):**
- Pass 1 (vision): classify image + detailed visual identification — lists every item with weight estimate using calibrated visual anchors (standard dinner plate = 25–27cm, palm-sized protein = ~85–100g cooked, egg = ~50g, etc.) and cooking method. NO macro calculation in this pass.
- Pass 2 (text-only, food only): takes Pass 1 output → scientific USDA calculation. Uses embedded reference table (50+ foods, g protein/100g from USDA FoodData Central). Explicit per-item formula: `weight_g / 100 × USDA_value`. Outputs `CALCULATION_NOTES` with USDA matches used. Falls back to Pass 1 result if Pass 2 fails.
- Output format: identical to before (`IMAGE_TYPE: food`, `ITEMS:`, `BREAKDOWN:`, `TOTAL:`, `CONFIDENCE:`, `NOTES:`) — no changes needed in `ai.service.ts` or `buildFoodLogArg()`.
- `body` → Pass 1 only (unchanged) → GLP-1-aware progress analysis, no tool call
- `other` → Pass 1 only (unchanged) → Grace handles gracefully

**Audio** (WhatsApp voice notes, `audio/ogg`) — Gemini inline base64 doesn't reliably support ogg.
Uses the File API instead: write buffer to OS temp file → `GoogleAIFileManager.uploadFile()` → reference by `fileUri` → delete after. Twilio media URLs require Basic auth (`SID:token`) — passed via `AIServiceDeps.twilioSid/twilioToken` → `analyzeMedia opts.twilio`.

**Injection point** in `ai.service.ts`: augmented text is built before the orchestrator runs.
- Food images: Pass 2 result contains `IMAGE_TYPE: food` + `TOTAL:` → `buildFoodLogArg()` extracts items+total → `log_food` auto-called. Grace replies with TOTAL protein in 1–2 sentences.
- Body images: Pass 1 result contains `IMAGE_TYPE: body` → Grace replies warmly, no tool call.
- This prevents the orchestrator from guessing intent wrong.

---

## Known gaps / deferred

- **Fly payment method**: add at https://fly.io/trial — trial machines auto-stop after 5 min idle, breaking scheduler proactive messages and adding ~10s cold-start to every incoming webhook.
- **WhatsApp Business sender**: still on Twilio sandbox (`whatsapp:+14155238886`), which forcibly prepends "Twilio Sandbox:" to every outbound message and requires each user to text `join <code>` first. Submit a real sender via Twilio Console → Messaging → Senders → New Sender → "My own phone number". 3–10 business day Meta approval. When done: update `VITE_WHATSAPP_NUMBER` on Vercel, remove `VITE_WHATSAPP_JOIN_CODE`, update `TWILIO_WHATSAPP_FROM` Fly secret.
- **Vercel env vars**: `VITE_SUPABASE_URL` + `VITE_SUPABASE_PUBLISHABLE_KEY` need to be set on the `grace-admin` Vercel project for the Stripe checkout step to work. `VITE_WHATSAPP_NUMBER` + `VITE_WHATSAPP_JOIN_CODE` light up the deeplink button on the Confirmation screen.
- **Legacy v1 edge fn**: `handle-inbound-sms` still deployed in Supabase as a fallback. Disable after 24h of stable v2 traffic.
- **v2 Stripe webhook**: Stripe events currently update `is_paid` via v1 Supabase function hitting the shared DB. v2 reads from same DB so it works. Only build a native v2 handler if moving off Supabase DB entirely.
- **Admin auth upgrade**: localStorage Bearer token is fine for internal use. Upgrade to Supabase Auth roles before broad team access.
- **OpenTelemetry + Sentry**: not yet instrumented.
- **Integration tests**: boot Fastify in-process with stubbed LLMProvider.
- **`exactOptionalPropertyTypes`**: disabled in tsconfig — re-enable when ready.
- **A/B testing harness**: deferred.
- **BullMQ dashboard**: Bull Board not wired yet.
- **Welcome email sending**: template written (`docs/WELCOME_EMAIL.md`) but not wired into `POST /users/onboard` yet — needs an email provider (Postmark/Resend/SendGrid).
