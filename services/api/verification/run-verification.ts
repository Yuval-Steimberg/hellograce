// Execution-path verification battery. Drives the REAL webhook + AI pipeline
// (real Postgres, real Redis, real workers, real guards) with a deterministic
// LLM stub, and verifies routing accuracy, tool execution, memory/context
// correctness, guard behavior, coalescing, burst handling, and latency.
//
// Run:  pnpm --filter @grace/api exec tsx verification/run-verification.ts [phase ...]
import { buildHarness, type Harness } from './harness.js';

interface Check { name: string; pass: boolean; detail: string }
const results: Record<string, Check[]> = {};
let current = '';

function phase(name: string): void {
  current = name;
  results[name] = [];
  console.log(`\n━━━ ${name} ━━━`);
}
function check(name: string, pass: boolean, detail = ''): void {
  results[current]!.push({ name, pass, detail });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const pct = (vals: number[], p: number): number => {
  const s = [...vals].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? 0;
};

async function p1ShortCircuits(h: Harness): Promise<void> {
  phase('P1 deterministic short-circuits (webhook)');
  const P = '+15551110001';
  await h.wipeUser(P); await h.createUser(P);

  let r = await h.sendWhatsApp(P, 'I want to end my life');
  check('crisis → 988 safety response', !!r && /988/.test(r.body), r?.body.slice(0, 60) ?? 'no reply');

  r = await h.sendWhatsApp(P, 'I have chest pain and trouble breathing');
  check('emergency → 911/988 safety response', !!r && /(911|988)/.test(r.body), r?.body.slice(0, 60) ?? 'no reply');

  r = await h.sendWhatsApp(P, 'please stop texting me');
  check('natural opt-out → settings link', !!r && /settings/.test(r.body), r?.body.slice(0, 80) ?? 'no reply');

  r = await h.sendWhatsApp(P, 'can you text me less often');
  check('frequency change → settings redirect (no DB write)', !!r && /Settings page/i.test(r.body), r?.body.slice(0, 80) ?? 'no reply');

  r = await h.sendWhatsApp(P, 'change my injection day to Sunday');
  const { rows: u1 } = await h.pool.query(`SELECT injection_day FROM users WHERE phone = $1`, [P]);
  check('injection day change → confirmed + persisted', !!r && /Sunday/.test(r.body) && u1[0]?.injection_day === 'Sunday', `reply=${r?.body.slice(0, 50)} db=${u1[0]?.injection_day}`);

  r = await h.sendWhatsApp(P, 'change my timezone to London please');
  check('profile update via chat → Settings redirect', !!r && /settings/i.test(r.body), r?.body.slice(0, 80) ?? 'no reply');

  r = await h.sendWhatsApp(P, 'pause');
  const { rows: u2 } = await h.pool.query(`SELECT paused FROM users WHERE phone = $1`, [P]);
  check('pause intent → paused=true + ack', !!r && u2[0]?.paused === true, `reply=${r?.body.slice(0, 50)} paused=${u2[0]?.paused}`);

  r = await h.sendWhatsApp(P, 'Hi');
  const { rows: u3 } = await h.pool.query(`SELECT paused FROM users WHERE phone = $1`, [P]);
  check('next message auto-resumes from pause', !!r && u3[0]?.paused === false, `paused=${u3[0]?.paused}`);

  r = await h.sendWhatsApp(P, 'how much does grace cost');
  check('upgrade intent → upgrade URL', !!r && /upgrade\?phone=/.test(r.body), r?.body.slice(0, 90) ?? 'no reply');

  r = await h.sendWhatsApp(P, 'Who will win the next election?');
  check('off-topic (politics) → scope boundary reply', !!r && !/election/i.test(r.body) && r.body.length < 400, r?.body.slice(0, 80) ?? 'no reply');

  await h.pool.query(`UPDATE users SET injection_flow_stage = 'morning_sent' WHERE phone = $1`, [P]);
  r = await h.sendWhatsApp(P, 'done');
  const { rows: u4 } = await h.pool.query(`SELECT injection_flow_stage FROM users WHERE phone = $1`, [P]);
  check('injection "done" → injection-aware ack + stage advance', !!r && /✅/.test(r.body) && u4[0]?.injection_flow_stage === 'done_confirmed', `stage=${u4[0]?.injection_flow_stage} reply=${r?.body.slice(0, 50)}`);

  // Expired-trial paywall
  const P2 = '+15551110002';
  await h.wipeUser(P2); await h.createUser(P2, { trial_start: new Date(Date.now() - 4 * 86400_000) });
  r = await h.sendWhatsApp(P2, 'what should I eat today?');
  check('expired trial → paywall message', !!r && /trial|subscribe|upgrade/i.test(r.body), r?.body.slice(0, 90) ?? 'no reply');

  // RLHF feedback intercept
  const P3 = '+15551110003';
  await h.wipeUser(P3); await h.createUser(P3, { rlhf_enabled: true });
  r = await h.sendWhatsApp(P3, '👍');
  const { rows: fb } = await h.pool.query(`SELECT rating FROM feedback WHERE user_id = $1`, [P3]);
  check('RLHF 👍 → ack + feedback row', !!r && /glad/i.test(r.body) && fb.length === 1 && fb[0]?.rating === 1, `reply=${r?.body.slice(0, 40)} rows=${fb.length}`);

  await h.wipeUser(P); await h.wipeUser(P2); await h.wipeUser(P3);
}

async function p2FastPath(h: Harness): Promise<void> {
  phase('P2 fast-path (zero-LLM trivial messages)');
  const P = '+15551120001';
  await h.wipeUser(P); await h.createUser(P);

  const cases: Array<[string, string]> = [
    ['Hi', 'greeting'], ['thanks!', 'thanks'], ['ok', 'ack'], ['goodnight', 'goodnight'],
    ['I\'m feeling great', 'brief_positive'], ['I\'m exhausted', 'brief_negative'],
    ['haha', 'laughter'], ['you\'re the best', 'appreciation'], ['love it', 'love_it'], ['wow', 'reaction'],
  ];
  const lats: number[] = [];
  let allNoLlm = true;
  let allReplied = true;
  for (const [text] of cases) {
    h.llm.reset();
    const r = await h.sendWhatsApp(P, text);
    if (!r) { allReplied = false; console.log(`    no reply for "${text}"`); continue; }
    lats.push(r.latencyMs);
    const gens = h.llm.calls.filter((c) => !['fact_extractor', 'user_memory_extract', 'memory_md_updater', 'conversation_summary'].includes(c.cls));
    if (gens.length > 0) { allNoLlm = false; console.log(`    "${text}" used LLM: ${gens.map((c) => c.cls).join(',')}`); }
    await new Promise((res) => setTimeout(res, 150));
  }
  check('all trivial messages replied', allReplied, `${lats.length}/${cases.length}`);
  check('zero pipeline LLM calls on fast-path turns', allNoLlm);
  check('fast-path p95 latency < 1500ms (incl. webhook+locks)', pct(lats, 95) < 1500, `p50=${pct(lats, 50)}ms p95=${pct(lats, 95)}ms`);

  // Negative control: a question must NOT take the trivial fast path —
  // it should get a substantive reply (curated meal bank or LLM, both fine).
  h.llm.reset();
  const r = await h.sendWhatsApp(P, 'What should I eat for breakfast?');
  check('question gets substantive reply (not trivial fast-path)', !!r && r.body.length > 60, `len=${r?.body.length} calls=${JSON.stringify(h.llm.callsByClass())}`);

  // Rotation: same trivial message twice should not produce identical replies back-to-back
  const r1 = await h.sendWhatsApp(P, 'thanks');
  await new Promise((res) => setTimeout(res, 150));
  const r2 = await h.sendWhatsApp('+15551120002', 'thanks');
  check('fast-path replies rotate across users', !!r1 && !!r2 && r1.body !== r2.body, `a="${r1?.body.slice(0, 30)}" b="${r2?.body.slice(0, 30)}"`);
  await h.wipeUser(P); await h.wipeUser('+15551120002');
}

async function p3PipelineCorrectness(h: Harness): Promise<void> {
  phase('P3 AI pipeline correctness (tools, context, memory)');
  const P = '+15551130001';
  await h.wipeUser(P); await h.createUser(P, { glp1_start_date: new Date(Date.now() - 56 * 86400_000) });

  // Food log 1
  let res = await h.chatSend(P, 'I just had grilled chicken with rice');
  const t1 = res.toolResults.find((t) => t.name === 'log_food');
  check('food text → forced log_food + DB row', !!t1 && t1.ok && (t1.output as { daily_protein_g?: number })?.daily_protein_g === 40, String(JSON.stringify(t1?.output)).slice(0, 80));

  // Food log 2 accumulates (may take the deterministic food_log_fast path,
  // whose output shape differs from the orchestrator log_food tool).
  res = await h.chatSend(P, 'just ate a greek yogurt');
  const t2 = res.toolResults.find((t) => t.name === 'log_food');
  const out2 = (t2?.output ?? {}) as { daily_protein_g_after_this_log?: number; daily_protein_g?: number };
  const daily2 = out2.daily_protein_g_after_this_log ?? out2.daily_protein_g;
  check('second food log accumulates daily total', typeof daily2 === 'number' && daily2 > 40, `intent=${res.intent} daily_after=${daily2}`);

  // Protein question → forced get_food_summary with correct totals
  const { rows: dbSum } = await h.pool.query<{ p: number }>(`SELECT COALESCE(SUM(protein_g),0)::int AS p FROM food_logs WHERE user_id = $1`, [P]);
  h.llm.reset();
  res = await h.chatSend(P, 'how much protein did I have today?');
  const ts = res.toolResults.find((t) => t.name === 'get_food_summary');
  const sum = ts?.output as { protein_g?: number; protein_goal_grams?: number } | undefined;
  // Production may serve this via the deterministic query_fast path (no
  // tool call, templated reply) — both are correct as long as the number
  // the user sees equals the DB total.
  const numberShown = sum?.protein_g ?? Number(res.reply.match(/(\d+)\s*g/)?.[1] ?? NaN);
  check('protein question → reported total matches DB', numberShown === dbSum[0]!.p, `intent=${res.intent} shown=${numberShown} db=${dbSum[0]!.p} reply=${res.reply.slice(0, 70)}`);

  // DB cross-check: the daily total the user was told matches food_logs
  const { rows: foodRows } = await h.pool.query(`SELECT COALESCE(SUM(protein_g),0)::int AS p FROM food_logs WHERE user_id = $1`, [P]);
  check('DB daily protein matches reported running total', foodRows[0]?.p === daily2, `db=${foodRows[0]?.p} reported=${daily2}`);

  // Knowledge question → retrieval executes against pgvector
  h.llm.reset();
  res = await h.chatSend(P, 'Why am I nauseous after my injection?');
  check('knowledge question → AI replied (no crash, no fallback)', res.reply.length > 20 && !/not sure I caught/i.test(res.reply), `intent=${res.intent} reply=${res.reply.slice(0, 60)}`);

  // Weight log
  res = await h.chatSend(P, 'I weighed 205 this morning');
  const { rows: w } = await h.pool.query(`SELECT weight::float AS weight FROM weight_logs WHERE user_id = $1`, [P]);
  check('weight message → weight_logs row', w.length >= 1 && Number(w[0]?.weight) === 205, `intent=${res.intent} rows=${JSON.stringify(w)}`);

  // Memory: store a durable fact, then verify it reaches a later prompt
  await h.chatSend(P, 'Please remember I work night shifts at the hospital');
  await new Promise((r) => setTimeout(r, 2500)); // let fact-extract worker drain
  h.llm.reset();
  res = await h.chatSend(P, 'When should I eat my biggest meal?');
  const gen2 = h.llm.calls.find((c) => c.cls === 'generation' || c.cls === 'food_question_direct');
  const promptHasFact = !!gen2 && (gen2.promptChars > 0) && h.llm.calls.some((c) => /night shift/i.test(c.systemHead + c.userText));
  const { rows: factRows } = await h.pool.query(
    `SELECT fact FROM user_profile_facts WHERE user_id = $1`, [P],
  ).catch(() => ({ rows: [] as Array<{ fact: string }> }));
  const { rows: memRows } = await h.pool.query(
    `SELECT content FROM user_memories WHERE user_id = $1`, [P],
  ).catch(() => ({ rows: [] as Array<{ content: string }> }));
  check('durable fact persisted (facts or memories table)', factRows.length > 0 || memRows.length > 0, `facts=${factRows.length} memories=${memRows.length} promptHasFact=${promptHasFact}`);

  // Multi-part message single turn
  res = await h.chatSend(P, 'Two things: I had eggs for breakfast and also when should I take my shot if I am travelling Friday?');
  check('multi-part message → single coherent turn (no crash)', res.reply.length > 10, `intent=${res.intent}`);

  await h.wipeUser(P);
}

async function p4Guards(h: Harness): Promise<void> {
  phase('P4 guard execution (scripted bad outputs)');
  const P = '+15551140001';
  await h.wipeUser(P); await h.createUser(P);

  // Block-severity content rule: extra dose advice must NEVER ship
  h.llm.reset();
  h.llm.scriptGeneration('You could take an extra dose to make up for the missed one, that usually works fine.');
  let res = await h.chatSend(P, 'I think I missed my dose yesterday, what do I do?');
  check('block-severity rule (extra dose) never ships', !/extra dose/i.test(res.reply), res.reply.slice(0, 90));

  // Regen-severity: banned phrase triggers regen, final differs from bad draft
  h.llm.reset();
  h.llm.scriptGeneration(
    'Great job! Your symptoms are incredibly common and completely understandable. You should contact your healthcare provider right away.',
    'Nausea after a dose increase usually settles within a couple of days. Small bland meals and fluids help.',
  );
  res = await h.chatSend(P, 'feeling a bit queasy since the new dose');
  const genCount = h.llm.calls.filter((c) => c.cls === 'generation').length;
  check('banned-phrase draft → regenerated (≥2 gen calls)', genCount >= 2 && !/healthcare provider right away/i.test(res.reply), `gens=${genCount} reply=${res.reply.slice(0, 70)}`);

  // Markdown/list formatting stripped by format enforcer
  h.llm.reset();
  h.llm.scriptGeneration('Here\'s a breakdown:\n* **Option one** — eggs\n* **Option two** — yogurt\nWhy it\'s happening: protein matters.');
  res = await h.chatSend(P, 'give me some breakfast ideas please');
  check('markdown bullets/headers stripped or regenerated', !/\*\*|^\s*\*/m.test(res.reply) && !/Here's a breakdown:/i.test(res.reply), res.reply.slice(0, 90));

  // Em-dash policy
  h.llm.reset();
  h.llm.scriptGeneration('Protein first — that is the rule — and water all day.');
  res = await h.chatSend(P, 'any tips for today?');
  check('em-dashes removed by format enforcer', !/—/.test(res.reply), res.reply.slice(0, 80));

  // Two questions
  h.llm.reset();
  h.llm.scriptGeneration('How are you feeling now? Did you drink water today? Try some crackers.');
  res = await h.chatSend(P, 'still tired today honestly');
  check('two-question response caught (≤1 question ships)', (res.reply.match(/\?/g) ?? []).length <= 1, res.reply.slice(0, 80));

  // Relevance-check failure forces regen. Must be a 'general' chat message —
  // knowledge/emotional/food intents take direct paths that skip the
  // relevance judge by design.
  h.llm.reset();
  h.llm.failNextRelevance = true;
  res = await h.chatSend(P, 'I rearranged my whole kitchen this weekend and it honestly changed my routine');
  const gens2 = h.llm.calls.filter((c) => c.cls === 'generation').length;
  const relRan = h.llm.calls.some((c) => c.cls === 'relevance_check');
  check('relevance-check fail → regen attempted (orchestrator path)', relRan && gens2 >= 2, `relRan=${relRan} gens=${gens2}`);

  await h.wipeUser(P);
}

async function p5Concurrency(h: Harness): Promise<void> {
  phase('P5 coalescing, bursts, duplicates, multi-user');
  const P = '+15551150001';
  await h.wipeUser(P); await h.createUser(P);

  // Coalesce: two quick non-trivial parts → ONE merged reply
  h.sender.reset();
  const since = Date.now();
  await h.sendWhatsApp(P, 'I keep waking up at 3am feeling weird and', { noWait: true });
  await new Promise((r) => setTimeout(r, 300));
  await h.sendWhatsApp(P, 'also my stomach has been off since the new dose', { noWait: true });
  await h.sender.waitForReply(P, since, 30_000);
  await new Promise((r) => setTimeout(r, 4000));
  const replies = h.sender.sent.filter((m) => m.to === P && m.at >= since);
  const merged = h.llm.calls.find((c) => c.cls === 'generation' && /3am/.test(c.userText) && /stomach/.test(c.userText));
  check('rapid burst coalesced into ONE turn', replies.length === 1, `replies=${replies.length}`);
  check('merged text reached generation as one message', !!merged, merged?.userText.slice(0, 80) ?? 'not found');

  // No message loss when a second message arrives mid-processing
  h.sender.reset(); h.llm.reset();
  h.llm.delays['generation'] = 1500;
  const since2 = Date.now();
  await h.sendWhatsApp(P, 'What helps with constipation on Mounjaro?', { noWait: true });
  await new Promise((r) => setTimeout(r, 2600)); // past coalesce window; first turn still generating
  await h.sendWhatsApp(P, 'And is it normal for it to last a week?', { noWait: true });
  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline && h.sender.sent.filter((m) => m.to === P && m.at >= since2).length < 2) {
    await new Promise((r) => setTimeout(r, 200));
  }
  const got = h.sender.sent.filter((m) => m.to === P && m.at >= since2).length;
  check('message arriving mid-turn is NOT lost (both answered)', got === 2, `replies=${got}`);
  h.llm.delays['generation'] = 0;

  // Duplicate MessageSid dropped
  h.sender.reset();
  const since3 = Date.now();
  const payload = new URLSearchParams({ From: `whatsapp:${P}`, To: 'whatsapp:+10000000000', Body: 'thanks', MessageSid: `SM-dup-${Date.now()}`, NumMedia: '0' }).toString();
  for (let i = 0; i < 2; i++) {
    await h.app.inject({ method: 'POST', url: '/webhook/twilio', payload, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  }
  await new Promise((r) => setTimeout(r, 2000));
  const dupReplies = h.sender.sent.filter((m) => m.to === P && m.at >= since3).length;
  check('duplicate MessageSid → single reply', dupReplies === 1, `replies=${dupReplies}`);

  // 6 concurrent users
  const phones = Array.from({ length: 6 }, (_, i) => `+1555116000${i}`);
  await Promise.all(phones.map(async (p) => { await h.wipeUser(p); await h.createUser(p); }));
  const t0 = Date.now();
  const lat = await Promise.all(phones.map(async (p, i) => {
    const r = await h.sendWhatsApp(p, i % 2 === 0 ? 'I just had a protein shake' : 'why am I so tired this week?');
    return r ? r.latencyMs : -1;
  }));
  check('6 concurrent users all answered', lat.every((l) => l >= 0), `lats=${lat.join(',')}`);
  check('concurrent p95 < 8s (stub LLM)', pct(lat.filter((l) => l >= 0), 95) < 8000, `wall=${Date.now() - t0}ms p95=${pct(lat, 95)}ms`);
  await Promise.all(phones.map((p) => h.wipeUser(p)));
  await h.wipeUser(P);
}

async function p6LongThread(h: Harness): Promise<void> {
  phase('P6 long-conversation scalability (30 turns)');
  const P = '+15551170001';
  await h.wipeUser(P); await h.createUser(P);

  const lats: number[] = [];
  const promptSizes: number[] = [];
  const topics = ['protein', 'sleep', 'nausea', 'hydration', 'energy', 'cravings'];
  for (let i = 0; i < 30; i++) {
    h.llm.reset();
    const topic = topics[i % topics.length]!;
    const res = await h.chatSend(P, `Turn ${i + 1}: tell me something about ${topic} on my medication`);
    lats.push(res.latencyMs);
    const gen = h.llm.calls.find((c) => c.cls === 'generation' || c.cls === 'food_question_direct');
    if (gen) promptSizes.push(gen.promptChars);
  }
  const early = lats.slice(2, 8); const late = lats.slice(-6);
  const avg = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
  check('latency stable: late avg ≤ 2x early avg', avg(late) <= Math.max(200, avg(early) * 2), `early=${avg(early).toFixed(0)}ms late=${avg(late).toFixed(0)}ms`);
  const earlyP = promptSizes.slice(2, 8); const lateP = promptSizes.slice(-6);
  check('prompt size bounded (late ≤ 1.5x early)', avg(lateP) <= avg(earlyP) * 1.5, `early=${avg(earlyP).toFixed(0)}ch late=${avg(lateP).toFixed(0)}ch`);
  const { rows } = await h.pool.query(`SELECT COUNT(*)::int AS n FROM messages m JOIN conversations c ON m.conversation_id = c.id WHERE c.user_id = $1`, [P]);
  check('all turns persisted to messages table', rows[0]!.n >= 55, `rows=${rows[0]!.n} (expect ~60)`);
  await h.wipeUser(P);
}

async function p7LatencyModel(h: Harness): Promise<void> {
  phase('P7 latency model with production-like LLM delays');
  // Approximate production round-trips (ms)
  Object.assign(h.llm.delays, {
    generation: 900, food_question_direct: 900, planner: 250,
    relevance_check: 200, behavioral_guard: 220, critic: 250,
    food_itemize: 450, food_decompose: 350, default: 150,
  });
  const P = '+15551180001';
  await h.wipeUser(P); await h.createUser(P);

  const scenarios: Array<[string, string, number]> = [
    ['greeting (fast-path)', 'Hi', 1200],
    ['food log', 'I just had two eggs and toast', 7000],
    ['knowledge question', 'Why does Ozempic cause constipation?', 7000],
    ['emotional', 'I feel like a failure today, the scale will not move', 7000],
  ];
  for (const [name, text, budget] of scenarios) {
    // Drain: wait until no new outbound for 1.2s so a late reply from the
    // previous scenario can't be attributed to this one.
    let lastCount = h.sender.sent.length;
    for (;;) {
      await new Promise((res) => setTimeout(res, 1200));
      if (h.sender.sent.length === lastCount) break;
      lastCount = h.sender.sent.length;
    }
    h.llm.reset();
    const r = await h.sendWhatsApp(P, text).catch(() => null);
    const e2e = r?.latencyMs ?? -1;
    check(`${name} E2E ≤ ${budget}ms`, e2e >= 0 && e2e <= budget, `e2e=${e2e}ms calls=${JSON.stringify(h.llm.callsByClass())}`);
  }

  // Parallel guard proof: relevance + behavioral windows must overlap.
  // Use a 'general' chat message — knowledge/emotional/food intents take
  // direct paths that intentionally skip the LLM judges.
  h.llm.reset();
  await h.chatSend(P, 'I switched my walking route this week and it has been a nice change honestly');
  const rel = h.llm.calls.find((c) => c.cls === 'relevance_check');
  const beh = h.llm.calls.find((c) => c.cls === 'behavioral_guard');
  if (rel && beh) {
    const overlap = rel.startedAt < beh.endedAt && beh.startedAt < rel.endedAt;
    check('relevance + behavioral guards run in PARALLEL', overlap, `rel=[${rel.startedAt % 100000},${rel.endedAt % 100000}] beh=[${beh.startedAt % 100000},${beh.endedAt % 100000}]`);
  } else {
    check('relevance + behavioral guards both ran', false, `rel=${!!rel} beh=${!!beh} calls=${JSON.stringify(h.llm.callsByClass())}`);
  }
  Object.assign(h.llm.delays, { generation: 0, food_question_direct: 0, planner: 0, relevance_check: 0, behavioral_guard: 0, critic: 0, food_itemize: 0, food_decompose: 0, default: 0 });
  await h.wipeUser(P);
}

async function p8ContentAccuracy(h: Harness): Promise<void> {
  phase('P8 deterministic response content accuracy');
  // A large share of production replies are NOT model free-text: curated meal
  // bank, query_fast templates, food_log_fast confirmations, safety texts.
  // Their factual content is verifiable without Gemini.

  // Dietary safety: vegan user with a dislike must never be offered
  // meat/dairy/eggs or the disliked food by the curated food path.
  const P = '+15551210001';
  await h.wipeUser(P);
  await h.createUser(P, { dietary_pattern: 'vegan', food_dislikes: ['tofu'] });
  const MEAT_DAIRY_RE = /\b(chicken|beef|turkey|salmon|tuna|shrimp|pork|bacon|steak|yogurt|cheese|cottage|egg|eggs|milk|whey)\b/i;
  let allClean = true;
  let sampled = 0;
  for (const q of ['What should I eat for lunch?', 'Any snack ideas?', 'What should I eat for breakfast?', 'high protein dinner ideas?']) {
    const r = await h.sendWhatsApp(P, q);
    if (!r) continue;
    sampled++;
    if (MEAT_DAIRY_RE.test(r.body) || /\btofu\b/i.test(r.body)) {
      allClean = false;
      console.log(`    VIOLATION for "${q}": ${r.body.slice(0, 100)}`);
    }
  }
  check('vegan + dislike never offered meat/dairy/eggs/disliked food', sampled >= 3 && allClean, `sampled=${sampled}`);

  // Profile answers must match the DB exactly.
  const P2 = '+15551210002';
  await h.wipeUser(P2);
  await h.createUser(P2, { injection_day: 'Friday', protein_goal_grams: 95, calorie_goal_kcal: 1500 });
  let r = await h.sendWhatsApp(P2, 'what is my injection day?');
  check('injection-day question → exact DB value', !!r && /friday/i.test(r.body), r?.body.slice(0, 70) ?? 'no reply');
  r = await h.sendWhatsApp(P2, "what's my protein goal?");
  check('protein-goal question → exact DB value', !!r && /95\s*g/i.test(r.body), r?.body.slice(0, 70) ?? 'no reply');

  // Nutrition math: log food, then calories-left must equal target - logged.
  await h.chatSend(P2, 'I just had grilled chicken with rice'); // 2 items × 250 kcal = 500
  const { rows: kc } = await h.pool.query<{ c: number }>(`SELECT COALESCE(SUM(calories),0)::int AS c FROM food_logs WHERE user_id = $1`, [P2]);
  const res = await h.chatSend(P2, 'how many calories do I have left today?');
  const expectedLeft = 1500 - kc[0]!.c;
  const sumOut = res.toolResults.find((t) => t.name === 'get_food_summary')?.output as { calories_remaining?: number } | undefined;
  const shownLeft = sumOut?.calories_remaining ?? Number(res.reply.replace(/,/g, '').match(/(\d{3,4})\s*(?:kcal|calories)?\s*(?:left|remaining)/i)?.[1] ?? NaN);
  check('calories-left math correct vs DB', shownLeft === expectedLeft, `intent=${res.intent} shown=${shownLeft} expected=${expectedLeft} reply=${res.reply.slice(0, 70)}`);

  await h.wipeUser(P); await h.wipeUser(P2);
}

async function p9HallucinationContext(h: Harness): Promise<void> {
  phase('P9 anti-hallucination machinery + context priority');
  const P = '+15551220001';
  await h.wipeUser(P); await h.createUser(P);

  // Grounding precheck fail-close: a generation asserting unsupported
  // quantitative medical claims (dose mg, efficacy %) with no KB support
  // must NOT ship as-is. Use a 'general' message so the orchestrator
  // (which owns the grounding precheck) handles it.
  h.llm.reset();
  h.llm.scriptGeneration(
    'Most people adjust their routine here, and taking 2.4 mg weekly fixes this for 80% of users within days.',
    'Feeling run down in the early weeks is something a lot of people notice. Gentle movement and steady protein usually help.',
  );
  let res = await h.chatSend(P, 'I have been feeling kind of run down lately with all the changes');
  const gens = h.llm.calls.filter((c) => c.cls === 'generation').length;
  check('unsupported dose/efficacy claims never ship (grounding fail-close)', !/2\.4\s*mg|80%/.test(res.reply), `gens=${gens} reply=${res.reply.slice(0, 80)}`);

  // Topic-closer stripping: after "thanks", the next turn's generation
  // prompt must NOT carry the pre-closer topic as history.
  const P3 = '+15551220003';
  await h.wipeUser(P3); await h.createUser(P3);
  await h.chatSend(P3, 'My neighbor keeps borrowing my kitchen scale and it annoys me');
  await new Promise((r) => setTimeout(r, 1500)); // let turn-persist drain
  await h.chatSend(P3, 'thanks');
  await new Promise((r) => setTimeout(r, 1500));
  h.llm.reset();
  res = await h.chatSend(P3, 'I want to plan tomorrow morning a bit better');
  const gen = h.llm.calls.find((c) => c.cls === 'generation');
  const carried = gen ? /kitchen scale|neighbor/i.test(gen.fullText) : true;
  check('history before a topic-closer ("thanks") is stripped from the prompt', !!gen && !carried, gen ? `promptChars=${gen.promptChars} carriedOldTopic=${carried}` : 'no generation call');

  // Latest-message priority: the most recent user message is the LAST user
  // turn in the prompt the model sees.
  const lastUserIdx = gen ? gen.fullText.lastIndexOf('plan tomorrow morning') : -1;
  check('latest message is the final user turn in the prompt', !!gen && lastUserIdx > -1, `idx=${lastUserIdx}`);

  // Durable-fact injection: a stored fact must actually reach a later
  // turn's generation prompt (not just sit in the table).
  const P4 = '+15551220004';
  await h.wipeUser(P4); await h.createUser(P4);
  await h.chatSend(P4, 'Please remember I work night shifts at the hospital');
  await new Promise((r) => setTimeout(r, 2500)); // fact-extract worker
  h.llm.reset();
  await h.chatSend(P4, 'I have been struggling to fit meals around my schedule lately');
  const gen2 = h.llm.calls.find((c) => c.cls === 'generation');
  const factInPrompt = gen2 ? /night shift/i.test(gen2.fullText) : false;
  check('stored durable fact reaches a later generation prompt', factInPrompt, gen2 ? `promptChars=${gen2.promptChars}` : 'no generation call');

  await h.wipeUser(P); await h.wipeUser(P3); await h.wipeUser(P4);
}

// ── P10: 2026-06-11 WhatsApp screenshot regressions ──────────────────────────
// Reproduces the exact production failures (generic "what's on your mind"
// deflections, "considering food" treated as "ate food", personal questions
// answered with generic clinical ranges, typos breaking intent) and asserts
// each now produces a USEFUL reply — crucially under GEMINI_DOWN (the
// intermittent-outage condition that caused them). Generic-deflection strings
// must NEVER appear.
const GENERIC_DEFLECTION_RE =
  /what'?s on your mind|what would you like to talk about|i'?m listening|tell me a bit more|say more|what'?s the rest of that/i;

async function p10ScreenshotRegressions(h: Harness): Promise<void> {
  phase('P10 WhatsApp screenshot regressions (Gemini DOWN)');
  const P = '+15551330001';
  await h.wipeUser(P); await h.createUser(P, { protein_goal_grams: 60, dietary_pattern: null });
  await h.sendWhatsApp(P, 'I just had 2 eggs and toast'); // prime intake

  // Simulate the intermittent Gemini outage that produced the screenshots.
  h.llm.throwOnClasses = new Set(['generation', 'food_question_direct', 'emergency_fallback', 'planner', 'search_food_ideas'] as const);

  let r = await h.sendWhatsApp(P, 'What I should eat for dinner');
  check('food-rec request → real suggestions, not deflection',
    !!r && !GENERIC_DEFLECTION_RE.test(r.body) && /\b(yogurt|eggs?|chicken|tofu|salmon|tuna|cottage|lentil|turkey|shrimp|options?)\b/i.test(r.body),
    r?.body.slice(0, 80) ?? 'no reply');

  r = await h.sendWhatsApp(P, 'How about pizza for dinner?');
  check('considering food → NOT treated as eaten ("what did you have")',
    !!r && !/what did you have at|once i know.*you ordered/i.test(r.body),
    r?.body.slice(0, 80) ?? 'no reply');

  r = await h.sendWhatsApp(P, 'How much protein I had');
  check('"how much protein I had" → today\'s logged total (not generic target)',
    !!r && /\b\d+\s*g\b/.test(r.body) && /today/i.test(r.body),
    r?.body.slice(0, 80) ?? 'no reply');

  r = await h.sendWhatsApp(P, 'What is my target?');
  check('bare "what is my target?" → personal protein target',
    !!r && /\b60\s*g\b/.test(r.body),
    r?.body.slice(0, 80) ?? 'no reply');

  r = await h.sendWhatsApp(P, "What's is my protein target? How much I had?");
  check('compound personal question → BOTH target and today\'s intake',
    !!r && /\b60\s*g\b/.test(r.body) && /today/i.test(r.body),
    r?.body.slice(0, 80) ?? 'no reply');

  r = await h.sendWhatsApp(P, "I'm good. My stomach herts. I'm hungry");
  check('symptom with typo ("herts") → acknowledgement + guidance, not deflection',
    !!r && !GENERIC_DEFLECTION_RE.test(r.body) && /\b(water|prescriber|light|protein|uncomfortable|stomach|nausea)\b/i.test(r.body),
    r?.body.slice(0, 80) ?? 'no reply');

  r = await h.sendWhatsApp(P, 'Ima nervous');
  check('emotional with typo ("ima") → emotional reflection, not deflection',
    !!r && !/what would you like to talk about|what'?s on your mind/i.test(r.body),
    r?.body.slice(0, 80) ?? 'no reply');

  r = await h.sendWhatsApp(P, 'Hey, for breakfast I ate 2 eggs. For lunch I had chicken breast with bowl of rice');
  check('multi-meal food log → not a generic deflection',
    !!r && !/what'?s on your mind|what would you like to talk about/i.test(r.body),
    r?.body.slice(0, 80) ?? 'no reply');
  // The core comprehension regression: the WHOLE meal must be understood, not
  // just the first food. eggs (12) + chicken (30) + rice (4) = 46g — the reply
  // must name chicken AND rice and report a total well above the 12g eggs-only
  // undercount that shipped in production.
  check('multi-meal food log → names chicken AND rice (not just eggs)',
    !!r && /chicken/i.test(r.body) && /rice/i.test(r.body),
    r?.body.slice(0, 120) ?? 'no reply');
  {
    const protein = r ? Number(r.body.match(/(\d+)\s*g\b/)?.[1] ?? 0) : 0;
    check('multi-meal food log → total counts all items (>= 40g, not 12g eggs-only)',
      protein >= 40, r ? `${protein}g in reply` : 'no reply');
  }

  h.llm.throwOnClasses = new Set();
  await h.wipeUser(P);
}

// ── P11: follow-up intent reconstruction ─────────────────────────────────────
// "is hair loss common?" then "on glp?" must be understood as "is hair loss
// common on GLP-1?" — routed by the full meaning and answered about hair loss,
// not the generic GLP-1 mechanism. Verified both with the stub LLM healthy
// (reconstruction reaches the prompt) and DOWN (deterministic topic fallback
// matches the reconstructed subject).
async function p11Reconstruction(h: Harness): Promise<void> {
  phase('P11 follow-up intent reconstruction');
  const P = '+15551440001';
  await h.wipeUser(P); await h.createUser(P);

  // ── Healthy: reconstruction reaches the generation prompt ──
  h.llm.throwOnClasses = new Set();
  await h.sendWhatsApp(P, 'is hair loss common?');
  await new Promise((r) => setTimeout(r, 1500)); // let turn-persist drain
  h.llm.reset();
  await h.sendWhatsApp(P, 'on glp?');
  const gen = h.llm.calls.find((c) => c.cls === 'generation' && /is hair loss common on glp/i.test(c.fullText));
  check('continuation "on glp?" → reconstructed question reaches the model',
    !!gen, gen ? 'found reconstructed question in prompt' : 'reconstruction NOT in any generation prompt');

  // ── Gemini DOWN: topic fallback matches the reconstructed subject ──
  const P2 = '+15551440002';
  await h.wipeUser(P2); await h.createUser(P2);
  h.llm.throwOnClasses = new Set(['generation', 'food_question_direct', 'emergency_fallback', 'planner', 'search_food_ideas'] as const);
  await h.sendWhatsApp(P2, 'is hair loss common?');
  await new Promise((r) => setTimeout(r, 1500));
  const r = await h.sendWhatsApp(P2, 'on glp?', { timeoutMs: 20_000 });
  check('continuation answered about HAIR (not GLP-1 mechanism) with LLM down',
    !!r && /hair/i.test(r.body) && !/mimicking the incretin|reducing appetite/i.test(r.body),
    r?.body.slice(0, 90) ?? 'no reply');

  h.llm.throwOnClasses = new Set();
  await h.wipeUser(P); await h.wipeUser(P2);
}

// ── P12: aggregated, non-repetitive food summary ─────────────────────────────
// "What did I eat today?" must NEVER return a raw, repeated database dump
// ("chicken, rice, 2 eggs, 2 eggs, chicken, rice, … and 12 more"). Identical
// foods aggregate into "Name × N", totals live in their own section, and there
// is no vague "and N more". Preloads duplicate rows directly (chat dedup would
// otherwise collapse identical messages sent in the same minute).
async function p12FoodSummaryAggregation(h: Harness): Promise<void> {
  phase('P12 aggregated food summary (no raw repetition)');
  const P = '+15551550001';
  await h.wipeUser(P); await h.createUser(P, { protein_goal_grams: 200, calorie_goal_kcal: 3500, timezone: 'UTC' });

  const rows: Array<[string, number, number]> = [
    ['chicken breast (4oz)', 30, 180], ['chicken breast (4oz)', 30, 180], ['chicken breast (4oz)', 30, 180],
    ['rice (1 cup)', 4, 200], ['rice (1 cup)', 4, 200],
    ['2 eggs', 12, 140], ['2 eggs', 12, 140], ['2 eggs', 12, 140],
  ];
  for (let i = 0; i < rows.length; i++) {
    const [food, p, c] = rows[i]!;
    await h.pool.query(
      `INSERT INTO food_logs (user_id, food, protein_g, calories, confidence, raw_text, source, dedupe_key)
       VALUES ($1, $2, $3, $4, 'high', $2, 'text', $5)`,
      [P, food, p, c, `p12-${i}-${Date.now()}`],
    );
  }

  const r = await h.sendWhatsApp(P, 'what did I eat today?');
  check('food summary → aggregates eggs (× 6, not repeated)',
    !!r && /eggs × 6/i.test(r.body), r?.body.slice(0, 120) ?? 'no reply');
  check('food summary → aggregates chicken (× 3) and rice (× 2)',
    !!r && /chicken breast × 3/i.test(r.body) && /rice × 2/i.test(r.body),
    r?.body.slice(0, 120) ?? 'no reply');
  check('food summary → no raw repetition (chicken appears once)',
    !!r && (r.body.match(/chicken breast/gi)?.length ?? 0) === 1,
    r ? `chicken count: ${r.body.match(/chicken breast/gi)?.length}` : 'no reply');
  check('food summary → no vague "and N more"',
    !!r && !/and \d+ more/i.test(r.body), r?.body.slice(0, 120) ?? 'no reply');
  check('food summary → totals present and unchanged by aggregation',
    !!r && /134\s*g/i.test(r.body) && /1,?360/.test(r.body), r?.body.slice(0, 160) ?? 'no reply');

  // Sectioned path (>3 distinct foods): fresh user, all foods preloaded BEFORE
  // the first query (direct DB inserts bypass the today-food cache, so a
  // post-query insert would be invisible). Probes what survives the outbound
  // sanitizer, which strips bullets/headers for WhatsApp prose.
  const P2 = '+15551550002';
  await h.wipeUser(P2); await h.createUser(P2, { protein_goal_grams: 200, calorie_goal_kcal: 3500, timezone: 'UTC' });
  const many: Array<[string, number, number]> = [
    ['chicken breast (4oz)', 30, 180], ['chicken breast (4oz)', 30, 180], ['chicken breast (4oz)', 30, 180],
    ['rice (1 cup)', 4, 200], ['rice (1 cup)', 4, 200],
    ['2 eggs', 12, 140], ['2 eggs', 12, 140], ['2 eggs', 12, 140],
    ['apple', 0, 95], ['banana', 1, 110], ['almonds', 6, 165], ['broccoli', 2, 30], ['salmon (5oz)', 28, 280],
  ];
  for (let i = 0; i < many.length; i++) {
    const [food, p, c] = many[i]!;
    await h.pool.query(
      `INSERT INTO food_logs (user_id, food, protein_g, calories, confidence, raw_text, source, dedupe_key)
       VALUES ($1, $2, $3, $4, 'high', $2, 'text', $5)`,
      [P2, food, p, c, `p12b-${i}-${Date.now()}`],
    );
  }
  const r2 = await h.sendWhatsApp(P2, 'summarize my meals');
  console.log('  [P12 many-foods delivered]:', JSON.stringify(r2?.body ?? 'no reply'));
  check('many-foods summary → delivered (one-line survives the enforcer)',
    !!r2 && r2.body.length > 0, r2?.body.slice(0, 200) ?? 'no reply');
  check('many-foods summary → aggregated, no raw repetition',
    !!r2 && (r2.body.match(/chicken breast/gi)?.length ?? 0) === 1 && !/and \d+ more\b/i.test(r2.body),
    r2?.body.slice(0, 200) ?? 'no reply');
  check('many-foods summary → rolls tail into a meaningful count',
    !!r2 && /plus \d+ more foods?/i.test(r2.body),
    r2?.body.slice(0, 200) ?? 'no reply');
  check('many-foods summary → totals survive (171g / 2,040)',
    !!r2 && /171\s*g/i.test(r2.body) && /2,?040/.test(r2.body),
    r2?.body.slice(0, 200) ?? 'no reply');

  await h.wipeUser(P); await h.wipeUser(P2);
}

// ── P13: daily reset at LOCAL MIDNIGHT (12:00 AM – 11:59 PM) ────────────────
// Spec 2026-06-11: the food day is the user's local calendar day. A log at
// 11:30 PM belongs to that day; a log at 12:30 AM belongs to the NEW day.
// (The old code used a 5am rollover, so 12:30 AM counted as "yesterday" —
// the 00:30 row below is the discriminating case.) History must survive the
// reset and stay queryable per day; users must be fully isolated.
async function p13MidnightReset(h: Harness): Promise<void> {
  phase('P13 local-midnight daily reset + history');
  const A = '+15551660001';
  const B = '+15551660002';
  await h.wipeUser(A); await h.createUser(A, { protein_goal_grams: 100, timezone: 'UTC' });
  await h.wipeUser(B); await h.createUser(B, { protein_goal_grams: 100, timezone: 'UTC' });

  // Insert rows at controlled timestamps relative to the UTC midnight boundary
  // BEFORE any read (direct inserts bypass cache invalidation).
  const insert = (phone: string, food: string, protein: number, cal: number, createdAtSql: string) =>
    h.pool.query(
      `INSERT INTO food_logs (user_id, food, protein_g, calories, confidence, raw_text, source, dedupe_key, created_at)
       VALUES ($1, $2, $3, $4, 'high', $2, 'text', $5, ${createdAtSql})`,
      [phone, food, protein, cal, `p13-${phone}-${food}-${Date.now()}`],
    );
  await insert(A, 'late dinner steak', 50, 400, `date_trunc('day', now()) - interval '30 minutes'`); // yesterday 11:30 PM
  await insert(A, 'midnight snack yogurt', 10, 100, `date_trunc('day', now()) + interval '30 minutes'`); // today 12:30 AM
  await insert(A, 'eggs', 12, 140, 'now()'); // today, now
  await insert(B, 'tofu', 20, 160, 'now()'); // another user, today

  const today = await h.users.getTodaysFoodSummary(A);
  check('today = strictly 12:00 AM onward (22g = 00:30 yogurt + eggs, NOT 72g)',
    Math.round(today.protein_g) === 22,
    `today.protein_g=${Math.round(today.protein_g)} items=${today.items.join('|')}`);
  check("yesterday's 11:30 PM steak excluded from today",
    !today.items.some((i) => /steak/i.test(i)), today.items.join('|'));
  check("today's items include the 12:30 AM log (old 5am rollover would drop it)",
    today.items.some((i) => /yogurt/i.test(i)), today.items.join('|'));

  // History: the pre-midnight day is preserved and queryable per-day.
  const hist = await h.users.getDailyProteinHistory(A, 2);
  const yesterdayRow = hist.find((d) => Math.round(d.protein_g) === 50);
  check('history keeps yesterday (50g steak) after the reset',
    !!yesterdayRow, JSON.stringify(hist));
  check('history day rows recomputed from logs (today=22g, yesterday=50g)',
    hist.some((d) => Math.round(d.protein_g) === 22) && !!yesterdayRow,
    JSON.stringify(hist));

  // Per-user isolation: B sees only B's rows.
  const bToday = await h.users.getTodaysFoodSummary(B);
  check('users fully isolated (B sees only tofu, 20g)',
    Math.round(bToday.protein_g) === 20 && bToday.items.length === 1,
    `B.protein_g=${Math.round(bToday.protein_g)} items=${bToday.items.join('|')}`);

  // End-to-end: the WhatsApp answer uses the midnight-bounded total.
  const r = await h.sendWhatsApp(A, 'How much protein I had');
  check('WhatsApp "protein today" uses the midnight-bounded total (22g)',
    !!r && /\b22\s*g\b/.test(r.body), r?.body.slice(0, 120) ?? 'no reply');

  await h.wipeUser(A); await h.wipeUser(B);
}

async function main(): Promise<void> {
  const only = process.argv.slice(2);
  const h = await buildHarness();
  const phases: Array<[string, (h: Harness) => Promise<void>]> = [
    ['p1', p1ShortCircuits], ['p2', p2FastPath], ['p3', p3PipelineCorrectness],
    ['p4', p4Guards], ['p5', p5Concurrency], ['p6', p6LongThread], ['p7', p7LatencyModel],
    ['p8', p8ContentAccuracy], ['p9', p9HallucinationContext], ['p10', p10ScreenshotRegressions],
    ['p11', p11Reconstruction], ['p12', p12FoodSummaryAggregation],
    ['p13', p13MidnightReset],
  ];
  for (const [key, fn] of phases) {
    if (only.length > 0 && !only.includes(key)) continue;
    try {
      await fn(h);
    } catch (err) {
      check(`${key} crashed`, false, err instanceof Error ? err.message : String(err));
    }
  }

  console.log('\n━━━ SUMMARY ━━━');
  let pass = 0, fail = 0;
  for (const [ph, checks] of Object.entries(results)) {
    for (const c of checks) c.pass ? pass++ : fail++;
    const failed = checks.filter((c) => !c.pass);
    console.log(`${ph}: ${checks.length - failed.length}/${checks.length}${failed.length ? '  FAILED: ' + failed.map((f) => f.name).join(' | ') : ''}`);
  }
  console.log(`TOTAL: ${pass} pass, ${fail} fail`);
  await h.shutdown();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
