// Validates the degraded-mode (Gemini fully DOWN) behavior the user saw in
// production logs (403 SERVICE_DISABLED). Every Gemini class throws.
import { buildHarness } from './harness.js';
const PHONE = '+15550000942';
async function main() {
  const h = await buildHarness();
  await h.wipeUser(PHONE);
  await h.createUser(PHONE, { protein_goal_grams: 60 });
  // Total outage: every LLM class throws.
  h.llm.throwOnClasses = new Set([
    'generation','food_question_direct','emergency_fallback','planner',
    'search_food_ideas','relevance_check','behavioral_guard','critic',
    'food_itemize','food_decompose','macro_estimate',
  ] as any);
  const msgs = [
    'Hey, for breakfast I ate 2 eggs. For lunch I had chicken breast with bowl of rice',
    'Hey, for breakfast I ate 2 eggs. For lunch I had chicken breast with bowl of rice',
    'is hair loose commn on glp?',
    'How about burger for dinner?',
    'Ima sad',
  ];
  for (const m of msgs) {
    const r = await h.sendWhatsApp(PHONE, m, { timeoutMs: 20000 });
    console.log(`\nUSER: ${m.replace(/\n/g,' / ')}`);
    console.log(`GRACE: ${r ? r.body.replace(/\n+/g,' ⏎ ') : '*** NO REPLY ***'}`);
  }
  await h.shutdown(); process.exit(0);
}
main().catch(e=>{console.error(e);process.exit(1);});
