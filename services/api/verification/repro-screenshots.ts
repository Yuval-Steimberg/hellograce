// Reproduction of the 2026-06-11 WhatsApp screenshots.
// Sends the exact failing messages through the real pipeline against real
// Postgres + Redis, in two modes:
//   (A) Gemini healthy  — what routing/intent decisions produce
//   (B) Gemini down     — generation/food_question/emergency THROW, exposing
//       the terminal fallback the user actually receives ("what's on your mind")
import { buildHarness } from './harness.js';

const PHONE = '+15550000931';

async function main() {
  const h = await buildHarness({ delays: {} });
  await h.wipeUser(PHONE);
  await h.createUser(PHONE, { protein_goal_grams: 60, first_name: 'Tester' });

  // Prime: log a food so "how much I had" has real data.
  await h.sendWhatsApp(PHONE, 'I just had 2 eggs and toast');

  const messages = [
    'What I should eat for dinner',
    'And tuna\nRice\nAvocado',
    "I'm good. My stomach herts. I'm hungry",
    'Ima nervous',
    'All',
    'How about pizza for dinner?',
    'How much protein I had',
    'What is my target?',
    "What's is my protein target? How much I had?",
  ];

  for (const mode of ['HEALTHY', 'GEMINI_DOWN'] as const) {
    console.log(`\n================ MODE: ${mode} ================`);
    h.llm.throwOnClasses = mode === 'GEMINI_DOWN'
      ? new Set(['generation', 'food_question_direct', 'emergency_fallback', 'planner', 'search_food_ideas'] as const)
      : new Set();

    for (const msg of messages) {
      try {
        const r = await h.sendWhatsApp(PHONE, msg, { timeoutMs: 20_000 });
        const oneLine = msg.replace(/\n/g, ' / ');
        console.log(`\nUSER: ${oneLine}`);
        console.log(`GRACE: ${r ? r.body.replace(/\n+/g, ' ⏎ ') : '*** NO REPLY ***'}`);
      } catch (e) {
        console.log(`\nUSER: ${msg.replace(/\n/g, ' / ')}`);
        console.log(`ERROR: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  await h.shutdown();
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
