# Grace Message Taxonomy + Latency Reference

> Comprehensive map of every kind of message Grace receives, the code path
> each takes, the expected latency floor, and the verification commands.
>
> Generated 2026-06-04 via deep audit of `services/api/src/services/`,
> `services/api/src/safety/`, `services/api/src/routes/webhook.ts`,
> `packages/ai-core/src/classify.ts`, `packages/ai-core/src/orchestrator.ts`.

Pair this doc with:
- `latency-bench/cases.ts` — machine-readable case definitions with per-category target floors + hard caps
- `latency-bench/analyze.ts` — pulls `/admin/latency` and reports compliance per category

## Pipeline layers

| Layer | Code | When it fires | Cost |
|---|---|---|---|
| 1. Safety guard | `safety/guard.ts` | Crisis / emergency / "should I change my dose" — verbatim canned response | ~100ms |
| 2. Webhook intercepts | `routes/webhook.ts` | RLHF feedback (👍/👎/#), opt-out (STOP, "unsubscribe"), frequency change ("text me less") | ~100ms |
| 3. Fast-path | `services/fast-path.ts` | 14 categories of trivial messages (greetings, brief acks, brief feelings, thanks, goodnight, etc.) | ~50-150ms |
| 4. food_log_fast | `services/food-log-fast.ts` | Food logs that match COMMON_FOODS table | ~200-300ms |
| 5. weight_log_fast | `services/weight-log-fast.ts` | Pure weight number messages | ~200-300ms |
| 6. query_fast | `services/query-fast.ts` | Protein/calorie/weight goal queries, "how am I doing today" | ~200-300ms |
| 7. FAQ semantic cache | `cache/faq-semantic-cache.ts` | Pre-seeded knowledge / side-effect Q&A (50+ seeds) | ~500-800ms |
| 8. Full orchestrator | `packages/ai-core/src/orchestrator.ts` | Everything else — planner, tools, generate, guards, regen | ~3-5s |

## Per-category map

### A. Greetings — `~100ms` (fast_path)
Examples: `Hi` / `Hey` / `good morning` / `what's up` / `sup` / `hello grace`
- Classifier: `greeting`
- Path: fast-path returns rotated reply pool

### B. Brief acks — `~100ms` (fast_path)
`ok` / `got it` / `cool` / `sounds good` / `noted` / `kk` / `thanks` / 👍 / 🤍

### C. Brief positive feelings — `~100ms` (fast_path)
`feeling great` / `I'm doing amazing` / `feeling strong` / `morning, doing good`
- Typo-tolerant; strips greeting prefixes

### D. Brief negative feelings — `~100ms` (fast_path)
`I'm tired` / `rough day` / `feeling stressed` / `not okay`
- **Excludes** medical states (nauseous, dizzy, chest pain) → routed to orchestrator

### E. Thanks / appreciation — `~100ms` (fast_path)
`thanks` / `thank you` / `appreciate it` / `love you` / `you're the best`

### F. Goodnight / farewell — `~100ms` (fast_path)
`goodnight` / `night` / `bye` / `talk later` / `sleep well`

### G. Laughter / reactions — `~100ms` (fast_path)
`lol` / `haha` / 😂 / `omg` / `wow`

### H. Apologies — `~100ms` (fast_path)
`sorry` / `my bad` / `oops` / `my apologies`

### I. Food log — common foods — `~250ms` (food_log_fast)
`I ate 2 eggs` / `just had a protein shake` / `Greek yogurt` / `had oatmeal for breakfast`
- Lookup in COMMON_FOODS (USDA-anchored), DB insert + daily-total read
- Guards: ≤80 chars, no question marks, no negations

### J. Food log — restaurant/brand — `~250ms-3s`
`Chipotle bowl` / `Starbucks latte` — fast-path IF brand entry exists, else orchestrator with `log_food` tool

### K. Food log — compound — `~3-5s` (orchestrator)
`chicken and rice and broccoli` / `eggs with toast and avocado` / multi-meal
- `>80 chars` → full pipeline, log_food LLM decomposes
- USDA-anchored macros where possible

### L. Food log — voice transcription — `~2-4s` upstream + intent latency
Transcribed text classified normally; food-log-fast or orchestrator based on length

### M. Food log — photo — `~3-5s` (orchestrator)
Image → vision LLM → log_food tool; media always bypasses fast-paths

### N. Food question — recommendations — `~3-4s` (orchestrator)
`what should I eat for breakfast?` / `any snack ideas?` / `recommend a dinner`
- Force-call gating: skipped on "what should I eat" so the LLM uses the FOOD RECOMMENDATIONS prompt section
- Vegetarian/vegan/pescatarian dietary filter applies

### O. Food question — protein content — `~500ms FAQ` or `~3-5s orchestrator`
`how much protein in eggs?` / `protein in a chicken breast`
- Common items FAQ-cached

### P. Food question — recipes — `~3-5s` (orchestrator)
`recipe for high-protein pancakes` / `how do I make protein pasta`
- search_food_ideas tool with Google grounding

### Q. Status — protein/calorie totals — `~250ms` (query_fast)
`how much protein have I had today?` / `what's my calorie count?`
- Single SUM aggregate read from food_logs

### R. Status — remaining / did I overeat — `~250ms` (query_fast)
`did I overeat?` / `calories left?` / `am I over?`
- Goal − total math

### S. Goals — protein/calorie/weight target — `~250ms` (query_fast)
`what's my protein goal?` / `what's my calorie target?` / `what's my weight goal?`
- Single field read from users row

### T. Progress — today — `~300ms` (query_fast)
`how am I doing today?` / `progress check?` / `where am I at?`
- Aggregated protein + calorie + goal in one response

### U. Progress — weekly/historical — `~3-5s` (orchestrator)
`how was last week?` / `weekly protein average?` / `am I on track this week?`
- Force-calls `get_protein_history` tool

### V. Weight log — simple — `~250ms` (weight_log_fast)
`185 lbs` / `scale says 184.6` / `184` / `182.5 kg`
- Parse + range-validate (60-600 lbs) + INSERT + trend template

### W. Weight log — compound — `~250ms + 3-5s`
`185 lbs and what should I eat?` / `190 and feeling nauseous` — first part fast-path, follow-up orchestrator

### X. Mood log — descriptor — `~100ms` (fast_path) or `~3-5s` (orchestrator)
`feeling great` (fast-path) / `mood is 8/10` (orchestrator log_mood)

### Y. Exercise log — `~3-5s` (orchestrator) ⚠️ gap
`worked out 30 mins` / `ran 5k` / `walked 8k steps`
- **Could be fast-pathed** to ~250ms with a `log_exercise` table + template

### Z. Injection log — `~3-5s` (orchestrator with state machine)
`took my shot` / `just injected` / `did my weekly`
- Webhook state machine advances injection_flow_stage

### AA. Medication — timing/storage/travel — `~500ms FAQ` or `~3-5s` (orchestrator)
`when should I take my shot?` / `how do I store this?` / `can I fly with it?`
- High FAQ coverage

### AB. Medication — dose change — `~100ms` (safety guard)
`should I increase my dose?` / `can I lower it?` / `should I skip?`
- Warm clinical-redirect template, NEVER reaches the LLM

### AC. Emotional support — `~3-5s` (orchestrator) ⚠️ deliberately routed
`struggling` / `hard day` / `want to give up` / `depressed`
- Excluded from fast-path despite intent classification — needs empathy + context

### AD. Crisis — `~100ms` (safety guard)
`want to die` / `kill myself` / `chest pain` / `can't breathe`
- All-occurrences-negated check (`I don't want to die` is safe), verbatim 988+911 response

### AE. Identity questions — `~3-5s` (orchestrator)
`are you AI?` / `are you real?` / `who are you?`

### AF. Reasoning requests — `~3-5s` (orchestrator with REASONING REQUEST banner)
`why?` / `how did you calculate that?` / `where does that number come from?`
- `detectReasoningRequest` + forced `get_user_profile` tool for actual math
- Reasoning-aware fallback if generation fails

### AG. Confirmation / denial — `~100ms` (fast_path) — UNLESS following an offer question
`yes` / `no` / `sure` / `please do`
- Fast-path UNLESS Grace's last message ended with an offer question (`want me to walk you through?`) → orchestrator delivers the promised action

### AH. Corrections — `~3-5s` (orchestrator with `remove_food` tool)
`actually I lost 8 not 18` / `that's wrong` / `I didn't eat that`

### AI. Schedule changes — `~100ms` (webhook intercept)
`text me less` / `every other day` / `more messages`
- Direct DB update + ack, no AI turn

### AJ. Pause request — `~3-5s` (orchestrator) currently; could be webhook intercept
`pause messages for a week` / `take a break`

### AK. Opt-out — `~100ms` (webhook intercept)
Twilio STOP at carrier level + `detectNaturalOptOut` for paraphrases

### AL. RLHF feedback — `~100ms` (webhook intercept)
👍 / 👎 / `#this was confusing`
- DB log + bandit reward, no AI turn

### AM. Gibberish — `~3-5s` (orchestrator) — could be fast-pathed
`asdfgh` / `????` / random chars
- Typed fallback used if generation fails

### AN. Social situations — `~3-5s` (orchestrator)
`going to a wedding` / `eating out tonight` / `holiday dinner coming up`
- Practical strategies + dietary-respecting

### AO. Appointment prep — `~3-5s` (orchestrator)
`help me write questions for my endocrinologist`
- Lookahead patterns catch cross-sentence + first-turn

### AP. Knowledge — GLP-1 / side effects — `~500ms FAQ` or `~3-5s` (orchestrator)
`why does GLP-1 work?` / `is hair loss normal?` / `what causes plateau?`
- 50+ FAQ seeds covering top questions

### AQ. Hydration / alcohol / coffee — `~500ms FAQ` or `~3-5s` (orchestrator)
`can I have coffee?` / `wine at dinner?` / `how much water?`

### AR. Sleep questions — `~500ms FAQ` or `~3-5s` (orchestrator)
`why am I waking at 3am?` / `vivid dreams?` / `sleeping poorly?`

### AS. Multi-part messages — first part's path + coalesce
Webhook `coalesceMessages()` buffers 2s; merged into single turn

### AT. Photos — `~3-5s` (orchestrator)
Vision LLM analysis; media bypasses fast-paths

## How to verify each category's latency in production

```bash
# 1. Pull aggregated per-intent metrics over last hour
curl 'https://grace-api.fly.dev/admin/latency?window=1h' \
  -H 'Authorization: Bearer <ADMIN_TOKEN>' \
  | jq '.by_intent, .by_stage'

# 2. Run the analyzer script which cross-references against the target table
ADMIN_TOKEN=<token> pnpm --filter @grace/api latency-bench
ADMIN_TOKEN=<token> pnpm --filter @grace/api latency-bench 1h
ADMIN_TOKEN=<token> pnpm --filter @grace/api latency-bench 5m

# 3. Check specific behavior verification
fly logs --app grace-api 2>&1 | grep -E 'skipped_offer_followthrough|forced_get_user_profile_for_reasoning|persist_latency.failed|regen_fired'

# 4. Inspect slow samples to diagnose
curl 'https://grace-api.fly.dev/admin/latency?window=1h' \
  -H 'Authorization: Bearer <ADMIN_TOKEN>' \
  | jq '.slow_samples[] | {intent, latency_ms, stage_timings}'
```

## Accuracy guards (verified wired)

| Risk | Guard | Verdict |
|---|---|---|
| Crisis / suicide ideation | safety.guard, negation-aware, verbatim 988+911 | ✅ Strong |
| Dose change / "should I" | safety.guard MEDICAL_ADVICE keyword list | ✅ Strong |
| Wrong dietary recommendation | content-checker dietary filter + force-call get_user_profile for reasoning + FOOD_RESPONSE_HARD_RULES in focus marker | ✅ Strong |
| Mid-sentence truncation | endsMidWord (3 callsites) + iterative trimToLastCompleteSentence | ✅ Strong |
| Memory limitation exposure | 7 content-checker bans | ✅ Strong |
| Sycophantic openers | format-enforcer FILLER_OPENERS + content-checker banned phrases | ✅ Strong |
| Reasoning requests deflected | detectReasoningRequest + REASONING REQUEST banner + reasoning-aware fallback | ✅ Strong |
| Latest-message priority | detectMustAcknowledge (symptom/correction/new-info) | ✅ Strong |
| Side effect severity gating | FAQ cache + orchestrator escalation language | 🟡 Medium — could strengthen |

## Optimization gaps (next round if needed)

1. **Exercise log fast-path** — current 3-5s could be 250ms (same pattern as weight_log_fast)
2. **Mood log fast-path** — numeric `mood 7` could be deterministic
3. **Injection log fast-path** — combine state machine + DB insert
4. **Appointment prep FAQ seed** — generic questions cacheable
5. **Side effect severity gating** — escalate to orchestrator on duration/intensity signals
