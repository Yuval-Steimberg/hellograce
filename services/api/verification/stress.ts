// Heavy-load run: 24 users × 3 mixed messages with production-like LLM
// delays, all real pipeline (webhook → coalesce → locks → AI → workers).
import { buildHarness } from './harness.js';

async function main(): Promise<void> {
  const h = await buildHarness({ delays: {
    generation: 900, food_question_direct: 900, planner: 250,
    relevance_check: 200, behavioral_guard: 220, critic: 250,
    food_itemize: 450, food_decompose: 350, default: 150,
  } });
  const N = 24;
  const phones = Array.from({ length: N }, (_, i) => `+1666${String(i).padStart(7, '0')}`);
  await Promise.all(phones.map(async (p) => { await h.wipeUser(p); await h.createUser(p); }));

  const traffic = [
    'Hi', 'I just had a protein shake', 'why am I so tired this week?',
    'thanks', 'What should I eat for dinner?', 'I weighed 198 this morning',
    'feeling pretty low today honestly', 'how much protein did I have today?',
  ];
  const lats: number[] = [];
  let failures = 0;
  const t0 = Date.now();
  await Promise.all(phones.map(async (p, ui) => {
    for (let round = 0; round < 3; round++) {
      const msg = traffic[(ui + round * 7) % traffic.length]!;
      const r = await h.sendWhatsApp(p, msg, { timeoutMs: 30_000 });
      if (!r) { failures++; console.log(`NO REPLY user=${p} msg="${msg}"`); }
      else lats.push(r.latencyMs);
      await new Promise((res) => setTimeout(res, 250));
    }
  }));
  const wall = Date.now() - t0;
  lats.sort((a, b) => a - b);
  const pct = (p: number) => lats[Math.min(lats.length - 1, Math.floor((p / 100) * lats.length))];
  console.log(`replied=${lats.length}/${N * 3} failures=${failures} wall=${wall}ms`);
  console.log(`latency p50=${pct(50)}ms p90=${pct(90)}ms p95=${pct(95)}ms p99=${pct(99)}ms max=${lats.at(-1)}ms`);
  // Postgres pool + Redis sanity after load
  const { rows } = await h.pool.query(`SELECT COUNT(*)::int AS n FROM messages`);
  console.log('messages persisted total:', rows[0].n);
  await Promise.all(phones.map((p) => h.wipeUser(p)));
  await h.shutdown();
  process.exit(failures > 0 ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
